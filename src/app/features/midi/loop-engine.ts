import { DEFAULT_PROGRAMS } from './programs';
import { PEDAL_CONTROLLERS } from './midi-events';
import { compileLoop } from './loop-seam';
export type Mode = 'free' | 'tempo';
export type State = 'empty' | 'armed' | 'recording' | 'playing' | 'overdub';
export type Action = 'start' | 'finish' | 'dub' | 'play';
export interface MidiEvent {
  at: number;
  data: number[];
  boundary?: boolean;
}
export interface Pending {
  at: number;
  action: Action;
}
export interface Track {
  id: number;
  state: State;
  pending?: Pending;
  start: number;
  length: number;
  events: MidiEvent[];
  take: MidiEvent[];
  takeStart: number;
  layers?: MidiEvent[][];
  carry?: number[][];
  cursor: number;
  muted: boolean;
  unmuteAt?: number;
  volume: number;
  program: number;
  octave: number;
  fixedBars?: number | null;
  plannedLength?: number;
  autoEnd?: number;
  autoAction?: 'dub' | 'play';
  barDuration?: number;
  releaseTail?: { until: number; notes: Record<string, number>; pedals: string[] };
}
export interface MidiSink {
  send(track: number, data: number[], at: number): void;
  reset(at: number): void;
  resetTrack?(track: number, at: number): void;
  deleteTrack?(track: number, at: number): void;
  closeLiveTake?(track: number, at: number): void;
  beginTrack?(track: number, at: number): void;
  closeReleaseTail?(
    track: number,
    notes: Record<string, number>,
    pedals: string[],
    at: number,
  ): void;
}
const EPS = 0.001;
export function nextBoundary(now: number, origin: number, unit: number): number {
  const n = (now - origin) / unit;
  return origin + Math.max(0, Math.ceil(n - EPS / unit)) * unit;
}
export function fittedLength(duration: number, reference: number): number {
  const candidates = [1 / 8, 1 / 4, 1 / 2, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => n * reference);
  if (duration > reference * 8) return Math.round(duration / reference) * reference;
  return candidates.reduce((a, b) => (Math.abs(a - duration) <= Math.abs(b - duration) ? a : b));
}
export class LoopEngine {
  tracks: Track[] = Array.from({ length: 5 }, (_, id) => ({
    id,
    state: 'empty',
    start: 0,
    length: 0,
    events: [],
    take: [],
    takeStart: 0,
    cursor: 0,
    muted: false,
    volume: 100,
    program: DEFAULT_PROGRAMS[id],
    octave: id === 4 ? 2 : 4,
  }));
  mode: Mode = 'free';
  bpm = 120;
  beats = 4;
  denominator = 4;
  afterRecord: 'dub' | 'play' = 'dub';
  selected = 0;
  origin: number | null = null;
  reference = 0;
  lastTick = 0;
  startToleranceMs = 50;
  unmuteMode: 'cycle' | 'immediate' = 'cycle';
  private heldInput = Array.from(
    { length: 5 },
    () => new Map<string, { at: number; data: number[]; count: number }>(),
  );
  clearInputHistory(): void {
    for (const notes of this.heldInput) notes.clear();
  }
  select(id: number): void {
    this.selected = id;
    this.clearInputHistory();
  }
  onFirstFreeLoop: (track: Track) => void = () => {};
  constructor(public sink: MidiSink) {}
  get bar(): number {
    return ((60000 / this.bpm) * this.beats * 4) / this.denominator;
  }
  get grid(): number {
    return this.mode === 'tempo' ? this.bar : this.reference;
  }
  get busy(): boolean {
    return this.tracks.some((t) => t.state !== 'empty');
  }
  press(id: number, now: number): void {
    this.tick(now, now);
    const t = this.tracks[id];
    this.selected = id;
    if (t.state === 'empty') {
      // Only one unmeasured first recording can establish the free transport.
      if (this.mode === 'free' && !this.reference && this.busy) return;
      const first = !this.busy,
        fixed = Number.isInteger(t.fixedBars) && t.fixedBars! >= 1 && t.fixedBars! <= 64;
      t.plannedLength = fixed ? t.fixedBars! * this.bar : undefined;
      t.barDuration = fixed || this.mode === 'tempo' ? this.bar : undefined;
      if (first && fixed && this.mode === 'free') {
        this.mode = 'tempo';
        this.origin = now;
        this.begin(t, now);
      } else if (!this.grid) {
        if (this.origin === null) this.origin = now;
        this.begin(t, now);
      } else {
        // Free follow-up tracks start at the complete reference-loop boundary.
        // Their eventual length can still be a fraction or multiple of that loop.
        const startGrid = this.mode === 'free' ? this.reference : this.grid;
        if (this.origin === null) this.origin = now;
        t.state = 'armed';
        t.pending = { at: nextBoundary(now, this.origin, startGrid), action: 'start' };
      }
    } else if (t.state === 'armed') {
      t.state = 'empty';
      t.pending = undefined;
      this.resetIfEmpty();
    } else if (t.state === 'recording') {
      if (t.autoEnd !== undefined) t.autoAction = t.autoAction === 'dub' ? 'play' : 'dub';
      else if (t.pending) t.pending.action = t.pending.action === 'dub' ? 'play' : 'dub';
      else if (this.mode === 'free' && !this.reference) {
        if (now - t.start < 100) return;
        this.reference = now - t.start;
        this.finish(t, now, this.afterRecord, now);
        this.onFirstFreeLoop(t);
      } else {
        const end =
          this.mode === 'free'
            ? t.start + fittedLength(now - t.start, this.reference)
            : Math.max(t.start + this.bar, nextBoundary(now, this.origin!, this.bar));
        if (end <= now + EPS) this.finish(t, end, this.afterRecord, now);
        else t.pending = { at: end, action: this.afterRecord };
      }
    } else if (t.state === 'overdub') {
      if (t.pending?.action === 'play') t.pending = undefined;
      else {
        const phase = (((now - t.start) % t.length) + t.length) % t.length;
        if (phase >= t.length / 2) t.pending = { at: now + t.length - phase, action: 'play' };
        else this.endOverdub(t, now);
      }
    } else if (t.pending) t.pending = undefined;
    else
      t.pending = {
        at: nextBoundary(now, t.start, t.length),
        action: t.state === 'playing' ? 'dub' : 'play',
      };
    this.tick(now, now);
  }
  private begin(t: Track, at: number): void {
    this.sink.beginTrack?.(t.id, at);
    t.state = 'recording';
    t.start = at;
    t.takeStart = at;
    t.take = [];
    t.pending = undefined;
    t.cursor = at;
    this.captureLeadIn(t, at);
    t.autoEnd = t.plannedLength ? at + t.plannedLength : undefined;
    t.autoAction = this.afterRecord;
  }
  private captureLeadIn(t: Track, at: number): void {
    const tolerance = Math.max(0, Math.min(100, this.startToleranceMs));
    if (!tolerance) return;
    for (const note of this.heldInput[t.id].values())
      if (note.at >= at - tolerance && note.at <= at)
        for (let i = 0; i < note.count; i++) t.take.push({ at: 0, data: [...note.data] });
  }
  private endOverdub(t: Track, now: number): void {
    const notes: Record<string, number> = {};
    const pedals = new Set<string>();
    for (const e of t.take) {
      const op = e.data[0] & 0xf0,
        key = `${e.data[0] & 15}:${e.data[1]}`;
      if (op === 0x90 && e.data[2]) notes[key] = (notes[key] ?? 0) + 1;
      else if (op === 0x80 || op === 0x90) notes[key] = Math.max(0, (notes[key] ?? 0) - 1);
      else if (op === 0xb0 && PEDAL_CONTROLLERS.includes(e.data[1])) {
        if (e.data[2] > 0) pedals.add(key);
        else pedals.delete(key);
      }
    }
    t.state = 'playing';
    t.pending = undefined;
    const phase = (((now - t.start) % t.length) + t.length) % t.length;
    t.releaseTail = { until: now + t.length - phase, notes, pedals: [...pedals] };
    if (!Object.values(notes).some(Boolean) && !pedals.size) this.finishReleaseTail(t, now);
  }
  private finishReleaseTail(t: Track, now: number, force = false): void {
    if (force && t.releaseTail)
      this.sink.closeReleaseTail?.(t.id, t.releaseTail.notes, t.releaseTail.pedals, now);
    if (t.take.length) this.addTake(t, this.closeTake(t, Math.min(t.length, now - t.takeStart)));
    t.take = [];
    t.releaseTail = undefined;
    this.heldInput[t.id].clear();
  }
  useMetronome(origin: number): void {
    if (this.busy) return;
    this.mode = 'tempo';
    this.origin = origin;
  }
  useFree(): void {
    if (!this.busy) {
      this.mode = 'free';
      this.origin = null;
    }
  }
  private closeTake(t: Track, length: number, boundary = false): MidiEvent[] {
    const events: MidiEvent[] = t.take
      .filter((e) => e.at >= 0 && e.at < length)
      .map((e) => ({ at: e.at, data: [...e.data] }));
    // Clip held notes and sustain at the seam; never carry a stuck voice into another cycle.
    const notes = new Map<string, { note: number; channel: number; count: number }>();
    const pedals = new Map<string, number[]>();
    for (const e of events) {
      const op = e.data[0] & 0xf0;
      const key = `${e.data[0] & 15}:${e.data[1]}`,
        held = notes.get(key);
      if (op === 0x90 && e.data[2])
        notes.set(key, { note: e.data[1], channel: e.data[0] & 15, count: (held?.count ?? 0) + 1 });
      if ((op === 0x80 || (op === 0x90 && !e.data[2])) && held)
        held.count = Math.max(0, held.count - 1);
      if (op === 0xb0 && PEDAL_CONTROLLERS.includes(e.data[1])) {
        if (e.data[2] > 0) pedals.set(key, e.data);
        else pedals.delete(key);
      }
    }
    const at = Math.max(0, length - 0.01);
    for (const pedal of pedals.values())
      events.push({ at, data: [pedal[0], pedal[1], 0], boundary });
    for (const { note, channel, count } of notes.values())
      for (let i = 0; i < count; i++)
        events.push({ at, data: [0x80 | channel, note, 0], boundary });
    return events.sort((a, b) => a.at - b.at);
  }
  private finish(t: Track, end: number, action: Action, now: number): void {
    t.length = end - t.start;
    t.layers = [this.closeTake(t, t.length, true)];
    Object.assign(t, compileLoop(t.layers));
    t.take = [];
    if (!this.reference) this.reference = t.length;
    t.autoEnd = undefined;
    t.plannedLength = undefined;
    this.sink.closeLiveTake?.(t.id, now);
    this.heldInput[t.id].clear();
    t.pending = undefined;
    t.state = action === 'dub' ? 'overdub' : 'playing';
    t.takeStart = end;
    t.cursor = now;
    // Late stop: retain absolute phase and chase notes/controllers at the current position.
    this.invalidateTrack(t.id, now);
  }
  input(data: number[], now: number, track = this.selected, eventAt = now): void {
    this.tick(now, now);
    const op = data[0] & 0xf0;
    if (![0x80, 0x90, 0xa0, 0xb0, 0xd0, 0xe0].includes(op)) return;
    if (
      op === 0xb0 &&
      (data[1] === 0 || data[1] === 32 || data[1] === 7 || data[1] === 11 || data[1] >= 120)
    )
      return;
    const t = this.tracks[track];
    const key = `${data[0] & 15}:${data[1]}`;
    if (t.releaseTail) {
      const tail = t.releaseTail;
      let accepted = false;
      if ((op === 0x80 || (op === 0x90 && !data[2])) && tail.notes[key]) {
        tail.notes[key]--;
        accepted = true;
      } else if (op === 0xb0 && !data[2] && tail.pedals.includes(key)) {
        tail.pedals = tail.pedals.filter((p) => p !== key);
        accepted = true;
      }
      if (accepted) {
        t.take.push({ at: Math.max(0, eventAt - t.takeStart), data: [...data] });
        if (!Object.values(tail.notes).some(Boolean) && !tail.pedals.length)
          this.finishReleaseTail(t, now + 0.01);
      }
    }
    const held = this.heldInput[t.id].get(key);
    if (op === 0x90 && data[2])
      this.heldInput[t.id].set(key, {
        at: eventAt,
        data: [...data],
        count: (held?.count ?? 0) + 1,
      });
    else if ((op === 0x80 || op === 0x90) && held) {
      if (--held.count <= 0) this.heldInput[t.id].delete(key);
    }
    if (t.state === 'recording' || t.state === 'overdub')
      t.take.push({ at: Math.max(0, eventAt - t.takeStart), data: [...data] });
  }
  tick(now: number, horizon = now + 30): void {
    this.lastTick = now;
    for (const t of this.tracks) {
      if (t.unmuteAt !== undefined && t.unmuteAt <= now + EPS) {
        t.unmuteAt = undefined;
        t.muted = false;
        this.invalidateTrack(t.id, now);
      }
      if (t.releaseTail && t.releaseTail.until <= now + EPS)
        this.finishReleaseTail(t, t.releaseTail.until, true);
      if (t.pending && t.pending.at <= now + EPS) {
        const p = t.pending;
        t.pending = undefined;
        if (p.action === 'start') this.begin(t, p.at);
        else if (t.state === 'recording') this.finish(t, p.at, p.action, now);
        else {
          this.commitOverdub(t, p.at);
          t.state = p.action === 'dub' ? 'overdub' : 'playing';
          t.takeStart = p.at;
          if (t.state === 'overdub') this.captureLeadIn(t, p.at);
        }
      }
      if (t.state === 'recording' && t.autoEnd !== undefined && t.autoEnd <= now + EPS)
        this.finish(t, t.autoEnd, t.autoAction ?? this.afterRecord, now);
      if (t.state === 'overdub') {
        while (t.takeStart + t.length <= now + EPS) {
          const end = t.takeStart + t.length;
          this.commitOverdub(t, end);
          t.takeStart = end;
        }
      }
      if (!t.length || !['playing', 'overdub'].includes(t.state)) continue;
      let until = horizon;
      if (t.pending) until = Math.min(until, t.pending.at);
      if (t.state === 'overdub') until = Math.min(until, t.takeStart + t.length);
      if (t.cursor < now - 250) t.cursor = now;
      if (!t.muted) {
        const from = t.cursor;
        for (
          let cycle = Math.max(0, Math.floor((from - t.start) / t.length));
          t.start + cycle * t.length < until;
          cycle++
        ) {
          for (const e of t.events) {
            const at = t.start + cycle * t.length + e.at;
            if (at >= from && at < until) this.sink.send(t.id, e.data, at);
          }
        }
      }
      t.cursor = Math.max(t.cursor, until);
    }
  }
  private commitOverdub(t: Track, end: number): void {
    const rest = t.take.filter((e) => e.at >= t.length).map((e) => ({ ...e, at: e.at - t.length }));
    if (t.take.some((e) => e.at < t.length)) {
      const before = this.noteState(t, t.length);
      this.addTake(t, this.closeTake(t, t.length, true));
      // Newly periodic notes were only heard on the LIVE channel this cycle.
      // Transfer them once; never reset/re-articulate unchanged loop voices.
      const after = this.noteState(t, 0);
      if (!t.muted) {
        for (const [key, data] of after.controls)
          if (JSON.stringify(before.controls.get(key)) !== JSON.stringify(data))
            this.sink.send(t.id, data, end);
        for (const [note, data] of after.notes)
          if (!before.notes.has(note)) this.sink.send(t.id, data, end);
      }
      // These events were inserted behind the playback cursor: close the LIVE
      // part now rather than waiting a full loop for synthetic seam releases.
      this.sink.closeLiveTake?.(t.id, end);
      this.heldInput[t.id].clear();
    }
    t.take = rest;
    t.takeStart = end;
  }
  private addTake(t: Track, take: MidiEvent[]): void {
    t.layers ??= [t.events];
    t.layers.push(take);
    Object.assign(t, compileLoop(t.layers));
  }
  invalidate(now: number): void {
    this.sink.reset(now);
    for (const t of this.tracks) this.chaseTrack(t, now);
  }
  invalidateTrack(id: number, now: number): void {
    this.resetTrack(id, now);
    this.chaseTrack(this.tracks[id], now);
  }
  private resetTrack(id: number, now: number): void {
    if (this.sink.resetTrack) this.sink.resetTrack(id, now);
    else {
      this.sink.send(id, [0xb0, 64, 0], now);
      this.sink.send(id, [0xb0, 120, 0], now);
    }
  }
  private chaseTrack(t: Track, now: number): void {
    t.cursor = now;
    if (!t.length || t.muted) return;
    const phase = (((now - t.start) % t.length) + t.length) % t.length;
    const { notes, controls } = this.noteState(t, phase);
    for (const data of controls.values()) this.sink.send(t.id, data, now);
    for (const data of notes.values()) this.sink.send(t.id, data, now);
  }
  private noteState(
    t: Track,
    phase: number,
  ): { notes: Map<number, number[]>; controls: Map<string, number[]> } {
    const notes = new Map<number, number[]>();
    const controls = new Map<string, number[]>();
    for (const e of [...(t.carry ?? []).map((data) => ({ at: -1, data })), ...t.events]) {
      if (e.at >= phase) break;
      const op = e.data[0] & 0xf0;
      if (op === 0x90 && e.data[2]) notes.set(e.data[1], e.data);
      else if (op === 0x80 || op === 0x90) notes.delete(e.data[1]);
      else controls.set(`${op}:${op === 0xb0 ? e.data[1] : 0}`, e.data);
    }
    return { notes, controls };
  }
  mute(id: number, now: number): void {
    const t = this.tracks[id];
    if (t.unmuteAt !== undefined) {
      t.unmuteAt = undefined;
      return;
    }
    if (t.muted && t.length && this.unmuteMode === 'cycle') {
      const at = nextBoundary(now, t.start, t.length);
      if (at > now + EPS) {
        t.unmuteAt = at;
        return;
      }
    }
    t.muted = !t.muted;
    this.invalidateTrack(id, now);
  }
  clear(id: number, now: number): void {
    if (this.sink.deleteTrack) this.sink.deleteTrack(id, now);
    else this.resetTrack(id, now);
    this.heldInput[id].clear();
    const t = this.tracks[id];
    Object.assign(t, {
      state: 'empty',
      pending: undefined,
      unmuteAt: undefined,
      start: 0,
      length: 0,
      events: [],
      layers: undefined,
      carry: undefined,
      take: [],
      takeStart: 0,
      cursor: now,
      plannedLength: undefined,
      autoEnd: undefined,
      autoAction: undefined,
      barDuration: undefined,
      releaseTail: undefined,
    });
    this.resetIfEmpty();
  }
  private resetIfEmpty(): void {
    if (!this.busy) {
      this.reference = 0;
      this.origin = null;
    }
  }
  phase(t: Track, now: number, common = false): number {
    const length = common ? this.grid : t.length;
    return length
      ? ((((now - (common ? (this.origin ?? now) : t.start)) % length) + length) % length) / length
      : 0;
  }
}
