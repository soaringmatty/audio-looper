import { it, expect, vi } from 'vitest';
import { LoopEngine } from '../app/features/midi/loop-engine';
import { Metronome } from '../app/features/midi/metronome';
import { shortcut } from '../app/shared/shortcuts';
import { suggestTempo } from '../app/shared/tempo';
it('laufendes Metronom gibt Start/Ende vor ohne Reset; Overdub endet sofort und Enter steuert die Spur', async () => {
  const metro = new Metronome();
  metro.context = { resume: async () => {}, currentTime: 0 } as unknown as AudioContext;
  metro.gain = { gain: { setValueAtTime: () => {} } } as unknown as GainNode;
  await metro.toggle(0, 0);
  const e = new LoopEngine({ send: () => {}, reset: () => {} });
  e.useMetronome(metro.origin);
  e.press(0, 1500);
  expect(e.tracks[0].pending?.at).toBe(2000);
  e.tick(2000);
  e.input([0x90, 60, 90], 2100);
  e.input([0x80, 60, 0], 2300);
  e.press(0, 3500);
  expect(e.tracks[0].pending?.at).toBe(4000);
  e.tick(4000);
  expect(e.tracks[0].state).toBe('overdub');
  e.input([0x90, 64, 100], 4100);
  e.press(0, 4500);
  const t = e.tracks[0];
  expect(t.state).toBe('playing');
  expect(t.pending).toBeUndefined();
  expect(t.events.some((v) => v.data[0] === 0x80 && v.data[1] === 64 && v.at < 500)).toBe(true);
  const count = t.events.length;
  e.input([0x90, 67, 100], 4600);
  expect(t.events.length).toBe(count);
  expect(t.take).toEqual([]);
  e.press(0, 4700);
  expect(t.pending?.at).toBe(6000);
  e.tick(6000);
  expect(t.state).toBe('overdub');
  const before = [t.start, t.length, e.origin];
  await metro.toggle(6500, 4000);
  await metro.toggle(7000, 9999);
  expect(metro.origin).toBe(0);
  expect([t.start, t.length, e.origin]).toEqual(before);
  const key = {
    key: 'Enter',
    code: 'Enter',
    repeat: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
  };
  expect(shortcut(key, false, false)).toEqual({ kind: 'main' });
  expect(shortcut(key, true, false)).toBeNull();
  expect(shortcut({ ...key, repeat: true }, false, false)).toBeNull();
});
it('Tempo-Vorschlag berücksichtigt mehrere Takte und Notenraster, ohne den freien Loop zu verändern', () => {
  const e = new LoopEngine({ send: () => {}, reset: () => {} });
  e.afterRecord = 'play';
  e.press(0, 0);
  for (let now = 0; now < 8000; now += 500) {
    e.input([0x90, 60, 100], now);
    e.input([0x80, 60, 0], now + 100);
  }
  e.press(0, 8000);
  const before = JSON.stringify(e.tracks[0].events),
    c = suggestTempo(8000, e.tracks[0].events);
  expect(c[0]).toMatchObject({
    bpm: 120,
    beats: 4,
    denominator: 4,
    bars: 4,
    evidence: 'Notenraster',
  });
  expect(c.some((v) => v.bpm !== 120 || v.beats !== 4)).toBe(true);
  expect(e.mode).toBe('free');
  expect(JSON.stringify(e.tracks[0].events)).toBe(before);
  const chosen = c[0];
  e.bpm = chosen.bpm;
  e.beats = chosen.beats;
  e.denominator = chosen.denominator;
  e.mode = 'tempo';
  expect(e.tracks[0].length).toBe(8000);
  expect(e.bar * chosen.bars).toBe(8000);
  expect(suggestTempo(8000, [])[0].evidence).toBe('Nur Loop-Länge');
  expect(suggestTempo(0, [])).toEqual([]);
});

// The former smplr adapter cases are superseded by soundfont.test.ts and live Worklet checks.
