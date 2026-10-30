import { midiTemplates } from './source-fixtures';
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { LoopEngine } from '../app/features/midi/loop-engine';
import { MidiRouter } from '../app/features/midi/midi-router';

import { PianoController, PIANO_KEYS } from '../app/features/midi/piano';
import { shortcut } from '../app/shared/shortcuts';

describe('Hardwarefreier Umbau: drei gezielte Fälle', () => {
  it('Piano spielt Akkorde, nimmt über denselben Eingang auf und beendet Noten bei Release/Oktavwechsel', () => {
    const midi = new MidiRouter();
    const engine = new LoopEngine(midi);
    midi.engine = engine;
    const output: { data: number[]; at: number }[] = [];
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    midi.browser.send = (data, at) => output.push({ data, at });
    midi.browser.clear = () => {};
    const piano = new PianoController((data) => midi.receive(data));
    engine.afterRecord = 'play';
    engine.press(0, 0);
    now = 100;
    piano.down('KeyZ', 0);
    piano.down('KeyC', 4);
    piano.down('KeyB', 7);
    piano.down('KeyZ', 0);
    expect(engine.tracks[0].take).toHaveLength(3);
    expect(output.filter((m) => m.data[0] === 0x90).map((m) => m.data[1])).toEqual([60, 64, 67]);
    now = 400;
    piano.up('KeyZ');
    piano.release();
    expect(output.filter((m) => m.data[0] === 0x80)).toHaveLength(3);
    now = 1000;
    engine.press(0, 1000);
    expect(engine.tracks[0].events).toHaveLength(6);
    output.length = 0;
    engine.tick(1100, 1150);
    expect(output.filter((m) => m.data[0] === 0x90).map((m) => m.at)).toEqual([1100, 1100, 1100]);
    now = 1200;
    piano.down('pointer:1', 0);
    piano.down('KeyZ', 0);
    const count = output.length;
    piano.up('pointer:1');
    expect(output.length).toBe(count); // second source still holds it
    piano.shift(1);
    expect(output.at(-1)?.data).toEqual([0x80, 60, 0]);
    expect(piano.octave).toBe(5);
    expect(piano.active(0)).toBe(false);
    piano.down('KeyZ', 0);
    expect(output.at(-1)?.data).toEqual([0x90, 72, 100]);
    piano.release();
    expect(PIANO_KEYS.map((k) => k.label).join('')).toBe('YSXDCVGBHNJM');
    vi.restoreAllMocks();
  });
  it('Browser-Routing trennt Programme und Lautstärken nach MIDI-Kanal und räumt Stimmen auf', () => {
    const midi = new MidiRouter();
    const engine = new LoopEngine(midi);
    midi.engine = engine;
    const send = vi.fn(),
      clear = vi.fn();
    midi.browser.send = send;
    midi.browser.clearTrack = clear;
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    midi.configure(0, 1000);
    midi.configure(1, 1000);
    expect(send).toHaveBeenCalledWith([0xc0, 0], 1000);
    expect(send).toHaveBeenCalledWith([0xc1, 0], 1000);
    midi.send(1, [0x90, 48, 100], 1030);
    expect(send).toHaveBeenCalledWith([0x91, 48, 100], 1030);
    send.mockClear();
    engine.mute(1, 1000);
    expect(send).toHaveBeenCalledWith([0xb1, 7, 0], 1000);
    expect(send).not.toHaveBeenCalledWith([0xb0, 7, 100], 1000);
    expect(clear).toHaveBeenCalledTimes(1);
    engine.clear(1, 1000);
    expect(clear).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });
  it('Layout-Vertrag mit separatem Piano und Settings und getrennte Piano/Metronom-Keybinds', () => {
    const css = readFileSync(new URL('../styles/workspace.css', import.meta.url), 'utf8').replace(
      /\s+/g,
      '',
    );
    const html = readFileSync(
      new URL('../app/features/midi/midi-looper.html', import.meta.url),
      'utf8',
    );
    expect(css).toContain('.workspace.with-piano');
    expect(css).toContain('.loop-button::before');
    expect(css).toContain('font-size:14px');
    expect(css).toContain('.settings-content{overflow:auto');
    expect(html.indexOf('class="piano-dock')).toBeGreaterThan(html.indexOf('<footer>'));
    expect(html.indexOf('class="settings-panel')).toBeGreaterThan(html.indexOf('</main>'));
    const key = {
      key: 'm',
      code: 'KeyM',
      repeat: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
      shiftKey: false,
    };
    expect(shortcut(key, false, false)).toBeNull();
    expect(shortcut({ ...key, key: 't', code: 'KeyT' }, false, false)).toEqual({ kind: 'metro' });
    expect(shortcut({ ...key, key: '3', code: 'Digit3' }, false, false)).toEqual({
      kind: 'select',
      id: 2,
    });
    expect(shortcut({ ...key, key: ' ', code: 'Space' }, false, false)).toEqual({ kind: 'main' });
    expect(shortcut({ ...key, key: 'M', shiftKey: true }, true, false)).toBeNull();
    expect(shortcut({ ...key, key: 'M', shiftKey: true, repeat: true }, false, false)).toBeNull();
  });
});
