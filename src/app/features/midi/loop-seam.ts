import type { MidiEvent } from './loop-engine';
import { mergeTakes, PEDAL_CONTROLLERS } from './midi-events';

// Boundary releases are safety markers, not a played rest. Make only those
// voices periodic; explicit releases (including an intentional final rest) stay.
export function compileLoop(layers: MidiEvent[][]): { events: MidiEvent[]; carry: number[][] } {
  const periodic = layers.map((layer) => {
    const events = layer.map((e) => ({ ...e, data: [...e.data] }));
    const seeds: MidiEvent[] = [],
      remove = new Set<MidiEvent>(),
      insert: MidiEvent[] = [];
    const on = (e: MidiEvent) => (e.data[0] & 0xf0) === 0x90 && !!e.data[2];
    const off = (e: MidiEvent) =>
      (e.data[0] & 0xf0) === 0x80 || ((e.data[0] & 0xf0) === 0x90 && !e.data[2]);
    const firstAttack = events.find(on)?.at ?? 0;
    const firstRelease = events.find((e) => off(e) && !e.boundary)?.at ?? Infinity;
    const firstChordEnd = Math.min(firstRelease, firstAttack + 50);
    for (const e of events.filter((e) => e.boundary)) {
      const op = e.data[0] & 0xf0;
      if (off(e)) {
        const matches = (v: MidiEvent) =>
          on(v) && (v.data[0] & 15) === (e.data[0] & 15) && v.data[1] === e.data[1];
        const last = events.filter(matches).at(-1);
        if (!last) continue;
        seeds.push({ at: -1, data: [...last.data] });
        remove.add(e);
        const first = events.find((v) => matches(v) && v.at < firstChordEnd && !remove.has(v));
        if (first)
          remove.add(first); // same held pitch in first chord: tie, no retrigger
        else insert.push({ at: firstAttack, data: [...e.data] });
      } else if (op === 0xb0 && PEDAL_CONTROLLERS.includes(e.data[1])) {
        const last = events
          .filter((v) => !v.boundary && (v.data[0] & 0xff) === e.data[0] && v.data[1] === e.data[1])
          .at(-1);
        if (last) {
          seeds.push({ at: -1, data: [...last.data] });
          remove.add(e);
        }
      }
    }
    // At a chord change release the previous chord before its new attacks.
    return [...seeds, ...insert, ...events.filter((e) => !remove.has(e))].sort(
      (a, b) => a.at - b.at,
    );
  });
  const compiled = mergeTakes(periodic),
    notes = new Map<number, number[]>(),
    controls = new Map<string, number[]>();
  for (const e of compiled.filter((e) => e.at < 0)) {
    const op = e.data[0] & 0xf0;
    if (op === 0x90 && e.data[2]) notes.set(e.data[1], e.data);
    else if (op === 0x80 || op === 0x90) notes.delete(e.data[1]);
    else controls.set(`${op}:${e.data[1]}`, e.data);
  }
  return {
    events: compiled.filter((e) => e.at >= 0),
    carry: [...controls.values(), ...notes.values()],
  };
}
