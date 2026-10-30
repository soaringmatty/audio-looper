import '@angular/compiler';
import { it, expect, vi } from 'vitest';
import { LoopEngine } from '../app/features/midi/loop-engine';
import { PCMEngine } from '../../public/audio/pcm-engine.js';
import { Metronome } from '../app/features/midi/metronome';
import { MidiWorkspace as App } from '../app/features/midi/midi-workspace';
import { AudioWorkspace as AudioApp } from '../app/features/audio/audio-workspace';
import { suggestTempo } from '../app/shared/tempo';
import { formatBarCount, readRecordBars, saveRecordBars } from '../app/shared/record-length';
const engine = () => new LoopEngine({ send: () => {}, reset: () => {}, resetTrack: () => {} });
function renderTo(e: PCMEngine, end: number) {
  while (e.frame < end) {
    const size = Math.min(128, end - e.frame);
    e.render(
      [new Float32Array(size).fill(0.08)],
      [new Float32Array(size), new Float32Array(size)],
      e.frame,
    );
  }
}

it('MIDI: 4 Takte bei 120 BPM enden nach 8 s ohne Klick; Folgespur bleibt gerastert; freie Einteilung startet keinen Klick', async () => {
  const e = engine();
  e.afterRecord = 'play';
  e.tracks[0].fixedBars = 4;
  e.useFree();
  e.press(0, 137);
  expect(e.tracks[0].state).toBe('recording');
  expect(e.tracks[0].autoEnd).toBe(8137);
  e.input([0x90, 60, 100], 200);
  e.press(0, 1000);
  e.press(0, 1500);
  expect(e.tracks[0].autoEnd).toBe(8137);
  e.tick(8136, 8136);
  expect(e.tracks[0].state).toBe('recording');
  e.tick(8137, 8137);
  expect(e.tracks[0]).toMatchObject({
    state: 'playing',
    start: 137,
    length: 8000,
    barDuration: 2000,
  });
  expect(formatBarCount(e.tracks[0].length, e.tracks[0].barDuration)).toBe('4');
  e.afterRecord = 'dub';
  e.tracks[1].fixedBars = 2;
  e.press(1, 8500);
  expect(e.tracks[1].pending?.at).toBe(10137);
  e.tick(10137, 10137);
  expect(e.tracks[1].autoEnd).toBe(14137);
  e.tick(14137, 14137);
  expect(e.tracks[1]).toMatchObject({ state: 'overdub', length: 4000 });
  expect(e.tracks[1].autoEnd).toBeUndefined();
  e.press(1, 14200);
  expect(e.tracks[1].state).toBe('playing');
  const free = engine();
  free.afterRecord = 'play';
  free.press(0, 0);
  free.press(0, 4000);
  expect(free.tracks[0].barDuration).toBeUndefined();
  const app = Object.create(App.prototype) as App;
  Object.assign(app, {
    engine: free,
    tempoCandidates: suggestTempo(4000, []),
    tempoBars: 2,
    tempoSignature: '4/4',
    tempoIndex: -1,
    tempoConfirmed: false,
    metro: { enabled: false, align: vi.fn(), toggle: vi.fn() },
    settingsOpen: false,
    now: () => 5000,
  });
  const before = [free.origin, free.tracks[0].start, free.tracks[0].length];
  app.chooseTempo(0);
  app.tempoBars = 2;
  await app.confirmTempo();
  expect(app.metro.enabled).toBe(false);
  expect(app.metro.toggle).not.toHaveBeenCalled();
  expect([free.origin, free.tracks[0].start, free.tracks[0].length]).toEqual(before);
  expect(app.barCount(free.tracks[0])).toBe('2');
});

it('Audio: feste Grenze samplegenau samt Nachlauf; bekannte/unbekannte Taktzahlen und 120-s-Schutz', async () => {
  const e = new PCMEngine(8000);
  e.command({ type: 'config', bpm: 120, afterRecord: 'play', compensationMs: 80 });
  e.frame = 137;
  e.command({
    type: 'press',
    id: 0,
    fixedBars: 4,
    buffers: [new Float32Array(100000), new Float32Array(100000)],
  });
  expect(e.tracks[0].autoEnd).toBe(64137);
  renderTo(e, 64137);
  expect(e.tracks[0].state).toBe('recording');
  renderTo(e, 64138);
  expect(e.tracks[0]).toMatchObject({ state: 'playing', length: 64000, barDuration: 16000 });
  expect(e.snapshot().tracks[0].draining).toBe(true);
  renderTo(e, 65000);
  expect(e.snapshot().tracks[0].draining).toBe(false);
  expect(e.metro).toBe(false);
  expect(formatBarCount(e.tracks[0].length, e.tracks[0].barDuration)).toBe('4');
  const limit = new PCMEngine(8000);
  limit.command({ type: 'config', bpm: 30 });
  limit.command({
    type: 'press',
    id: 0,
    fixedBars: 64,
    buffers: [new Float32Array(960000), new Float32Array(960000)],
  });
  expect(limit.tracks[0].state).toBe('empty');
  expect(limit.snapshot().error).toContain('120 Sekunden');
  const free = new PCMEngine(8000);
  free.command({ type: 'config', afterRecord: 'play' });
  free.command({
    type: 'press',
    id: 0,
    buffers: [new Float32Array(40000), new Float32Array(40000)],
  });
  renderTo(free, 32000);
  free.command({ type: 'press', id: 0 });
  expect(free.tracks[0].barDuration).toBeUndefined();
  const before = [free.origin, free.tracks[0].start, free.tracks[0].length],
    pcm = Array.from(free.tracks[0].buffer[0]);
  const app = Object.create(AudioApp.prototype) as AudioApp;
  Object.assign(app, {
    audio: {
      state: free.snapshot(),
      send: async (c: any) => {
        free.command(c);
        app.audio.state = free.snapshot();
      },
    },
    tempoBars: 2,
    tempoSignature: '4/4',
    working: false,
    settingsOpen: false,
    refresh: () => {},
  });
  await app.confirmTempo();
  expect(free.metro).toBe(false);
  expect([free.origin, free.tracks[0].start, free.tracks[0].length]).toEqual(before);
  expect(Array.from(free.tracks[0].buffer[0])).toEqual(pcm);
  expect(app.barCount(free.snapshot().tracks[0])).toBe('2');
});

it('Metronom startet ohne Loops jedes Mal mit betontem Beat 0; mit Loops bleibt die Phase, Vorgaben werden gespeichert', async () => {
  let now = 1000;
  const oscillators: any[] = [];
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const gain = () => ({
    gain: { value: 0, setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
    connect: () => {},
    disconnect: () => {},
  });
  vi.stubGlobal(
    'AudioContext',
    class {
      currentTime = 1;
      destination = {};
      resume = async () => {};
      createGain = gain;
      createOscillator() {
        const osc = {
          frequency: { value: 0 },
          connect: () => {},
          disconnect: () => {},
          start: vi.fn(),
          stop: vi.fn(),
          onended: null,
        };
        oscillators.push(osc);
        return osc;
      }
    },
  );
  try {
    const m = new Metronome();
    await m.toggle(now, 0, true);
    expect(m.origin).toBe(1000);
    expect(oscillators.at(-1).frequency.value).toBe(1300);
    m.tick(1005);
    expect(oscillators).toHaveLength(1);
    now = 1400;
    await m.toggle(now, m.origin, true);
    now = 1750;
    await m.toggle(now, m.origin, true);
    expect(m.origin).toBe(1750);
    expect(oscillators.at(-1).frequency.value).toBe(1300);
    const established = m.origin;
    await m.toggle(1800, established, false);
    await m.toggle(1900, established, false);
    expect(m.origin).toBe(established);
    const e = new PCMEngine(8000);
    e.frame = 100;
    e.command({ type: 'metro' });
    e.frame = 2100;
    e.command({ type: 'metro' });
    e.frame = 3700;
    e.command({ type: 'metro' });
    expect((e as any).metroOrigin).toBe(3700);
    expect((e as any).clickBeat).toBe(-1);
    e.command({
      type: 'press',
      id: 0,
      fixedBars: 1,
      buffers: [new Float32Array(40000), new Float32Array(40000)],
    });
    const origin = (e as any).metroOrigin;
    e.command({ type: 'metro' });
    e.frame += 300;
    e.command({ type: 'metro' });
    expect((e as any).metroOrigin).toBe(origin);
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => data.set(k, v),
    });
    saveRecordBars('midi', [4, null, 2, 0, 900]);
    saveRecordBars('audio', [1, 8]);
    expect(readRecordBars('midi')).toEqual([4, null, 2, null, null]);
    expect(readRecordBars('audio')).toEqual([1, 8, null, null, null]);
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
