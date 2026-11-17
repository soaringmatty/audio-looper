// @vitest-environment happy-dom
import '@angular/compiler';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LoopEngine } from '../app/features/midi/loop-engine';
import {
  exportMidiProject,
  parseMidiProject,
  restoreMidiProject,
} from '../app/features/midi/midi-project';
import { MidiWorkspace } from '../app/features/midi/midi-workspace';
import { MidiRouter } from '../app/features/midi/midi-router';
import { Metronome } from '../app/features/midi/metronome';

let vm: MidiWorkspace | undefined;
const sink = () => ({ send: vi.fn(), reset: vi.fn(), resetTrack: vi.fn() });
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'Worker',
    class {
      onmessage: any;
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
});
afterEach(() => {
  vm?.ngOnDestroy();
  vm = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('exports completed MIDI layers during recording/overdub without mutations, roundtrips free/tempo phase, sustain, settings and rejects bad files atomically', async () => {
  const engine = new LoopEngine(sink());
  engine.origin = 100;
  engine.reference = 4000;
  Object.assign(engine.tracks[0], {
    state: 'overdub',
    length: 4000,
    start: 100,
    volume: 81,
    pianoStart: 60,
    fixedBars: 2,
    barDuration: 2000,
    layers: [
      [
        { at: 0, data: [0x90, 60, 90] },
        { at: 20, data: [0xb0, 64, 127] },
        { at: 500, data: [0x80, 60, 0] },
        { at: 900, data: [0xb0, 64, 0] },
      ],
    ],
    take: [{ at: 50, data: [0x90, 72, 110] }],
  });
  Object.assign(engine.tracks[1], {
    state: 'playing',
    length: 1000,
    start: 600,
    muted: true,
    layers: [
      [
        { at: 0, data: [0x90, 36, 100] },
        { at: 100, data: [0x80, 36, 0] },
      ],
    ],
    program: 128,
  });
  Object.assign(engine.tracks[2], { state: 'recording', take: [{ at: 0, data: [0x90, 64, 100] }] });
  for (const mode of ['free', 'tempo'] as const) {
    engine.mode = mode;
    const before = JSON.stringify(engine.tracks);
    const project = parseMidiProject(JSON.stringify(exportMidiProject(engine, 'fluidr3')));
    expect(JSON.stringify(engine.tracks)).toBe(before);
    expect(project.tracks[0].layers.flat().some((e) => e.data[1] === 72)).toBe(false);
    expect(project.tracks[2]).toMatchObject({ length: 0, layers: [] });
    const loaded = new LoopEngine(sink());
    restoreMidiProject(loaded, project, 10000);
    expect(loaded.paused).toBe(true);
    expect(loaded.tracks[0]).toMatchObject({
      volume: 81,
      pianoStart: 60,
      fixedBars: 2,
      barDuration: 2000,
    });
    expect(loaded.tracks[0].events).toEqual(project.tracks[0].layers[0]);
    expect(loaded.tracks[1]).toMatchObject({ muted: true, program: 128, length: 1000 });
    loaded.resume(20000);
    expect(loaded.phase(loaded.tracks[0], 20000)).toBe(0);
    expect(loaded.phase(loaded.tracks[1], 20000)).toBe(0.5);
    expect(loaded.mode).toBe(mode);
    const good = JSON.stringify(loaded.tracks);
    const corrupt = structuredClone(project);
    corrupt.tracks[0].layers[0][0].data = [0xf0, 1, 2];
    expect(() =>
      restoreMidiProject(loaded, parseMidiProject(JSON.stringify(corrupt)), 22000),
    ).toThrow();
    expect(JSON.stringify(loaded.tracks)).toBe(good);
    expect(() => parseMidiProject(JSON.stringify({ ...project, version: 2 }))).toThrow();
    expect(() => parseMidiProject('{')).toThrow();
  }
  vm = new MidiWorkspace();
  const before = JSON.stringify(vm.engine.tracks);
  const project = exportMidiProject(engine, 'generaluser');
  const fileEvent = (text: string, size = text.length) =>
    ({
      target: {
        files: [{ size, text: async () => text }],
        value: 'test.aloop',
      },
    }) as unknown as Event;
  await vm.importProject(fileEvent('{'));
  expect(vm.pendingProject).toBeNull();
  expect(JSON.stringify(vm.engine.tracks)).toBe(before);
  await vm.importProject(fileEvent(JSON.stringify(project)));
  expect(vm.pendingProject).not.toBeNull();
  expect(JSON.stringify(vm.engine.tracks)).toBe(before); // Confirmation is not destructive.
  vm.pendingProject = null; // Cancel leaves the original session untouched.
  await vm.importProject(fileEvent(JSON.stringify(project), 17 * 1024 * 1024));
  expect(vm.pendingProject).toBeNull();
  await vm.importProject(fileEvent(JSON.stringify(project)));
  await vm.confirmImportProject();
  expect(vm.pendingProject).toBeNull();
  expect(vm.engine.paused).toBe(true);
  expect(vm.engine.tracks[0]).toMatchObject({ state: 'playing', length: 4000, volume: 81 });
  expect(vm.metro.paused).toBe(true);

  const verifyStart = (lengths: number[], offsets: number[], phases: number[]) => {
    const saved = structuredClone(project);
    lengths.forEach((length, id) =>
      Object.assign(saved.tracks[id], { length, offset: offsets[id] }),
    );
    const loaded = new LoopEngine(sink());
    restoreMidiProject(loaded, parseMidiProject(JSON.stringify(saved)), 123456);
    loaded.resume(200000);
    phases.forEach((phase, id) =>
      expect(loaded.phase(loaded.tracks[id], 200000)).toBeCloseTo(phase, 8),
    );
  };
  // Shared zero need not be at the old project origin, nor at the longest
  // loop's first stored boundary. A genuine half-loop offset is preserved.
  verifyStart([4000, 1000], [1000, 0], [0, 0]);
  verifyStart([6000, 4000], [1000, 3000], [0, 0]);
  verifyStart([1000, 4000], [250, 750], [0.5, 0]);
  verifyStart([16000 / 3, 8000 / 3], [4000 / 3, 0], [0, 0.5]);
});

it('pause freezes loop phase, recording, pending actions and metronome; resume shifts clocks and chases held voices', async () => {
  const output = sink();
  const engine = new LoopEngine(output);
  engine.origin = 0;
  engine.reference = 1000;
  Object.assign(engine.tracks[0], {
    state: 'playing',
    start: 0,
    length: 1000,
    events: [
      { at: 0, data: [0x90, 60, 100] },
      { at: 900, data: [0x80, 60, 0] },
    ],
  });
  Object.assign(engine.tracks[1], {
    state: 'recording',
    start: 0,
    takeStart: 0,
    autoEnd: 2000,
    pending: { at: 2000, action: 'play' },
    take: [{ at: 20, data: [0x90, 64, 100] }],
  });
  engine.pause(500);
  const before = JSON.stringify(engine.tracks);
  output.send.mockClear();
  engine.tick(9000);
  engine.input([0x90, 67, 100], 9000);
  engine.press(2, 9000);
  expect(JSON.stringify(engine.tracks)).toBe(before);
  expect(engine.phase(engine.tracks[0], 9000)).toBe(0.5);
  expect(output.send).not.toHaveBeenCalled();
  engine.resume(10500);
  expect(engine.origin).toBe(10000);
  expect(engine.tracks[1]).toMatchObject({
    start: 10000,
    takeStart: 10000,
    autoEnd: 12000,
    pending: { at: 12000 },
  });
  expect(engine.phase(engine.tracks[0], 10500)).toBe(0.5);
  expect(output.send).toHaveBeenCalledWith(0, [0x90, 60, 100], 10500);
  engine.input([0x80, 64, 0], 10600, 1);
  expect(engine.tracks[1].take.at(-1)?.at).toBe(600);
  const metro = new Metronome();
  metro.outputMode = 'midi';
  metro.enabled = true;
  metro.origin = 0;
  metro.established = true;
  metro.onMidiBeat = vi.fn();
  metro.onMidiStop = vi.fn();
  metro.pause();
  metro.tick(9000);
  expect(metro.onMidiStop).toHaveBeenCalled();
  expect(metro.onMidiBeat).not.toHaveBeenCalled();
  metro.resume(10000, 10500);
  metro.tick(10500, 10530);
  expect(metro.origin).toBe(10000);
  expect(metro.onMidiBeat).toHaveBeenCalled();
  vm = new MidiWorkspace();
  vm.midi.outputId = 'external';
  vm.metro.outputMode = 'midi';
  await vm.togglePause();
  expect(vm.engine.paused).toBe(true);
  expect(vm.metro.paused).toBe(true);
  expect(vm.projectStatus).toBe('');
  await vm.togglePause();
  expect(vm.engine.paused).toBe(false);
  expect(vm.metro.paused).toBe(false);
});

it('all mute controls actual individual track mutes, allows selective unmute, preserves phase/live channels and exports those mutes', () => {
  vm = new MidiWorkspace();
  const t = vm.engine.tracks[0];
  vm.engine.reference = 1000;
  Object.assign(t, {
    state: 'playing',
    start: 0,
    length: 1000,
    volume: 81,
    events: [{ at: 100, data: [0x90, 60, 100] }],
  });
  vm.engine.tracks[1].muted = true;
  const deliver = vi.spyOn(vm.midi as any, 'deliver').mockImplementation(() => {});
  const now = vi.spyOn(vm, 'now').mockReturnValue(50);
  vm.toggleAllMuted();
  expect(vm.engine.allMuted).toBe(true);
  expect(vm.engine.tracks.every((t) => t.muted)).toBe(true);
  expect(exportMidiProject(vm.engine, 'generaluser').tracks.every((t) => t.muted)).toBe(true);
  expect(deliver).toHaveBeenCalledWith(0, [0xb0, 7, 0], 50, 0);
  expect(deliver).toHaveBeenCalledWith(0, [0xb0, 7, 81], 50, 5);
  vm.midi.receive([0x90, 67, 90], 70);
  expect(deliver).toHaveBeenCalledWith(0, [0x90, 67, 90], 70, 5);
  deliver.mockClear();
  vm.engine.tick(100, 140);
  expect(deliver).not.toHaveBeenCalled();
  now.mockReturnValue(150);
  vm.engine.unmuteMode = 'immediate';
  vm.mute(0);
  expect(vm.engine.allMuted).toBe(false);
  expect(vm.engine.tracks.map((t) => t.muted)).toEqual([false, true, true, true, true]);
  vm.engine.tracks[1].unmuteAt = 1000;
  vm.toggleAllMuted();
  expect(vm.engine.allMuted).toBe(true);
  expect(vm.engine.tracks[1].unmuteAt).toBeUndefined();
  vm.toggleAllMuted();
  expect(vm.engine.tracks.map((t) => t.muted)).toEqual([false, false, false, false, false]);
  expect(t.start).toBe(0);
  expect(deliver).toHaveBeenCalledWith(0, [0xb0, 7, 81], 150, 0);
  vm.engine.pause(200);
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => 'blob:test'), revokeObjectURL: vi.fn() });
  vm.exportProject();
  expect(click).toHaveBeenCalled();
  expect(vm.engine.paused).toBe(true);
});
