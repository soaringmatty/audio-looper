import { it, expect, vi } from 'vitest';
import { PCMEngine, calibrationPulse, measureLatency } from '../../public/audio/pcm-engine.js';
import { AudioSession } from '../app/features/audio/audio-session';
function run(e: PCMEngine, end: number, signal: (frame: number) => number = () => 0): Float32Array {
  const result = new Float32Array(end - e.frame);
  let cursor = 0;
  while (e.frame < end) {
    const frame = e.frame,
      size = Math.min(37, end - frame),
      input = Float32Array.from({ length: size }, (_, i) => signal(frame + i)),
      output = [new Float32Array(size), new Float32Array(size)];
    e.render([input, input], output, frame);
    result.set(output[0], cursor);
    cursor += size;
  }
  return result;
}
function press(e: PCMEngine, id: number) {
  e.command({
    type: 'press',
    id,
    ...(e.tracks[id].state === 'empty'
      ? { buffers: [new Float32Array(e.rate * 120), new Float32Array(e.rate * 120)] }
      : {}),
  });
}
it('Audio-Clock: kompensierte Erstaufnahme, bestehender Metronom-Takt und 4:1-Loops bleiben phasensynchron', () => {
  const e = new PCMEngine(1000);
  e.command({ type: 'config', compensationMs: 50, afterRecord: 'play', master: 1, metroVolume: 0 });
  e.command({ type: 'metro' });
  run(e, 1500);
  press(e, 0);
  expect(e.snapshot().tracks[0].pending?.at).toBe(2000);
  run(e, 9500, (f) => (f === 2150 ? 0.3 : 0));
  press(e, 0);
  expect(e.snapshot().tracks[0].pending?.at).toBe(10000);
  run(e, 10050);
  expect(e.tracks[0].length).toBe(8000);
  expect(e.tracks[0].buffer[0][100]).toBeCloseTo(0.3);
  const before = [e.origin, e.tracks[0].start];
  press(e, 1);
  expect(e.snapshot().tracks[1].pending?.at).toBe(12000);
  run(e, 13500, (f) => (f === 12150 ? 0.2 : 0));
  press(e, 1);
  run(e, 14050);
  expect(e.tracks[1].length).toBe(2000);
  expect(e.tracks[1].buffer[0][100]).toBeCloseTo(0.2);
  const output = run(e, 74150);
  for (const frame of [18100, 26100, 34100, 42100, 50100, 58100, 66100, 74100])
    expect(output[frame - 14050]).toBeCloseTo(0.4, 5);
  e.command({ type: 'metro' });
  expect([e.origin, e.tracks[0].start]).toEqual(before);
  expect(e.tracks[1].start).toBe(12000);
  expect(e.snapshot().metro).toBe(false);
});
it('Overdub endet sofort, Nachlauf bleibt erhalten, Spurwechsel/Mute/Löschen verändern keine fremden PCM-Daten', () => {
  const e = new PCMEngine(1000);
  e.command({ type: 'config', afterRecord: 'play', compensationMs: 40 });
  press(e, 0);
  run(e, 400, () => 0.1);
  press(e, 0);
  run(e, 450, () => 0.1);
  press(e, 1);
  run(e, 800);
  run(e, 1200, () => 0.05);
  press(e, 1);
  run(e, 1240, () => 0.05);
  const second = Array.from(e.tracks[1].buffer[0].slice(0, 400)),
    secondStart = e.tracks[1].start;
  press(e, 0);
  expect(e.snapshot().tracks[0].pending?.at).toBe(1600);
  // A second press cancels the pending overdub; the third re-arms it.
  press(e, 0);
  expect(e.snapshot().tracks[0].pending).toBeNull();
  press(e, 0);
  run(e, 1600);
  run(e, 1700, () => 0.2);
  press(e, 0);
  expect(e.tracks[0].state).toBe('playing');
  expect(e.tracks[0].capture.end).toBe(1700);
  e.command({ type: 'config', selected: 1 });
  run(e, 1740, () => 0.2);
  run(e, 1780, () => 0.9);
  expect(e.tracks[0].buffer[0][50]).toBeCloseTo(0.3);
  expect(e.tracks[0].buffer[0][99]).toBeCloseTo(0.3);
  expect(e.tracks[0].buffer[0][100]).toBeCloseTo(0.1);
  expect(e.tracks[0].capture).toBeNull();
  e.command({ type: 'mute', id: 0 });
  e.command({ type: 'clear', id: 0 });
  expect(Array.from(e.tracks[1].buffer[0].slice(0, 400))).toEqual(second);
  expect(e.tracks[1].start).toBe(secondStart);
  expect(e.reference).toBe(400);
  e.command({ type: 'clear', id: 1 });
  expect(e.reference).toBe(0);
  expect(e.busy).toBe(false);
});
it('Loopback erkennt stabilen Versatz, lehnt fehlendes Signal ab; Session routet Geräte und gibt Ressourcen frei', async () => {
  const rate = 1000,
    starts = [200, 900, 1600],
    samples = new Float32Array(2500),
    pulse = calibrationPulse();
  for (const start of starts)
    for (let i = 0; i < pulse.length; i++) samples[start + 73 + i] = pulse[i] * 0.4;
  expect(measureLatency(samples, starts, rate)).toBe(73);
  expect(measureLatency(new Float32Array(2500), starts, rate)).toBeNull();
  const config: unknown[] = [],
    stop = vi.fn(),
    disconnect = vi.fn(),
    close = vi.fn(async () => {}),
    sink = vi.fn(async () => {});
  const track = {
    getSettings: () => ({ channelCount: 2, sampleRate: 48000, latency: 0.01 }),
    stop,
    onended: null,
  };
  const stream = { active: true, getTracks: () => [track], getAudioTracks: () => [track] };
  const gum = vi.fn(async () => stream),
    devices = {
      getUserMedia: gum,
      enumerateDevices: async () => [
        { kind: 'audioinput', deviceId: 'in', label: 'USB in' },
        { kind: 'audiooutput', deviceId: 'out', label: 'USB Kopfhörer' },
      ],
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
  class Context {
    state = 'running';
    sampleRate = 48000;
    baseLatency = 0.01;
    outputLatency = 0.02;
    destination = {};
    audioWorklet = { addModule: async () => {} };
    resume = async () => {};
    close = close;
    setSinkId(id: string) {
      return sink(id);
    }
    createMediaStreamSource = () => ({ connect: vi.fn(), disconnect });
  }
  const engine = new PCMEngine();
  class Worklet {
    port: { onmessage: ((e: any) => void) | null; postMessage: (v: any) => void };
    constructor() {
      this.port = {
        onmessage: null,
        postMessage: (v) => {
          config.push(v);
          engine.command(v);
          this.port.onmessage?.({ data: { type: 'state', state: engine.snapshot(), ack: v.ack } });
        },
      };
    }
    connect = vi.fn();
    disconnect = disconnect;
  }
  vi.stubGlobal('navigator', { mediaDevices: devices });
  vi.stubGlobal('AudioContext', Context);
  vi.stubGlobal('AudioWorkletNode', Worklet);
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('document', { baseURI: 'https://looper.test/' });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
  try {
    const session = new AudioSession();
    await session.connect();
    expect(session.ready).toBe(true);
    expect(session.compensationMs).toBeCloseTo(40);
    expect(gum.mock.calls[0][0]).toMatchObject({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    expect(session.outputs[0].label).toBe('USB Kopfhörer');
    session.monitor = true;
    await session.changeOutput('out');
    expect(sink).toHaveBeenCalledWith('out');
    expect(session.monitor).toBe(false);
    expect(config.some((c: any) => c.type === 'prepareRoute')).toBe(true);
    session.state.busy = true;
    await session.changeInput('other');
    expect(gum).toHaveBeenCalledTimes(2);
    session.dispose();
    expect(stop).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalled();
    expect(devices.removeEventListener).toHaveBeenCalled();
  } finally {
    vi.unstubAllGlobals();
  }
});
