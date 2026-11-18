// @vitest-environment happy-dom
import '@angular/compiler';
import { afterEach, expect, it, vi } from 'vitest';
import { LoopEngine, Track } from '../app/features/midi/loop-engine';
import { MidiRouter } from '../app/features/midi/midi-router';
import { readRollPedals } from '../app/features/midi/midi-pedals';
import {
  exportMidiProject,
  parseMidiProject,
  restoreMidiProject,
} from '../app/features/midi/midi-project';

afterEach(() => vi.restoreAllMocks());

function fixture() {
  let now = 100;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const router = new MidiRouter();
  router.trace.setEnabled(false);
  const engine = (router.engine = new LoopEngine(router));
  router.monitor = false; // The Clavinova is heard locally, not through MIDI monitoring.
  router.outputId = 'clp';
  router.outputProfile = 'clp625';
  const port = {
    id: 'clp',
    state: 'connected',
    open: async () => port,
    close: async () => port,
    send: vi.fn(),
    clear: vi.fn(),
  };
  router.output = port;
  const at = (time: number, action: () => void) => {
    now = time;
    action();
  };
  const pedal = (time: number, value: number) => at(time, () => router.receive([176, 64, value]));
  engine.press(0, now);
  const track = engine.tracks[0];
  return { router, engine, track, at, pedal, port };
}

function valueAt(track: Track, phase: number): number {
  let value = track.carry?.find((d) => d[1] === 64)?.[2] ?? 0;
  for (const event of track.events)
    if (event.at <= phase && (event.data[0] & 240) === 176 && event.data[1] === 64)
      value = event.data[2];
  return value;
}

it('sustain cleanup preserves the original recording through overdub, Stop and aloop roundtrip', () => {
  const { router, engine, track, at, pedal, port } = fixture();
  pedal(110, 127);
  at(120, () => router.receive([144, 60, 100]));
  at(500, () => router.receive([128, 60, 0]));
  at(1100, () => engine.press(0, 1100));
  expect(track.state).toBe('overdub');
  expect(port.send).toHaveBeenCalled();
  expect(valueAt(track, 200)).toBe(127);
  expect(router.snapshot().livePedals).toHaveLength(1);
  const original = structuredClone(track.layers![0]);
  expect(track.take).toEqual([{ at: 0, data: [176, 64, 127] }]);
  const otherTracks = structuredClone(engine.tracks.slice(1));

  // The foot has NOT moved. This is the same cleanup used before Pause/Stop.
  at(1200, () => router.releaseInput(1200));
  at(1200, () => engine.finishCaptures(1200));
  expect(track.layers![0]).toEqual(original);
  expect(track.layers![0].filter((e) => e.data[1] === 64)).toEqual([
    { at: 10, data: [176, 64, 127] },
    { at: 999.99, data: [176, 64, 0] },
  ]);
  expect(valueAt(track, 200)).toBe(127);
  expect(valueAt(track, 900)).toBe(127);
  expect(valueAt(track, 999.995)).toBe(0);
  expect(readRollPedals(track).find((p) => p.cc === 64)?.duration).toBeGreaterThanOrEqual(989.99);
  expect(engine.tracks.slice(1)).toEqual(otherTracks);

  const saved = parseMidiProject(JSON.stringify(exportMidiProject(engine, 'generaluser')));
  const restored = new LoopEngine({ send() {}, reset() {} });
  restoreMidiProject(restored, saved, 2000);
  expect(readRollPedals(restored.tracks[0])).toEqual(readRollPedals(track));
});

it('sustain physical releases only enter the new take and never rewrite completed pedal cycles', () => {
  const { router, engine, track, at, pedal } = fixture();
  pedal(110, 100);
  pedal(500, 0);
  pedal(1000, 80);
  at(1100, () => engine.press(0, 1100));
  const original = structuredClone(track.layers![0]);
  expect(track.take).toEqual([{ at: 0, data: [176, 64, 80] }]);
  pedal(1210, 64); // Continuous pedal update in the new take.
  pedal(1220, 0);
  expect(track.layers).toEqual([original]); // No retroactive mutation or added wrap owner.
  expect(track.take.filter((e) => e.data[1] === 64).map((e) => e.data[2])).toEqual([80, 64, 0]);
  at(2100, () => engine.tick(2100, 2100));
  expect(track.layers![0]).toEqual(original);
  expect(valueAt(track, 5)).toBe(80); // Only the completed second take adds this head.
  expect(valueAt(track, 115)).toBe(100); // Earlier recorded gesture still wins.
  expect(valueAt(track, 200)).toBe(100);
  expect(valueAt(track, 500)).toBe(0);
  expect(valueAt(track, 950)).toBe(80);
  expect(valueAt(track, 999.995)).toBe(0);
  expect(track.layers!.every((layer) => layer.every((e) => !e.boundary))).toBe(true);

  // A pedal held for more than a full cycle must not collapse to a short head.
  pedal(2150, 127);
  at(3100, () => engine.tick(3100, 3100));
  const completed = structuredClone(track.layers);
  expect(track.take).toEqual([{ at: 0, data: [176, 64, 127] }]);
  at(4100, () => engine.tick(4100, 4100));
  const completedAgain = structuredClone(track.layers);
  pedal(4200, 0);
  expect(track.layers).toEqual(completedAgain);
  expect(track.layers!.slice(0, completed!.length)).toEqual(completed);
  expect(valueAt(track, 500)).toBe(127);
  expect(valueAt(track, 999.995)).toBe(0); // Still finite; no permanent carry owner.
  expect(router.snapshot().livePedals).toHaveLength(0);

  // Pure playback: later hardware input must not modify any stored pedal take.
  at(4250, () => engine.finishCaptures(4250));
  at(4300, () => engine.resume(4300));
  const playing = structuredClone(track.layers);
  pedal(4350, 127);
  pedal(4400, 0);
  expect(track.layers).toEqual(playing);
});
