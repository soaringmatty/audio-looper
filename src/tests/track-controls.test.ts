import { midiTemplates } from './source-fixtures';
import { it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { LoopEngine } from '../app/features/midi/loop-engine';
import { MidiRouter } from '../app/features/midi/midi-router';
import { BrowserSynth } from '../app/features/midi/synth';
import { DEFAULT_PROGRAMS, STANDARD_DRUM_KIT } from '../app/features/midi/programs';

it('Spurwahl erzeugt keine Ausgabe; Löschen/Mute/Take-Ende setzen nur die betroffene Spur zurück', () => {
  const send = vi.fn(),
    reset = vi.fn(),
    resetTrack = vi.fn(),
    e = new LoopEngine({ send, reset, resetTrack });
  e.origin = 0;
  e.reference = 1000;
  for (const id of [0, 1])
    Object.assign(e.tracks[id], {
      state: 'playing',
      start: 0,
      length: 1000,
      cursor: 1000,
      events: [
        { at: 0, data: [0x90, 60 + id, 100] },
        { at: 900, data: [0x80, 60 + id, 0] },
      ],
    });
  e.tick(1000, 1030);
  expect(send).toHaveBeenCalledTimes(2);
  const cursor = e.tracks[1].cursor;
  send.mockClear();
  e.select(1);
  expect(send).not.toHaveBeenCalled();
  expect(reset).not.toHaveBeenCalled();
  expect(resetTrack).not.toHaveBeenCalled();
  e.clear(0, 1100);
  expect(resetTrack).toHaveBeenCalledWith(0, 1100);
  expect(send).not.toHaveBeenCalled();
  expect(e.tracks[1].cursor).toBe(cursor);
  expect(e.origin).toBe(0);
  resetTrack.mockClear();
  e.mute(0, 1110);
  expect(resetTrack).toHaveBeenCalledWith(0, 1110);
  expect(send).not.toHaveBeenCalled();
  e.press(2, 1200);
  e.tick(2000, 2000);
  e.input([0x90, 65, 100], 2010);
  e.input([0x80, 65, 0], 2050);
  send.mockClear();
  resetTrack.mockClear();
  e.press(2, 2100);
  e.tick(2125, 2125);
  expect(resetTrack).toHaveBeenCalledWith(2, 2125);
  expect(send.mock.calls.every((c) => c[0] === 2)).toBe(true);
  expect(reset).not.toHaveBeenCalled();
});

it('Worklet und Web MIDI entfernen nur Zielspur-Events; verspätetes Live-Note-Off erreicht keine neu gewählte Spur', () => {
  const file = readFileSync(
    new URL('../../public/audio/looper-processor.js', import.meta.url),
    'utf8',
  );
  const start = file.indexOf('class LooperProcessor extends '),
    end = file.indexOf('registerProcessor(', start);
  const received: any[] = [];
  class Base {
    port: any = {
      onmessage: (e: any) => received.push(e.data),
      capture: null,
      addEventListener: (_type: string, listener: any) => {
        this.port.capture = listener;
      },
      postMessage: () => {},
      start: () => {},
      dispatch: (event: any) => {
        let stopped = false;
        this.port.capture({
          ...event,
          stopImmediatePropagation: () => {
            stopped = true;
          },
        });
        if (!stopped) this.port.onmessage(event);
      },
    };
    process() {
      return true;
    }
  }
  const context: any = { Base, currentTime: 1 };
  runInNewContext(
    file.slice(start, end).replace(/extends \w+ \{/, 'extends Base {') +
      ';this.Processor=LooperProcessor;',
    context,
  );
  const processor = new context.Processor({}),
    msg = (channel: number) => ({
      type: 'midiMessage',
      channelNumber: -1,
      data: { messageData: [0x90 | channel, 60, 100], channelOffset: 0, options: { time: 2 } },
    });
  processor.port.dispatch({ data: msg(0) });
  processor.port.dispatch({ data: msg(1) });
  processor.port.dispatch({ data: { type: 'looperClearTrack', channel: 0 } });
  context.currentTime = 2;
  processor.process([], []);
  const notes = received.filter(
    (m) => m.type === 'midiMessage' && (m.data.messageData[0] & 0xf0) === 0x90,
  );
  expect(notes).toHaveLength(1);
  expect(notes[0].data.messageData[0]).toBe(0x91);
  const midi = new MidiRouter();
  midi.engine = new LoopEngine(midi);
  const port = {
    id: 'test',
    state: 'connected',
    send: vi.fn(),
    clear: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
  };
  midi.outputId = 'test';
  midi.output = port as any;
  let now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  try {
    midi.send(1, [0x90, 61, 100], 1000);
    midi.send(0, [0x90, 60, 100], 1010);
    midi.send(1, [0x80, 61, 0], 1020);
    port.send.mockClear();
    now = 1005;
    midi.resetTrack(0, 1005);
    expect(port.send).toHaveBeenCalledWith([0x81, 61, 0], 1020);
    expect(port.send.mock.calls.some(([d]) => (d[0] & 0xf0) === 0x90)).toBe(false);
    now = 1030;
    port.send.mockClear();
    midi.resetTrack(0, 1030);
    expect(port.send.mock.calls.some(([, at]) => at === 1020)).toBe(false);
    midi.outputId = 'browser';
    const live = vi.spyOn(midi.browser, 'send').mockImplementation(() => {});
    midi.receive([0x90, 64, 100], 1040);
    midi.releaseInput(1050);
    midi.engine.select(1);
    live.mockClear();
    midi.receive([0x80, 64, 0], 1060);
    expect(live).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

it('Piano/Piano/Strings/Violin/Drums, getrennte Oktaven und echtes Drum-Routing statt Program 128 auf MIDI', async () => {
  const e = new LoopEngine({ send: () => {}, reset: () => {} });
  expect(e.tracks.map((t) => t.program)).toEqual([0, 0, 48, 40, 128]);
  expect(e.tracks.map((t) => t.octave)).toEqual([4, 4, 4, 4, 2]);
  const midi = new MidiRouter();
  midi.engine = e;
  const output = { state: 'connected', send: vi.fn(), clear: vi.fn() };
  midi.outputId = 'external';
  midi.output = output as any;
  midi.configure(4, 0);
  midi.send(4, [0x90, 36, 100], 0);
  expect(output.send).toHaveBeenCalledWith([0xc9, 0], 0);
  expect(output.send).toHaveBeenCalledWith([0x99, 36, 100], 0);
  e.tracks[4].program = 0;
  midi.configure(4, 0);
  midi.send(4, [0x90, 60, 100], 0);
  expect(output.send).toHaveBeenCalledWith([0x94, 60, 100], 0);
  const b = new BrowserSynth(),
    setDrums = vi.fn(),
    programChange = vi.fn();
  (b as any).synth = {
    midiChannels: Array.from({ length: 5 }, () => ({ setDrums })),
    programChange,
    controllerChange: vi.fn(),
  };
  b.channels[4].loaded = true;
  await b.loadProgram(4, STANDARD_DRUM_KIT);
  expect(setDrums).toHaveBeenCalledWith(true);
  expect(programChange).toHaveBeenCalledWith(4, 0);
  expect(b.channels[4].activeProgram).toBe(128);
  const html = midiTemplates(),
    css = readFileSync(new URL('../styles/workspace.css', import.meta.url), 'utf8').replace(
      /\s+/g,
      '',
    );
  expect(html).toContain('Ausgewählt');
  expect(html).toContain('Eingabe →');
  expect(html).toContain('Standard Drum Kit');
  expect(css).not.toContain('border-top:4pxsolid #458cdd');
  expect(css).not.toContain('border-top:4pxsolid #8bc1ff');
  expect(DEFAULT_PROGRAMS).toHaveLength(5);
});
