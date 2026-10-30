import { describe, it, expect } from 'vitest';
import { LoopEngine, MidiSink } from '../app/features/midi/loop-engine';
import { MidiRouter } from '../app/features/midi/midi-router';
import { Metronome } from '../app/features/midi/metronome';
import { shortcut } from '../app/shared/shortcuts';
function fixture() {
  const messages: { track: number; data: number[]; at: number }[] = [];
  const sink: MidiSink = {
    send: (track, data, at) => messages.push({ track, data, at }),
    reset: () => {},
  };
  return { engine: new LoopEngine(sink), messages };
}
describe('Gezielte Machbarkeitstests', () => {
  it('vier- und eintaktige Loops bleiben auf absoluten Zeitpunkten; freier Spätstopp behält Phase', () => {
    const { engine: e, messages } = fixture();
    e.mode = 'tempo';
    e.afterRecord = 'play';
    e.press(0, 0);
    e.input([0x90, 60, 100], 10);
    e.input([0x80, 60, 0], 100);
    e.press(0, 7900);
    e.tick(8000, 8000);
    expect(e.tracks[0].length).toBe(8000);
    e.press(1, 8100);
    e.tick(10000, 10000);
    e.input([0x90, 48, 100], 10010);
    e.input([0x80, 48, 0], 10100);
    e.press(1, 11900);
    e.tick(12000, 12000);
    expect(e.tracks[1].length).toBe(2000);
    messages.length = 0;
    for (let now = 12000; now < 48001; now += 5) e.tick(now);
    const a = messages.filter((m) => m.track === 0 && (m.data[0] & 0xf0) === 0x90).map((m) => m.at);
    const b = messages.filter((m) => m.track === 1 && (m.data[0] & 0xf0) === 0x90).map((m) => m.at);
    expect(a).toEqual([16010, 24010, 32010, 40010, 48010]);
    expect(b.slice(0, 5)).toEqual([12010, 14010, 16010, 18010, 20010]);
    expect(new Set(a).size).toBe(a.length);
    const { engine: f } = fixture();
    f.afterRecord = 'play';
    f.press(0, 0);
    f.press(0, 8000);
    f.press(1, 9000);
    f.tick(16000);
    f.input([0x90, 60, 100], 16010);
    f.press(1, 18100);
    expect(f.tracks[1].length).toBe(2000);
    expect(f.phase(f.tracks[1], 18100)).toBeCloseTo(0.05);
    expect(f.tracks[1].carry).toContainEqual([0x90, 60, 100]);
  });
  it('Instrumente und CC-Lautstärken sind kanalgetrennt; Mute und Löschen räumen Stimmen auf', () => {
    const router = new MidiRouter();
    const e = new LoopEngine(router);
    router.engine = e;
    router.outputId = 'test';
    const sent: number[][] = [];
    let clears = 0;
    router.output = {
      id: 'test',
      name: 'Test',
      state: 'connected',
      open: async () => router.output!,
      close: async () => router.output!,
      clear: () => {
        clears++;
      },
      send: (data: number[]) => sent.push(data),
    };
    router.configure(0, 0);
    router.configure(1, 0);
    expect(sent).toContainEqual([0xc0, 0]);
    expect(sent).toContainEqual([0xc1, 0]);
    router.send(1, [0x90, 60, 110], 0);
    expect(sent.at(-1)).toEqual([0x91, 60, 110]);
    sent.length = 0;
    e.mute(1, 100);
    expect(sent).toContainEqual([0xb1, 7, 0]);
    expect(sent).not.toContainEqual([0xb0, 7, 100]);
    expect(sent).toContainEqual([0xb1, 64, 0]);
    expect(sent).toContainEqual([0xb1, 120, 0]);
    e.clear(1, 200);
    expect(e.tracks[1].volume).toBe(100);
    expect(clears).toBe(2);
  });
  it('Hauptbutton/Keybinds planen konsistent; Metronom-Aus verändert den Transport nicht', async () => {
    const { engine: e } = fixture();
    e.afterRecord = 'play';
    e.press(0, 0);
    e.press(0, 8000);
    e.press(0, 8100);
    expect(e.tracks[0].pending?.action).toBe('dub');
    e.press(0, 8200);
    expect(e.tracks[0].pending).toBeUndefined();
    e.press(0, 8300);
    e.tick(16000, 16000);
    expect(e.tracks[0].state).toBe('overdub');
    e.input([0x90, 67, 80], 16100);
    e.input([0x80, 67, 0], 16200);
    e.press(0, 17000);
    expect(e.tracks[0].state).toBe('playing');
    e.press(0, 17100);
    expect(e.tracks[0].state).toBe('playing');
    expect(e.tracks[0].pending?.action).toBe('dub');
    e.press(0, 17200);
    e.tick(24000, 24000);
    expect(e.tracks[0].state).toBe('playing');
    expect(e.tracks[0].events).toHaveLength(2);
    const before = [e.origin, e.reference, e.tracks[0].start, e.tracks[0].length];
    const metro = new Metronome();
    const gains: number[] = [];
    metro.context = { currentTime: 25, resume: async () => {} } as unknown as AudioContext;
    metro.gain = {
      gain: { setValueAtTime: (value: number) => gains.push(value) },
    } as unknown as GainNode;
    await metro.toggle(25000, e.origin!);
    expect(metro.enabled).toBe(true);
    await metro.toggle(25001, e.origin!);
    expect(metro.enabled).toBe(false);
    expect(gains.at(-1)).toBe(0);
    e.tick(25000);
    expect([e.origin, e.reference, e.tracks[0].start, e.tracks[0].length]).toEqual(before);
    const key = {
      key: ' ',
      code: 'Space',
      repeat: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    };
    expect(shortcut(key, false, false)).toEqual({ kind: 'main' });
    expect(shortcut({ ...key, key: '3', code: 'Digit3' }, false, false)).toEqual({
      kind: 'select',
      id: 2,
    });
    expect(shortcut({ ...key, key: 't', code: 'KeyT' }, false, false)).toEqual({ kind: 'metro' });
    expect(shortcut(key, true, false)).toBeNull();
    expect(shortcut({ ...key, repeat: true }, false, false)).toBeNull();
    expect(shortcut({ ...key, ctrlKey: true }, false, false)).toBeNull();
    e.press(1, 25100);
    e.press(1, 25200);
    e.tick(26000);
    expect(e.tracks[1].state).toBe('empty');
    e.clear(0, 27000);
    expect(e.origin).toBeNull();
    expect(e.reference).toBe(0);
  });
});
