import { it, expect, vi } from 'vitest';
import { PCMEngine } from '../../public/audio/pcm-engine.js';
import { analyzeTaps } from '../../public/audio/tap-calibration.js';
import { AudioSession } from '../app/features/audio/audio-session';
function render(e: PCMEngine, end: number, signal: (f: number) => number = () => 0) {
  while (e.frame < end) {
    const f = e.frame,
      n = Math.min(37, end - f),
      input = Float32Array.from({ length: n }, (_, i) => signal(f + i));
    e.render([input, input], [new Float32Array(n), new Float32Array(n)], f);
  }
}
function burst(samples: Float32Array, at: number, rate: number) {
  for (let i = 0; i < rate * 0.035; i++)
    samples[Math.round(at) + i] = 0.3 * Math.sin(i * 1.7) * Math.exp(-i / (rate * 0.015));
}
it('Einspiel-Kalibrierung: rund 300 ms mit Ausreißern, Stille/mehrdeutige oder schwankende Treffer werden nicht übernommen', () => {
  const rate = 1000,
    starts = Array.from({ length: 8 }, (_, i) => 2250 + i * 2000),
    samples = new Float32Array(18000);
  const delays = [300, 305, 295, 300, 310, 290, 650, null];
  starts.forEach((s, i) => {
    if (delays[i] !== null) burst(samples, s + delays[i]!, rate);
  });
  const result = analyzeTaps(samples, starts, rate);
  expect(result.ok).toBe(true);
  expect(result.accepted).toBe(6);
  expect(result.suggestedMs).toBeGreaterThanOrEqual(295);
  expect(result.suggestedMs).toBeLessThanOrEqual(310);
  expect(result.spreadMs).toBeLessThan(30);
  expect(analyzeTaps(new Float32Array(18000), starts, rate).ok).toBe(false);
  const unstable = new Float32Array(18000);
  starts.forEach((s, i) => burst(unstable, s + (i % 2 ? 650 : 100), rate));
  expect(analyzeTaps(unstable, starts, rate).ok).toBe(false);
  const ambiguous = new Float32Array(18000);
  starts.forEach((s) => {
    burst(ambiguous, s + 200, rate);
    burst(ambiguous, s + 600, rate);
  });
  expect(analyzeTaps(ambiguous, starts, rate).ok).toBe(false);
});
it('Korrektur gilt pro Take; Nachlauf/Route und Kalibrierung erhalten fremde PCM-Daten und absolute Loop-Phasen', () => {
  const e = new PCMEngine(1000);
  e.command({ type: 'config', afterRecord: 'play', compensationMs: 30 });
  e.command({
    type: 'press',
    id: 0,
    buffers: [new Float32Array(120000), new Float32Array(120000)],
  });
  render(e, 100, () => 0.1);
  e.command({ type: 'config', compensationMs: 300, channels: 'left' });
  render(e, 400, () => 0.1);
  expect(e.tracks[0].capture.compensation).toBe(30);
  expect(e.tracks[0].correctionMs).toBe(30);
  e.command({ type: 'press', id: 0 });
  render(e, 431, () => 0.1);
  expect(e.tracks[0].capture).toBeNull();
  const samples = Array.from(e.tracks[0].buffer[0].slice(0, 400)),
    origin = e.origin,
    start = e.tracks[0].start;
  e.command({ type: 'press', id: 0 });
  render(e, 801);
  expect(e.tracks[0].state).toBe('overdub');
  expect(e.tracks[0].capture.compensation).toBe(300);
  e.command({ type: 'prepareRoute' });
  expect(e.tracks[0].state).toBe('playing');
  render(e, 1102);
  expect(e.snapshot().captureBusy).toBe(false);
  e.command({ type: 'calibrate', method: 'tap' });
  const c = (e as any).calibration;
  expect(c).not.toBeNull();
  const before = Array.from(e.tracks[0].buffer[0].slice(0, 400));
  render(e, c.start + c.samples.length, (f) => {
    const relative = f - c.start;
    return c.starts.some((s: number) => relative >= s + 300 && relative < s + 330)
      ? 0.3 * Math.sin(relative * 1.7)
      : 0;
  });
  expect(analyzeTaps(c.samples, c.starts, 1000).suggestedMs).toBeGreaterThanOrEqual(295);
  expect(Array.from(e.tracks[0].buffer[0].slice(0, 400))).toEqual(before);
  expect(before).toEqual(samples);
  e.command({ type: 'cancelCalibration' });
  expect(e.origin).toBe(origin);
  expect(e.tracks[0].start).toBe(start);
  expect(e.tracks[0].length).toBe(400);
  expect(e.tracks[0].state).toBe('playing');
});
it('Geräteliste/Spurzuordnung und unabhängige Signalweg-Profile wechseln bei laufenden Loops ohne deren Reset', async () => {
  const engine = new PCMEngine(1000),
    saved = new Map<string, string>(),
    stops: ReturnType<typeof vi.fn>[] = [];
  const devices = [
    { kind: 'audioinput', deviceId: 'default', label: 'Standard Mic', groupId: 'mic-g' },
    { kind: 'audioinput', deviceId: 'mic', label: 'Logitech Test-Mikrofon', groupId: 'mic-g' },
    { kind: 'audioinput', deviceId: 'piano', label: 'Test-Klavier', groupId: 'piano-g' },
    { kind: 'audiooutput', deviceId: 'default', label: 'Standard Kopfhörer', groupId: 'hp-g' },
    { kind: 'audiooutput', deviceId: 'hp', label: 'USB Kopfhörer', groupId: 'hp-g' },
    { kind: 'audiooutput', deviceId: 'speaker', label: 'Lautsprecher', groupId: 'sp-g' },
  ];
  const gum = vi.fn(async (c: any) => {
    const id = c.audio.deviceId?.exact || 'mic',
      stop = vi.fn();
    stops.push(stop);
    const track = {
      label: devices.find((d) => d.deviceId === id)!.label,
      getSettings: () => ({
        deviceId: id,
        channelCount: 2,
        sampleRate: 1000,
        latency: 0.01,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      }),
      stop,
      onended: null,
    };
    return { active: true, getTracks: () => [track], getAudioTracks: () => [track] };
  });
  const close = vi.fn(async () => {}),
    sink = vi.fn(async (_id: string) => {});
  class Context {
    state = 'running';
    sampleRate = 1000;
    baseLatency = 0.01;
    outputLatency = 0.02;
    destination = {};
    audioWorklet = { addModule: async () => {} };
    resume = async () => {};
    close = close;
    setSinkId(id: string) {
      return sink(id);
    }
    createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  }
  class Worklet {
    port: { onmessage: ((e: any) => void) | null; postMessage: (c: any) => void };
    constructor() {
      this.port = {
        onmessage: null,
        postMessage: (c) => {
          engine.command(c);
          this.port.onmessage?.({ data: { type: 'state', state: engine.snapshot(), ack: c.ack } });
        },
      };
    }
    connect = vi.fn();
    disconnect = vi.fn();
  }
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: gum,
      enumerateDevices: async () => devices,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  vi.stubGlobal('document', { baseURI: 'https://looper.test/' });
  vi.stubGlobal('AudioContext', Context);
  vi.stubGlobal('AudioWorkletNode', Worklet);
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => saved.set(k, v),
  });
  const session = new AudioSession();
  try {
    await session.connect();
    expect(session.inputs.map((d) => d.deviceId)).toEqual(['mic', 'piano']);
    expect(session.outputs.map((d) => d.deviceId)).toEqual(['hp', 'speaker']);
    expect(session.resolvedInput).toBe('mic');
    expect(session.resolvedOutput).toBe('hp');
    engine.tracks[0].state = 'playing';
    engine.tracks[0].length = 400;
    engine.tracks[0].start = 100;
    engine.tracks[0].buffer = [
      Float32Array.from({ length: 500 }, () => 0.1),
      new Float32Array(500),
    ];
    engine.origin = 100;
    engine.reference = 400;
    session.state = engine.snapshot();
    session.setCorrection(310);
    expect(session.correctionLocked).toBe(false);
    await session.selectTrack(1);
    await session.changeInput('piano');
    expect(session.actualInput).toBe('Test-Klavier');
    session.setCorrection(110);
    await session.changeOutput('speaker');
    expect(session.compensationMs).toBe(40);
    session.setCorrection(190);
    await session.changeOutput('hp');
    expect(session.compensationMs).toBe(110);
    await session.selectTrack(0);
    expect(session.resolvedInput).toBe('mic');
    expect(session.compensationMs).toBe(310);
    await session.selectTrack(1);
    expect(session.resolvedInput).toBe('piano');
    expect(session.compensationMs).toBe(110);
    expect(session.trackInputs.slice(0, 2)).toEqual(['mic', 'piano']);
    expect(session.diagnostics.join('\n')).toContain('Noise Suppression: aus');
    expect(engine.tracks[0].start).toBe(100);
    expect(engine.tracks[0].length).toBe(400);
    expect(engine.tracks[0].buffer[0][50]).toBeCloseTo(0.1);
    expect(engine.origin).toBe(100);
    expect(stops.some((stop) => stop.mock.calls.length > 0)).toBe(true);
  } finally {
    session.dispose();
    vi.unstubAllGlobals();
  }
});
