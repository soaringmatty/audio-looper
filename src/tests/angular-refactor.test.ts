// @vitest-environment happy-dom
import '@angular/compiler';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ɵresolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MidiLooper } from '../app/features/midi/midi-looper';
import { AudioLooper } from '../app/features/audio/audio-looper';
import { MidiRouter } from '../app/features/midi/midi-router';
import { LoopEngine } from '../app/features/midi/loop-engine';
import { AudioSession } from '../app/features/audio/audio-session';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { MidiTrace } from '../app/features/midi/midi-trace';
import { MidiTiming } from '../app/features/midi/midi-timing';
import { BrowserSynth } from '../app/features/midi/synth';
import { Metronome } from '../app/features/midi/metronome';
import { audibleNow, outputDelayMs } from '../app/shared/audio-presentation';
import { PCMEngine } from '../../public/audio/pcm-engine.js';

const terminate = vi.fn();

it('measured click update adds only residual offsets, rejects unstable runs and restores per route', () => {
  const timing = new MidiTiming();
  timing.setRoute('clp|clp');
  const measure = (advance: number, offsets: number[]) => {
    timing.start(0, 500, 0, 0, advance);
    offsets.forEach((offset, i) => timing.input((i + 2) * 500 + offset));
  };
  measure(58, [79, 80, 80, 80, 80, 81]);
  expect(timing.calibration?.advanceMs).toBe(138);
  expect(timing.result?.metronomeAdvanceMs).toBe(58);
  measure(138, [-1, 0, 0, 0, 0, 1]);
  expect(timing.calibration?.advanceMs).toBe(138);
  measure(138, [-100, -80, -40, 40, 80, 100]);
  expect(timing.result!.spreadMs).toBeGreaterThan(25);
  expect(timing.calibration?.advanceMs).toBe(138);
  timing.start(0, 500, 0, 0, 138);
  timing.input(1080);
  timing.cancel();
  expect(timing.input(1580)).toBe(false);
  expect(timing.calibration?.advanceMs).toBe(138);
  timing.setRoute('clp|other');
  expect(timing.calibration).toBeUndefined();
  timing.setRoute('clp|clp');
  expect(timing.calibration?.advanceMs).toBe(138);
  const restored = new MidiTiming();
  restored.setRoute('clp|clp');
  expect(restored.calibration?.advanceMs).toBe(138);
  restored.resetCalibration();
  restored.setRoute('other');
  restored.setRoute('clp|clp');
  expect(restored.calibration).toBeUndefined();
  // Old diagnostic results cannot silently become a correction after reload.
  expect(restored.result).toBeDefined();
});

it('measured click update schedules earlier with a defined first beat and no duplicate or origin shift', async () => {
  let now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const starts: number[] = [];
  const ctx: any = {
    currentTime: 1,
    baseLatency: 0.01,
    outputLatency: 0.048,
    destination: {},
    resume: async () => {},
    createGain: () => ({
      gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    }),
    createOscillator: () => ({
      frequency: { value: 0 },
      connect: vi.fn(),
      disconnect: vi.fn(),
      stop: vi.fn(),
      start: (at: number) => starts.push(at),
    }),
  };
  const metro = new Metronome(() => ctx);
  metro.compensateOutput = true;
  metro.setAdvanceOverride(138);
  await metro.toggle(now, 0, true);
  expect(metro.origin).toBe(1138);
  expect(starts).toEqual([1]);
  now = 1480;
  ctx.currentTime = 1.48;
  metro.tick(now);
  expect(starts[1]).toBeCloseTo(1.5);
  metro.setAdvanceOverride(200);
  now = 1485;
  ctx.currentTime = 1.485;
  metro.tick(now);
  metro.setAdvanceOverride(undefined);
  now = 1500;
  ctx.currentTime = 1.5;
  metro.tick(now);
  now = 1540;
  ctx.currentTime = 1.54;
  metro.tick(now);
  expect(starts).toHaveLength(2);
  expect(metro.advanceMs).toBeCloseTo(58);
  expect(metro.origin).toBe(1138);
  metro.compensateOutput = false;
  metro.setAdvanceOverride(138);
  expect(metro.advanceMs).toBe(0);
});

it('measured click update integrates six taps, settings, route isolation and neutral fixed bars', async () => {
  const fixture = TestBed.createComponent(MidiLooper);
  await fixture.whenStable();
  const vm = fixture.componentInstance.workspace;
  vi.spyOn(vm, 'now').mockReturnValue(0);
  vm.midi.inputId = 'clp';
  vm.midi.outputId = 'clp';
  vm.midi.onChange();
  vm.metro.context = { baseLatency: 0.01, outputLatency: 0.048 } as AudioContext;
  vm.metro.enabled = true;
  const before = JSON.stringify(vm.engine.tracks);
  await vm.startTiming();
  for (let i = 2; i < 8; i++) vm.midi.onNoteInput?.(i * 500 + 80);
  await fixture.whenStable();
  expect(vm.timing.active).toBe(false);
  expect(vm.metro.advanceMs).toBeCloseTo(138);
  expect(fixture.nativeElement.querySelector('.timing-check-status').textContent).toContain('138');
  expect(JSON.stringify(vm.engine.tracks)).toBe(before);
  vm.openSettings();
  vm.refresh();
  await fixture.whenStable();
  const select: HTMLSelectElement = fixture.nativeElement.querySelector('#measured-metronome');
  select.value = select.options[1].value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await fixture.whenStable();
  expect(vm.useMeasuredMetronome).toBe(false);
  expect(vm.metro.advanceMs).toBeCloseTo(58);
  expect(JSON.parse(localStorage.getItem('midi-workspace-v1')!).useMeasuredMetronome).toBe(false);
  vm.setMeasuredMetronome(true);
  expect(vm.metro.advanceMs).toBeCloseTo(138);
  vm.midi.outputId = 'other';
  vm.midi.onChange();
  expect(vm.timing.calibration).toBeUndefined();
  expect(vm.metro.advanceMs).toBeCloseTo(58);
  vm.midi.outputId = 'browser';
  vm.midi.onChange();
  expect(vm.metro.advanceMs).toBe(0);
  const css = readFileSync(join(process.cwd(), 'src/styles/performance-cards.css'), 'utf8');
  const rule = css.split('.track-bars.has-fixed-bars input {')[1].split('}')[0];
  expect(rule).toContain('border: 2px solid #c9d1dc');
  expect(rule).toContain('font-weight: 700');
  expect(rule).not.toMatch(/#77c9ce|#19383e|#c2f5f0/);
  vm.metro.context = undefined;
  fixture.destroy();
});

class ClockWorker {
  onmessage: (() => void) | null = null;
  terminate = terminate;
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('Worker', ClockWorker);
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal(
    'confirm',
    vi.fn(() => false),
  );
  // No network, audio permission, MIDI device or physical input is used.
  vi.spyOn(MidiRouter.prototype, 'prepareAudio').mockResolvedValue(undefined);
  vi.spyOn(MidiRouter.prototype, 'connect').mockResolvedValue(undefined);
  vi.spyOn(AudioSession.prototype, 'refreshDevices').mockResolvedValue(undefined);
  terminate.mockClear();
});

afterEach(() => {
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(['midi', 'audio'] as const)(
  '%s header and timing UX update uses a plain left title and separate key without duration',
  async (mode) => {
    const fixture =
      mode === 'midi' ? TestBed.createComponent(MidiLooper) : TestBed.createComponent(AudioLooper);
    await fixture.whenStable();
    const root: HTMLElement = fixture.nativeElement;
    const cards = root.querySelectorAll<HTMLElement>('article.track');
    expect(cards).toHaveLength(5);
    expect(root.querySelector('.track-time')).toBeNull();
    expect(root.querySelector('.track-select strong')).toBeNull();
    cards.forEach((card, i) => {
      expect(card.querySelector('.track-title')?.textContent?.trim()).toBe(`SPUR 0${i + 1}`);
      expect(card.querySelector('.track-select > kbd')?.textContent?.trim()).toBe(String(i + 1));
    });
    cards[1].querySelector<HTMLButtonElement>('.track-select')!.click();
    await fixture.whenStable();
    const vm: any = fixture.componentInstance.workspace;
    expect(mode === 'midi' ? vm.engine.selected : vm.selected).toBe(1);
    cards[1].querySelector<HTMLButtonElement>('.mute-button')!.click();
    await fixture.whenStable();
    expect(cards[1].querySelector('.mute-indicator')?.textContent).toBe('STUMM');
    fixture.destroy();
  },
);

it('main-page timing UX update starts, completes and retries six taps without a settings round-trip', async () => {
  const fixture = TestBed.createComponent(MidiLooper);
  await fixture.whenStable();
  const root: HTMLElement = fixture.nativeElement;
  const vm = fixture.componentInstance.workspace;
  vm.metro.enabled = true;
  vm.metro.origin = 0;
  vi.spyOn(vm, 'now').mockReturnValue(0);
  root.querySelector<HTMLButtonElement>('.timing-check > button')!.click();
  await fixture.whenStable();
  expect(vm.settingsOpen).toBe(false);
  expect(root.querySelector('.timing-check-status')?.textContent).toContain('0/6 Anschläge');
  for (let i = 2; i < 8; i++) vm.timing.input(i * 500 + 154);
  vm.refresh();
  await fixture.whenStable();
  expect(vm.settingsOpen).toBe(false);
  expect(root.querySelector('.timing-check-status')?.textContent).toContain(
    'Einspielversatz: 154 ms',
  );
  expect(root.querySelector('.timing-check > button')?.textContent).toContain('Erneut messen');
  root.querySelector<HTMLButtonElement>('.timing-check > button')!.click();
  await fixture.whenStable();
  expect(vm.timing.active).toBe(true);
  expect(vm.timing.samples).toHaveLength(0);
  root.querySelector<HTMLButtonElement>('.timing-check > button')!.click();
  await fixture.whenStable();
  expect(vm.timing.active).toBe(false);
  expect(vm.settingsOpen).toBe(false);
  vm.midi.outputId = 'external';
  vm.midi.onChange();
  await fixture.whenStable();
  expect(vm.timing.result).toBeUndefined();
  expect(root.querySelector('.timing-check > button')?.textContent).toContain(
    'Timing-Check starten',
  );
  fixture.destroy();
});

it('audio timing update uses the native sample rate and maps presentation without changing transport', async () => {
  const options: AudioContextOptions[] = [];
  vi.stubGlobal(
    'AudioContext',
    class {
      state = 'running';
      sampleRate = 48000;
      currentTime = 2;
      baseLatency = 0.01;
      outputLatency = 0.048;
      constructor(value: AudioContextOptions) {
        options.push(value);
      }
      resume = async () => {};
      close = async () => {};
      getOutputTimestamp = () => ({ contextTime: 1.942, performanceTime: 1000 });
    },
  );
  const synth = new BrowserSynth();
  await synth.wake();
  expect(options).toEqual([{ latencyHint: 'interactive' }]);
  expect(synth.context?.sampleRate).toBe(48000);
  expect(outputDelayMs(synth.context)).toBeCloseTo(58);
  expect(audibleNow(synth.context, 1000)).toBeCloseTo(942);
  const fixture = TestBed.createComponent(MidiLooper);
  await fixture.whenStable();
  const vm = fixture.componentInstance.workspace;
  vm.midi.browser.context = synth.context;
  vm.clock = 1000;
  Object.assign(vm.engine.tracks[0], { state: 'playing', start: 0, length: 1000 });
  expect(vm.progress(vm.engine.tracks[0])).toBeCloseTo(94.2);
  expect(vm.clock).toBe(1000);
  vm.midi.outputId = 'external';
  expect(vm.progress(vm.engine.tracks[0])).toBe(0);
  vm.midi.outputId = 'browser';
  fixture.destroy();
  synth.context!.getOutputTimestamp = () => {
    throw Error('unsupported');
  };
  expect(audibleNow(synth.context, 1000)).toBeCloseTo(942);
  (synth.context as any).outputLatency = undefined;
  expect(outputDelayMs(synth.context)).toBeNull();
  expect(audibleNow(synth.context, 1000)).toBe(1000);
});

it('audio timing update shares the metronome clock and advances external-output clicks with a defined first beat', async () => {
  let now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const starts: number[] = [];
  const ctx: any = {
    currentTime: 1,
    baseLatency: 0.01,
    outputLatency: 0.048,
    state: 'running',
    destination: {},
    resume: async () => {},
    createGain: () => ({
      gain: { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
      connect: vi.fn(),
    }),
    createOscillator: () => ({
      frequency: { value: 0 },
      connect: vi.fn(),
      disconnect: vi.fn(),
      stop: vi.fn(),
      start: (at: number) => starts.push(at),
    }),
  };
  const metro = new Metronome(() => ctx);
  metro.compensateOutput = true;
  await metro.toggle(now, 0, true);
  expect(metro.context).toBe(ctx);
  expect(metro.origin).toBeCloseTo(1058);
  expect(starts).toEqual([1]);
  now = 1480;
  ctx.currentTime = 1.48;
  metro.tick(now);
  expect(starts[1]).toBeCloseTo(1.5);
  now = 1485;
  ctx.currentTime = 1.485;
  metro.tick(now);
  expect(starts).toHaveLength(2);
  expect(metro.origin).toBeCloseTo(1058);
});

it('audio timing update completes six taps and labels output-adjusted estimates separately', () => {
  const timing = new MidiTiming();
  timing.setRoute('isolated|browser');
  timing.start(0, 500, 0, 58.7);
  [198, 199, 200, 200, 201, 202].forEach((offset, i) => {
    timing.input((i + 2) * 500 + offset);
    expect(timing.active).toBe(i < 5);
  });
  expect(timing.result).toMatchObject({
    offsetMs: 200,
    spreadMs: 1,
    samples: 6,
    outputEstimateMs: 58.7,
  });
  expect(timing.result?.adjustedOffsetMs).toBeCloseTo(141.3);
  expect(timing.message).toContain('Kein Eingriff');
  timing.setRoute('other|device');
  expect(timing.result).toBeUndefined();
});

it.each(['midi', 'audio'] as const)(
  '%s performance update keeps presets clear, mute visible and reset at the footer end',
  async (mode) => {
    const fixture =
      mode === 'midi' ? TestBed.createComponent(MidiLooper) : TestBed.createComponent(AudioLooper);
    await fixture.whenStable();
    const root: HTMLElement = fixture.nativeElement;
    const vm: any = fixture.componentInstance.workspace;
    const tracks = mode === 'midi' ? vm.engine.tracks : vm.s.tracks;
    const cards = root.querySelectorAll<HTMLElement>('article.track');
    expect(root.querySelector('.bars-preset-badge')).toBeNull();
    expect(root.querySelector('.selection-badge')).toBeNull();
    expect(vm.metroPercent).toBe(80);
    expect(root.querySelector('footer > :last-child')?.classList.contains('reset-all-tracks')).toBe(
      true,
    );
    const bars = cards[0].querySelector<HTMLInputElement>('input[type=number]')!;
    bars.value = '4';
    bars.dispatchEvent(new Event('input', { bubbles: true }));
    await fixture.whenStable();
    expect(cards[0].querySelector<HTMLButtonElement>('.delete')?.disabled).toBe(true);
    expect(cards[1].querySelector('.track-bars.has-fixed-bars')).toBeNull();
    expect(cards[0].querySelector('.track-bars.has-fixed-bars')).not.toBeNull();
    const clear = cards[0].querySelector<HTMLButtonElement>('.bars-clear')!;
    clear.click();
    await fixture.whenStable();
    expect(cards[0].querySelector('.track-bars.has-fixed-bars')).toBeNull();
    vm.setRecordBars(tracks[0], 1);
    vm.refresh();
    await fixture.whenStable();
    const mute = cards[0].querySelector<HTMLButtonElement>('.mute-button')!;
    expect(mute.textContent).toContain('Stumm: Aus');
    mute.click();
    await fixture.whenStable();
    expect(tracks[0].muted).toBe(true);
    expect(cards[0].querySelector('.mute-indicator')?.textContent).toBe('STUMM');
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'KeyM', key: 'M', shiftKey: true, bubbles: true }),
    );
    await fixture.whenStable();
    expect(tracks[0].muted).toBe(false);
    if (mode === 'midi') {
      vm.midi.inputId = 'external';
      vm.midi.onChange();
      await fixture.whenStable();
      expect(root.querySelector('.piano-dock')).toBeNull();
      vm.midi.inputId = 'piano';
      vm.midi.onChange();
      await fixture.whenStable();
      expect(root.querySelector('.piano-dock')).not.toBeNull();
    }
    tracks[0].state = 'playing';
    vi.spyOn(vm, 'barCount').mockReturnValue('2');
    vm.refresh();
    await fixture.whenStable();
    expect(cards[0].querySelector('output.track-bars-value')?.textContent?.trim()).toBe('2');
    expect(cards[0].querySelector('.bars-clear')).toBeNull();
    fixture.destroy();
  },
);

it('transport update queues and cancels unmute independently and captures the global Clavinova voice at record start', () => {
  const send = vi.fn();
  const midi = new LoopEngine({ send, reset: vi.fn(), resetTrack: vi.fn() });
  const t = midi.tracks[0];
  Object.assign(t, {
    state: 'playing',
    length: 1000,
    start: 0,
    cursor: 100,
    muted: true,
    events: [{ at: 0, data: [0x90, 60, 100] }],
  });
  t.pending = { at: 2000, action: 'dub' };
  midi.mute(0, 250);
  expect(t.unmuteAt).toBe(1000);
  expect(t.pending?.action).toBe('dub');
  midi.tick(999, 999);
  expect(t.muted).toBe(true);
  midi.mute(0, 999);
  expect(t.unmuteAt).toBeUndefined();
  midi.mute(0, 999);
  midi.tick(1000, 1001);
  expect(t.muted).toBe(false);
  expect(send).toHaveBeenCalledWith(0, [0x90, 60, 100], 1000);
  midi.mute(0, 1100);
  expect(t.muted).toBe(true);
  midi.unmuteMode = 'immediate';
  midi.mute(0, 1200);
  expect(t.muted).toBe(false);
  midi.unmuteMode = 'cycle';
  midi.mute(0, 1300);
  midi.mute(0, 1400);
  midi.clear(0, 1500);
  expect(t.unmuteAt).toBeUndefined();

  const pcm = new PCMEngine(8000);
  Object.assign(pcm.tracks[0], {
    state: 'playing',
    start: 0,
    length: 1000,
    muted: true,
    buffer: [new Float32Array(1000).fill(0.2), new Float32Array(1000).fill(0.2)],
  });
  pcm.frame = 250;
  pcm.command({ type: 'mute', id: 0 });
  expect(pcm.tracks[0].unmuteAt).toBe(1000);
  pcm.render([], [new Float32Array(2), new Float32Array(2)], 999);
  expect(pcm.tracks[0].muted).toBe(false);
  pcm.command({ type: 'mute', id: 0 });
  pcm.command({ type: 'mute', id: 0 });
  expect(pcm.tracks[0].unmuteAt).toBe(2000);
  pcm.command({ type: 'mute', id: 0 });
  expect(pcm.tracks[0].muted).toBe(true);
  expect(pcm.tracks[0].unmuteAt).toBeUndefined();
  pcm.command({ type: 'mute', id: 0, unmuteMode: 'immediate' });
  expect(pcm.tracks[0].muted).toBe(false);

  const router = new MidiRouter();
  router.engine = new LoopEngine(router);
  router.outputId = 'clp';
  router.outputProfile = 'clp625';
  router.monitor = false;
  router.engine.tracks[0].program = 256;
  const voice = (lsb: number, program: number) => {
    router.receive([0xb0, 0, 108], 0);
    router.receive([0xb0, 32, lsb], 0);
    router.receive([0xc0, program], 0);
  };
  voice(0, 48);
  expect(router.clavinovaProgram).toBe(265);
  expect(router.engine.tracks[0].program).toBe(256);
  router.engine.tracks[0].state = 'playing';
  router.engine.tracks[0].length = 1000;
  router.engine.mode = 'tempo';
  router.engine.origin = 0;
  router.engine.select(1);
  router.engine.press(1, 250);
  expect(router.engine.tracks[1].state).toBe('armed');
  voice(6, 0);
  router.engine.tick(2000, 2000);
  expect(router.engine.tracks[1].program).toBe(257);
  expect(router.engine.tracks[0].program).toBe(256);
  router.trace.dispose();
});

it('Clavinova defaults and cleanup work with native, missing and throwing queue cancellation', async () => {
  const midi = new MidiRouter();
  midi.engine = new LoopEngine(midi);
  expect(midi.engine.tracks.map((t) => t.program)).toEqual([0, 0, 48, 40, 128]);
  midi.access = {
    inputs: new Map(),
    outputs: new Map([
      [
        'clp',
        {
          id: 'clp',
          name: 'Clavinova',
          state: 'connected',
          open: async () => ({}) as any,
          close: async () => ({}) as any,
          send: vi.fn(),
          clear: vi.fn(),
        },
      ],
    ]),
    onstatechange: null,
  };
  await midi.selectOutput('clp');
  expect(midi.engine.tracks.map((t) => t.program)).toEqual([256, 256, 256, 256, 256]);
  midi.engine.tracks[2].program = 257;
  midi.setProfile('gm');
  expect(midi.engine.tracks.map((t) => t.program)).toEqual([0, 0, 0, 0, 0]);
  midi.setProfile('clp625');
  expect(midi.engine.tracks[2].program).toBe(257);
  midi.receive([0xb0, 0, 108], performance.now());
  midi.receive([0xb0, 32, 6], performance.now());
  midi.receive([0xc0, 0], performance.now());
  expect(midi.clavinovaProgram).toBe(257);
  expect(midi.engine.tracks[0].program).toBe(256);
  midi.trace.dispose();

  for (const mode of ['native', 'missing', 'throwing'] as const) {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const queue: { data: number[]; at: number }[] = [];
    const voices = new Set<string>();
    const pedals = new Map<number, number>();
    const played: number[][] = [];
    const port = {
      id: 'clp',
      state: 'connected',
      open: async () => ({}) as any,
      close: async () => ({}) as any,
      send: vi.fn((data: number[], at = now) => queue.push({ data: [...data], at })),
      ...(mode === 'missing'
        ? {}
        : {
            clear: () => {
              if (mode === 'throwing') throw new Error('clear unavailable');
              queue.splice(0);
            },
          }),
    };
    const flush = () => {
      queue.sort((a, b) => a.at - b.at);
      while (queue[0]?.at <= now) {
        const { data } = queue.shift()!;
        played.push(data);
        const ch = data[0] & 15,
          op = data[0] & 0xf0,
          key = `${ch}:${data[1]}`;
        if (op === 0x90 && data[2]) voices.add(key);
        if (op === 0x80 || (op === 0x90 && !data[2])) voices.delete(key);
        if (op === 0xb0 && data[1] === 64) pedals.set(ch, data[2]);
        if (op === 0xb0 && [120, 123].includes(data[1]))
          for (const key of voices) if (key.startsWith(`${ch}:`)) voices.delete(key);
      }
    };
    const router = new MidiRouter();
    router.engine = new LoopEngine(router);
    router.output = port;
    router.outputId = 'clp';
    router.send(0, [0x90, 60, 100], now);
    router.send(1, [0x90, 67, 100], now);
    flush();
    router.send(0, [0x90, 64, 100], 1020);
    router.send(0, [0xb0, 64, 127], 1025);
    router.send(1, [0x80, 67, 0], 1100);
    router.engine.clear(0, now);
    flush();
    expect([...voices]).toEqual(['1:67']);
    now = 1030;
    flush();
    expect([...voices]).toEqual(['1:67']);
    expect(pedals.get(0)).toBe(0);
    now = 1100;
    flush();
    expect(voices.size).toBe(0);
    expect(played.filter((d) => d[0] === 0x91)).toHaveLength(1);
    expect(router.message).not.toContain('fehlgeschlagen');
    router.send(0, [0x90, 65, 100], 1120);
    router.reset(now);
    now = 1130;
    flush();
    expect(voices.size).toBe(0);
    router.trace.dispose();
  }
});

it('MIDI performance controls retain bars on delete and clear them only on confirmed global reset', async () => {
  const fixture = TestBed.createComponent(MidiLooper);
  await fixture.whenStable();
  const root: HTMLElement = fixture.nativeElement;
  const workspace = fixture.componentInstance.workspace;
  expect(root.querySelectorAll('article[app-midi-track]')).toHaveLength(5);
  expect(root.querySelectorAll('.piano-key')).toHaveLength(88);
  expect(root.querySelectorAll('instrument-picker [role=group]')).toHaveLength(81);
  expect(root.querySelector('.piano-target')).toBeNull();
  expect(root.querySelector('.piano-tools')?.textContent).not.toContain('Browser-Piano');

  root.querySelectorAll<HTMLButtonElement>('.track-select')[1].click();
  await fixture.whenStable();
  expect(workspace.engine.selected).toBe(1);
  expect(root.querySelectorAll('article.selected')).toHaveLength(1);
  expect(root.querySelector('.track-values .track-length')).not.toBeNull();

  const trigger = vi.spyOn(workspace, 'trigger').mockResolvedValue(undefined);
  root.querySelector<HTMLButtonElement>('#loop-1')!.click();
  expect(trigger).toHaveBeenCalledExactlyOnceWith(1);
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }),
  );
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { code: 'Space', key: ' ', repeat: true, bubbles: true }),
  );
  expect(trigger).toHaveBeenCalledTimes(2);
  const bars = root.querySelector<HTMLInputElement>('input[aria-label="Feste Taktzahl Spur 2"]')!;
  bars.focus();
  bars.value = '4';
  bars.dispatchEvent(new Event('input', { bubbles: true }));
  bars.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
  await fixture.whenStable();
  expect(workspace.engine.tracks[1].fixedBars).toBe(4);
  expect(document.activeElement).toBe(root.querySelector('main'));
  expect(trigger).toHaveBeenCalledTimes(2);
  const slider = root.querySelector<HTMLInputElement>('#volume-1')!;
  slider.focus();
  slider.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  await fixture.whenStable();
  expect(document.activeElement).toBe(root.querySelector('main'));
  workspace.clear(1);
  workspace.refresh();
  await fixture.whenStable();
  expect(workspace.engine.tracks[1].fixedBars).toBe(4);
  expect(JSON.parse(localStorage.getItem('midi-record-bars-v1')!)[1]).toBe(4);
  workspace.engine.tracks[0].state = 'playing';
  workspace.engine.tracks[0].events = [{ at: 0, data: [0x90, 60, 100] }];
  workspace.engine.tracks[1].volume = 73;
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  root.querySelector<HTMLButtonElement>('.reset-all-tracks')!.click();
  expect(workspace.engine.tracks[0].state).toBe('playing');
  expect(workspace.engine.tracks[1].fixedBars).toBe(4);
  confirm.mockReturnValue(true);
  root.querySelector<HTMLButtonElement>('.reset-all-tracks')!.click();
  await fixture.whenStable();
  expect(workspace.engine.tracks.every((t) => t.state === 'empty' && !t.events.length)).toBe(true);
  expect(workspace.engine.tracks[1].volume).toBe(73);
  expect(workspace.engine.tracks[1].fixedBars).toBeNull();
  expect(JSON.parse(localStorage.getItem('midi-record-bars-v1')!)[1]).toBeNull();
  const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
  workspace.visibility();
  expect(workspace.warning).toBe('');
  workspace.engine.tracks[0].state = 'recording';
  workspace.visibility();
  expect(workspace.warning).toContain('Hintergrundbetrieb');
  hidden.mockReturnValue(false);
  workspace.visibility();
  expect(workspace.warning).toBe('');
  workspace.clear(0);
  const picker = root.querySelector<HTMLElement>('instrument-picker')!;
  const list = picker.querySelector<HTMLElement>('[role=listbox]')!;
  list.showPopover = vi.fn();
  list.hidePopover = vi.fn();
  picker.querySelector<HTMLButtonElement>('[role=combobox]')!.click();
  await fixture.whenStable();
  expect(picker.querySelector('[role=combobox]')?.getAttribute('aria-expanded')).toBe('true');
  picker.querySelector<HTMLElement>('[data-program="3"]')!.click();
  await fixture.whenStable();
  expect(workspace.engine.tracks[0].program).toBe(3);
  expect(document.activeElement).toBe(root.querySelector('main'));
  workspace.warning = 'Test warning';
  workspace.refresh();
  await fixture.whenStable();
  expect(root.querySelector('[role=alert]')?.textContent).toContain('Test warning');
  root.querySelector<HTMLButtonElement>('header nav > button')!.click();
  await fixture.whenStable();
  expect(root.querySelector('[role="dialog"]')).not.toBeNull();
  expect(root.querySelector('main')?.hasAttribute('inert')).toBe(true);
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }),
  );
  expect(trigger).toHaveBeenCalledTimes(2);
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await fixture.whenStable();
  expect(root.querySelector('[role="dialog"]')).toBeNull();
  fixture.destroy();
  expect(terminate).toHaveBeenCalledOnce();
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }),
  );
  expect(trigger).toHaveBeenCalledTimes(2);
});

it('Audio controls retain bars and FX on delete and clear bars only on confirmed global reset', async () => {
  const fixture = TestBed.createComponent(AudioLooper);
  await fixture.whenStable();
  const root: HTMLElement = fixture.nativeElement;
  const workspace = fixture.componentInstance.workspace;
  expect(root.querySelectorAll('article[app-audio-track]')).toHaveLength(5);
  expect(root.querySelectorAll('.fx-presets button')).toHaveLength(6);
  expect(root.querySelectorAll('.routing-card')).toHaveLength(3);
  expect(workspace.audio.context).toBeUndefined();

  root.querySelectorAll<HTMLButtonElement>('.fx-presets button')[1].click();
  await fixture.whenStable();
  expect(workspace.audio.inputFx.preset).toBe('bass');
  expect(root.querySelector('.fx-presets button.active')?.textContent?.trim()).toBe('Bass');
  expect(JSON.parse(localStorage.getItem('audio-input-fx-v1')!)[0].preset).toBe('bass');
  await workspace.select(1);
  await fixture.whenStable();
  expect(workspace.selected).toBe(1);
  expect(workspace.audio.inputFx.preset).toBe('clean');
  await workspace.select(0);
  await fixture.whenStable();
  expect(workspace.audio.inputFx.preset).toBe('bass');

  root.querySelector<HTMLButtonElement>('.fx-controls > button')!.click();
  await fixture.whenStable();
  expect(root.querySelector('[app-input-effects-dialog]')).not.toBeNull();
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await fixture.whenStable();
  expect(root.querySelector('[role="dialog"]')).toBeNull();
  root.querySelector<HTMLButtonElement>('header nav > button')!.click();
  await fixture.whenStable();
  expect(root.querySelector('[app-audio-settings]')).not.toBeNull();
  workspace.openCalibration();
  workspace.refresh();
  await fixture.whenStable();
  expect(root.querySelector('[app-audio-settings]')).toBeNull();
  expect(root.querySelector('[app-audio-calibration]')).not.toBeNull();
  expect(root.querySelector<HTMLButtonElement>('.calibration-content .connect')?.disabled).toBe(
    true,
  );
  expect(workspace.audio.context).toBeUndefined();
  await workspace.closeCalibration();
  const send = vi.spyOn(workspace.audio, 'send').mockResolvedValue({} as any);
  workspace.setRecordBars(workspace.s.tracks[0], 4);
  await workspace.command('clear', 0);
  expect(workspace.recordBars[0]).toBe(4);
  expect(JSON.parse(localStorage.getItem('audio-record-bars-v1')!)[0]).toBe(4);
  expect(send).not.toHaveBeenCalled();
  workspace.s.tracks[0].state = 'playing';
  await workspace.command('clear', 0);
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'clear', id: 0 });
  expect(workspace.recordBars[0]).toBe(4);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  await workspace.resetAllTracks();
  expect(send).toHaveBeenCalledTimes(1);
  confirm.mockReturnValue(true);
  send.mockRejectedValueOnce(new Error('Test: Engine unavailable'));
  await workspace.resetAllTracks();
  expect(workspace.recordBars[0]).toBe(4);
  expect(workspace.audio.error).toContain('Engine unavailable');
  await workspace.resetAllTracks();
  expect(workspace.recordBars.every((bars) => bars === null)).toBe(true);
  expect(workspace.recordBars[0]).toBeNull();
  expect(JSON.parse(localStorage.getItem('audio-record-bars-v1')!)[0]).toBeNull();
  workspace.s.tracks[0].volume = 0.4;
  workspace.resetVolume(workspace.s.tracks[0]);
  expect(workspace.s.tracks[0].volume).toBe(0.8);
  expect(send).toHaveBeenCalledTimes(3);
  const dispose = vi.spyOn(workspace.audio, 'dispose');
  fixture.destroy();
  expect(dispose).toHaveBeenCalledOnce();
});

it('MIDI/PCM obey cycle halves; external cleanup is traced persistently and timing measurements stay diagnostic', async () => {
  const midi = new LoopEngine({ send: () => {}, reset: () => {}, resetTrack: () => {} });
  midi.afterRecord = 'play';
  midi.tracks[0].fixedBars = 4;
  midi.useFree();
  midi.press(0, 137);
  midi.input([0x90, 60, 100], 200);
  expect(midi.tracks[0].autoEnd).toBe(8137);
  midi.tick(8137, 8137);
  expect(midi.tracks[0]).toMatchObject({ state: 'playing', length: 8000, start: 137 });
  midi.afterRecord = 'dub';
  midi.tracks[1].fixedBars = 1;
  midi.press(1, 8500);
  midi.tick(10137, 10137);
  midi.tick(12137, 12137);
  expect(midi.tracks[1]).toMatchObject({ state: 'overdub', length: 2000 });
  midi.press(1, 12200);
  expect(midi.tracks[1].state).toBe('playing');
  expect(midi.tracks[0].start).toBe(137);

  const pcm = new PCMEngine(8000);
  pcm.command({ type: 'config', bpm: 120, afterRecord: 'dub', compensationMs: 0 });
  pcm.command({
    type: 'press',
    id: 0,
    fixedBars: 1,
    buffers: [new Float32Array(24000), new Float32Array(24000)],
  });
  while (pcm.frame < 16001) {
    const size = Math.min(128, 16001 - pcm.frame);
    pcm.render(
      [new Float32Array(size).fill(0.08)],
      [new Float32Array(size), new Float32Array(size)],
      pcm.frame,
    );
  }
  expect(pcm.tracks[0]).toMatchObject({ state: 'overdub', length: 16000, start: 0 });
  const phase = [pcm.origin, pcm.tracks[0].start, pcm.tracks[0].length];
  pcm.command({ type: 'press', id: 0 });
  expect(pcm.tracks[0].state).toBe('playing');
  const samples = Array.from(pcm.tracks[0].buffer[0]);
  pcm.command({ type: 'inputFx', id: 0, fx: { preset: 'bass' } });
  expect(Array.from(pcm.tracks[0].buffer[0])).toEqual(samples);
  expect([pcm.origin, pcm.tracks[0].start, pcm.tracks[0].length]).toEqual(phase);
  for (const phase of [499, 500, 999, 1001]) {
    const e = new LoopEngine({ send: () => {}, reset: () => {}, resetTrack: () => {} });
    Object.assign(e.tracks[0], {
      state: 'overdub',
      start: 0,
      takeStart: Math.floor(phase / 1000) * 1000,
      length: 1000,
      cursor: phase,
    });
    e.press(0, phase);
    if (phase >= 500 && phase < 1000) {
      expect(e.tracks[0].state).toBe('overdub');
      expect(e.tracks[0].pending).toEqual({ at: 1000, action: 'play' });
      e.tick(1000, 1000);
      expect(e.tracks[0].state).toBe('playing');
    } else expect(e.tracks[0].state).toBe('playing');
    const a = new PCMEngine(1000);
    Object.assign(a.tracks[0], {
      state: 'overdub',
      start: 0,
      length: 1000,
      buffer: [new Float32Array(1000), new Float32Array(1000)],
      capture: { start: 0, end: Infinity, compensation: 0, channels: 'mono' },
    });
    a.frame = phase;
    a.command({ type: 'press', id: 0 });
    if (phase >= 500 && phase < 1000) {
      expect(a.tracks[0].pending).toEqual({ at: 1000, action: 'play' });
      a.render([], [new Float32Array(1), new Float32Array(1)], 1000);
      expect(a.tracks[0].state).toBe('playing');
    } else expect(a.tracks[0].state).toBe('playing');
  }
  const tail = new LoopEngine({ send: () => {}, reset: () => {}, resetTrack: () => {} });
  Object.assign(tail.tracks[0], { state: 'overdub', start: 0, takeStart: 0, length: 1000 });
  tail.input([0x90, 60, 100], 100);
  tail.press(0, 200);
  tail.input([0x90, 62, 100], 250);
  tail.input([0x80, 60, 0], 300);
  expect(tail.tracks[0].state).toBe('playing');
  expect(tail.tracks[0].releaseTail).toBeUndefined();
  expect(tail.tracks[0].events.some((e) => e.data[1] === 62)).toBe(false);
  expect(tail.tracks[0].events).toContainEqual(
    expect.objectContaining({ at: 300, data: [0x80, 60, 0] }),
  );
  const router = new MidiRouter();
  router.engine = new LoopEngine(router);
  const port = {
    id: 'clp-test',
    name: 'Yamaha CLP-625',
    state: 'connected',
    send: vi.fn(),
    clear: vi.fn(),
  };
  router.output = port as any;
  router.outputId = port.id;
  router.send(0, [0x90, 60, 100], performance.now());
  router.engine.clear(0, performance.now());
  const doc = router.trace.document('test');
  expect(doc.events.map((e) => e.kind)).toEqual(
    expect.arrayContaining([
      'loop-schedule',
      'delete-before',
      'external-clear-request',
      'external-clear-returned',
      'external-send-accepted',
      'delete-cleanup-complete',
    ]),
  );
  expect(port.send.mock.calls.some(([data]) => data[0] === 0xb0 && data[1] === 120)).toBe(true);
  // Small asynchronous IndexedDB stand-in: verify writes and a later instance's read, not hardware acknowledgement.
  const stored = new Map<string, unknown>();
  const db = {
    transaction: () => {
      const tx: any = {
        objectStore: () => ({
          put: (value: unknown, key: string) => {
            stored.set(key, structuredClone(value));
            queueMicrotask(() => tx.oncomplete?.());
          },
          get: (key: string) => {
            const req: any = {};
            queueMicrotask(() => {
              req.result = stored.get(key);
              req.onsuccess?.();
            });
            return req;
          },
        }),
      };
      return tx;
    },
    close: vi.fn(),
  };
  vi.stubGlobal('indexedDB', {
    open: () => {
      const req: any = {};
      queueMicrotask(() => {
        req.result = db;
        req.onsuccess?.();
      });
      return req;
    },
  });
  const trace = new MidiTrace();
  trace.configure(() => ({ output: 'clp-test' }));
  trace.record('note-on', { data: [0x90, 60, 100] });
  await trace.save('incident', 'stuck-note');
  const restored = new MidiTrace();
  expect((await restored.read('incident'))?.events[0].kind).toBe('note-on');
  for (let i = 0; i < 10000; i++) trace.record('event', { i });
  expect(trace.document('bounded').events.length).toBeLessThanOrEqual(8192);
  const timing = new MidiTiming();
  timing.setRoute('clp-in|browser');
  timing.start(0, 500, 0);
  for (let i = 2; i < 8; i++) timing.input(i * 500 + 120);
  expect(timing.result).toMatchObject({ offsetMs: 120, spreadMs: 0, samples: 6 });
  timing.setRoute('clp-in|clp-out');
  expect(timing.result).toBeUndefined();
  trace.dispose();
  restored.dispose();
  router.trace.dispose();

  const worklet = readFileSync(join(process.cwd(), 'public/audio/looper-processor.js'), 'utf8');
  const start = worklet.indexOf('class LooperProcessor extends '),
    end = worklet.indexOf('registerProcessor(', start);
  const delivered: any[] = [],
    acknowledgements: any[] = [];
  class Base {
    port: any = {
      onmessage: null,
      capture: null,
      start: () => {},
      postMessage: (m: any) => acknowledgements.push(m),
      addEventListener: (_kind: string, listener: any) => {
        this.port.capture = listener;
      },
    };
    process() {
      return true;
    }
  }
  const clock: any = { Base, currentTime: 1 };
  runInNewContext(
    worklet.slice(start, end).replace(/extends \w+ \{/, 'extends Base {') +
      ';this.Processor=LooperProcessor;',
    clock,
  );
  const processor = new clock.Processor({});
  // Match SpessaSynth: onmessage is installed AFTER the subclass constructor.
  processor.port.onmessage = (event: any) => delivered.push(event.data);
  const dispatch = (data: any) => {
    let stop = false;
    processor.port.capture({
      data,
      stopImmediatePropagation: () => {
        stop = true;
      },
    });
    if (!stop) processor.port.onmessage({ data });
  };
  const msg = (channel: number) => ({
    type: 'midiMessage',
    data: { messageData: [0x90 | channel, 60, 100], options: { time: 2 } },
  });
  dispatch(msg(0));
  dispatch(msg(1));
  dispatch({ type: 'looperClearTrack', channel: 0 });
  clock.currentTime = 2;
  processor.process([], []);
  expect(delivered.filter((m) => m.data?.messageData?.[0] === 0x90)).toHaveLength(0);
  expect(delivered.filter((m) => m.data?.messageData?.[0] === 0x91)).toHaveLength(1);
  expect(acknowledgements[0]).toMatchObject({
    kind: 'clear-applied',
    channel: 0,
    queuedBefore: 2,
    queuedAfter: 1,
  });
});
