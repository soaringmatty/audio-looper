// @vitest-environment happy-dom
import '@angular/compiler';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MidiWorkspace } from '../app/features/midi/midi-workspace';
import { MidiRouter } from '../app/features/midi/midi-router';
import { LoopEngine } from '../app/features/midi/loop-engine';
import { PianoController, FULL_PIANO } from '../app/features/midi/piano';
import { STANDARD_DRUM_KIT } from '../app/features/midi/programs';
import { PCMEngine } from '../../public/audio/pcm-engine.js';

let workspace: MidiWorkspace | undefined;
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'Worker',
    class {
      onmessage = null;
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
  // The tests never open real ports, an AudioContext or microphone.
  if (workspace) {
    workspace.midi.browser.context = undefined;
    (workspace.midi.browser as any).synth = undefined;
    workspace.ngOnDestroy();
  }
  workspace = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('track switch ends MIDI/PCM overdub immediately, cancels previews/arming and preserves phase, releases and first recordings', () => {
  const sink = { send: vi.fn(), reset: vi.fn(), resetTrack: vi.fn(), cancelScheduled: vi.fn() };
  const engine = new LoopEngine(sink);
  const t = engine.tracks[0];
  Object.assign(t, { state: 'overdub', length: 1000, pending: { at: 1000, action: 'play' } });
  engine.input([0x90, 60, 100], 100);
  engine.input([0xb0, 64, 127], 110);
  engine.tick(980, 1010); // A first-replay preview already exists in the queue.
  sink.send.mockClear();
  engine.select(1, 985); // Second half must still stop immediately.
  expect(t).toMatchObject({ state: 'playing', start: 0, length: 1000 });
  expect(t.pending).toBeUndefined();
  expect(sink.cancelScheduled).toHaveBeenCalledWith(0, 1000, 985);
  expect(sink.resetTrack).not.toHaveBeenCalled();
  expect(t.releaseTail).toBeDefined();
  engine.input([0x80, 60, 0], 990, 0);
  engine.input([0xb0, 64, 0], 991, 0);
  expect(t.releaseTail).toBeUndefined();
  engine.input([0x90, 65, 100], 992, 0);
  expect(t.take).toEqual([]);
  expect(t.events.some((event) => event.data[1] === 65)).toBe(false);
  engine.tick(1000, 1030);
  expect(t.state).toBe('playing');
  Object.assign(engine.tracks[1], {
    state: 'playing',
    length: 1000,
    pending: { at: 2000, action: 'dub' },
  });
  engine.select(2, 1100);
  expect(engine.tracks[1].pending).toBeUndefined();
  engine.tracks[2].state = 'recording';
  engine.select(3, 1200);
  expect(engine.tracks[2].state).toBe('recording');

  const pcm = new PCMEngine(1000);
  Object.assign(pcm.tracks[0], {
    state: 'overdub',
    start: 0,
    length: 1000,
    buffer: [new Float32Array(1000), new Float32Array(1000)],
    pending: { at: 1000, action: 'play' },
    capture: { start: 0, end: Infinity, compensation: 50, channels: 'mono' },
  });
  pcm.frame = 750;
  pcm.command({ type: 'config', selected: 1 });
  expect(pcm.tracks[0]).toMatchObject({
    state: 'playing',
    start: 0,
    length: 1000,
    pending: null,
    capture: { end: 750 },
  });
  Object.assign(pcm.tracks[1], { state: 'playing', pending: { at: 1000, action: 'dub' } });
  pcm.command({ type: 'config', selected: 2 });
  expect(pcm.tracks[1].pending).toBeNull();
  pcm.tracks[2].state = 'recording';
  pcm.command({ type: 'config', selected: 3 });
  expect(pcm.tracks[2].state).toBe('recording');
});

it('all browser tracks offer drums and mute only loops, preserving live notes/pedals, levels and PCM monitoring', async () => {
  const vm = (workspace = new MidiWorkspace());
  for (let id = 0; id < 5; id++)
    expect(
      vm
        .instrumentGroups(id)
        .flatMap((group) => group.programs)
        .some((p) => p.id === STANDARD_DRUM_KIT),
    ).toBe(true);
  const browser = vm.midi.browser;
  const channels = Array.from({ length: 10 }, () => ({ setDrums: vi.fn() }));
  const controllerChange = vi.fn();
  (browser as any).synth = { midiChannels: channels, programChange: vi.fn(), controllerChange };
  browser.context = { currentTime: 0, state: 'running' } as AudioContext;
  const post = vi.fn();
  (browser as any).port = { postMessage: post };
  browser.channels.forEach((c) => (c.loaded = true));
  for (const id of [0, 1]) {
    vm.engine.tracks[id].program = STANDARD_DRUM_KIT;
    vm.midi.configure(id, 0);
    expect(channels[id].setDrums).toHaveBeenLastCalledWith(true);
    expect(channels[id + 5].setDrums).toHaveBeenLastCalledWith(true);
  }
  const t = vm.engine.tracks[0];
  Object.assign(t, { state: 'playing', length: 1000, volume: 81 });
  vm.midi.receive([0x90, 36, 100], 100);
  vm.midi.receive([0xb0, 64, 127], 101);
  post.mockClear();
  vi.spyOn(vm, 'now').mockReturnValue(750);
  vm.mute(0);
  expect(
    post.mock.calls.some(([packet]) => packet.type === 'looperClearTrack' && packet.channel === 5),
  ).toBe(false);
  expect(post.mock.calls.some(([packet]) => packet.data?.[0] === 0x85)).toBe(false);
  expect(browser.channels[0]).toMatchObject({ volume: 0, liveVolume: 81 });
  vm.midi.receive([0x80, 36, 0], 760);
  vm.midi.receive([0xb0, 64, 0], 761);
  vm.midi.receive([0x90, 38, 100], 762);
  vm.midi.releaseInput(763);
  for (const data of [
    [0x85, 36, 0],
    [0xb5, 64, 0],
    [0x95, 38, 100],
    [0x85, 38, 0],
  ])
    expect(
      post.mock.calls.some(([packet]) => JSON.stringify(packet.data) === JSON.stringify(data)),
    ).toBe(true);
  // Reapplying an instrument/bank must not copy the muted loop level to live.
  await browser.loadProgram(0, 40);
  expect(controllerChange).toHaveBeenCalledWith(0, 7, 0);
  expect(controllerChange).toHaveBeenCalledWith(5, 7, 81);
  post.mockClear();
  vm.midi.monitor = false;
  vm.midi.receive([0x90, 40, 100], 770);
  expect(post).not.toHaveBeenCalled();

  const pcm = new PCMEngine(1000);
  pcm.command({ type: 'config', monitor: true, monitorVolume: 1, master: 1 });
  Object.assign(pcm.tracks[0], {
    state: 'playing',
    length: 100,
    muted: true,
    buffer: [new Float32Array(100).fill(0.25), new Float32Array(100).fill(0.25)],
  });
  const output = [new Float32Array(4), new Float32Array(4)];
  pcm.render([new Float32Array(4).fill(0.5), new Float32Array(4).fill(0.5)], output, 10);
  expect([...output[0]]).toEqual([0.5, 0.5, 0.5, 0.5]);
});

it('extended white-key mapping shifts diatonically, releases chords, respects controls and remembers/resets all track ranges', () => {
  const emit = vi.fn();
  const piano = new PianoController(emit);
  const whites = () => piano.keys.filter((key) => !key.black);
  expect(whites().map((key) => key.label)).toEqual([
    '<',
    'Y',
    'X',
    'C',
    'V',
    'B',
    'N',
    'M',
    ',',
    '.',
    '-',
  ]);
  expect(piano.rangeLabel).toBe('H3–E5');
  expect(piano.binding(60)).toBe('Y');
  piano.shiftWhite(3); // E4: no black key between the first two lower-row keys.
  expect(piano.keys.some((key) => key.code === 'KeyA')).toBe(false);
  expect(piano.keys.find((key) => key.code === 'KeyS')?.black).toBe(true);
  for (const key of piano.keys)
    expect(FULL_PIANO.find((note) => note.note === piano.note(key.offset))?.black).toBe(key.black);
  for (const key of whites().slice(0, 3)) piano.down(key.code, key.offset);
  expect(emit.mock.calls.map(([data]) => data[1])).toEqual([64, 65, 67]);
  piano.shift(1);
  expect(emit.mock.calls.slice(-3).map(([data]) => data)).toEqual([
    [0x80, 64, 0],
    [0x80, 65, 0],
    [0x80, 67, 0],
  ]);
  expect(piano.startNote).toBe(76);
  piano.shiftWhite(-100);
  expect(piano.startNote).toBe(21);
  piano.shiftWhite(100);
  expect(Math.max(...piano.keys.map((key) => piano.note(key.offset)))).toBe(108);

  const vm = (workspace = new MidiWorkspace());
  expect(vm.engine.tracks.map((t) => t.pianoStart)).toEqual([59, 59, 59, 59, 35]);
  vm.select(4);
  expect(vm.piano.binding(36)).toBe('Y');
  vm.select(0);
  const key = (code: string, target: HTMLElement = document.body, init: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent('keydown', { code, key: code, cancelable: true, ...init });
    target.dispatchEvent(e);
    vm.key(e);
    return e;
  };
  key('ArrowRight');
  expect(vm.piano.startNote).toBe(60);
  vm.select(1);
  key('ArrowUp');
  expect(vm.piano.startNote).toBe(71);
  vm.select(0);
  expect(vm.piano.startNote).toBe(60);
  const input = document.createElement('input');
  key('ArrowLeft', input);
  const combo = document.createElement('button');
  combo.setAttribute('role', 'combobox');
  key('ArrowLeft', combo);
  key('ArrowLeft', document.body, { ctrlKey: true });
  key('ArrowLeft', document.body, { repeat: true });
  expect(vm.piano.startNote).toBe(60);
  vm.clear(0);
  expect(vm.piano.startNote).toBe(60);
  vm.resetAllTracks();
  vm.resetOpen = false; // Cancel keeps the ranges.
  expect(vm.engine.tracks[1].pianoStart).toBe(71);
  vm.engine.tracks[1].program = STANDARD_DRUM_KIT;
  vm.resetAllTracks();
  vm.confirmResetAllTracks();
  expect(vm.engine.tracks.map((t) => t.pianoStart)).toEqual([59, 35, 59, 59, 35]);
  expect(vm.piano.startNote).toBe(59);
  expect(vm.piano.binding(60)).toBe('Y');
  vm.select(1);
  expect(vm.piano.binding(36)).toBe('Y');
});
