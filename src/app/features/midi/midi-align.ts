import type { MidiEvent } from './loop-engine';
import type { RollNote } from './midi-editor';
import { PEDAL_CONTROLLERS } from './midi-events';

export interface AlignResult {
  notes: RollNote[];
  changed: number;
  unchanged: number;
  skipped: { id: string; reason: string }[];
}
const EPS = 0.001;

/** Explicit nearest-grid quantization, not musical-intent recognition. */
export function alignNotes(
  notes: RollNote[],
  length: number,
  step: number,
  ends: boolean,
  events: MidiEvent[],
  ids?: readonly string[],
): AlignResult {
  const scope = new Set(ids ?? notes.map((n) => n.id));
  const reasons = new Map<string, string>(),
    proposed = new Map<string, RollNote>(),
    rawStarts = new Map<string, number>();
  const pedals = events
    .filter((e) => (e.data[0] & 240) === 176 && PEDAL_CONTROLLERS.includes(e.data[1]))
    .flatMap((e) => [-length, 0, length].map((offset) => e.at + offset))
    .sort((a, b) => a - b);
  const crossesPedal = (a: number, b: number) => {
    if (Math.abs(a - b) < EPS) return false;
    let lo = 0,
      hi = pedals.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (pedals[mid] < Math.min(a, b) - EPS) lo = mid + 1;
      else hi = mid;
    }
    return lo < pedals.length && pedals[lo] <= Math.max(a, b) + EPS;
  };
  const nearest = (at: number) => Math.round(at / step) * step;
  const tied = (at: number) => Math.abs(at / step - Math.floor(at / step) - 0.5) < EPS / step;
  if (Number.isFinite(step) && step > 0 && length > 0)
    for (const n of notes) {
      if (!scope.has(n.id)) continue;
      if (n.continuous) {
        reasons.set(n.id, 'Durchgehende Haltenote');
        continue;
      }
      if (tied(n.start) || (ends && tied(n.start + n.duration))) {
        reasons.set(n.id, 'Genau zwischen zwei Rasterpunkten');
        continue;
      }
      const rawStart = nearest(n.start),
        start = Math.abs(rawStart - length) < EPS ? 0 : rawStart;
      const duration = ends ? nearest(n.start + n.duration) - rawStart : n.duration;
      if (start < 0 || start >= length || duration <= EPS || duration > length + EPS) {
        reasons.set(n.id, 'Loop-Grenze oder ungültige Notenlänge');
        continue;
      }
      if (
        crossesPedal(n.start, rawStart) ||
        crossesPedal(n.start + n.duration, rawStart + duration)
      ) {
        reasons.set(n.id, 'Pedalgrenze würde überschritten');
        continue;
      }
      if (Math.abs(n.start - start) < EPS && Math.abs(n.duration - duration) < EPS) continue;
      proposed.set(n.id, { ...n, start, duration: Math.min(length, duration), continuous: false });
      rawStarts.set(n.id, rawStart);
    }
  // Propagate same-pitch endpoint conflicts without a quadratic retry loop.
  type Point = { id: string; at: number; kind: 'on' | 'off'; offset: number };
  const pitches = new Map<number, Point[]>();
  for (const n of notes) {
    const list = pitches.get(n.pitch) ?? [];
    for (const offset of [-length, 0, length])
      list.push(
        { id: n.id, at: n.start + offset, kind: 'on', offset },
        { id: n.id, at: n.start + n.duration + offset, kind: 'off', offset },
      );
    pitches.set(n.pitch, list);
  }
  const edges: [Point, Point][] = [],
    touching = new Map<string, number[]>();
  for (const list of pitches.values()) {
    list.sort((a, b) => a.at - b.at || Number(a.kind === 'on') - Number(b.kind === 'on'));
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1],
        b = list[i];
      if (a.id === b.id) continue;
      const index = edges.push([a, b]) - 1;
      for (const id of [a.id, b.id]) {
        const linked = touching.get(id) ?? [];
        linked.push(index);
        touching.set(id, linked);
      }
    }
  }
  const position = (p: Point) => {
    const n = proposed.get(p.id);
    return n ? rawStarts.get(p.id)! + p.offset + (p.kind === 'off' ? n.duration : 0) : p.at;
  };
  const queue = edges.map((_, i) => i);
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const [a, b] = edges[queue[cursor]],
      x = position(a),
      y = position(b);
    const collision =
      x > y + EPS ||
      (a.kind === 'on' && b.kind === 'on' && Math.abs(a.at - b.at) > EPS && Math.abs(x - y) < EPS);
    if (!collision) continue;
    for (const id of [a.id, b.id])
      if (proposed.delete(id)) {
        reasons.set(id, 'Gleiche Tonhöhe: Notenkonflikt');
        queue.push(...(touching.get(id) ?? []));
      }
  }
  const count = notes.filter((n) => scope.has(n.id)).length;
  return {
    notes: notes.map((n) => proposed.get(n.id) ?? n),
    changed: proposed.size,
    unchanged: count - proposed.size,
    skipped: [...reasons].map(([id, reason]) => ({ id, reason })),
  };
}
