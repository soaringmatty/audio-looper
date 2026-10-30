import { MidiTrace } from './midi-trace';
import { LoopEngine, MidiSink } from './loop-engine';
import { BrowserSynth } from './synth';
import {
  outputChannel,
  wireProgram,
  DEFAULT_PROGRAMS,
  CLP625_VOICES,
  isDrumProgram,
} from './programs';
import { PEDAL_CONTROLLERS } from './midi-events';
interface Port {
  id: string;
  name?: string;
  state: string;
  open(): Promise<Port>;
  close(): Promise<Port>;
}
interface Input extends Port {
  onmidimessage: ((e: { data: Uint8Array; timeStamp: number }) => void) | null;
}
interface Output extends Port {
  send(data: number[], at?: number): void;
  clear?(): void;
}
interface Access {
  inputs: Map<string, Input>;
  outputs: Map<string, Output>;
  onstatechange: (() => void) | null;
}
export type OutputProfile = 'gm' | 'clp625';
export class MidiRouter implements MidiSink {
  readonly trace = new MidiTrace();
  access?: Access;
  input?: Input;
  output?: Output;
  inputId = 'piano';
  outputId = 'browser';
  monitor = true;
  outputProfile: OutputProfile = 'gm';
  midiState: 'idle' | 'requesting' | 'ready' | 'error' = 'idle';
  message = 'Browser-Piano bereit.';
  browser = new BrowserSynth();
  engine!: LoopEngine;
  onChange = () => {};
  autoClavinova = true;
  syncInstrument = true;
  clavinovaProgram = CLP625_VOICES[0].id;
  clavinovaProgramKnown = false;
  softPedalControl = true;
  onLoopPedal = () => {};
  onInstrumentChange = (track: number, program: number) => {
    this.releaseInput();
    this.engine.tracks[track].program = program;
    this.engine.invalidateTrack(track, performance.now());
    this.onChange();
  };
  private activating?: Promise<boolean>;
  private connecting?: Promise<void>;
  private scheduled: { track: number; data: number[]; at: number; port: Output }[] = [];
  private configuredChannels = DEFAULT_PROGRAMS.map((p, id) => outputChannel(id, p));
  private profilePrograms = new Map<string, number[]>();
  private liveNotes = new Map<string, { track: number; data: number[]; count: number }>();
  private livePedals = new Map<string, { track: number; data: number[] }>();
  private liveCounts = new Map<string, number>();
  private ignoredRelease = new Set<string>();
  private banks = new Map<number, { msb?: number; lsb?: number }>();
  private commandPedals = new Map<number, boolean>();
  private commandDown = false;
  private externalNotes = new Map<
    string,
    { track: number; channel: number; note: number; active: boolean }
  >();
  private externalPedals = new Map<
    string,
    { track: number; channel: number; cc: number; value: number }
  >();
  snapshot() {
    return structuredClone({
      input: { id: this.inputId, name: this.input?.name },
      output: {
        id: this.outputId,
        name: this.output?.name,
        profile: this.outputProfile,
        canClearQueue: typeof this.output?.clear === 'function',
      },
      monitor: this.monitor,
      liveNotes: [...this.liveNotes],
      livePedals: [...this.livePedals],
      liveCounts: [...this.liveCounts],
      ignoredRelease: [...this.ignoredRelease],
      externalNotes: [...this.externalNotes],
      externalPedals: [...this.externalPedals],
      scheduled: this.scheduled.map(({ port, ...event }) => ({ ...event, port: port.id })),
      tracks: this.engine?.tracks.map((t) => ({
        id: t.id,
        state: t.state,
        start: t.start,
        length: t.length,
        pending: t.pending,
        cursor: t.cursor,
        program: t.program,
        muted: t.muted,
        events: t.events.length,
        take: t.take.slice(-128),
      })),
      audio: this.browser.diagnostics(),
      timing: this.timingStats,
    });
  }
  timingStats = { received: 0, lastDispatchMs: 0, maxDispatchMs: 0 };
  constructor() {
    this.trace.configure(() => this.snapshot());
    this.browser.onTrace = (kind, detail) => this.trace.record(kind, detail);
    this.autoClavinova = this.read('looper-auto-clavinova') !== 'false';
    this.syncInstrument = this.read('looper-sync-instrument') !== 'false';
    this.softPedalControl = this.read('looper-soft-pedal-control') !== 'false';
    this.browser.onChange = () => this.onChange();
    this.browser.onBankChanged = () => {
      if (this.outputId === 'browser') this.engine?.invalidate(performance.now());
      this.onChange();
    };
  }
  get inputs(): Input[] {
    return [...(this.access?.inputs.values() ?? [])].filter((p) => p.state === 'connected');
  }
  get outputs(): Output[] {
    return [...(this.access?.outputs.values() ?? [])].filter((p) => p.state === 'connected');
  }
  get outputReady(): boolean {
    return this.outputId === 'browser' ? this.browser.ready : !!this.output;
  }
  get clavinova(): boolean {
    return this.outputId !== '' && this.outputId !== 'browser' && this.outputProfile === 'clp625';
  }
  get autoProfileActive(): boolean {
    return this.autoClavinova && /clavinova|clp[- _]?625/i.test(this.output?.name ?? '');
  }
  channel(id: number): number {
    return this.outputId === 'browser' || this.clavinova
      ? id
      : outputChannel(id, this.engine.tracks[id].program);
  }
  private liveChannel(id: number): number {
    return this.outputId === 'browser'
      ? id + 5
      : isDrumProgram(this.engine.tracks[id].program)
        ? 9
        : id + 5;
  }
  async enableAudio(): Promise<boolean> {
    if (this.activating) return this.activating;
    if (this.browser.loaded && this.browser.ready) return true;
    this.activating = this.activate();
    try {
      return await this.activating;
    } finally {
      this.activating = undefined;
    }
  }
  async prepareAudio(): Promise<void> {
    try {
      await this.browser.prepare(this.engine.tracks.map((t) => t.program));
    } catch (e) {
      this.message = `Soundbank noch nicht bereit: ${String(e)}`;
    }
    this.onChange();
  }
  private async activate(): Promise<boolean> {
    try {
      const ready = this.browser.ready;
      await this.browser.enable(this.engine.tracks.map((t) => t.program));
      if (!ready) this.engine.invalidate(performance.now());
      this.onChange();
      return true;
    } catch (e) {
      this.message = `Browser-Audio nicht verfügbar: ${String(e)}`;
      this.onChange();
      return false;
    }
  }
  onNoteInput: (at: number) => void = () => {};
  receive(data: number[], now = performance.now(), receivedAt = now): void {
    this.trace.record(
      'input',
      { data: [...data], selected: this.engine.selected, receivedAt },
      now,
    );
    if ((data[0] & 0xf0) === 0x90 && data[2]) this.onNoteInput(receivedAt);
    const op = data[0] & 0xf0;
    if (
      ![0x80, 0x90, 0xa0, 0xb0, 0xc0, 0xd0, 0xe0].includes(op) ||
      data.length < ([0xc0, 0xd0].includes(op) ? 2 : 3)
    )
      return;
    if (data.some((v, i) => !Number.isInteger(v) || v < 0 || v > (i === 0 ? 255 : 127))) return;
    const source = data[0] & 15;
    if (op === 0xb0 && [0, 32].includes(data[1])) {
      const bank = this.banks.get(source) ?? {};
      if (data[1] === 0) bank.msb = data[2];
      else bank.lsb = data[2];
      this.banks.set(source, bank);
      return;
    }
    if (op === 0xc0) {
      this.receiveProgram(source, data[1]);
      return;
    }
    if (op === 0xb0 && data[1] === 67) {
      const wasDown = this.commandDown,
        pressed = this.commandPedals.get(source) ?? false;
      this.commandPedals.set(source, pressed ? data[2] >= 32 : data[2] >= 64);
      this.commandDown = [...this.commandPedals.values()].some(Boolean);
      if (this.softPedalControl) {
        if (this.commandDown && !wasDown) this.onLoopPedal();
        return;
      }
    }
    if (
      op === 0xb0 &&
      (data[1] === 0 || data[1] === 32 || data[1] === 7 || data[1] === 11 || data[1] >= 120)
    )
      return;
    this.engine.tick(now, now);
    let track = this.engine.selected;
    const key = `${data[0] & 15}:${op === 0xb0 ? 'cc:' : ''}${data[1]}`;
    if (op === 0x90 && data[2]) {
      this.ignoredRelease.delete(key);
      const previous = this.liveNotes.get(key);
      track = previous?.track ?? track;
      this.liveNotes.set(key, { track, data: [...data], count: (previous?.count ?? 0) + 1 });
    } else if (op === 0x80 || op === 0x90) {
      if (this.ignoredRelease.delete(key)) return;
      const note = this.liveNotes.get(key);
      if (!note) return;
      track = note.track;
      if (--note.count <= 0) this.liveNotes.delete(key);
    } else if (op === 0xb0 && PEDAL_CONTROLLERS.includes(data[1])) {
      const previous = this.livePedals.get(key);
      track = previous?.track ?? track;
      if (data[2] > 0) {
        this.ignoredRelease.delete(key);
        this.livePedals.set(key, { track, data: [...data] });
      } else {
        if (this.ignoredRelease.delete(key)) return;
        this.livePedals.delete(key);
      }
    }
    this.engine.input(data, now, track, receivedAt);
    this.trace.record('input-routed', { track, data: [...data], monitor: this.monitor }, now);
    if (this.monitor && !this.engine.tracks[track].muted) this.sendLive(track, data, now);
  }
  private receiveProgram(channel: number, program: number): void {
    if (!this.syncInstrument && !this.clavinova) return;
    const bank = this.banks.get(channel);
    const yamaha = this.clavinova || /clavinova|clp[- _]?625/i.test(this.input?.name ?? '');
    let selected = program;
    if (yamaha) {
      const voice = CLP625_VOICES.find(
        (v) =>
          v.program === program &&
          v.msb === bank?.msb &&
          v.lsb === (bank?.lsb === 100 && program === 0 ? 0 : bank?.lsb),
      );
      if (!voice) {
        this.message =
          'Instrumentwechsel empfangen, aber keine eindeutige CLP-Bankzuordnung. Klang am Klavier erneut wählen.';
        this.onChange();
        return;
      }
      selected = this.clavinova ? voice.id : voice.program;
      this.clavinovaProgram = voice.id;
      this.clavinovaProgramKnown = true;
      if (this.clavinova) {
        this.onChange();
        return;
      }
    } else if (this.clavinova) return;
    const track = this.engine.selected;
    if (this.engine.tracks[track].program !== selected) this.onInstrumentChange(track, selected);
  }
  setAutoClavinova(value: boolean): void {
    this.autoClavinova = value;
    this.persist('auto-clavinova', String(value));
    if (value && /clavinova|clp[- _]?625/i.test(this.output?.name ?? '')) this.setProfile('clp625');
    this.onChange();
  }
  setSyncInstrument(value: boolean): void {
    this.syncInstrument = value;
    this.persist('sync-instrument', String(value));
  }
  setSoftPedalControl(value: boolean): void {
    this.releaseInput();
    this.softPedalControl = value;
    this.persist('soft-pedal-control', String(value));
  }
  private sendLive(track: number, data: number[], at: number): void {
    if (
      this.clavinova &&
      !this.engine.tracks[track].length &&
      this.engine.tracks[track].program !== this.clavinovaProgram
    ) {
      this.engine.tracks[track].program = this.clavinovaProgram;
      this.configure(track, at);
    }
    const op = data[0] & 0xf0,
      key = `${track}:${data[1]}`,
      count = this.liveCounts.get(key) ?? 0;
    if (op === 0xb0 && PEDAL_CONTROLLERS.includes(data[1])) {
      data = [...data];
      data[2] = Math.max(
        0,
        ...[...this.livePedals.values()]
          .filter((p) => p.track === track && p.data[1] === data[1])
          .map((p) => p.data[2]),
      );
    }
    if (op === 0x90 && data[2]) {
      if (count) this.deliver(track, [0x80, data[1], 0], at, this.liveChannel(track));
      this.liveCounts.set(key, count + 1);
    } else if (op === 0x80 || op === 0x90) {
      if (!count) return;
      this.liveCounts.set(key, count - 1);
      if (count > 1) return;
    }
    this.deliver(track, data, at, this.liveChannel(track));
  }
  // Separate live channels prevent loop Note-Off/pedals from affecting live voices.
  releaseInput(now = performance.now()): void {
    const notes = [...this.liveNotes],
      pedals = [...this.livePedals];
    this.liveNotes.clear();
    this.livePedals.clear();
    for (const [key, note] of notes) {
      this.ignoredRelease.add(key);
      for (let i = 0; i < note.count; i++) {
        const off = [0x80 | (note.data[0] & 15), note.data[1], 0];
        this.engine.input(off, now, note.track);
        if (this.monitor && !this.engine.tracks[note.track].muted)
          this.sendLive(note.track, off, now);
      }
    }
    for (const [key, pedal] of pedals) {
      const off = [...pedal.data];
      off[2] = 0;
      this.ignoredRelease.add(key);
      this.engine.input(off, now, pedal.track);
      if (this.monitor && !this.engine.tracks[pedal.track].muted)
        this.sendLive(pedal.track, off, now);
    }
  }
  closeLiveTake(track: number, at: number): void {
    // Never call input() recursively from inside engine.tick().
    for (const [key, note] of this.liveNotes)
      if (note.track === track) {
        this.liveNotes.delete(key);
        this.ignoredRelease.add(key);
        if (this.monitor)
          for (let i = 0; i < note.count; i++) this.sendLive(track, [0x80, note.data[1], 0], at);
      }
    for (const [key, pedal] of this.livePedals)
      if (pedal.track === track) {
        this.livePedals.delete(key);
        this.ignoredRelease.add(key);
        if (this.monitor) this.sendLive(track, [0xb0, pedal.data[1], 0], at);
      }
  }
  closeReleaseTail(
    track: number,
    notes: Record<string, number>,
    pedals: string[],
    at: number,
  ): void {
    for (const [key, count] of Object.entries(notes)) {
      const live = this.liveNotes.get(key);
      if (!live || live.track !== track || !count) continue;
      const release = Math.min(count, live.count);
      live.count -= release;
      if (!live.count) {
        this.liveNotes.delete(key);
        this.ignoredRelease.add(key);
      }
      if (this.monitor)
        for (let i = 0; i < release; i++) this.sendLive(track, [0x80, live.data[1], 0], at);
    }
    for (const key of pedals) {
      const pedal = this.livePedals.get(key.replace(':', ':cc:'));
      if (!pedal || pedal.track !== track) continue;
      const sourceKey = key.replace(':', ':cc:');
      this.livePedals.delete(sourceKey);
      this.ignoredRelease.add(sourceKey);
      if (this.monitor) this.sendLive(track, [0xb0, pedal.data[1], 0], at);
    }
  }
  async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    this.connecting = this.connectPorts();
    try {
      await this.connecting;
    } finally {
      this.connecting = undefined;
    }
  }
  private async connectPorts(): Promise<void> {
    try {
      const nav = navigator as unknown as {
        requestMIDIAccess?: (options: { sysex: boolean; software: boolean }) => Promise<Access>;
      };
      if (!nav.requestMIDIAccess || !window.isSecureContext)
        throw Error('Web MIDI benötigt Chrome/Edge und localhost oder HTTPS.');
      if (this.access) {
        this.onChange();
        return;
      }
      this.midiState = 'requesting';
      this.onChange();
      this.access = await nav.requestMIDIAccess({ sysex: false, software: true });
      this.midiState = 'ready';
      this.access.onstatechange = () => {
        if (this.input?.state === 'disconnected' || this.output?.state === 'disconnected') {
          this.releaseInput();
          this.engine.clearInputHistory();
          this.reset(performance.now());
          this.message = 'Gerät getrennt. Verbindung erneut auswählen; Loops bleiben erhalten.';
          if (this.input?.state === 'disconnected') {
            this.clavinovaProgram = CLP625_VOICES[0].id;
            this.clavinovaProgramKnown = false;
            this.input.onmidimessage = null;
            this.input = undefined;
          }
          if (this.output?.state === 'disconnected') this.output = undefined;
        }
        this.onChange();
      };
      this.message = 'MIDI bereit · Eingang und Ausgang auswählen.';
      const input = this.read('looper-input'),
        output = this.read('looper-output');
      if (input && this.inputs.some((p) => p.id === input)) await this.selectInput(input);
      if (output && this.outputs.some((p) => p.id === output)) await this.selectOutput(output);
    } catch (e) {
      this.midiState = 'error';
      this.message = e instanceof Error ? e.message : 'MIDI-Zugriff verweigert.';
    }
    this.onChange();
  }
  async selectInput(id: string): Promise<void> {
    try {
      if (id !== this.inputId) {
        this.clavinovaProgram = CLP625_VOICES[0].id;
        this.clavinovaProgramKnown = false;
      }
      this.releaseInput();
      this.engine.clearInputHistory();
      this.banks.clear();
      this.commandPedals.clear();
      this.commandDown = false;
      if (this.input) {
        this.input.onmidimessage = null;
        await this.input.close();
      }
      this.input = undefined;
      this.inputId = id;
      const port = this.access?.inputs.get(id);
      if (port) {
        await port.open();
        this.input = port;
        port.onmidimessage = (e) => {
          const handledAt = performance.now();
          const receivedAt =
            Number.isFinite(e.timeStamp) &&
            e.timeStamp > 0 &&
            e.timeStamp <= handledAt &&
            handledAt - e.timeStamp < 60000
              ? e.timeStamp
              : handledAt;
          this.timingStats.received++;
          this.timingStats.lastDispatchMs = handledAt - receivedAt;
          this.timingStats.maxDispatchMs = Math.max(
            this.timingStats.maxDispatchMs,
            handledAt - receivedAt,
          );
          this.trace.record(
            'midi-received',
            { data: Array.from(e.data), receivedAt, handledAt, dispatchMs: handledAt - receivedAt },
            receivedAt,
          );
          this.receive(Array.from(e.data), handledAt, receivedAt);
        };
      }
      this.persist('input', id);
    } catch (e) {
      this.message = `Eingang nicht verfügbar: ${String(e)}`;
    }
    this.onChange();
  }
  private get programKey(): string {
    return this.outputId === 'browser' ? 'browser' : this.outputProfile;
  }
  private switchPrograms(previous: string): void {
    this.profilePrograms.set(
      previous,
      this.engine.tracks.map((t) => t.program),
    );
    const key = this.programKey;
    const programs =
      this.profilePrograms.get(key) ??
      this.engine.tracks.map((t) => {
        if (key === 'clp625') return CLP625_VOICES[0].id;
        const voice = CLP625_VOICES.find((v) => v.id === t.program);
        return voice?.program ?? t.program;
      });
    this.engine.tracks.forEach((t, id) => {
      t.program = programs[id];
    });
  }
  async selectOutput(id: string): Promise<void> {
    try {
      this.releaseInput();
      this.engine.clearInputHistory();
      const previous = this.programKey;
      this.reset(performance.now());
      if (this.output) await this.output.close();
      this.output = undefined;
      this.outputId = id;
      const port = this.access?.outputs.get(id),
        saved = this.read(`looper-profile-${id}`);
      this.outputProfile =
        (this.autoClavinova && /clavinova|clp[- _]?625/i.test(port?.name ?? '')) ||
        saved === 'clp625'
          ? 'clp625'
          : 'gm';
      this.switchPrograms(previous);
      this.monitor = id === 'browser';
      if (id === 'browser') await this.browser.enable(this.engine.tracks.map((t) => t.program));
      if (port) {
        await port.open();
        this.output = port;
      }
      this.engine.invalidate(performance.now());
      this.persist('output', id);
    } catch (e) {
      this.message = `Ausgang nicht verfügbar: ${String(e)}`;
    }
    this.onChange();
  }
  setProfile(profile: OutputProfile): void {
    if (this.outputId === 'browser' || !this.outputId || profile === this.outputProfile) return;
    this.releaseInput();
    this.engine.clearInputHistory();
    const previous = this.programKey;
    this.reset(performance.now());
    this.outputProfile = profile;
    this.switchPrograms(previous);
    this.persist(`profile-${this.outputId}`, profile);
    this.engine.invalidate(performance.now());
    this.onChange();
  }
  private read(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
  private persist(key: string, value: string): void {
    try {
      localStorage.setItem(`looper-${key}`, value);
    } catch {
      /* optional */
    }
  }
  send(track: number, data: number[], at: number): void {
    this.trace.record('loop-schedule', { track, data: [...data], at });
    this.deliver(track, data, at, this.channel(track));
  }
  private rememberExternal(track: number, data: number[]): void {
    const op = data[0] & 0xf0,
      channel = data[0] & 15;
    if (op === 0x90 || op === 0x80)
      this.externalNotes.set(`${channel}:${data[1]}`, {
        track,
        channel,
        note: data[1],
        active: op === 0x90 && data[2] > 0,
      });
    if (op === 0xb0 && PEDAL_CONTROLLERS.includes(data[1]))
      this.externalPedals.set(`${channel}:${data[1]}`, {
        track,
        channel,
        cc: data[1],
        value: data[2],
      });
  }
  private advanceExternal(now: number): void {
    for (const e of this.scheduled
      .filter((e) => e.port === this.output && e.at <= now)
      .sort((a, b) => a.at - b.at))
      this.rememberExternal(e.track, e.data);
    this.scheduled = this.scheduled.filter((e) => e.at > now && e.port === this.output);
  }
  private externalSend(port: Output, data: number[], at: number, reason: string): void {
    port.send(data, at);
    this.trace.record('external-send-accepted', { port: port.id, data: [...data], at, reason });
  }
  private deliver(track: number, data: number[], at: number, channel: number): void {
    if (this.outputId === 'browser') {
      this.browser.send([(data[0] & 0xf0) | channel, ...data.slice(1)], at);
      return;
    }
    const routed = [(data[0] & 0xf0) | channel, ...data.slice(1)];
    if ((data[0] & 0xf0) === 0xc0) routed[1] = wireProgram(routed[1]);
    if (!this.output || this.output.state !== 'connected') return;
    try {
      const now = performance.now();
      this.advanceExternal(now);
      this.externalSend(this.output, routed, at, 'deliver');
      if (at > now) this.scheduled.push({ track, data: [...routed], at, port: this.output });
      else this.rememberExternal(track, routed);
    } catch {
      this.message = 'MIDI-Ausgabe fehlgeschlagen. Verbindung prüfen.';
    }
  }
  configure(id: number, at = performance.now(), cleanupRouting = true): void {
    const t = this.engine.tracks[id],
      channel = this.channel(id);
    if (cleanupRouting && this.outputId !== 'browser' && channel !== this.configuredChannels[id])
      this.clearExternalTrack(id, this.configuredChannels[id], at);
    this.configuredChannels[id] = channel;
    const voice = this.clavinova ? CLP625_VOICES.find((v) => v.id === t.program) : undefined;
    for (const ch of new Set([channel, this.liveChannel(id)])) {
      if (this.outputId !== 'browser') {
        this.deliver(id, [0xb0, 0, voice?.msb ?? 0], at, ch);
        this.deliver(id, [0xb0, 32, voice?.lsb ?? 0], at, ch);
      }
      this.deliver(id, [0xc0, voice?.program ?? t.program], at, ch);
      this.deliver(id, [0xb0, 7, t.muted ? 0 : t.volume], at, ch);
    }
  }
  private clearExternalTrack(id: number, channel: number, at: number, includeLive = false): void {
    if (!this.output) return;
    const now = Math.max(at, performance.now());
    this.advanceExternal(now);
    const channels = new Set(includeLive ? [channel, this.liveChannel(id)] : [channel]);
    const keep = this.scheduled.filter(
      (e) => !channels.has(e.data[0] & 15) && e.at > now && e.port === this.output,
    );
    try {
      this.trace.record('external-clear-request', {
        id,
        channels: [...channels],
        scheduled: this.scheduled.map(({ track, data, at }) => ({ track, data, at })),
      });
      if (this.cancelExternalQueue(channels, now)) {
        this.trace.record('external-clear-returned', { id });
        for (const e of keep)
          this.externalSend(this.output, e.data, e.at, 'restore-unaffected-queue');
      }
      this.scheduled = keep;
      // clear() can discard even already-due releases that the OS has not sent.
      // Re-assert inactive notes/pedals on untouched channels, never their Note-Ons.
      for (const note of this.externalNotes.values())
        if (channels.has(note.channel) || !note.active) {
          this.externalSend(this.output, [0x80 | note.channel, note.note, 0], at, 'cleanup-note');
          if (channels.has(note.channel)) note.active = false;
        }
      for (const pedal of this.externalPedals.values())
        if (!channels.has(pedal.channel) && pedal.value === 0)
          this.externalSend(this.output, [0xb0 | pedal.channel, pedal.cc, 0], at, 'cleanup-pedal');
      for (const ch of channels) {
        for (const cc of [...PEDAL_CONTROLLERS, 120, 123, 121])
          this.externalSend(this.output, [0xb0 | ch, cc, 0], at, 'cleanup-controller');
        this.externalSend(this.output, [0xe0 | ch, 0, 64], at, 'cleanup-pitch');
        for (const pedal of this.externalPedals.values()) if (pedal.channel === ch) pedal.value = 0;
      }
    } catch (error) {
      this.trace.record('external-cleanup-error', { id, error: String(error) });
      this.message = 'MIDI-Cleanup fehlgeschlagen. Geräteverbindung prüfen.';
      this.trace.checkpoint('cleanup-error', true);
    }
  }
  private cancelExternalQueue(channels: Set<number>, now: number): boolean {
    if (!this.output) return false;
    if (typeof this.output.clear === 'function') {
      try {
        this.output.clear();
        return true;
      } catch (error) {
        this.trace.record('external-clear-error', { error: String(error) });
      }
    }
    // Chromium may have send() but no clear(). Never skip release cleanup or
    // replay unaffected packets. Already submitted events cannot be cancelled:
    // append releases at their timestamps, after the original packets.
    const pending = this.scheduled.filter(
      (e) => e.port === this.output && e.at > now && channels.has(e.data[0] & 15),
    );
    this.trace.record('external-clear-fallback', {
      channels: [...channels],
      pending: pending.length,
    });
    for (const e of pending) {
      const op = e.data[0] & 0xf0,
        channel = e.data[0] & 15;
      if (op === 0x90 && e.data[2] > 0)
        this.externalSend(
          this.output,
          [0x80 | channel, e.data[1], 0],
          e.at,
          'fallback-note-release',
        );
      if (op === 0xb0 && PEDAL_CONTROLLERS.includes(e.data[1]) && e.data[2] > 0)
        this.externalSend(
          this.output,
          [0xb0 | channel, e.data[1], 0],
          e.at,
          'fallback-pedal-release',
        );
    }
    return false;
  }
  beginTrack(id: number, at: number): void {
    if (!this.clavinova) return;
    this.engine.tracks[id].program = this.clavinovaProgram;
    this.configure(id, at);
    this.trace.record(
      'clavinova-record-voice',
      { id, program: this.clavinovaProgram, assumed: !this.clavinovaProgramKnown },
      at,
    );
  }
  resetTrack(id: number, at: number): void {
    if (this.outputId === 'browser') this.browser.clearTrack(id);
    else this.clearExternalTrack(id, this.configuredChannels[id], at);
    this.configure(id, at);
  }
  deleteTrack(id: number, at: number): void {
    this.trace.record('delete-before', { id, snapshot: this.snapshot() }, at);
    this.closeLiveTake(id, at);
    for (const key of this.liveCounts.keys())
      if (key.startsWith(`${id}:`)) this.liveCounts.delete(key);
    if (this.outputId === 'browser') {
      this.browser.clearTrack(id);
      this.browser.clearTrack(id + 5);
    } else this.clearExternalTrack(id, this.configuredChannels[id], at, true);
    this.configure(id, at);
    this.trace.record('delete-cleanup-complete', { id, snapshot: this.snapshot() });
    this.trace.checkpoint('track-delete');
  }
  reset(at: number): void {
    try {
      this.cancelExternalQueue(
        new Set(Array.from({ length: 16 }, (_, ch) => ch)),
        performance.now(),
      );
    } catch (error) {
      this.trace.record('external-reset-error', { error: String(error) });
    }
    this.scheduled = [];
    this.liveCounts.clear();
    this.externalNotes.clear();
    this.externalPedals.clear();
    if (this.outputId === 'browser') this.browser.clear();
    for (let id = 0; id < 5; id++) {
      for (const channel of new Set([
        this.configuredChannels[id],
        this.channel(id),
        this.liveChannel(id),
      ])) {
        for (const cc of [...PEDAL_CONTROLLERS, 120, 123, 121])
          this.deliver(id, [0xb0, cc, 0], at, channel);
        this.deliver(id, [0xe0, 0, 64], at, channel);
      }
      this.configure(id, at, false);
    }
  }
}
