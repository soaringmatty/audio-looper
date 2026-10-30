import { it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { LoopEngine } from '../app/features/midi/loop-engine';
import { BrowserSynth } from '../app/features/midi/synth';
import { MidiRouter } from '../app/features/midi/midi-router';
import { WorkletSynthesizer } from 'spessasynth_lib';
vi.mock('spessasynth_lib', () => ({ WorkletSynthesizer: vi.fn() }));

it('50-ms-Starttoleranz übernimmt nur aktuelle gehaltene Live-Noten ohne Live-Doppelanschlag oder Rasterverschiebung', () => {
  const send = vi.fn(),
    e = new LoopEngine({ send, reset: () => {} });
  e.afterRecord = 'play';
  e.input([0x90, 60, 90], 960);
  e.input([0x90, 62, 80], 940);
  e.input([0x90, 64, 80], 970);
  e.input([0x80, 64, 0], 980);
  e.press(0, 1000);
  expect(e.origin).toBe(1000);
  expect(e.tracks[0].take).toEqual([{ at: 0, data: [0x90, 60, 90] }]);
  expect(send).not.toHaveBeenCalled();
  e.input([0x80, 60, 0], 1200);
  e.press(0, 2000);
  expect(e.tracks[0].length).toBe(1000);
  expect(e.tracks[0].events).toContainEqual({ at: 200, data: [0x80, 60, 0] });
  const grid = new LoopEngine({ send: () => {}, reset: () => {} });
  grid.useMetronome(0);
  grid.press(0, 1100);
  grid.input([0x90, 67, 99], 1970);
  grid.tick(2000);
  expect(grid.origin).toBe(0);
  expect(grid.tracks[0].start).toBe(2000);
  expect(grid.tracks[0].take).toContainEqual({ at: 0, data: [0x90, 67, 99] });
  const off = new LoopEngine({ send: () => {}, reset: () => {} });
  off.startToleranceMs = 0;
  off.input([0x90, 60, 99], 990);
  off.press(0, 1000);
  expect(off.tracks[0].take).toEqual([]);
  const cleared = new LoopEngine({ send: () => {}, reset: () => {} });
  cleared.input([0x90, 60, 99], 990);
  cleared.clearInputHistory();
  cleared.press(0, 1000);
  expect(cleared.tracks[0].take).toEqual([]);
});

it('Ein Worklet für fünf Kanäle, sofortige Program Changes, Audiofreigabe trotz vorbereiteter Bank und Timestamp-Routing', async () => {
  const postMessage = vi.fn(),
    sendMessage = vi.fn(),
    programChange = vi.fn(),
    add = vi.fn().mockResolvedValue(undefined);
  const synth = {
    connect: vi.fn(),
    isReady: Promise.resolve(),
    setLogLevel: vi.fn(),
    midiChannels: Array.from({ length: 5 }, () => ({ setDrums: vi.fn() })),
    soundBankManager: {
      addSoundBank: add,
      deleteSoundBank: vi.fn().mockResolvedValue(undefined),
      priorityOrder: [],
    },
    programChange,
    controllerChange: vi.fn(),
    sendMessage,
    destroy: vi.fn(),
  };
  const ctx = {
    state: 'suspended',
    currentTime: 3,
    destination: {},
    createGain: () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }),
    audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
    resume: vi.fn(async () => {
      ctx.state = 'running';
    }),
    close: vi.fn(),
  } as any;
  vi.stubGlobal('document', { baseURI: 'http://localhost:4201/' });
  vi.stubGlobal('AudioContext', function () {
    return ctx;
  });
  vi.stubGlobal('AudioWorkletNode', function () {
    return {
      port: { postMessage, addEventListener: vi.fn(), start: vi.fn() },
      onprocessorerror: null,
    };
  });
  vi.mocked(WorkletSynthesizer).mockImplementation(function (_context, options) {
    options!.audioNodeCreators!.worklet(ctx, 'spessa', {} as any);
    return synth as any;
  });
  try {
    const browser = new BrowserSynth();
    vi.spyOn((browser as any).loader, 'load').mockResolvedValue(new ArrayBuffer(16));
    await browser.prepare();
    expect(browser.loaded).toBe(true);
    expect(browser.ready).toBe(false);
    expect(WorkletSynthesizer).toHaveBeenCalledTimes(1);
    const router = new MidiRouter();
    router.browser = browser;
    router.engine = {
      tracks: [0, 32, 48, 4, 88].map((program) => ({ program })),
      invalidate: vi.fn(),
    } as any;
    await router.enableAudio();
    expect(ctx.resume).toHaveBeenCalled();
    expect(browser.ready).toBe(true);
    await browser.loadProgram(2, 49);
    expect(programChange).toHaveBeenCalledWith(2, 49);
    expect(add).toHaveBeenCalledTimes(1);
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    browser.send([0x92, 60, 100], 1030);
    expect(sendMessage).toHaveBeenCalledWith([0x92, 60, 100], 0, { time: 3.03 });
    browser.send([0xb2, 64, 127], 1000);
    expect(sendMessage).toHaveBeenLastCalledWith([0xb2, 64, 127], 0, { time: 3 });
    browser.clear();
    expect(postMessage).toHaveBeenCalledWith({ type: 'looperClear' });
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it('Worklet-Adapter hält absolute Termine ein und verwirft zukünftige Noten beim Cleanup, ohne Engine-Interna zu ändern', () => {
  const file = readFileSync(
    new URL('../../public/audio/looper-processor.js', import.meta.url),
    'utf8',
  );
  const start = file.indexOf('class LooperProcessor extends '),
    end = file.indexOf('registerProcessor(', start);
  const source = file.slice(start, end).replace(/extends \w+ \{/, 'extends Base {');
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
  runInNewContext(source + ';this.Processor=LooperProcessor;', context);
  const processor = new context.Processor({});
  const message = (note: number, time: number) => ({
    type: 'midiMessage',
    channelNumber: -1,
    data: { messageData: [0x90, note, 100], options: { time }, channelOffset: 0 },
  });
  processor.port.dispatch({ data: message(60, 2) });
  expect(received).toEqual([]);
  context.currentTime = 2;
  processor.process([], []);
  expect(received[0].data.messageData[1]).toBe(60);
  expect(received[0].data.options.time).toBe(0);
  processor.port.dispatch({ data: message(64, 3) });
  processor.port.dispatch({ data: { type: 'looperClear' } });
  context.currentTime = 4;
  processor.process([], []);
  expect(received).toHaveLength(2);
  expect(received[1]).toEqual({ type: 'stopAll', channelNumber: -1, data: 1 });
});
