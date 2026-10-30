import { it, expect, vi } from 'vitest';
import { AudioSession } from '../app/features/audio/audio-session';
import { PCMEngine } from '../../public/audio/pcm-engine.js';
const devices = [
  { kind: 'audioinput', deviceId: 'piano', label: 'Klavier', groupId: 'p' },
  { kind: 'audioinput', deviceId: 'default', label: 'Standard · Mikrofon', groupId: 'm' },
  {
    kind: 'audioinput',
    deviceId: 'communications',
    label: 'Kommunikation · Mikrofon',
    groupId: 'm',
  },
  { kind: 'audioinput', deviceId: 'mic', label: 'Mikrofon', groupId: 'm' },
  { kind: 'audioinput', deviceId: 'mic', label: 'Mikrofon (doppelt)', groupId: 'm' },
  { kind: 'audiooutput', deviceId: 'headphones', label: 'Kopfhörer', groupId: 'h' },
  { kind: 'audiooutput', deviceId: 'default', label: 'Standard · Lautsprecher', groupId: 's' },
  {
    kind: 'audiooutput',
    deviceId: 'communications',
    label: 'Kommunikation · Lautsprecher',
    groupId: 's',
  },
  { kind: 'audiooutput', deviceId: 'speakers', label: 'Lautsprecher', groupId: 's' },
];
function fixture(storage = new Map<string, string>(), initial = devices) {
  let available = initial;
  const engine = new PCMEngine(48000),
    sink = vi.fn(async (_id: string) => {});
  const gum = vi.fn(async (c: any) => {
    const id = c.audio.deviceId?.exact || 'mic';
    if (!devices.some((d) => d.kind === 'audioinput' && d.deviceId === id))
      throw Object.assign(Error('missing'), { name: 'NotFoundError' });
    available = devices;
    const track = {
      label: devices.find((d) => d.deviceId === id)!.label,
      getSettings: () => ({ deviceId: id, sampleRate: 48000, channelCount: 2, latency: 0.01 }),
      stop: vi.fn(),
      onended: null,
    };
    return { active: true, getTracks: () => [track], getAudioTracks: () => [track] };
  });
  class Context {
    state = 'running';
    sampleRate = 48000;
    baseLatency = 0.01;
    outputLatency = 0.02;
    destination = {};
    audioWorklet = { addModule: async () => {} };
    resume = async () => {};
    close = async () => {};
    setSinkId(id: string) {
      return sink(id);
    }
    createMediaStreamSource = () => ({ connect: () => {}, disconnect: () => {} });
  }
  class Worklet {
    port: { onmessage: ((e: any) => void) | null; postMessage: (v: any) => void };
    constructor() {
      this.port = {
        onmessage: null,
        postMessage: (c) => {
          engine.command(c);
          this.port.onmessage?.({ data: { type: 'state', state: engine.snapshot(), ack: c.ack } });
        },
      };
    }
    connect = () => {};
    disconnect = () => {};
  }
  vi.stubGlobal('navigator', {
    mediaDevices: {
      enumerateDevices: async () => available,
      getUserMedia: gum,
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
  vi.stubGlobal('AudioContext', Context);
  vi.stubGlobal('AudioWorkletNode', Worklet);
  vi.stubGlobal('document', { baseURI: 'https://looper.test/' });
  vi.stubGlobal('isSecureContext', true);
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
  });
  return { storage, gum, sink };
}
it('nur konkrete Geräte, keine Standard-/Kommunikations-Aliase oder Duplikate; Systemstandard statt erstem Listeneintrag vorwählen', async () => {
  const f = fixture(),
    s = new AudioSession();
  try {
    await s.refreshDevices();
    expect(s.inputs.map((d) => d.deviceId)).toEqual(['piano', 'mic']);
    expect(s.outputs.map((d) => d.deviceId)).toEqual(['headphones', 'speakers']);
    expect(s.inputId).toBe('mic');
    expect(s.outputId).toBe('speakers');
    expect(f.gum).not.toHaveBeenCalled();
  } finally {
    s.dispose();
    vi.unstubAllGlobals();
  }
});
it('Reload lädt konkrete Geräte, Kanalmodus und passendes kalibriertes Profil vor und nach Audiofreigabe; anderes Paar bleibt getrennt', async () => {
  const f = fixture();
  let s = new AudioSession();
  try {
    await s.connect();
    expect(s.ready).toBe(true);
    await s.changeInput('piano');
    await s.changeOutput('headphones');
    await s.changeChannels('left');
    s.setCorrection(275, 'tap', 12);
    expect(JSON.parse(f.storage.get('audio-route-v1')!)).toMatchObject({
      inputId: 'piano',
      outputId: 'headphones',
      channels: 'left',
      rate: 48000,
    });
    s.dispose();
    s = new AudioSession();
    await s.refreshDevices();
    expect([s.inputId, s.outputId, s.channels, s.compensationMs, s.correctionKind]).toEqual([
      'piano',
      'headphones',
      'left',
      275,
      'tap',
    ]);
    expect(s.ready).toBe(false);
    await s.connect();
    expect(s.ready).toBe(true);
    expect(f.gum.mock.calls.at(-1)![0].audio.deviceId.exact).toBe('piano');
    expect(f.sink).toHaveBeenLastCalledWith('headphones');
    expect(s.compensationMs).toBe(275);
    await s.changeOutput('speakers');
    expect(s.compensationMs).toBe(40);
    s.setCorrection(120);
    await s.changeOutput('headphones');
    expect(s.compensationMs).toBe(275);
    expect(s.correctionKind).toBe('tap');
  } finally {
    s.dispose();
    vi.unstubAllGlobals();
  }
});
it('fehlende gespeicherte Geräte: vor Berechtigung nicht verwerfen, nach Freigabe auf konkrete Standardgeräte zurückfallen ohne fremde Korrektur', async () => {
  const storage = new Map([
    [
      'audio-route-v1',
      JSON.stringify({
        inputId: 'removed-mic',
        outputId: 'removed-output',
        channels: 'stereo',
        rate: 48000,
      }),
    ],
    [
      'audio-correction-v2:removed-mic:removed-output:stereo:48000',
      JSON.stringify({ value: 600, kind: 'tap' }),
    ],
  ]);
  const f = fixture(
      storage,
      devices.filter((d) => d.deviceId === 'default' || d.deviceId === 'communications'),
    ),
    s = new AudioSession();
  try {
    await s.refreshDevices();
    expect(s.inputs).toEqual([]);
    expect(s.inputId).toBe('removed-mic');
    expect(JSON.parse(storage.get('audio-route-v1')!).inputId).toBe('removed-mic');
    await s.connect();
    expect(s.ready).toBe(true);
    expect([s.inputId, s.outputId]).toEqual(['mic', 'speakers']);
    expect(f.gum).toHaveBeenCalledTimes(2);
    expect(s.compensationMs).toBe(40);
    expect(s.correctionKind).toBe('estimate');
    expect(JSON.parse(storage.get('audio-route-v1')!)).toMatchObject({
      inputId: 'mic',
      outputId: 'speakers',
    });
  } finally {
    s.dispose();
    vi.unstubAllGlobals();
  }
});
