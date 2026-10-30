import type { MidiEvent } from './loop-engine';

export const PEDAL_CONTROLLERS = [64, 66, 67, 69];

// Compile independent takes to one MIDI part. Retrigger a repeated pitch, but
// release it only when its last overlapping owner releases it. Pedals are
// combined per take, not allowed to switch another take's pedal off.
export function mergeTakes(takes: MidiEvent[][]): MidiEvent[] {
  const events = takes
    .flatMap((take, layer) => take.map((e) => ({ ...e, layer })))
    .sort((a, b) => a.at - b.at);
  const notes = new Map<number, number>();
  const owners = new Map<string, number>();
  const pedals = new Map<number, Map<number, number>>();
  const result: MidiEvent[] = [];
  for (const e of events) {
    const data = [...e.data],
      op = data[0] & 0xf0,
      note = data[1];
    const count = notes.get(note) ?? 0;
    const owner = `${e.layer}:${data[0] & 15}:${note}`,
      owned = owners.get(owner) ?? 0;
    if (op === 0x90 && data[2]) {
      if (count) result.push({ at: e.at, data: [0x80, note, 0] });
      notes.set(note, count + 1);
      owners.set(owner, owned + 1);
    } else if (op === 0x80 || op === 0x90) {
      if (!owned) continue; // orphan releases must not stop a different source
      owners.set(owner, owned - 1);
      notes.set(note, count - 1);
      if (count > 1) continue;
    } else if (op === 0xb0 && PEDAL_CONTROLLERS.includes(note)) {
      const states = pedals.get(note) ?? new Map<number, number>();
      states.set(e.layer * 16 + (data[0] & 15), data[2]);
      pedals.set(note, states);
      data[2] = Math.max(0, ...states.values());
    }
    result.push({ at: e.at, data });
  }
  return result;
}
