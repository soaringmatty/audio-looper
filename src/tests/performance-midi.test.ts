import { it, expect, vi } from 'vitest';
import { LoopEngine } from '../app/features/midi/loop-engine';
import { MidiRouter } from '../app/features/midi/midi-router';

it('Löschen überlebt asynchrones MIDI-clear: Loop und Live aus, fremde Stimmen und Releases erhalten', () => {
  let now = 1000;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const queue: { data: number[]; at: number }[] = [],
    played: number[][] = [],
    voices = new Set<string>();
  const port = {
    id: 'clp',
    name: 'Clavinova',
    state: 'connected',
    open: async () => {},
    close: async () => {},
    send: vi.fn((data: number[], at = now) => queue.push({ data: [...data], at })),
    clear: vi.fn(() => queue.splice(0)),
  };
  const flush = () => {
    queue.sort((a, b) => a.at - b.at);
    while (queue[0]?.at <= now) {
      const { data } = queue.shift()!;
      played.push(data);
      const op = data[0] & 0xf0,
        ch = data[0] & 15,
        key = `${ch}:${data[1]}`;
      if (op === 0x90 && data[2]) voices.add(key);
      else if (op === 0x80 || op === 0x90) voices.delete(key);
      else if (op === 0xb0 && [120, 123].includes(data[1]))
        for (const k of voices) if (k.startsWith(`${ch}:`)) voices.delete(k);
    }
  };
  const midi = new MidiRouter();
  midi.engine = new LoopEngine(midi);
  midi.outputId = 'clp';
  midi.output = port;
  midi.outputProfile = 'clp625';
  try {
    midi.receive([0x90, 60, 100], now);
    midi.send(0, [0x90, 64, 100], now);
    midi.send(1, [0x90, 67, 100], now);
    midi.send(1, [0x90, 70, 100], now);
    flush();
    expect([...voices].sort()).toEqual(['0:64', '1:67', '1:70', '5:60']);
    now = 1002;
    midi.receive([0x80, 60, 0], now);
    midi.send(1, [0x80, 70, 0], now);
    midi.send(1, [0x80, 67, 0], 1100);
    // No native flush: even the already-due releases are still cancellable.
    const before = played.length;
    midi.engine.clear(0, now);
    flush();
    expect([...voices]).toEqual(['1:67']);
    expect(port.clear).toHaveBeenCalledTimes(1);
    expect(played.slice(before).some((d) => (d[0] & 0xf0) === 0x90)).toBe(false);
    now = 1100;
    flush();
    expect(voices.size).toBe(0);
    now = 1200;
    midi.receive([0x90, 62, 100], now);
    flush();
    expect(voices.has('5:62')).toBe(true);
    midi.engine.clear(0, now);
    flush();
    expect(voices.size).toBe(0);
    midi.outputId = 'browser';
    const clear = vi.spyOn(midi.browser, 'clearTrack');
    midi.engine.clear(2, now);
    expect(clear).toHaveBeenCalledWith(2);
    expect(clear).toHaveBeenCalledWith(7);
  } finally {
    vi.restoreAllMocks();
  }
});

it('verbindet vier gehaltene Akkorde an der Naht, erhält bewusste Pausen und überträgt neue Overdub-Dauertöne', () => {
  const send = vi.fn(),
    e = new LoopEngine({ send, reset: () => {}, resetTrack: () => {} });
  e.afterRecord = 'play';
  e.press(0, 0);
  const input = (data: number[], at: number) => e.input(data, at);
  input([0x90, 60, 100], 100);
  input([0x90, 64, 100], 101);
  input([0x90, 67, 100], 102);
  for (const [at, old, next] of [
    [4100, [64, 67], [65, 69]],
    [8100, [65, 69], [64, 67]],
    [12100, [64, 67], [65, 69]],
  ] as const) {
    for (const n of old) input([0x80, n, 0], at);
    for (const n of next) input([0x90, n, 100], at);
  }
  e.press(0, 16000);
  const t = e.tracks[0];
  expect(
    t.carry
      ?.filter((d) => (d[0] & 0xf0) === 0x90)
      .map((d) => d[1])
      .sort(),
  ).toEqual([60, 65, 69]);
  expect(t.events.some((v) => v.at > 15900 && (v.data[0] & 0xf0) === 0x80)).toBe(false);
  expect(t.events.some((v) => v.at === 100 && v.data[0] === 0x80 && v.data[1] === 65)).toBe(true);
  expect(t.events.some((v) => v.data[1] === 60 && [0x80, 0x90].includes(v.data[0] & 0xf0))).toBe(
    false,
  );
  send.mockClear();
  for (let now = 16000; now < 48000; now += 20) e.tick(now, now + 20);
  expect(send.mock.calls.some(([, d, at]) => d[1] === 60 && at >= 16000)).toBe(false);
  expect(send.mock.calls.some(([, d, at]) => d[0] === 0x80 && d[1] === 65 && at === 32100)).toBe(
    true,
  );
  const rest = new LoopEngine({ send: () => {}, reset: () => {} });
  rest.afterRecord = 'play';
  rest.press(0, 0);
  rest.input([0x90, 60, 100], 100);
  rest.input([0x80, 60, 0], 800);
  rest.press(0, 1000);
  expect(rest.tracks[0].carry).toEqual([]);
  expect(rest.tracks[0].events.some((v) => v.at === 800 && v.data[0] === 0x80)).toBe(true);
  const dubSend = vi.fn(),
    dub = new LoopEngine({ send: dubSend, reset: () => {} });
  Object.assign(dub.tracks[0], {
    state: 'overdub',
    start: 0,
    length: 1000,
    takeStart: 0,
    take: [{ at: 100, data: [0x90, 72, 100] }],
  });
  dub.tick(1000, 1030);
  expect(dubSend).toHaveBeenCalledWith(0, [0x90, 72, 100], 1000);
  dubSend.mockClear();
  dub.tick(2000, 2030);
  expect(dubSend).not.toHaveBeenCalled();
});

it('erkennt Clavinova automatisch, übernimmt Bank/Program nur zur Zielspur und steuert per linkem Pedal ohne Wiederholung', async () => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
  });
  const port = {
    id: 'clav',
    name: 'Clavinova',
    state: 'connected',
    open: async () => {},
    close: async () => {},
    send: vi.fn(),
    clear: vi.fn(),
  };
  const input = { ...port, id: 'clav-in', onmidimessage: null };
  const midi = new MidiRouter();
  midi.engine = new LoopEngine(midi);
  midi.access = {
    inputs: new Map([['clav-in', input]]),
    outputs: new Map([['clav', port]]),
    onstatechange: null,
  };
  try {
    await midi.selectInput('clav-in');
    await midi.selectOutput('clav');
    expect(midi.clavinova).toBe(true);
    expect(midi.monitor).toBe(false);
    midi.engine.selected = 2;
    const before = midi.engine.tracks.map((t) => t.program);
    midi.receive([0xb0, 0, 108]);
    midi.receive([0xb0, 32, 6]);
    midi.receive([0xc0, 0]);
    expect(midi.engine.tracks[2].program).toBe(257);
    expect(midi.engine.tracks.filter((_, id) => id !== 2).map((t) => t.program)).toEqual(
      before.filter((_, id) => id !== 2),
    );
    const messages = port.send.mock.calls.length;
    midi.receive([0xc0, 0]);
    expect(port.send.mock.calls.length).toBe(messages);
    midi.setSyncInstrument(false);
    midi.receive([0xb0, 32, 0]);
    midi.receive([0xc0, 48]);
    expect(midi.engine.tracks[2].program).toBe(257);
    midi.setAutoClavinova(false);
    midi.setProfile('gm');
    await midi.selectOutput('clav');
    expect(midi.clavinova).toBe(false);
    midi.setAutoClavinova(true);
    expect(midi.clavinova).toBe(true);
    expect(store.get('looper-auto-clavinova')).toBe('true');
    const command = vi.fn();
    midi.onLoopPedal = command;
    midi.receive([0xb0, 67, 127], 100);
    midi.receive([0xb0, 67, 100], 101);
    midi.receive([0xb1, 67, 127], 102);
    midi.receive([0xb0, 67, 0], 103);
    midi.receive([0xb1, 67, 127], 104);
    expect(command).toHaveBeenCalledTimes(1);
    midi.receive([0xb1, 67, 0], 105);
    midi.receive([0xb0, 67, 127], 106);
    expect(command).toHaveBeenCalledTimes(2);
    expect(
      midi.engine.tracks.every(
        (t) => !t.events.some((v) => v.data[1] === 67) && !t.take.some((v) => v.data[1] === 67),
      ),
    ).toBe(true);
    midi.setSoftPedalControl(false);
    midi.receive([0xb0, 67, 0], 107);
    midi.receive([0xb0, 67, 127], 108);
    expect(command).toHaveBeenCalledTimes(2);
    expect(store.get('looper-soft-pedal-control')).toBe('false');
  } finally {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});
