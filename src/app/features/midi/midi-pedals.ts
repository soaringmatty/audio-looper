import type { MidiEvent, Track } from './loop-engine';
import { compileLoop } from './loop-seam';
import { PEDAL_CONTROLLERS } from './midi-events';

export const PEDALS = [
  { cc: 64, name: 'Sustain' },
  { cc: 66, name: 'Sostenuto' },
  { cc: 67, name: 'Soft' },
  { cc: 69, name: 'Hold 2' },
];
export interface RollPedal {
  id: string;
  cc: number;
  start: number;
  duration: number;
  value: number;
}
export interface PedalPaint {
  start: number;
  duration: number;
  value: number;
}
const matches = (e: MidiEvent, cc: number) => (e.data[0] & 0xf0) === 0xb0 && e.data[1] === cc;

/** One audible step curve per track, including the periodic state before zero. */
export function readRollPedals(t: Track): RollPedal[] {
  if (!t.length) return [];
  return PEDAL_CONTROLLERS.flatMap((cc) => {
    let value = t.carry?.find((data) => matches({ at: -1, data }, cc))?.[2] ?? 0;
    let start = 0;
    const steps: RollPedal[] = [];
    const append = (end: number) => {
      if (value > 0 && end > start)
        steps.push({ id: `${cc}:${start}`, cc, start, duration: end - start, value });
    };
    for (const e of t.events.filter((e) => matches(e, cc))) {
      if (e.data[2] === value) continue;
      append(e.at);
      start = e.at;
      value = e.data[2];
    }
    append(t.length);
    const first = steps[0],
      last = steps.at(-1);
    if (
      first &&
      last &&
      first !== last &&
      first.start === 0 &&
      last.start + last.duration === t.length &&
      first.value === last.value
    ) {
      last.duration += first.duration;
      steps.shift();
    }
    return steps;
  });
}

function windows(paints: PedalPaint[], length: number): PedalPaint[] {
  return paints.flatMap((p) => {
    const duration = Math.min(p.duration, length - p.start);
    return [
      { ...p, duration },
      ...(p.duration > duration ? [{ ...p, start: 0, duration: p.duration - duration }] : []),
    ];
  });
}

/** Paint every contributing owner, not a new layer that MAX could overrule.
 * Only this controller is rewritten; original owner states resume outside the
 * edited windows. Notes, other controllers and the note take identities stay.
 */
export function paintPedal(
  layers: MidiEvent[][],
  cc: number,
  paints: PedalPaint[],
  length: number,
): MidiEvent[][] {
  const spans = windows(paints, length);
  const result = layers.map((layer) => layer.map((e) => ({ ...e, data: [...e.data] })));
  if (!result.length) result.push([]);
  const owners = result.flatMap((layer, index) =>
    [...new Set(layer.filter((e) => matches(e, cc)).map((e) => e.data[0] & 15))].map((channel) => ({
      index,
      channel,
    })),
  );
  if (!owners.length) owners.push({ index: 0, channel: 0 });
  for (const { index, channel } of owners) {
    const owns = (e: MidiEvent) => matches(e, cc) && (e.data[0] & 15) === channel;
    const original = result[index].filter(owns);
    // Use the same boundary-to-seed rule as compileLoop, per source channel.
    const compiled = compileLoop([original]);
    const seed = compiled.carry.find((data) => data[1] === cc)?.[2] ?? 0;
    const events = compiled.events;
    const points = [
      ...new Set([
        ...spans.flatMap((s) => [s.start, s.start + s.duration]).filter((at) => at < length),
        ...(spans.some((s) => s.start + s.duration === length) ? [0] : []),
      ]),
    ].sort((a, b) => a - b);
    const state = (at: number) => {
      let value = seed;
      for (const e of events) {
        if (e.at > at) break;
        value = e.data[2];
      }
      return value;
    };
    const paintAt = (at: number) =>
      [...spans].reverse().find((s) => at >= s.start && at < s.start + s.duration);
    const initial = paintAt(0)?.value ?? seed;
    const data = (value: number) => [0xb0 | channel, cc, value];
    const replacement: MidiEvent[] = [{ at: -1, data: data(initial) }];
    for (const at of points) replacement.push({ at, data: data(paintAt(at)?.value ?? state(at)) });
    // Preserve original same-time ordering outside the edited windows. Boundary
    // safety markers must no longer regenerate an old, edited-away pedal seed.
    result[index] = [
      ...replacement,
      ...result[index].filter(
        (e) => !owns(e) || (e.at >= 0 && !e.boundary && !paintAt(e.at) && !points.includes(e.at)),
      ),
    ].sort((a, b) => a.at - b.at);
  }
  return result;
}
