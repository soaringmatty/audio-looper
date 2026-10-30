import { WorkletSynthesizer } from 'spessasynth_lib';
import { SoundBankLoader, SOUND_BANKS, SoundBankId } from './soundbanks';
import { DEFAULT_PROGRAMS, isDrumProgram, wireProgram } from './programs';
import { outputDelayMs } from '../../shared/audio-presentation';
interface Channel {
  program: number;
  activeProgram: number;
  status: string;
  volume: number;
  pan: number;
  loaded: boolean;
}
export class BrowserSynth {
  context?: AudioContext;
  private master?: GainNode;
  private synth?: WorkletSynthesizer;
  private port?: MessagePort;
  private initializing?: Promise<void>;
  private loading?: Promise<void>;
  private loader = new SoundBankLoader();
  private disposed = false;
  bankId: SoundBankId = 'generaluser';
  requestedBank: SoundBankId = 'generaluser';
  bankLoading = false;
  error = '';
  onTrace: (kind: string, detail: unknown) => void = () => {};
  diagnostics() {
    return {
      state: this.state,
      sampleRate: this.context?.sampleRate,
      baseLatencyMs: this.context ? this.context.baseLatency * 1000 : null,
      outputLatencyMs:
        this.context && Number.isFinite(this.context.outputLatency)
          ? this.context.outputLatency * 1000
          : null,
      estimatedTotalMs: outputDelayMs(this.context),
      contextState: this.context?.state,
      sinkId: this.context && 'sinkId' in this.context ? this.context.sinkId : undefined,
      contextTime: this.context?.currentTime,
    };
  }
  onChange = () => {};
  onBankChanged = () => {};
  channels: Channel[] = Array.from({ length: 5 }, () => ({
    program: -1,
    activeProgram: -1,
    status: 'Soundbank vorbereiten',
    volume: 100,
    pan: 64,
    loaded: false,
  }));
  get ready(): boolean {
    return this.context?.state === 'running';
  }
  get loaded(): boolean {
    return !!this.synth && this.channels.every((c) => c.loaded);
  }
  get state(): 'ready' | 'loading' | 'error' | 'idle' {
    return this.error
      ? 'error'
      : this.bankLoading || !this.loaded
        ? 'loading'
        : this.ready
          ? 'ready'
          : 'idle';
  }
  trackReady(id: number): boolean {
    return this.ready && this.channels[id].loaded;
  }
  private init(): Promise<void> {
    if (this.initializing) return this.initializing;
    this.context ??= new AudioContext({ latencyHint: 'interactive' });
    this.master = this.context.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(this.context.destination);
    const task = (async () => {
      await this.context!.audioWorklet.addModule(
        new URL('audio/looper-processor.js', document.baseURI).href,
      );
      if (this.disposed) return;
      this.synth = new WorkletSynthesizer(this.context!, {
        audioNodeCreators: {
          worklet: (ctx, name, options) => {
            const node = new AudioWorkletNode(ctx, name, options);
            this.port = node.port;
            node.port.addEventListener('message', (event) => {
              if (event.data?.type === 'looperTrace') this.onTrace('worklet', event.data);
            });
            node.port.start();
            node.onprocessorerror = () => {
              this.error = 'AudioWorklet unterbrochen. Seite neu laden.';
              this.onChange();
            };
            return node;
          },
        },
      });
      this.synth.connect(this.master!);
      this.synth.setLogLevel(false, true, false);
      await this.synth.isReady;
    })();
    this.initializing = task.catch((error) => {
      this.initializing = undefined;
      throw error;
    });
    return this.initializing;
  }
  async prepare(programs = DEFAULT_PROGRAMS): Promise<void> {
    programs.forEach((p, id) => {
      this.channels[id].program = p;
    });
    await this.init();
    if (!this.loaded) await this.selectBank(this.requestedBank);
  }
  async wake(): Promise<void> {
    this.context ??= new AudioContext({ latencyHint: 'interactive' });
    await this.context.resume();
  }
  async enable(programs = DEFAULT_PROGRAMS): Promise<void> {
    await Promise.all([this.wake(), this.prepare(programs)]);
  }
  async selectBank(id: SoundBankId): Promise<void> {
    if (!SOUND_BANKS.some((b) => b.id === id)) return;
    if (this.loading) {
      await this.loading;
      if (id !== this.bankId) return this.selectBank(id);
      return;
    }
    if (this.loaded && id === this.bankId) {
      this.requestedBank = id;
      this.error = '';
      for (const c of this.channels)
        c.status = `${SOUND_BANKS.find((b) => b.id === id)!.name} · bereit`;
      this.onChange();
      return;
    }
    this.requestedBank = id;
    this.bankLoading = true;
    this.error = '';
    this.onChange();
    const operation = (async () => {
      await this.init();
      const data = await this.loader.load(id, (text) => {
        for (const c of this.channels)
          c.status = this.loaded ? `${text} · bisherige Bank aktiv` : text;
        this.onChange();
      });
      if (this.disposed) return;
      await this.synth!.soundBankManager.addSoundBank(data, id);
      this.clear();
      this.synth!.soundBankManager.priorityOrder = [id, this.bankId].filter(
        (value, index, array) => array.indexOf(value) === index,
      );
      if (this.loaded && this.bankId !== id)
        await this.synth!.soundBankManager.deleteSoundBank(this.bankId);
      this.bankId = id;
      for (let i = 0; i < this.channels.length; i++) {
        const c = this.channels[i];
        c.loaded = true;
        this.applyChannel(i);
        c.status = `${SOUND_BANKS.find((b) => b.id === id)!.name} · bereit`;
      }
      this.onBankChanged();
    })()
      .catch((error) => {
        this.error = `Soundbank-Ladefehler: ${String(error)}`;
        for (const c of this.channels)
          c.status = `Ladefehler${c.loaded ? ' · bisherige Bank aktiv' : ''}`;
        throw error;
      })
      .finally(() => {
        this.bankLoading = false;
        this.loading = undefined;
        this.onChange();
      });
    this.loading = operation;
    return operation;
  }
  private applyChannel(id: number): void {
    const c = this.channels[id];
    if (!c.loaded || !this.synth) return;
    for (const channel of [id, id + 5]) {
      this.synth.midiChannels[channel]?.setDrums(isDrumProgram(c.program));
      this.synth.programChange(channel, Math.max(0, wireProgram(c.program)));
      this.synth.controllerChange(channel, 7, c.volume);
      this.synth.controllerChange(channel, 10, c.pan);
    }
    c.activeProgram = c.program;
  }
  async loadProgram(id: number, program: number): Promise<void> {
    const c = this.channels[id];
    if (c.program === program && c.activeProgram === program) return;
    if (c.loaded) {
      this.clearTrack(id);
      this.clearTrack(id + 5);
    }
    c.program = program;
    this.applyChannel(id);
    this.onChange();
  }
  send(data: number[], at: number): void {
    const id = data[0] & 15,
      c = this.channels[id % 5];
    if (id >= 10 || !c) return;
    const op = data[0] & 0xf0;
    if (op === 0xc0) {
      void this.loadProgram(id % 5, data[1]);
      return;
    }
    if (op === 0xb0 && data[1] === 7) c.volume = data[2];
    if (op === 0xb0 && data[1] === 10) c.pan = data[2];
    if (!c.loaded || !this.synth) return;
    const time = this.context!.currentTime + Math.max(0, at - performance.now()) / 1000;
    this.synth.sendMessage(data, 0, { time });
  }
  clear(): void {
    this.port?.postMessage({ type: 'looperClear' });
  }
  clearTrack(id: number): void {
    this.onTrace('worklet-clear-request', { channel: id });
    this.port?.postMessage({ type: 'looperClearTrack', channel: id });
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    this.clear();
    this.synth?.destroy();
    this.master?.disconnect();
    await this.context?.close();
  }
}
