// @vitest-environment happy-dom
import '@angular/compiler';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { MidiLooper } from '../app/features/midi/midi-looper';
import { AudioLooper } from '../app/features/audio/audio-looper';
import { MidiRouter } from '../app/features/midi/midi-router';
import { AudioSession } from '../app/features/audio/audio-session';
import { LoopEngine } from '../app/features/midi/loop-engine';
import { Metronome } from '../app/features/midi/metronome';
import { shortcut } from '../app/shared/shortcuts';
import { PCMEngine } from '../../public/audio/pcm-engine.js';

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'confirm',
    vi.fn(() => false),
  );
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
  vi.spyOn(MidiRouter.prototype, 'prepareAudio').mockResolvedValue(undefined);
  vi.spyOn(MidiRouter.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(AudioSession.prototype, 'refreshDevices').mockResolvedValue(undefined);
});
afterEach(() => {
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('reset dialog keeps MIDI/audio running until confirmation, cancels safely and resets only global volumes', async () => {
  const midi = TestBed.createComponent(MidiLooper);
  await midi.whenStable();
  const vm = midi.componentInstance.workspace;
  const sent = vi.spyOn(vm.midi, 'send').mockImplementation(() => {});
  vi.spyOn(vm.midi, 'configure').mockImplementation(() => {});
  vi.spyOn(vm.midi, 'deleteTrack').mockImplementation(() => {});
  Object.assign(vm.engine.tracks[0], {
    state: 'playing',
    length: 2000,
    volume: 31,
    events: [
      { at: 100, data: [0x90, 60, 100] },
      { at: 150, data: [0x80, 60, 0] },
    ],
  });
  vm.engine.tracks[1].volume = 42;
  const confirm = vi.spyOn(window, 'confirm');
  vm.resetAllTracks();
  await midi.whenStable();
  expect(midi.nativeElement.querySelector('dialog').open).toBe(true);
  vm.engine.tick(90, 160);
  expect(sent).toHaveBeenCalledWith(0, [0x90, 60, 100], 100);
  expect(vm.engine.tracks[0].state).toBe('playing');
  midi.nativeElement.querySelector('dialog button').click();
  await midi.whenStable();
  expect(vm.resetOpen).toBe(false);
  expect(vm.engine.tracks[0].volume).toBe(31);
  vm.clear(0);
  expect(vm.engine.tracks[0].volume).toBe(31);
  vm.resetAllTracks();
  await midi.whenStable();
  midi.nativeElement.querySelector('dialog .danger').click();
  await midi.whenStable();
  expect(vm.engine.tracks.every((t) => t.volume === 100 && t.state === 'empty')).toBe(true);
  expect(confirm).not.toHaveBeenCalled();
  midi.destroy();

  const audio = TestBed.createComponent(AudioLooper);
  await audio.whenStable();
  const av = audio.componentInstance.workspace;
  const pcm = new PCMEngine(1000);
  const t: any = pcm.tracks[0];
  Object.assign(t, { state: 'playing', length: 2000, volume: 0.2 });
  av.audio.state = pcm.snapshot();
  // A mock worklet still processes the real PCM commands; no microphone is used.
  av.audio.node = {} as AudioWorkletNode;
  vi.spyOn(av.audio, 'send').mockImplementation(async (command) => {
    pcm.command(command as any);
    av.audio.state = pcm.snapshot();
  });
  av.resetAllTracks();
  await audio.whenStable();
  expect(av.s.tracks[0].state).toBe('playing');
  audio.nativeElement.querySelector('dialog button').click();
  await audio.whenStable();
  await av.command('clear', 0);
  expect(av.s.tracks[0].volume).toBe(0.2);
  av.resetAllTracks();
  await av.confirmResetAllTracks();
  expect(av.s.tracks.every((track) => track.volume === 0.8 && track.state === 'empty')).toBe(true);
  av.audio.node = undefined;
  audio.destroy();
});

it('Shift+1–5 toggles another track without selecting/releasing the live track, with modal/edit/repeat guards', async () => {
  const fixture = TestBed.createComponent(MidiLooper);
  await fixture.whenStable();
  const vm = fixture.componentInstance.workspace;
  vm.select(2);
  const release = vi.spyOn(vm, 'release');
  const event = () =>
    new KeyboardEvent('keydown', { key: '!', code: 'Digit1', shiftKey: true, bubbles: true });
  document.body.dispatchEvent(event());
  expect(vm.engine.selected).toBe(2);
  expect(vm.engine.tracks[0].muted).toBe(true);
  document.body.dispatchEvent(event());
  expect(vm.engine.tracks[0].muted).toBe(false);
  expect(release).not.toHaveBeenCalled();
  expect(shortcut(event(), true, false)).toBeNull();
  expect(
    shortcut(
      new KeyboardEvent('keydown', { code: 'Digit1', shiftKey: true, repeat: true }),
      false,
      false,
    ),
  ).toBeNull();
  vm.resetAllTracks();
  document.body.dispatchEvent(event());
  expect(vm.engine.tracks[0].muted).toBe(false);
  vm.resetOpen = false;
  vm.engine.tracks[0].state = 'playing';
  vm.engine.tracks[0].length = 2000;
  vm.engine.tracks[0].muted = true;
  vi.spyOn(vm, 'now').mockReturnValue(500);
  document.body.dispatchEvent(event());
  expect(vm.engine.tracks[0].unmuteAt).toBe(2000);
  document.body.dispatchEvent(event());
  expect(vm.engine.tracks[0].unmuteAt).toBeUndefined();
  const root: HTMLElement = fixture.nativeElement;
  expect(root.querySelector('.metronome-controls [aria-label="Metronom-Ausgang"]')).not.toBeNull();
  expect(root.textContent).not.toContain('Kanal 11');
  fixture.destroy();
  const audio = TestBed.createComponent(AudioLooper);
  await audio.whenStable();
  await audio.componentInstance.workspace.select(2);
  document.body.dispatchEvent(event());
  expect(audio.componentInstance.workspace.selected).toBe(2);
  expect(audio.componentInstance.workspace.s.tracks[0].muted).toBe(true);
  audio.destroy();
});

it('live BPM preserves four/one-bar phase, queued events, held notes/pedals and click alignment without MIDI clear', async () => {
  const queue: { id: number; data: number[]; at: number }[] = [];
  const sink = {
    send: vi.fn((id: number, data: number[], at: number) => queue.push({ id, data, at })),
    reset: vi.fn(),
    cancelScheduled: vi.fn(),
  };
  const engine = new LoopEngine(sink);
  engine.mode = 'tempo';
  engine.origin = 0;
  engine.reference = 8000;
  for (const [id, length] of [
    [0, 8000],
    [1, 2000],
  ]) {
    const events = [
      { at: 0, data: [0x90, 60 + id, 90] },
      { at: 0, data: [0xb0, 64, 127] },
      { at: 1500, data: [0x80, 60 + id, 0] },
      { at: 1600, data: [0xb0, 64, 0] },
    ];
    Object.assign(engine.tracks[id], {
      state: 'playing',
      start: 0,
      length,
      cursor: 0,
      events,
      layers: [events],
      barDuration: 2000,
    });
  }
  const metro = new Metronome();
  metro.outputMode = 'midi';
  metro.enabled = true;
  metro.align(0, 0);
  const clicks: number[] = [];
  metro.onMidiBeat = (_, at) => clicks.push(at);
  for (let n = 0; n <= 990; n += 10) {
    engine.tick(n);
    metro.tick(n);
  }
  const phase = engine.tracks.map((t) => (t.length ? (1040 - t.start) / t.length : 0));
  const at = engine.setTempo(240, 1000, metro.cursor)!;
  metro.tick(1000, at);
  metro.setTempo(240, at);
  expect(at).toBe(1040);
  expect(engine.tracks[0].length).toBe(4000);
  expect(engine.tracks[1].length).toBe(1000);
  expect(engine.reference).toBe(4000);
  for (const id of [0, 1])
    expect((at - engine.tracks[id].start) / engine.tracks[id].length).toBeCloseTo(phase[id]);
  for (let n = 1040; n < 3100; n += 10) {
    engine.tick(n);
    metro.tick(n);
  }
  expect(queue.filter((e) => e.id === 0 && e.data[0] === 0x80)).toEqual([
    { id: 0, data: [0x80, 60, 0], at: 1270 },
  ]);
  expect(queue.filter((e) => e.id === 0 && e.data[1] === 64 && e.data[2] === 0)[0].at).toBe(1320);
  expect(queue.filter((e) => e.id === 1 && e.data[0] === 0x90).map((e) => e.at)).toEqual([
    0, 1520, 2520,
  ]);
  expect(clicks.slice(3, 6)).toEqual([1270, 1520, 1770]);
  expect(engine.tracks[0].layers![0][2].at).toBe(750);
  const back = engine.setTempo(120, 3100, metro.cursor)!;
  metro.tick(3100, back);
  metro.setTempo(120, back);
  expect(engine.tracks[0].length).toBe(8000);
  expect(engine.tracks[1].length).toBe(2000);
  expect(engine.tracks[0].layers![0][2].at).toBe(1500);
  expect(sink.reset).not.toHaveBeenCalled();
  expect(sink.cancelScheduled).not.toHaveBeenCalled();
  engine.tracks[1].state = 'overdub';
  expect(engine.setTempo(180, 3200)).toBeUndefined();
  engine.tracks[1].state = 'playing';
  engine.mode = 'free';
  expect(engine.setTempo(180, 3200)).toBeUndefined();
  expect(engine.setTempo(NaN, 3200)).toBeUndefined();

  const fixture = TestBed.createComponent(MidiLooper);
  await fixture.whenStable();
  const vm = fixture.componentInstance.workspace;
  Object.assign(vm.engine.tracks[0], { state: 'playing', length: 2000, events: [] });
  vm.engine.mode = 'tempo';
  vm.tempoCandidates = [
    { bpm: 120, beats: 4, denominator: 4, bars: 1, score: 1, evidence: 'Nur Loop-Länge' },
  ];
  vm.refresh();
  await fixture.whenStable();
  const input: HTMLInputElement = fixture.nativeElement.querySelector('[aria-label="Tempo"]');
  expect(input.disabled).toBe(false);
  input.value = '180';
  input.dispatchEvent(new Event('change', { bubbles: true }));
  expect(vm.engine.bpm).toBe(180);
  expect(vm.metro.bpm).toBe(180);
  expect(vm.tempoCandidates[0].bpm).toBe(180);
  vm.engine.tracks[0].state = 'overdub';
  vm.refresh();
  await fixture.whenStable();
  expect(input.disabled).toBe(true);
  fixture.destroy();
});
