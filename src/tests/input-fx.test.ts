import { it, expect, vi } from 'vitest';
import { InputFX, normalizeInputFx, INPUT_FX_PRESETS } from '../../public/audio/input-fx.js';
import { PCMEngine } from '../../public/audio/pcm-engine.js';
import { AudioSession } from '../app/features/audio/audio-session';
function signal(fx: InputFX, freq: number, amplitude = 0.08, rate = 8000) {
  let energy = 0;
  for (let i = 0; i < rate; i++) {
    const x = amplitude * Math.sin((2 * Math.PI * freq * i) / rate);
    fx.process(x, x);
    if (i > rate / 2) energy += fx.left ** 2;
    expect(Number.isFinite(fx.left)).toBe(true);
  }
  return Math.sqrt(energy / (rate / 2));
}
function preset(id: string) {
  const fx = new InputFX(8000);
  fx.set({ ...normalizeInputFx(), preset: id as any, amount: 1 });
  return fx;
}
it('sechs Presets: Clean/Bypass transparent, Bass/Telephone filtern sinnvoll, Punch begrenzt, Space/Echo erzeugen stabile Nachläufe', () => {
  const clean = preset('clean');
  clean.process(0.123, -0.25);
  expect([clean.left, clean.right]).toEqual([0.123, -0.25]);
  const bypass = preset('bass');
  bypass.set({ ...normalizeInputFx(), preset: 'clean' });
  for (let i = 0; i < 1000; i++) bypass.process(0.123, -0.25);
  expect([bypass.left, bypass.right]).toEqual([0.123, -0.25]);
  expect(signal(preset('bass'), 80)).toBeGreaterThan(signal(preset('bass'), 3000) * 3);
  expect(signal(preset('telephone'), 1000)).toBeGreaterThan(signal(preset('telephone'), 60) * 10);
  expect(signal(preset('punch'), 1000, 0.6)).toBeLessThan(signal(preset('clean'), 1000, 0.6));
  const echo = preset('echo');
  echo.set({ ...normalizeInputFx(), preset: 'echo', amount: 1, echoMs: 100, feedback: 0 });
  for (let i = 0; i < 1000; i++) echo.process(0, 0);
  let delayed = 0;
  for (let i = 0; i < 1000; i++) {
    echo.process(i === 0 ? 0.5 : 0, 0);
    if (i >= 800 && i < 810) delayed = Math.max(delayed, Math.abs(echo.left));
  }
  expect(delayed).toBeGreaterThan(0.2);
  const space = preset('space');
  for (let i = 0; i < 1000; i++) space.process(0, 0);
  let tail = 0;
  for (let i = 0; i < 4000; i++) {
    space.process(i === 0 ? 0.5 : 0, 0);
    if (i > 200) tail += space.left ** 2;
    expect(Number.isFinite(space.left)).toBe(true);
  }
  expect(tail).toBeGreaterThan(0.0001);
  expect(INPUT_FX_PRESETS).toHaveLength(6);
});
it('derselbe bearbeitete Eingang wird gehört/aufgenommen; Presetwechsel verändern keinen Loop und Kalibrierung bleibt trocken', () => {
  const e = new PCMEngine(8000);
  e.command({ type: 'config', master: 1, monitor: true, monitorVolume: 1, afterRecord: 'play' });
  e.command({ type: 'inputFx', id: 0, fx: { preset: 'bass', amount: 1 } });
  e.command({ type: 'press', id: 0, buffers: [new Float32Array(16000), new Float32Array(16000)] });
  let frame = 0;
  while (frame < 1200) {
    const size = Math.min(37, 1200 - frame),
      x = Float32Array.from(
        { length: size },
        (_, i) => 0.08 * Math.sin((2 * Math.PI * 80 * (frame + i)) / 8000),
      ),
      out = [new Float32Array(size), new Float32Array(size)];
    e.render([x, x], out, frame);
    for (let i = 0; i < size; i++)
      expect(out[0][i]).toBeCloseTo(e.tracks[0].buffer[0][frame + i], 6);
    frame += size;
  }
  e.command({ type: 'press', id: 0 });
  e.render(
    [new Float32Array(37), new Float32Array(37)],
    [new Float32Array(37), new Float32Array(37)],
    frame,
  );
  frame += 37;
  const before = Array.from(e.tracks[0].buffer[0].slice(0, 1200)),
    origin = e.origin,
    start = e.tracks[0].start;
  e.command({ type: 'inputFx', id: 0, fx: { preset: 'telephone', amount: 1 } });
  e.render(
    [new Float32Array(37), new Float32Array(37)],
    [new Float32Array(37), new Float32Array(37)],
    frame,
  );
  frame += 37;
  expect(Array.from(e.tracks[0].buffer[0].slice(0, 1200))).toEqual(before);
  expect([e.origin, e.tracks[0].start]).toEqual([origin, start]);
  e.command({ type: 'calibrate', method: 'tap' });
  e.render(
    [Float32Array.from({ length: 37 }, () => 0.2), Float32Array.from({ length: 37 }, () => 0.2)],
    [new Float32Array(37), new Float32Array(37)],
    frame,
  );
  expect((e as any).calibration.samples[10]).toBeCloseTo(0.2);
  e.command({ type: 'cancelCalibration' });
  expect(Array.from(e.tracks[0].buffer[0].slice(0, 1200))).toEqual(before);
  const isolated = new PCMEngine(8000);
  isolated.command({ type: 'config', monitor: true, master: 1, monitorVolume: 1 });
  isolated.command({ type: 'inputFx', id: 0, fx: { preset: 'space', amount: 1 } });
  isolated.render(
    [Float32Array.from({ length: 2000 }, () => 0.1)],
    [new Float32Array(2000), new Float32Array(2000)],
    0,
  );
  isolated.command({ type: 'config', selected: 1 });
  const out = [new Float32Array(1000), new Float32Array(1000)];
  isolated.render([new Float32Array(1000)], out, 2000);
  expect(Math.max(...out[0].map(Math.abs))).toBe(0);
});
it('Preset/Intensität/Details/Bypass werden pro Spur gespeichert und nach Reload normalisiert wiederhergestellt', async () => {
  const storage = new Map<string, string>();
  vi.stubGlobal('navigator', {
    mediaDevices: {
      enumerateDevices: async () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
  });
  let s = new AudioSession();
  try {
    await s.refreshDevices();
    s.updateInputFx({ preset: 'bass', amount: 0.8, tone: 0.2 });
    await s.selectTrack(1);
    s.updateInputFx({
      preset: 'echo',
      amount: 0.4,
      feedback: 0.6,
      division: 'eighth',
      bypass: true,
    });
    await s.selectTrack(0);
    expect(s.inputFx.preset).toBe('bass');
    s.dispose();
    s = new AudioSession();
    await s.refreshDevices();
    expect(s.inputFx).toMatchObject({ preset: 'bass', amount: 0.8, tone: 0.2, bypass: false });
    await s.selectTrack(1);
    expect(s.inputFx).toMatchObject({
      preset: 'echo',
      amount: 0.4,
      feedback: 0.6,
      division: 'eighth',
      bypass: false,
    });
    expect(
      normalizeInputFx({ preset: 'unknown', amount: 999, feedback: 99, tone: NaN }),
    ).toMatchObject({ preset: 'clean', amount: 1, feedback: 0.7, tone: 0.5 });
  } finally {
    s.dispose();
    vi.unstubAllGlobals();
  }
});
