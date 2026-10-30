import { midiTemplates } from './source-fixtures';
import { it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { LoopEngine } from '../app/features/midi/loop-engine';
import { MidiRouter } from '../app/features/midi/midi-router';
import { mergeTakes } from '../app/features/midi/midi-events';
import { BrowserSynth } from '../app/features/midi/synth';
import { CLP625_VOICES } from '../app/features/midi/programs';

it('beendet Live-Noten beim Umlauf und erhält Releases nach sofortigem Ende der ersten Zyklushälfte', () => {
  const midi = new MidiRouter(),
    e = new LoopEngine(midi);
  midi.engine = e;
  midi.softPedalControl = false;
  const sent = vi.spyOn(midi.browser, 'send').mockImplementation(() => {});
  const t = e.tracks[0];
  Object.assign(t, { state: 'overdub', start: 0, length: 1000, takeStart: 0 });
  midi.receive([0x90, 60, 100], 10);
  midi.receive([0xb0, 64, 127], 20);
  midi.receive([0xb0, 66, 127], 21);
  midi.receive([0xb0, 67, 127], 22);
  e.tick(995, 1000);
  sent.mockClear();
  e.tick(1000, 1030);
  expect(sent).toHaveBeenCalledWith([0x85, 60, 0], 1000);
  for (const cc of [64, 66, 67]) expect(sent).toHaveBeenCalledWith([0xb5, cc, 0], 1000);
  expect(t.carry).toContainEqual([0x90, 60, 100]); // periodic loop voice, live voice closed
  // Hardware releases after the seam are not re-recorded into the next take.
  midi.receive([0x80, 60, 0], 1050);
  midi.receive([0xb0, 64, 0], 1060);
  expect(t.take).toEqual([]);
  midi.receive([0x90, 62, 100], 1100);
  midi.receive([0xb0, 64, 127], 1110);
  sent.mockClear();
  e.press(0, 1250);
  expect(t.state).toBe('playing');
  expect(sent).not.toHaveBeenCalledWith([0x85, 62, 0], 1250);
  midi.receive([0x80, 62, 0], 1300);
  midi.receive([0xb0, 64, 0], 1310);
  expect(sent).toHaveBeenCalledWith([0x85, 62, 0], 1300);
  expect(sent).toHaveBeenCalledWith([0xb5, 64, 0], 1310);
  expect(sent.mock.calls.some(([d]) => d[0] === 0xb0 && d[1] === 120)).toBe(false);
  sent.mockRestore();
});

it('vereinigt überlappende Noten/Pedale ohne fremde Releases und trennt Live- vom Loop-Kanal', async () => {
  const result = mergeTakes([
    [
      { at: 0, data: [0x90, 60, 100] },
      { at: 5, data: [0xb0, 64, 127] },
      { at: 200, data: [0x80, 60, 0] },
      { at: 400, data: [0xb0, 64, 0] },
    ],
    [
      { at: 100, data: [0x91, 60, 90] },
      { at: 150, data: [0x81, 70, 0] },
      { at: 250, data: [0xb1, 64, 0] },
      { at: 500, data: [0x81, 60, 0] },
    ],
  ]);
  const off = result.filter((v) => (v.data[0] & 0xf0) === 0x80);
  expect(off.map((v) => v.at)).toEqual([100, 500]); // retrigger, then final owner release
  expect(result.find((v) => v.at === 250)?.data[2]).toBe(127);
  expect(result.find((v) => v.at === 400)?.data[2]).toBe(0);
  const midi = new MidiRouter();
  midi.engine = new LoopEngine(midi);
  const send = vi.spyOn(midi.browser, 'send').mockImplementation(() => {});
  midi.receive([0x90, 60, 100], 0);
  midi.receive([0x91, 60, 90], 1);
  midi.send(0, [0x80, 60, 0], 2);
  send.mockClear();
  midi.receive([0x80, 60, 0], 3);
  expect(send).not.toHaveBeenCalled();
  midi.receive([0x81, 60, 0], 4);
  expect(send).toHaveBeenCalledExactlyOnceWith([0x85, 60, 0], 4);
  midi.receive([0xb0, 64, 127], 10);
  midi.receive([0xb1, 64, 127], 11);
  midi.receive([0xb0, 64, 0], 12);
  expect(send).toHaveBeenLastCalledWith([0xb5, 64, 127], 12);
  midi.receive([0xb1, 64, 0], 13);
  expect(send).toHaveBeenLastCalledWith([0xb5, 64, 0], 13);
  const b = new BrowserSynth(),
    programChange = vi.fn(),
    drums = vi.fn();
  (b as any).synth = {
    midiChannels: Array.from({ length: 10 }, () => ({ setDrums: drums })),
    programChange,
    controllerChange: vi.fn(),
  };
  b.channels[0].loaded = true;
  await b.loadProgram(0, 40);
  expect(programChange).toHaveBeenCalledWith(0, 40);
  expect(programChange).toHaveBeenCalledWith(5, 40);
  send.mockRestore();
});

it('fragt MIDI automatisch an, stellt CLP-625 mit zehn echten Presets wieder her und setzt Output-Defaults', async () => {
  const store = new Map([
    ['looper-input', 'clp-in'],
    ['looper-output', 'clp-out'],
  ]);
  const port = {
    id: 'clp-out',
    name: 'Yamaha CLP-625',
    state: 'connected',
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    send: vi.fn(),
    clear: vi.fn(),
  };
  const input = { ...port, id: 'clp-in', onmidimessage: null };
  const request = vi.fn().mockResolvedValue({
    inputs: new Map([['clp-in', input]]),
    outputs: new Map([['clp-out', port]]),
  });
  vi.stubGlobal('navigator', { requestMIDIAccess: request });
  vi.stubGlobal('window', { isSecureContext: true });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
  });
  const midi = new MidiRouter();
  midi.engine = new LoopEngine(midi);
  vi.spyOn(midi.browser, 'enable').mockResolvedValue();
  vi.spyOn(midi.browser, 'send').mockImplementation(() => {});
  try {
    await Promise.all([midi.connect(), midi.connect()]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(midi.midiState).toBe('ready');
    expect(midi.clavinova).toBe(true);
    expect(midi.monitor).toBe(false);
    expect(CLP625_VOICES).toHaveLength(10);
    expect(midi.engine.tracks.every((t) => CLP625_VOICES.some((v) => v.id === t.program))).toBe(
      true,
    );
    for (const voice of CLP625_VOICES) {
      midi.engine.tracks[0].program = voice.id;
      port.send.mockClear();
      midi.configure(0, 100);
      expect(port.send).toHaveBeenCalledWith([0xb0, 0, 108], 100);
      expect(port.send).toHaveBeenCalledWith([0xb0, 32, voice.lsb], 100);
      expect(port.send).toHaveBeenCalledWith([0xc0, voice.program], 100);
      expect(port.send.mock.calls.every(([d]) => (d as number[]).every((v) => v < 256))).toBe(true);
    }
    await midi.selectOutput('browser');
    expect(midi.monitor).toBe(true);
    expect(midi.engine.tracks.map((t) => t.program)).toEqual([0, 0, 48, 40, 128]);
    await midi.selectOutput('clp-out');
    expect(midi.engine.tracks[0].program).toBe(265);
    expect(midi.monitor).toBe(false);
    midi.setProfile('gm');
    expect(midi.clavinova).toBe(false);
    expect(midi.engine.tracks[0].program).toBe(48);
    midi.setProfile('clp625');
    expect(store.get('looper-profile-clp-out')).toBe('clp625');
    const app = readFileSync(
        new URL('../app/features/midi/midi-workspace.ts', import.meta.url),
        'utf8',
      ),
      html = midiTemplates();
    expect(app).toContain('void this.midi.connect()');
    expect(html).toContain('@if (vm.midi.clavinova)');
    expect(html).toContain('class="panic-button"');
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});
