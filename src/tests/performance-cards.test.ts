import '@angular/compiler';
import { it, expect, vi } from 'vitest';
import { InputFX, normalizeInputFx, INPUT_FX_PRESETS } from '../../public/audio/input-fx.js';
import { PCMEngine } from '../../public/audio/pcm-engine.js';
import { LoopEngine } from '../app/features/midi/loop-engine';
import { MidiWorkspace as App } from '../app/features/midi/midi-workspace';
import { AudioWorkspace as AudioApp } from '../app/features/audio/audio-workspace';
import { AudioSession } from '../app/features/audio/audio-session';
import { TempoSuggestion } from '../app/shared/ui/tempo-suggestion';
import { suggestTempo } from '../app/shared/tempo';
import {
  readWorkspacePreferences,
  saveWorkspacePreferences,
} from '../app/shared/workspace-preferences';

it('Octaver erzeugt tiefe Frequenzen bei 44,1/48 kHz; Original/Capture bleiben direkt, Kalibrierung trocken', () => {
  for (const rate of [44100, 48000]) {
    const fx = new InputFX(rate);
    fx.set({ preset: 'bass', amount: 1 });
    let lowRe = 0,
      lowIm = 0,
      highRe = 0,
      highIm = 0;
    for (let i = 0; i < rate; i++) {
      fx.process(0.08 * Math.sin((2 * Math.PI * 200 * i) / rate), 0);
      expect(Number.isFinite(fx.left)).toBe(true);
      if (i > rate / 2) {
        lowRe += fx.left * Math.cos((2 * Math.PI * 100 * i) / rate);
        lowIm += fx.left * Math.sin((2 * Math.PI * 100 * i) / rate);
        highRe += fx.left * Math.cos((2 * Math.PI * 200 * i) / rate);
        highIm += fx.left * Math.sin((2 * Math.PI * 200 * i) / rate);
      }
    }
    expect(Math.hypot(lowRe, lowIm)).toBeGreaterThan(Math.hypot(highRe, highIm) * 4);
    fx.set({ preset: 'clean' });
    for (let i = 0; i < rate * 0.02; i++) fx.process(0.123, -0.2);
    expect([fx.left, fx.right]).toEqual([0.123, -0.2]);
  }
  const e = new PCMEngine(8000);
  e.command({ type: 'config', monitor: true, monitorVolume: 1, master: 1, afterRecord: 'play' });
  e.command({ type: 'inputFx', id: 0, fx: { preset: 'bass', amount: 0.8 } });
  e.command({ type: 'press', id: 0, buffers: [new Float32Array(16000), new Float32Array(16000)] });
  const input = Float32Array.from(
      { length: 4000 },
      (_, i) => 0.08 * Math.sin((2 * Math.PI * 200 * i) / 8000),
    ),
    out = [new Float32Array(4000), new Float32Array(4000)];
  e.render([input, input], out, 0);
  expect(Array.from(out[0])).toEqual(Array.from(e.tracks[0].buffer[0].slice(0, 4000)));
  expect(out[0][0]).toBe(0);
  e.command({ type: 'press', id: 0 });
  e.render([new Float32Array(128)], [new Float32Array(128), new Float32Array(128)], 4000);
  const before = Array.from(e.tracks[0].buffer[0]),
    origin = e.origin,
    start = e.tracks[0].start;
  e.command({ type: 'inputFx', id: 0, fx: { preset: 'clean' } });
  e.command({ type: 'calibrate', method: 'tap' });
  e.render([new Float32Array(128).fill(0.2)], [new Float32Array(128), new Float32Array(128)], 4128);
  expect((e as any).calibration.samples[10]).toBeCloseTo(0.2);
  expect(Array.from(e.tracks[0].buffer[0])).toEqual(before);
  expect([e.origin, e.tracks[0].start]).toEqual([origin, start]);
  expect(INPUT_FX_PRESETS.map((p) => p.name)).toEqual([
    'Kein Effekt',
    'Bass',
    'Hall',
    'Echo',
    'Telefon',
    'Punch',
  ]);
  expect(normalizeInputFx({ preset: 'bass', bypass: true }).bypass).toBe(false);
});

it('MIDI: Vorschlag wählen/ändern/übernehmen erhält Loop-Phase; Escape im nichtmodalen Panel ist lokal', async () => {
  const engine = new LoopEngine({ send: () => {}, reset: () => {} });
  engine.afterRecord = 'play';
  engine.press(0, 100);
  engine.input([0x90, 60, 100], 200);
  engine.input([0x80, 60, 0], 500);
  engine.press(0, 4100);
  const app = Object.create(App.prototype) as App;
  Object.assign(app, {
    engine,
    tempoCandidates: suggestTempo(4000, engine.tracks[0].events),
    tempoOpen: true,
    settingsOpen: false,
    tempoIndex: 0,
    tempoBars: 2,
    tempoSignature: '4/4',
    tempoConfirmed: false,
    signature: '4/4',
    metro: { enabled: true, align: vi.fn() },
    now: () => 5000,
  });
  app.chooseTempo(0);
  app.tempoBars = 2;
  app.tempoSignature = '4/4';
  const origin = engine.origin,
    start = engine.tracks[0].start,
    length = engine.tracks[0].length,
    events = structuredClone(engine.tracks[0].events);
  expect(app.tempoBpm).toBe(120);
  await app.confirmTempo();
  expect(app.tempoOpen).toBe(false);
  expect(app.tempoConfirmed).toBe(true);
  expect(engine.mode).toBe('tempo');
  expect([engine.origin, engine.tracks[0].start, engine.tracks[0].length]).toEqual([
    origin,
    start,
    length,
  ]);
  expect(engine.tracks[0].events).toEqual(events);
  app.tempoBars = 0;
  expect(app.canConfirmTempo).toBe(false);
  const panel = Object.create(TempoSuggestion.prototype) as TempoSuggestion,
    stop = vi.fn();
  panel.key({ key: 'Escape', stopPropagation: stop } as any);
  expect(stop).toHaveBeenCalledOnce();
});

it('Audio: Hauptseiten-Übernahme erhält PCM/Phase; Spur-Presets über Reload ohne alten Bypass', async () => {
  const e = new PCMEngine(8000);
  e.command({ type: 'config', afterRecord: 'play', compensationMs: 0 });
  e.command({ type: 'press', id: 0, buffers: [new Float32Array(40000), new Float32Array(40000)] });
  e.render(
    [new Float32Array(32000).fill(0.05)],
    [new Float32Array(32000), new Float32Array(32000)],
    100,
  );
  e.command({ type: 'press', id: 0 });
  e.render([new Float32Array(128)], [new Float32Array(128), new Float32Array(128)], 32100);
  const app = Object.create(AudioApp.prototype) as AudioApp;
  Object.assign(app, {
    audio: {
      state: e.snapshot(),
      send: async (c: any) => {
        e.command(c);
        app.audio.state = e.snapshot();
      },
    },
    tempoOpen: true,
    tempoIndex: 0,
    tempoBars: 2,
    tempoSignature: '4/4',
    candidates: suggestTempo((e.reference / e.rate) * 1000, []),
    working: false,
    settingsOpen: false,
    refresh: () => {},
  });
  const pcm = Array.from(e.tracks[0].buffer[0]),
    phase = [e.origin, e.tracks[0].start, e.tracks[0].length];
  app.chooseTempo(0);
  app.tempoBars = 2;
  app.tempoSignature = '4/4';
  await app.confirmTempo();
  expect(app.tempoOpen).toBe(false);
  expect(e.metro).toBe(false);
  expect(e.mode).toBe('tempo');
  expect([e.origin, e.tracks[0].start, e.tracks[0].length]).toEqual(phase);
  expect(Array.from(e.tracks[0].buffer[0])).toEqual(pcm);
  const storage = new Map<string, string>();
  storage.set('audio-input-fx-v1', JSON.stringify([{ preset: 'bass', amount: 0.8, bypass: true }]));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
  });
  vi.stubGlobal('navigator', {
    mediaDevices: {
      enumerateDevices: async () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
  let session = new AudioSession();
  try {
    expect(session.inputFx).toMatchObject({ preset: 'bass', amount: 0.8, bypass: false });
    session.updateInputFx({ tone: 0.3 });
    session.updateInputFx({ preset: 'space', amount: 0.6, room: 0.9, tone: 0.7 });
    session.updateInputFx({ preset: 'bass' });
    expect(session.inputFx).toMatchObject({ amount: 0.8, tone: 0.3 });
    await session.selectTrack(1);
    session.updateInputFx({ preset: 'space', amount: 0.4, room: 0.8, tone: 0.2 });
    await session.selectTrack(0);
    session.updateInputFx({ preset: 'clean' });
    session.dispose();
    session = new AudioSession();
    expect(session.inputFx.preset).toBe('clean');
    session.updateInputFx({ preset: 'space' });
    expect(session.inputFx).toMatchObject({ amount: 0.6, room: 0.9, tone: 0.7 });
    session.updateInputFx({ preset: 'bass' });
    expect(session.inputFx).toMatchObject({ amount: 0.8, tone: 0.3 });
    await session.selectTrack(1);
    expect(session.inputFx).toMatchObject({ preset: 'space', amount: 0.4, room: 0.8, tone: 0.2 });
    saveWorkspacePreferences('audio', {
      bpm: 111,
      signature: '3/4',
      master: 0.55,
      monitorVolume: 0.3,
      metroVolume: 0.12,
      afterRecord: 'play',
      commonRing: true,
    });
    expect(readWorkspacePreferences('audio')).toMatchObject({
      bpm: 111,
      signature: '3/4',
      master: 0.55,
      monitorVolume: 0.3,
      metroVolume: 0.12,
      afterRecord: 'play',
      commonRing: true,
    });
    saveWorkspacePreferences('midi', {
      bpm: 90,
      signature: '6/8',
      startToleranceMs: 25,
      commonRing: false,
      metroVolume: 0.4,
    });
    expect(readWorkspacePreferences('midi')).toMatchObject({
      bpm: 90,
      signature: '6/8',
      startToleranceMs: 25,
      commonRing: false,
    });
    expect(readWorkspacePreferences('audio').bpm).toBe(111);
    storage.set(
      'audio-workspace-v1',
      JSON.stringify({
        bpm: 999,
        metroVolume: 8,
        signature: 'bad',
        monitor: true,
        recording: true,
        master: 'loud',
      }),
    );
    expect(readWorkspacePreferences('audio')).toEqual({ bpm: 300, metroVolume: 0.5 });
  } finally {
    session.dispose();
    vi.unstubAllGlobals();
  }
});
