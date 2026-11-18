import { LoopEngine, MidiEvent, Track } from './loop-engine';
import { compileLoop } from './loop-seam';
import { paintPedal, PEDALS, readRollPedals, RollPedal } from './midi-pedals';
import { alignNotes, AlignResult } from './midi-align';

export interface RollNote {
  id: string;
  layer: number;
  pitch: number;
  channel: number;
  velocity: number;
  start: number;
  duration: number;
  /** A recorded, deliberately tied voice with no release anywhere in the cycle. */
  continuous?: boolean;
}
type Layers = MidiEvent[][];
export interface AlignPreview extends AlignResult {
  source: RollNote[];
  track: number;
  layers: Layers | undefined;
  bpm: number;
  length: number;
  step: number;
  ends: boolean;
  scopeIds?: readonly string[];
}
export interface NoteChange {
  id: string;
  patch: Partial<Pick<RollNote, 'pitch' | 'start' | 'duration'>> | null;
}
/** One bounded translation for the whole group; never clamp notes individually. */
export function translateNotes(
  notes: RollNote[],
  time: number,
  pitch: number,
  length: number,
): RollNote[] {
  if (!notes.length || !Number.isFinite(time) || !Number.isFinite(pitch)) return notes;
  let minStart = Infinity,
    maxStart = -Infinity,
    minPitch = 128,
    maxPitch = -1;
  for (const n of notes) {
    minStart = Math.min(minStart, n.start);
    maxStart = Math.max(maxStart, n.start);
    minPitch = Math.min(minPitch, n.pitch);
    maxPitch = Math.max(maxPitch, n.pitch);
  }
  const dt = Math.max(-minStart, Math.min(Math.max(0, length - 0.001 - maxStart), time));
  const dp = Math.max(-minPitch, Math.min(127 - maxPitch, Math.round(pitch)));
  return notes.map((n) => ({ ...n, start: n.start + dt, pitch: n.pitch + dp }));
}
const isOn = (e: MidiEvent) => (e.data[0] & 0xf0) === 0x90 && e.data[2] > 0;
const isOff = (e: MidiEvent) =>
  (e.data[0] & 0xf0) === 0x80 || ((e.data[0] & 0xf0) === 0x90 && !e.data[2]);
const copy = (layers: Layers): Layers =>
  layers.map((layer) => layer.map((e) => ({ ...e, data: [...e.data] })));
export function editableLayers(t: Track): Layers {
  return t.layers ?? [[...(t.carry ?? []).map((data) => ({ at: -1, data })), ...t.events]];
}

/** Read the audible periodic part of each take separately; never flatten overdubs. */
export function readRollNotes(t: Track): RollNote[] {
  if (!t.length || !['playing', 'overdub'].includes(t.state)) return [];
  return editableLayers(t).flatMap((layer, index) => {
    const { events, carry } = compileLoop([layer]);
    const notes: RollNote[] = [],
      pending = new Map<string, RollNote>(),
      seeds = new Map<string, RollNote>();
    const key = (data: number[]) => `${data[0] & 15}:${data[1]}`;
    const make = (data: number[], start: number, id: string): RollNote => ({
      id: `${index}:${id}`,
      layer: index,
      pitch: data[1],
      channel: data[0] & 15,
      velocity: data[2],
      start,
      duration: t.length - start,
    });
    carry.forEach((data, i) => {
      if (!isOn({ at: -1, data })) return;
      const n = make(data, 0, `carry${i}`);
      notes.push(n);
      seeds.set(key(data), n);
      pending.set(key(data), n);
    });
    events.forEach((e, i) => {
      if (isOn(e)) {
        const n = make(e.data, e.at, String(i));
        notes.push(n);
        pending.set(key(e.data), n);
      } else if (isOff(e)) {
        const n = pending.get(key(e.data));
        if (n) n.duration = e.at - n.start;
        pending.delete(key(e.data));
      }
    });
    const remove = new Set<RollNote>();
    for (const [key, n] of pending) {
      const seed = seeds.get(key);
      if (seed && seed !== n) {
        n.duration = t.length - n.start + seed.duration;
        remove.add(seed);
      } else if (seed === n) {
        n.continuous = true;
      }
    }
    return notes.filter((n) => n.duration > 0 && !remove.has(n));
  });
}

/** Only the touched layer is rewritten. Pedal/controller events stay byte-for-byte intact. */
function writeLayer(original: MidiEvent[], notes: RollNote[], length: number): MidiEvent[] {
  const events = original.filter((e) => !isOn(e) && !isOff(e));
  for (const n of notes) {
    const on = [0x90 | n.channel, n.pitch, n.velocity];
    const off = [0x80 | n.channel, n.pitch, 0];
    const end = n.start + n.duration;
    if (n.continuous && n.start === 0 && n.duration >= length) events.push({ at: -1, data: on });
    else {
      if (end > length + 0.001) {
        events.push({ at: -1, data: [...on] });
        events.push({ at: end - length, data: off });
      } else {
        // Stored events must be inside the cycle (also in .aloop v1). A finite
        // editor note ending at the seam needs a real release, not an immortal
        // carry seed. The sub-microbeat gap is below the scheduler tolerance.
        events.push({ at: Math.min(end, length - 0.001), data: off });
      }
      events.push({ at: n.start, data: on });
    }
  }
  // Releases precede attacks at the same instant; negative seeds precede all of them.
  return events.sort((a, b) => a.at - b.at || Number(isOn(a)) - Number(isOn(b)));
}

interface History {
  source: Layers | undefined;
  events: MidiEvent[];
  length: number;
  undo: Layers[];
  redo: Layers[];
  notes: RollNote[];
  pedals: RollPedal[];
}
export class MidiEditor {
  private histories = new Map<number, History>();
  constructor(private engine: LoopEngine) {}
  get track(): Track {
    return this.engine.tracks[this.engine.selected];
  }
  get editable(): boolean {
    return (
      this.engine.paused &&
      this.track.state === 'playing' &&
      this.track.length > 0 &&
      !this.engine.tracks.some(
        (t) =>
          ['armed', 'recording', 'overdub'].includes(t.state) || !!t.pending || !!t.releaseTail,
      )
    );
  }
  get reason(): string {
    if (!this.track.length)
      return 'Zuerst einen Loop aufnehmen. Die Piano Roll bearbeitet bestehende Spuren.';
    if (!this.engine.paused)
      return 'Zum Bearbeiten pausieren. Der Ansichtswechsel unterbricht die Wiedergabe nicht.';
    if (!this.editable)
      return 'Aufnahme oder Vormerkung noch offen: mit Stop abschließen, dann bearbeiten.';
    return 'Leere Fläche ziehen: Auswahl · Shift+Klick: Auswahl ändern · Doppelklick: Note · Auswahl ziehen: verschieben · Kanten: Länge · Entf: löschen';
  }
  private history(): History {
    const t = this.track;
    let h = this.histories.get(t.id);
    if (!h || h.source !== t.layers || h.events !== t.events || h.length !== t.length) {
      h = {
        source: t.layers,
        events: t.events,
        length: t.length,
        undo: [],
        redo: [],
        notes: readRollNotes(t),
        pedals: readRollPedals(t),
      };
      this.histories.set(t.id, h);
    }
    return h;
  }
  get notes(): RollNote[] {
    return this.history().notes;
  }
  get pedals(): RollPedal[] {
    return this.history().pedals;
  }
  get canUndo(): boolean {
    return this.editable && this.history().undo.length > 0;
  }
  get canRedo(): boolean {
    return this.editable && this.history().redo.length > 0;
  }
  private install(layers: Layers, h: History): void {
    const t = this.track;
    t.layers = layers;
    Object.assign(t, compileLoop(layers));
    // Paused-only: no chase, queue clear or output resets, including live monitoring.
    h.source = t.layers;
    h.events = t.events;
    h.notes = readRollNotes(t);
    h.pedals = readRollPedals(t);
  }
  /** One transaction boundary for notes, pedals and later timing previews. */
  private commit(layers: Layers, h: History): boolean {
    const others = this.engine.tracks
      .filter((v) => v !== this.track && v.length > 0)
      .reduce((sum, v) => sum + editableLayers(v).reduce((n, l) => n + l.length, 0), 0);
    if (layers.length > 10000 || others + layers.reduce((sum, l) => sum + l.length, 0) > 200000)
      return false;
    h.undo.push(copy(editableLayers(this.track)));
    while (
      h.undo.length > 30 ||
      (h.undo.length > 1 &&
        h.undo.reduce(
          (sum, snapshot) => sum + snapshot.reduce((n, layer) => n + layer.length, 0),
          0,
        ) > 250000)
    )
      h.undo.shift();
    h.redo = [];
    this.install(layers, h);
    return true;
  }
  changePedal(
    cc: number,
    id: string | null,
    patch: Partial<Pick<RollPedal, 'start' | 'duration' | 'value'>> | null,
  ): RollPedal | undefined {
    if (!this.editable || !PEDALS.some((p) => p.cc === cc)) return;
    const h = this.history(),
      length = this.track.length;
    const old = id === null ? undefined : h.pedals.find((p) => p.id === id && p.cc === cc);
    if ((id !== null && !old) || (!old && !patch)) return;
    const next = patch
      ? { cc, start: 0, duration: Math.min(125, length), value: 127, ...old, ...patch }
      : undefined;
    if (
      next &&
      (!Number.isFinite(next.start) ||
        next.start < 0 ||
        next.start >= length ||
        !Number.isFinite(next.duration) ||
        next.duration <= 0 ||
        next.duration > length ||
        !Number.isInteger(next.value) ||
        next.value < 0 ||
        next.value > 127)
    )
      return;
    if (
      old &&
      next &&
      old.start === next.start &&
      old.duration === next.duration &&
      old.value === next.value
    )
      return old;
    const paints = [...(old ? [{ ...old, value: 0 }] : []), ...(next ? [next] : [])];
    if (!this.commit(paintPedal(editableLayers(this.track), cc, paints, length), h)) return;
    return next
      ? h.pedals.find((p) => p.cc === cc && p.start === next.start && p.value === next.value)
      : undefined;
  }
  change(
    id: string | null,
    patch: Partial<Pick<RollNote, 'pitch' | 'start' | 'duration'>> | null,
  ): RollNote | undefined {
    if (!this.editable) return;
    const h = this.history(),
      t = this.track;
    const old = id === null ? undefined : h.notes.find((n) => n.id === id);
    if (id !== null && !old) return;
    if (!old && !patch) return;
    const n = patch
      ? {
          ...(old ?? {
            layer: editableLayers(t).length,
            pitch: 60,
            channel: 0,
            velocity: 100,
            start: 0,
            duration: 125,
          }),
          ...patch,
          continuous: false,
        }
      : undefined;
    if (
      n &&
      (!Number.isInteger(n.pitch) ||
        n.pitch < 0 ||
        n.pitch > 127 ||
        !Number.isFinite(n.start) ||
        n.start < 0 ||
        n.start >= t.length ||
        !Number.isFinite(n.duration) ||
        n.duration <= 0 ||
        n.duration > t.length)
    )
      return;
    if (old && n && old.pitch === n.pitch && old.start === n.start && old.duration === n.duration)
      return old;
    const layers = copy(editableLayers(t));
    const layer = old?.layer ?? layers.length;
    if (layer >= 10000) return;
    layers[layer] = writeLayer(
      layers[layer] ?? [],
      [...h.notes.filter((v) => v.layer === layer && v.id !== id), ...(n ? [n as RollNote] : [])],
      t.length,
    );
    if (!this.commit(layers, h)) return;
    return n
      ? h.notes.find(
          (v) => v.layer === layer && v.pitch === n.pitch && Math.abs(v.start - n.start) < 0.01,
        )
      : undefined;
  }
  /** Source-bound batch: validation, serialization and history happen ONCE. */
  changeMany(source: RollNote[], changes: NoteChange[]): RollNote[] | undefined {
    if (!this.editable || source !== this.notes || !changes.length) return;
    const patches = new Map(changes.map((c) => [c.id, c.patch]));
    const known = new Set(source.map((n) => n.id));
    if (patches.size !== changes.length || changes.some((c) => !known.has(c.id))) return;
    const touched = new Set<number>(),
      next: RollNote[] = [];
    for (const old of source) {
      if (!patches.has(old.id)) {
        next.push(old);
        continue;
      }
      const patch = patches.get(old.id);
      if (patch === null) {
        touched.add(old.layer);
        continue;
      }
      const n = { ...old, ...patch };
      if (
        !Number.isInteger(n.pitch) ||
        n.pitch < 0 ||
        n.pitch > 127 ||
        !Number.isFinite(n.start) ||
        n.start < 0 ||
        n.start >= this.track.length ||
        !Number.isFinite(n.duration) ||
        n.duration <= 0 ||
        n.duration > this.track.length
      )
        return;
      if (n.start !== old.start || n.pitch !== old.pitch || n.duration !== old.duration) {
        n.continuous = false;
        touched.add(old.layer);
      }
      next.push(n);
    }
    const wanted = next.filter((n) => patches.has(n.id));
    if (!touched.size) return wanted;
    const h = this.history(),
      layers = copy(editableLayers(this.track)),
      buckets = new Map<number, RollNote[]>();
    for (const n of next)
      if (touched.has(n.layer)) {
        const bucket = buckets.get(n.layer) ?? [];
        bucket.push(n);
        buckets.set(n.layer, bucket);
      }
    for (const layer of touched)
      layers[layer] = writeLayer(layers[layer], buckets.get(layer) ?? [], this.track.length);
    if (!this.commit(layers, h)) return;
    const key = (n: RollNote) => `${n.layer}:${n.channel}:${n.pitch}:${Math.round(n.start * 1000)}`;
    const installed = new Map<string, RollNote[]>();
    for (const n of h.notes) {
      const bucket = installed.get(key(n)) ?? [];
      bucket.push(n);
      installed.set(key(n), bucket);
    }
    return wanted.flatMap((n) => {
      const match = installed.get(key(n))?.shift();
      return match ? [match] : [];
    });
  }
  previewAlign(
    subdivision: number,
    ends = false,
    scopeIds?: readonly string[],
  ): AlignPreview | undefined {
    if (!this.editable || this.engine.mode !== 'tempo' || ![1, 2, 4, 8].includes(subdivision))
      return;
    const t = this.track,
      source = this.notes,
      step = 60000 / this.engine.bpm / subdivision;
    return {
      ...alignNotes(source, t.length, step, ends, t.events, scopeIds),
      source,
      track: t.id,
      layers: t.layers,
      bpm: this.engine.bpm,
      length: t.length,
      step,
      ends,
      scopeIds: scopeIds ? [...scopeIds] : undefined,
    };
  }
  validAlign(preview: AlignPreview): boolean {
    return (
      this.editable &&
      this.engine.mode === 'tempo' &&
      preview.source === this.notes &&
      preview.track === this.track.id &&
      preview.layers === this.track.layers &&
      preview.length === this.track.length &&
      preview.bpm === this.engine.bpm &&
      [1, 2, 4, 8].some((s) => preview.step === 60000 / this.engine.bpm / s) &&
      typeof preview.ends === 'boolean'
    );
  }
  applyAlign(preview: AlignPreview): boolean {
    if (!this.validAlign(preview) || !preview.changed) return false;
    // Recompute, rather than trusting mutable UI preview data as a write API.
    const result = alignNotes(
      this.notes,
      this.track.length,
      preview.step,
      preview.ends,
      this.track.events,
      preview.scopeIds,
    );
    if (!result.changed) return false;
    const changes = result.notes.flatMap((n, i) =>
      n.start !== this.notes[i].start || n.duration !== this.notes[i].duration
        ? [{ id: n.id, patch: { start: n.start, duration: n.duration } }]
        : [],
    );
    return this.changeMany(this.notes, changes) !== undefined;
  }
  undo(): void {
    if (!this.canUndo) return;
    const h = this.history();
    h.redo.push(copy(editableLayers(this.track)));
    this.install(h.undo.pop()!, h);
  }
  redo(): void {
    if (!this.canRedo) return;
    const h = this.history();
    h.undo.push(copy(editableLayers(this.track)));
    this.install(h.redo.pop()!, h);
  }
}
