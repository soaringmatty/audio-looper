// @vitest-environment happy-dom
import '@angular/compiler';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { MidiWorkspace } from '../app/features/midi/midi-workspace';
import { MidiRouter } from '../app/features/midi/midi-router';
import { LoopEngine } from '../app/features/midi/loop-engine';
import { exportMidiProject, restoreMidiProject } from '../app/features/midi/midi-project';

let vm: MidiWorkspace;
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'Worker',
    class {
      onmessage: unknown;
      terminate() {}
    },
  );
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(MidiRouter.prototype, 'prepareAudio').mockResolvedValue();
  vi.spyOn(MidiRouter.prototype, 'connect').mockResolvedValue();
  vi.spyOn(performance, 'now').mockReturnValue(10000);
  vm = new MidiWorkspace();
  vm.midi.outputId = '';
});
afterEach(() => {
  vm.ngOnDestroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('Stop preserves loops/settings/current captures, cancels queues, pauses and uses exactly the import anchor/fallback', () => {
  vm.engine.origin = 0;
  vm.engine.reference = 4000;
  vm.engine.selected = 1;
  const notes = [
    { at: 0, data: [0x90, 60, 90] },
    { at: 100, data: [0x80, 60, 0] },
  ];
  Object.assign(vm.engine.tracks[0], {
    state: 'playing',
    start: 750,
    length: 4000,
    layers: [notes],
    events: notes,
    volume: 81,
    fixedBars: 4,
    pianoStart: 59,
  });
  Object.assign(vm.engine.tracks[1], {
    state: 'playing',
    start: 250,
    length: 1000,
    layers: [notes],
    events: notes,
    muted: true,
    unmuteAt: 20000,
    pending: { at: 20000, action: 'dub' },
  });
  const expected = new LoopEngine({ send: vi.fn(), reset: vi.fn() });
  restoreMidiProject(expected, exportMidiProject(vm.engine, 'generaluser'), 10000);
  vm.stopTransport();
  expect(vm.engine.paused).toBe(true);
  expect(vm.metro.paused).toBe(true);
  expect(vm.engine.selected).toBe(1);
  expect(vm.engine.tracks[0]).toMatchObject({
    length: 4000,
    volume: 81,
    fixedBars: 4,
    pianoStart: 59,
    events: notes,
  });
  expect(vm.engine.tracks[1]).toMatchObject({
    muted: true,
    pending: undefined,
    unmuteAt: undefined,
  });
  expect(vm.engine.tracks.slice(0, 2).map((t) => vm.engine.phase(t, 10000))).toEqual(
    expected.tracks.slice(0, 2).map((t) => expected.phase(t, 10000)),
  );
  expect(vm.engine.phase(vm.engine.tracks[0], 10000)).toBe(0);
  expect(vm.engine.phase(vm.engine.tracks[1], 10000)).toBe(0.5);
  const snapshot = JSON.stringify(vm.engine.tracks);
  vm.stopTransport();
  expect(JSON.stringify(vm.engine.tracks)).toBe(snapshot);
  // An active partial overdub must not disappear as it does in a read-only export.
  vm.engine.resume(11000);
  Object.assign(vm.engine.tracks[0], {
    state: 'overdub',
    takeStart: 9500,
    take: [{ at: 10, data: [0x90, 72, 100] }],
  });
  vm.engine.finishCaptures(11500);
  expect(vm.engine.tracks[0].layers!.flat().some((e) => e.data[1] === 72)).toBe(true);
  expect(vm.engine.tracks[0].take).toEqual([]);
  // A free first take is completed, not thrown away, and gets tempo suggestions.
  vm.engine = new LoopEngine({ send: vi.fn(), reset: vi.fn() });
  const onFirst = vi.fn();
  vm.engine.onFirstFreeLoop = onFirst;
  Object.assign(vm.engine.tracks[0], {
    state: 'recording',
    start: 8000,
    takeStart: 8000,
    take: notes,
  });
  vm.stopTransport();
  expect(vm.engine.tracks[0]).toMatchObject({ state: 'playing', length: 2000 });
  expect(onFirst).toHaveBeenCalledOnce();
  expect(vm.engine.paused).toBe(true);
});

it('tempo proposals replace controls until chosen; removed custom choice is ignored and loop timing is preserved', async () => {
  vm.engine.origin = 0;
  vm.engine.reference = 4000;
  Object.assign(vm.engine.tracks[0], { state: 'playing', start: 0, length: 4000 });
  vm.tempoCandidates = [
    { bpm: 120, beats: 4, denominator: 4, bars: 2, score: 0, evidence: 'Nur Loop-Länge' },
  ];
  expect(vm.showTempoChoice).toBe(true);
  vm.engine.pausedAt = 10000;
  const toggle = vi.spyOn(vm.metro, 'toggle').mockResolvedValue();
  await vm.toggleMetro();
  expect(toggle).not.toHaveBeenCalled();
  vm.applyTempoChoice(-2);
  expect(vm.tempoConfirmed).toBe(false);
  expect(vm.engine.mode).toBe('free');
  expect(vm.tempoIndex).toBe(-1);
  vm.applyTempoChoice(0);
  expect(vm.showTempoChoice).toBe(false);
  expect(vm.engine.bpm).toBe(120);
  expect(vm.signature).toBe('4/4');
  expect(vm.engine.tracks[0]).toMatchObject({ length: 4000, start: 0 });
  expect(vm.metro.enabled).toBe(false);
  vm.tempoOpen = true;
  expect(vm.showTempoChoice).toBe(true);
  vm.applyTempoChoice(0);
  expect(vm.showTempoChoice).toBe(false);
  expect(vm.displayBpm).toBe(120);
  expect(vm.signature).toBe('4/4');
});
