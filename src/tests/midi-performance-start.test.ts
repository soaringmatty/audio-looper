// @vitest-environment happy-dom
import '@angular/compiler';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { LoopEngine } from '../app/features/midi/loop-engine';
import { MidiRouter } from '../app/features/midi/midi-router';
import { MidiLooper } from '../app/features/midi/midi-looper';
import { Metronome } from '../app/features/midi/metronome';
import { readWorkspacePreferences } from '../app/shared/workspace-preferences';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { join } from 'node:path';

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
  vi.spyOn(MidiRouter.prototype, 'prepareAudio').mockResolvedValue(undefined);
  vi.spyOn(MidiRouter.prototype, 'connect').mockResolvedValue(undefined);
});
afterEach(() => {
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('prepares record/overdub and queued unmute before the boundary without early capture or foreign resets', () => {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const queue: { data: number[]; at: number; submitted: number }[] = [];
  const port = {
    id: 'clp',
    name: 'Clavinova',
    state: 'connected',
    open: async () => port,
    close: async () => port,
    send: vi.fn((data: number[], at = now) => queue.push({ data: [...data], at, submitted: now })),
    clear: vi.fn(() => {
      queue.length = 0;
    }),
  };
  const midi = new MidiRouter();
  const engine = (midi.engine = new LoopEngine(midi));
  midi.outputId = 'clp';
  midi.output = port;
  midi.outputProfile = 'clp625';
  engine.useMetronome(0);
  engine.press(0, 0);
  engine.input([0x90, 60, 100], 0);
  engine.input([0x80, 60, 0], 8);
  now = 1000;
  engine.press(0, now);
  expect(engine.tracks[0].pending?.at).toBe(2000);
  now = 1980;
  engine.tick(now);
  expect(engine.tracks[0].state).toBe('recording');
  const attack = queue.find((e) => e.data[0] === 0x90 && e.data[1] === 60);
  expect(attack).toMatchObject({ at: 2000, submitted: 1980 });
  expect(queue.find((e) => e.data[0] === 0x80 && e.data[1] === 60)).toMatchObject({
    at: 2008,
    submitted: 1980,
  });
  // A final release must update the prepared seam, not truncate recording early.
  now = 1985;
  engine.input([0x90, 72, 80], now);
  now = 1990;
  engine.input([0x80, 72, 0], now);
  expect(engine.tracks[0].take.some((e) => e.at === 1990)).toBe(true);
  const clearCount = port.clear.mock.calls.length;
  now = 2006;
  engine.tick(now);
  expect(engine.tracks[0].state).toBe('overdub');
  expect(engine.tracks[0].events.some((e) => e.at === 1990)).toBe(true);
  expect(port.clear).toHaveBeenCalledTimes(clearCount);
  expect(queue.filter((e) => e.data[0] === 0x90 && e.data[1] === 60 && e.at === 2000)).toHaveLength(
    1,
  );
  // New notes in an overdub also get their first replay scheduled ahead.
  now = 2010;
  engine.input([0x90, 65, 90], now);
  now = 2018;
  engine.input([0x80, 65, 0], now);
  now = 3985;
  engine.tick(now);
  expect(
    queue.some(
      (e) => e.data[0] === 0x90 && e.data[1] === 65 && e.at === 4010 && e.submitted < 4000,
    ),
  ).toBe(true);
  now = 4006;
  engine.tick(now);
  // Mute, then preview unmute. No redundant program changes at re-entry.
  now = 4100;
  engine.mute(0, now);
  now = 4200;
  engine.mute(0, now);
  const programs = port.send.mock.calls.filter(([d]) => (d[0] & 0xf0) === 0xc0).length;
  now = 5980;
  midi.send(1, [0x90, 67, 100], 6010);
  midi.send(1, [0x80, 67, 0], 6020);
  engine.tick(now);
  expect(engine.tracks[0].muted).toBe(true);
  expect(
    queue.some(
      (e) => e.data[0] === 0x90 && e.data[1] === 60 && e.at === 6000 && e.submitted < 6000,
    ),
  ).toBe(true);
  const foreign = queue.filter((e) => (e.data[0] & 15) === 1);
  // Cancel a prepared unmute; only target output is removed.
  now = 5985;
  engine.mute(0, now);
  expect(queue.filter((e) => (e.data[0] & 15) === 1).map(({ data, at }) => ({ data, at }))).toEqual(
    foreign.map(({ data, at }) => ({ data, at })),
  );
  expect(queue.some((e) => e.data[0] === 0x90 && e.at >= 6000)).toBe(false);
  expect(engine.tracks[0].unmuteAt).toBeUndefined();
  expect(port.send.mock.calls.filter(([d]) => (d[0] & 0xf0) === 0xc0)).toHaveLength(programs);
  now = 5990;
  engine.mute(0, now);
  engine.tick(now);
  const clears = port.clear.mock.calls.length;
  now = 6006;
  engine.tick(now);
  expect(engine.tracks[0].muted).toBe(false);
  expect(port.clear).toHaveBeenCalledTimes(clears);
  expect(queue.filter((e) => e.data[0] === 0x90 && e.data[1] === 60 && e.at === 6000)).toHaveLength(
    1,
  );
  // Browser adapter: exact transport-time cancellation despite audio-clock jitter.
  const source = readFileSync(join(process.cwd(), 'public/audio/looper-processor.js'), 'utf8');
  const received: any[] = [];
  class Base {
    port: any = {
      onmessage: (event: any) => received.push(event.data),
      addEventListener: (_type: string, listener: any) => {
        this.port.capture = listener;
      },
      start() {},
      postMessage() {},
    };
    process() {
      return true;
    }
  }
  const context: any = { Base, currentTime: 1 };
  runInNewContext(
    source
      .slice(
        source.indexOf('class LooperProcessor extends'),
        source.lastIndexOf('registerProcessor('),
      )
      .replace(/extends \w+ \{/, 'extends Base {') + ';this.Processor=LooperProcessor;',
    context,
  );
  const processor = new context.Processor({});
  const dispatch = (data: any) => processor.port.capture({ data, stopImmediatePropagation() {} });
  dispatch({ type: 'looperMidi', data: [0x90, 60, 100], at: 2000, time: 1.99 });
  dispatch({ type: 'looperMidi', data: [0x91, 67, 100], at: 2000, time: 1.99 });
  dispatch({ type: 'looperMidi', data: [0x80, 62, 0], at: 1999, time: 2.01 });
  dispatch({ type: 'looperCancelFrom', channel: 0, at: 2000, time: 2 });
  context.currentTime = 2.02;
  processor.process();
  expect(received.map((m) => m.data.messageData)).toEqual([
    [0x91, 67, 100],
    [0x80, 62, 0],
  ]);
});

it('routes an isolated accented MIDI click with zero laptop correction, preserved calibration and clean switches', async () => {
  let now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const fixture = TestBed.createComponent(MidiLooper);
  await fixture.whenStable();
  const vm = fixture.componentInstance.workspace;
  const queue: { data: number[]; at: number }[] = [];
  const port = {
    id: 'clp',
    name: 'Clavinova',
    state: 'connected',
    open: async () => port,
    close: async () => port,
    send: vi.fn((data: number[], at = now) => queue.push({ data: [...data], at })),
    clear: vi.fn(() => {
      queue.length = 0;
    }),
  };
  vm.midi.inputId = 'clp';
  vm.midi.outputId = 'clp';
  vm.midi.output = port;
  vm.midi.outputProfile = 'clp625';
  localStorage.setItem(
    'midi-metronome-calibration-v1:clp|clp',
    JSON.stringify({ advanceMs: 150, spreadMs: 2, savedAt: new Date().toISOString() }),
  );
  vm.midi.onChange();
  expect(vm.metro.advanceMs).toBe(150);
  const laptopCalibration = localStorage.getItem('midi-metronome-calibration-v1:clp|clp');
  const oscillator = vi.fn();
  vm.metro.context = { currentTime: 1, createOscillator: oscillator } as unknown as AudioContext;
  vm.openSettings('midi');
  vm.refresh();
  await fixture.whenStable();
  const select: HTMLSelectElement = fixture.nativeElement.querySelector('#metronome-output-midi');
  select.value = 'midi';
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await fixture.whenStable();
  expect(vm.metro.outputMode).toBe('midi');
  expect(vm.metro.advanceMs).toBe(0);
  expect(readWorkspacePreferences('midi').metronomeOutput).toBe('midi');
  const tracks = JSON.stringify(vm.engine.tracks);
  await vm.toggleMetro();
  expect(vm.metro.origin).toBe(1030);
  now = 1490;
  vm.metro.tick(now);
  now = 2490;
  vm.metro.tick(now);
  const attacks = queue.filter((e) => e.data[0] === 0x9a);
  expect(attacks[0]).toMatchObject({ data: [0x9a, 96, 105], at: 1030 });
  expect(attacks[1]).toMatchObject({ data: [0x9a, 84, 78], at: 1530 });
  expect(queue.every((e) => (e.data[0] & 15) === 10)).toBe(true);
  expect(queue.filter((e) => e.data[0] === 0xca)).toHaveLength(1);
  expect(queue.find((e) => e.data[0] === 0xca)!.at).toBeLessThan(attacks[0].at);
  expect(oscillator).not.toHaveBeenCalled();
  expect(JSON.stringify(vm.engine.tracks)).toBe(tracks);
  expect(localStorage.getItem('midi-metronome-calibration-v1:clp|clp')).toBe(laptopCalibration);
  await vm.startTiming();
  for (let i = 6; i < 12; i++) vm.midi.onNoteInput(1030 + i * 500 + 10);
  expect(vm.timing.calibration).toBeUndefined();
  vm.setMetronomeOutput('laptop');
  expect(vm.metro.advanceMs).toBe(150);
  expect(vm.timing.calibration?.advanceMs).toBe(150);
  expect(queue.some((e) => e.data[0] === 0x9a && e.at > now)).toBe(false);
  vm.setMetronomeOutput('midi');
  vm.midi.outputId = 'browser';
  vm.midi.onChange();
  expect(vm.metro.enabled).toBe(false);
  expect(vm.warning).toContain('MIDI-Klick beendet');
  vm.metro.context = undefined;
  fixture.destroy();
  const restored = new Metronome();
  restored.outputMode = readWorkspacePreferences('midi').metronomeOutput!;
  expect(restored.outputMode).toBe('midi');
  expect(restored.enabled).toBe(false);
});

it('shows one bar while recording is queued against a four-bar reference, ending at twelve o’clock', async () => {
  const fixture = TestBed.createComponent(MidiLooper);
  await fixture.whenStable();
  const vm = fixture.componentInstance.workspace;
  vm.midi.outputId = 'external';
  vm.engine.useMetronome(0);
  vm.engine.reference = 8000;
  Object.assign(vm.engine.tracks[0], { state: 'playing', start: 0, length: 8000 });
  const track = vm.engine.tracks[1];
  for (const bar of [0, 1, 2]) {
    const at = bar * 2000 + 1000;
    vm.engine.press(1, at);
    expect(track.pending?.at).toBe((bar + 1) * 2000);
    vm.clock = at;
    expect(vm.progress(track)).toBe(50);
    vm.clock = (bar + 1) * 2000 - 1;
    expect(vm.progress(track)).toBeCloseTo(99.95);
    vm.clock += 1;
    expect(vm.progress(track)).toBe(0);
    vm.engine.press(1, at + 1); // Cancel before the actual boundary.
  }
  vm.engine.press(1, 7000);
  vm.engine.tick(8000, 8000);
  expect(track.state).toBe('recording');
  expect(track.start).toBe(8000);
  expect(vm.engine.tracks[0].length).toBe(8000);
  expect(fixture.nativeElement.querySelectorAll('article.track')).toHaveLength(5);
  fixture.destroy();
});
