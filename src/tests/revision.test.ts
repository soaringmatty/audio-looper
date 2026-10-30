import { midiTemplates } from './source-fixtures';
import { it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { LoopEngine } from '../app/features/midi/loop-engine';
import { targetState, buttonLabel, countdown } from '../app/features/midi/feedback';
import { PianoController, FULL_PIANO, octaveShortcut } from '../app/features/midi/piano';
it('Freie Folgespur wartet auf vollen Referenzloop, passt Länge an und bestätigt Vormerkungen sofort', () => {
  const e = new LoopEngine({ send: () => {}, reset: () => {} });
  e.afterRecord = 'play';
  e.press(0, 0);
  e.press(0, 8000);
  e.press(1, 9100);
  const t = e.tracks[1];
  expect(e.grid).toBe(8000);
  expect(t.state).toBe('armed');
  expect(t.pending?.at).toBe(16000);
  expect(targetState(t)).toBe('recording');
  expect(buttonLabel(t)).toBe('Aufnahme');
  expect(countdown(t, 10000)).toContain('6.0 s');
  e.tick(15999);
  expect(t.state).toBe('armed');
  e.tick(16000);
  expect(t.state).toBe('recording');
  e.input([0x90, 60, 100], 16010);
  e.press(1, 18100);
  expect(t.length).toBe(2000);
  expect(e.phase(t, 18100)).toBeCloseTo(0.05);
  e.press(1, 18200);
  expect(targetState(t)).toBe('overdub');
  expect(t.state).toBe('playing');
  e.press(1, 18300);
  expect(t.pending).toBeUndefined();
  expect(targetState(t)).toBe('playing');
  e.press(2, 18500);
  e.tick(24000);
  e.press(2, 27500);
  expect(e.tracks[2].pending?.at).toBe(28000);
  e.tick(28000);
  expect(e.tracks[2].length).toBe(4000);
});
it('88 Tasten, markierte Keybind-Oktave, Plus/Minus und separater Hover-Fortschrittsring', () => {
  expect(FULL_PIANO).toHaveLength(88);
  expect(FULL_PIANO[0].note).toBe(21);
  expect(FULL_PIANO.at(-1)?.note).toBe(108);
  expect(FULL_PIANO.filter((k) => !k.black)).toHaveLength(52);
  const sent: number[][] = [];
  const piano = new PianoController((data) => sent.push(data));
  piano.downNote('pointer:1', 21);
  piano.down('KeyZ', 0);
  expect(sent).toEqual([
    [0x90, 21, 100],
    [0x90, 60, 100],
  ]);
  piano.shift(1);
  expect(sent).toContainEqual([0x80, 21, 0]);
  expect(sent).toContainEqual([0x80, 60, 0]);
  expect(piano.binding(72)).toBe('Y');
  expect(piano.mapped(71)).toBe(false);
  expect(piano.mapped(83)).toBe(true);
  const base = {
    key: '+',
    code: 'BracketRight',
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
  };
  expect(octaveShortcut(base)).toBe(1);
  expect(octaveShortcut({ ...base, key: '-', code: 'NumpadSubtract' })).toBe(-1);
  expect(octaveShortcut({ ...base, repeat: true })).toBe(0);
  expect(octaveShortcut({ ...base, ctrlKey: true })).toBe(0);
  piano.shift(100);
  expect(piano.octave).toBe(7);
  piano.shift(-100);
  expect(piano.octave).toBe(1);
  const css = readFileSync(new URL('../styles/workspace.css', import.meta.url), 'utf8').replace(
      /\s+/g,
      '',
    ),
    html = midiTemplates();
  expect(css).toContain('.loop-button::before');
  expect(css).toContain('background:conic-gradient(var(--tone)var(--progress)');
  expect(css).toMatch(
    /\.loop-button:hover:not\(:disabled\)::before\{filter:brightness\(1\.2\);?\}/,
  );
  expect(css).toContain('font-size:14px');
  expect(html).toContain('@for (k of vm.fullPiano');
  expect(html).toContain('Vorgemerkt');
  expect(html).not.toContain('>Panic</button>');
});

// The former smplr adapter cases are superseded by soundfont.test.ts and live Worklet checks.
