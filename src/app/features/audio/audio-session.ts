import {
  MAX_SECONDS,
  PCMEngine,
  measureLatency,
  AudioState,
} from '../../../../public/audio/pcm-engine.js';
import { analyzeTaps, TapResult } from '../../../../public/audio/tap-calibration.js';
import {
  normalizeInputFx,
  InputFxSettings,
  InputFxPreset,
  INPUT_FX_PRESETS,
} from '../../../../public/audio/input-fx.js';
type CorrectionKind = 'estimate' | 'manual' | 'tap' | 'loopback';
interface Correction {
  value: number;
  kind: CorrectionKind;
  spread?: number;
}
export interface CalibrationView {
  phase: 'idle' | 'starting' | 'running' | 'result' | 'error';
  method: 'tap' | 'loopback';
  result?: TapResult;
  message: string;
  suggested: number;
}
export class AudioSession {
  state: AudioState = new PCMEngine().snapshot();
  context?: AudioContext;
  node?: AudioWorkletNode;
  stream?: MediaStream;
  private source?: MediaStreamAudioSourceNode;
  private initializing?: Promise<void>;
  private disposed = false;
  inputs: MediaDeviceInfo[] = [];
  outputs: MediaDeviceInfo[] = [];
  private allDevices: MediaDeviceInfo[] = [];
  inputId = '';
  outputId = '';
  channels = 'stereo';
  selected = 0;
  trackInputs: (string | null)[] = Array(5).fill(null);
  trackChannels: string[] = Array(5).fill('stereo');
  trackLabels: string[] = Array(5).fill('Eingang noch nicht zugeordnet');
  actualInput = 'Noch kein Eingang aktiv';
  actualOutput = 'Systemstandard';
  resolvedInput = '';
  resolvedOutput = '';
  deviceNotice = 'Audio freigeben, um verfügbare Geräte anzuzeigen.';
  status = 'Eingang freigeben, dann aufnehmen';
  error = '';
  monitor = false;
  monitorVolume = 0.7;
  master = 0.8;
  compensationMs = 0;
  correctionSource = 'Noch nicht ermittelt';
  correctionKind: CorrectionKind = 'estimate';
  actualSettings = '';
  connecting = false;
  calibrated = false;
  calibration: CalibrationView = { phase: 'idle', method: 'tap', message: '', suggested: 0 };
  onChange = () => {};
  private request = 0;
  private awaiting = new Map<number, (error?: string) => void>();
  private calibrationRun = 0;
  private lastRate?: number;
  private preferenceNotice = '';
  private activeOutputId: string | null = null;
  inputFxSettings: InputFxSettings[] = Array.from({ length: 5 }, () => normalizeInputFx());
  private inputFxMemory: Partial<Record<InputFxPreset, InputFxSettings>>[] = Array.from(
    { length: 5 },
    () => ({}),
  );
  constructor() {
    try {
      const saved = JSON.parse(localStorage.getItem('audio-input-fx-v1') ?? 'null');
      if (Array.isArray(saved)) {
        this.inputFxSettings = Array.from({ length: 5 }, (_, i) => normalizeInputFx(saved[i]));
        this.inputFxMemory = this.inputFxSettings.map((fx, i) => {
          const memory: Partial<Record<InputFxPreset, InputFxSettings>> = {};
          for (const { id } of INPUT_FX_PRESETS)
            if (saved[i]?.presets?.[id])
              memory[id] = normalizeInputFx({ ...saved[i].presets[id], preset: id });
          memory[fx.preset] = fx;
          return memory;
        });
      }
    } catch {}
    try {
      const route = JSON.parse(localStorage.getItem('audio-route-v1') ?? 'null');
      if (route) {
        this.inputId = this.concreteId(route.inputId) ? route.inputId : '';
        this.outputId = this.concreteId(route.outputId) ? route.outputId : '';
        if (['stereo', 'left', 'right', 'mono'].includes(route.channels))
          this.channels = route.channels;
        if (Number.isFinite(route.rate) && route.rate > 0) this.lastRate = route.rate;
      }
    } catch {}
    navigator.mediaDevices?.addEventListener('devicechange', this.deviceChange);
    void this.refreshDevices().catch(() => {});
  }
  get inputFx(): InputFxSettings {
    return this.inputFxSettings[this.selected];
  }
  updateInputFx(change: Partial<InputFxSettings>): void {
    if (this.calibrationActive) return;
    const base =
      change.preset && change.preset !== this.inputFx.preset
        ? (this.inputFxMemory[this.selected][change.preset] ??
          normalizeInputFx({ preset: change.preset }))
        : this.inputFx;
    const fx = (this.inputFxSettings[this.selected] = normalizeInputFx({ ...base, ...change }));
    this.inputFxMemory[this.selected][fx.preset] = fx;
    try {
      localStorage.setItem(
        'audio-input-fx-v1',
        JSON.stringify(
          this.inputFxSettings.map((settings, i) => ({
            ...settings,
            presets: this.inputFxMemory[i],
          })),
        ),
      );
    } catch {}
    this.node?.port.postMessage({ type: 'inputFx', id: this.selected, fx });
    this.onChange();
  }
  private concreteId(id: unknown): id is string {
    return typeof id === 'string' && !!id && id !== 'default' && id !== 'communications';
  }
  private defaultDevice(kind: string): MediaDeviceInfo | undefined {
    const alias = this.allDevices.find((d) => d.kind === kind && d.deviceId === 'default');
    return this.allDevices.find(
      (d) =>
        d.kind === kind &&
        this.concreteId(d.deviceId) &&
        !!alias?.groupId &&
        d.groupId === alias.groupId,
    );
  }
  private saveRoute(): void {
    if (!this.concreteId(this.inputId) || !this.concreteId(this.outputId)) return;
    this.lastRate = this.context?.sampleRate ?? this.lastRate;
    try {
      localStorage.setItem(
        'audio-route-v1',
        JSON.stringify({
          inputId: this.inputId,
          outputId: this.outputId,
          channels: this.channels,
          rate: this.lastRate,
        }),
      );
    } catch {}
  }
  get outputSelectable(): boolean {
    return typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
  }
  get ready(): boolean {
    return (
      this.context?.state === 'running' &&
      !!this.stream?.active &&
      !!this.node &&
      this.activeOutputId === this.outputId
    );
  }
  get inputMissing(): boolean {
    return (
      !!this.inputId &&
      this.inputs.length > 0 &&
      !this.inputs.some((d) => d.deviceId === this.inputId)
    );
  }
  get outputMissing(): boolean {
    return (
      !!this.outputId &&
      this.outputs.length > 0 &&
      !this.outputs.some((d) => d.deviceId === this.outputId)
    );
  }
  get correctionLabel(): string {
    return { estimate: 'Geschätzt', manual: 'Manuell', tap: 'Kalibriert', loopback: 'Loopback' }[
      this.correctionKind
    ];
  }
  get firstRecording(): boolean {
    return this.state.tracks.some((t) => t.state === 'recording' || t.state === 'armed');
  }
  get calibrationActive(): boolean {
    return ['starting', 'running'].includes(this.calibration.phase) || this.state.calibrating;
  }
  get routeLocked(): boolean {
    return this.firstRecording || this.connecting || this.calibrationActive;
  }
  get correctionLocked(): boolean {
    return !this.ready || this.state.captureBusy || this.connecting || this.calibrationActive;
  }
  get diagnostics(): string[] {
    const settings = this.stream?.getAudioTracks()[0]?.getSettings() as
      | (MediaTrackSettings & { latency?: number })
      | undefined;
    const ms = (n: number | undefined) =>
      Number.isFinite(n) ? `${((n ?? 0) * 1000).toFixed(1)} ms` : 'nicht gemeldet';
    const flag = (v: unknown) =>
      v === undefined ? 'nicht gemeldet' : v === false ? 'aus' : String(v);
    return [
      `Tatsächlicher Eingang: ${this.actualInput}`,
      `Tatsächlicher Ausgang: ${this.actualOutput}`,
      `Audio-Clock: ${this.context?.sampleRate ?? '–'} Hz · Eingangsformat: ${settings?.sampleRate ?? '–'} Hz / ${settings?.channelCount ?? '–'} Kanal/Kanäle`,
      `Context-Buffer (baseLatency): ${ms(this.context?.baseLatency)}`,
      `Ausgabeverzögerung (outputLatency): ${ms(this.context?.outputLatency)}`,
      `Eingangsangabe (keine Messung): ${ms(settings?.latency)}`,
      `Echo Cancellation: ${flag(settings?.echoCancellation)} · Noise Suppression: ${flag(settings?.noiseSuppression)} · Auto Gain: ${flag(settings?.autoGainControl)}`,
      `Browser-Geräteliste: ${this.allDevices.filter((d) => d.kind === 'audioinput').length} Eingänge / ${this.allDevices.filter((d) => d.kind === 'audiooutput').length} Ausgänge (einschließlich System-Aliasen)`,
      'Browser-Angaben sind keine Messung der gesamten Live-Mithörlatenz. G HUB / BLUE VO!CE, DTS und Windows-Audioeffekte liegen außerhalb der App-Steuerung.',
    ];
  }
  private key(): string {
    return `audio-correction-v2:${this.resolvedInput || this.inputId || 'default'}:${this.resolvedOutput || this.outputId || 'default'}:${this.channels}:${this.context?.sampleRate ?? this.lastRate}`;
  }
  private restoreCorrection(): void {
    let saved: Correction | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(this.key()) ?? 'null');
    } catch {}
    const settings = this.stream?.getAudioTracks()[0]?.getSettings() as MediaTrackSettings & {
      latency?: number;
    };
    const estimate =
      ((this.context?.baseLatency ?? 0) +
        (this.context?.outputLatency ?? 0) +
        (settings?.latency ?? 0)) *
      1000;
    const kind =
      saved && ['manual', 'tap', 'loopback'].includes(saved.kind) && Number.isFinite(saved.value)
        ? saved.kind
        : 'estimate';
    this.compensationMs = Math.max(
      0,
      Math.min(1000, kind === 'estimate' ? Math.round(estimate * 10) / 10 : saved!.value),
    );
    this.correctionKind = kind;
    this.calibrated = kind === 'tap' || kind === 'loopback';
    this.correctionSource = {
      estimate: 'Browser-Schätzung · nicht gemessen',
      manual: 'Manuell eingestellt',
      tap: 'Einspiel-Kalibrierung · inklusive persönlichem Timing',
      loopback: 'Kabel-Loopback gemessen',
    }[kind];
    this.config({ compensationMs: this.compensationMs, channels: this.channels });
  }
  setCorrection(value: number, kind: CorrectionKind = 'manual', spread?: number): void {
    if (this.correctionLocked) {
      this.error =
        'Zuerst Aufnahme/Overdub und Nachlauf beenden. Vorhandene Wiedergabe-Loops dürfen bleiben.';
      this.onChange();
      return;
    }
    const profile: Correction = {
      value: Math.max(0, Math.min(1000, Number(value) || 0)),
      kind,
      spread,
    };
    this.saveRoute();
    try {
      localStorage.setItem(this.key(), JSON.stringify(profile));
    } catch {}
    this.compensationMs = profile.value;
    this.correctionKind = kind;
    this.calibrated = kind === 'tap' || kind === 'loopback';
    this.correctionSource =
      kind === 'tap'
        ? 'Einspiel-Kalibrierung · inklusive persönlichem Timing'
        : kind === 'loopback'
          ? 'Kabel-Loopback gemessen'
          : 'Manuell eingestellt';
    this.config({ compensationMs: profile.value });
    this.onChange();
  }
  async initialize(): Promise<void> {
    if (this.disposed) throw Error('Audio-Modus geschlossen.');
    if (this.initializing) return this.initializing;
    const task = (async () => {
      if (!isSecureContext || !navigator.mediaDevices?.getUserMedia)
        throw Error('Audioaufnahme benötigt HTTPS oder localhost und einen unterstützten Browser.');
      this.context ??= new AudioContext({ latencyHint: 'interactive' });
      await this.context.resume();
      if (!this.node) {
        await this.context.audioWorklet.addModule(
          new URL('audio/pcm-processor.js', document.baseURI).href,
        );
        if (this.disposed) return;
        this.node = new AudioWorkletNode(this.context, 'pcm-looper', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [2],
          channelCount: 2,
          channelCountMode: 'max',
        });
        this.node.port.onmessage = ({ data }) => {
          if (data.type === 'state') {
            this.state = data.state;
            if (this.state.error) this.error = this.state.error;
          }
          if (data.ack) {
            this.awaiting.get(data.ack)?.(data.state?.error);
            this.awaiting.delete(data.ack);
          }
          if (data.type === 'calibration') this.handleCalibration(data);
          this.onChange();
        };
        this.node.onprocessorerror = () => {
          this.error = 'Audio-Engine unterbrochen. Seite neu laden; Loops sind nicht gespeichert.';
          this.monitor = false;
          this.disconnectInput();
          this.onChange();
        };
        this.node.connect(this.context.destination);
        this.state.tracks.forEach((t) =>
          this.node!.port.postMessage({ type: 'volume', id: t.id, value: t.volume }),
        );
        this.state.tracks
          .filter((t) => t.muted)
          .forEach((t) =>
            this.node!.port.postMessage({ type: 'mute', id: t.id, unmuteMode: 'immediate' }),
          );
        this.inputFxSettings.forEach((fx, id) =>
          this.node!.port.postMessage({ type: 'inputFx', id, fx }),
        );
        this.context.onstatechange = () => {
          if (this.context?.state === 'suspended') {
            this.monitor = false;
            this.config({ monitor: false });
            if (this.calibrationActive)
              void this.cancelCalibration('Messung durch Audio-Unterbrechung abgebrochen.');
            this.error = 'Audio angehalten. Über „Audio fortsetzen“ wieder aktivieren.';
          }
          this.onChange();
        };
      }
      this.config({
        monitor: this.monitor,
        monitorVolume: this.monitorVolume,
        master: this.master,
        channels: this.channels,
        selected: this.selected,
      });
      if (!this.stream?.active) {
        await this.refreshDevices();
        try {
          await this.openInput(this.inputId);
        } catch (error) {
          if ((error as DOMException)?.name !== 'NotFoundError' || !this.inputId) throw error;
          this.preferenceNotice = 'Gespeicherter Eingang fehlt; aktuelles Standardgerät verwendet.';
          await this.openInput('');
        }
      }
      if (this.activeOutputId !== this.outputId) await this.applyOutput(this.outputId);
      this.saveRoute();
      this.restoreCorrection();
    })();
    this.initializing = task;
    try {
      await task;
    } catch (error) {
      this.error = this.describe(error);
      throw error;
    } finally {
      this.initializing = undefined;
      this.onChange();
    }
  }
  async connect(): Promise<void> {
    if (this.connecting || this.calibrationActive) return;
    this.connecting = true;
    this.error = '';
    this.onChange();
    try {
      await this.initialize();
      await this.refreshDevices();
    } catch {
    } finally {
      this.connecting = false;
      this.onChange();
    }
  }
  private describe(error: unknown): string {
    const name = (error as DOMException)?.name;
    if (name === 'NotAllowedError')
      return 'Audiozugriff nicht erlaubt. Mikrofon-/Audioberechtigung dieser Seite im Browser prüfen und erneut versuchen.';
    if (name === 'NotFoundError')
      return 'Kein passendes Audiogerät gefunden. Gerät anschließen und „Geräte neu suchen“ verwenden.';
    if (name === 'NotReadableError')
      return 'Audiogerät kann nicht geöffnet werden. Wird es exklusiv von einer anderen App verwendet?';
    return error instanceof Error ? error.message : String(error);
  }
  private disconnectInput(): void {
    this.source?.disconnect();
    this.source = undefined;
    this.stream?.getTracks().forEach((t) => {
      t.onended = null;
      t.stop();
    });
    this.stream = undefined;
  }
  private async openInput(id: string): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(id ? { deviceId: { exact: id } } : {}),
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: { ideal: 2 },
        latency: { ideal: 0 },
      } as MediaTrackConstraints,
      video: false,
    });
    if (this.disposed) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const source = this.context!.createMediaStreamSource(stream);
    source.connect(this.node!);
    this.disconnectInput();
    this.stream = stream;
    this.source = source;
    const track = stream.getAudioTracks()[0],
      settings = track.getSettings();
    this.resolvedInput = this.concreteId(settings.deviceId)
      ? settings.deviceId
      : this.concreteId(id)
        ? id
        : this.defaultDevice('audioinput')?.deviceId || 'default';
    this.inputId = this.concreteId(this.resolvedInput) ? this.resolvedInput : '';
    this.actualInput =
      track.label ||
      this.inputs.find((d) => d.deviceId === this.resolvedInput)?.label ||
      'Aktiver Audioeingang (Name nicht gemeldet)';
    this.actualSettings = `${settings.channelCount ?? '?'} Kanal/Kanäle · ${settings.sampleRate ?? this.context?.sampleRate} Hz`;
    if (settings.echoCancellation || settings.noiseSuppression || settings.autoGainControl)
      this.actualSettings += ' · Sprachverarbeitung noch aktiv';
    track.onended = () => {
      this.monitor = false;
      this.config({ monitor: false });
      if (this.calibrationActive)
        void this.cancelCalibration('Eingang während der Messung getrennt.');
      void this.send({ type: 'prepareRoute' }).catch(() => {});
      this.error =
        'Audioeingang getrennt. Loops bleiben erhalten; Gerät wieder verbinden oder Eingang wechseln.';
      this.onChange();
    };
    this.status = 'Audio bereit';
    await this.refreshDevices();
    this.rememberInput();
    this.saveRoute();
    this.restoreCorrection();
    this.onChange();
  }
  private rememberInput(): void {
    this.trackInputs[this.selected] =
      this.resolvedInput === 'default' ? this.inputId : this.resolvedInput;
    this.trackChannels[this.selected] = this.channels;
    this.trackLabels[this.selected] = this.actualInput;
  }
  private async prepareRoute(): Promise<void> {
    if (this.firstRecording)
      throw Error('Zuerst die laufende/vorgemerkte Erstaufnahme abschließen oder abbrechen.');
    if (!this.node) return;
    await this.send({ type: 'prepareRoute' });
    this.monitor = false;
    const deadline = performance.now() + 2500;
    while (this.state.captureBusy) {
      if (performance.now() > deadline)
        throw Error(
          'Aufnahme-Nachlauf noch aktiv oder Audio angehalten. Audio fortsetzen und erneut versuchen.',
        );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await this.send({ type: 'resetInputFx' });
  }
  private async routeOperation(action: () => Promise<void>): Promise<void> {
    if (this.routeLocked) return;
    this.connecting = true;
    this.error = '';
    this.onChange();
    try {
      await this.prepareRoute();
      await action();
    } catch (e) {
      this.error = this.describe(e);
    } finally {
      this.connecting = false;
      this.onChange();
    }
  }
  async changeInput(id: string): Promise<void> {
    await this.routeOperation(async () => {
      if (!this.context) {
        this.inputId = id;
        await this.initialize();
      } else await this.openInput(id);
    });
  }
  async selectTrack(id: number): Promise<boolean> {
    if (id === this.selected) return true;
    if (this.routeLocked) return false;
    const requested = this.trackInputs[id],
      channel = this.trackChannels[id];
    const needsRoute =
      requested !== null &&
      ((requested !== this.resolvedInput && requested !== this.inputId) ||
        channel !== this.channels);
    if (needsRoute) {
      let success = false;
      await this.routeOperation(async () => {
        const previous = this.selected,
          previousChannel = this.channels;
        this.selected = id;
        this.channels = channel;
        try {
          if (!this.context) await this.initialize();
          else await this.openInput(requested!);
          this.config({ selected: id, channels: this.channels });
          success = true;
        } catch (e) {
          this.selected = previous;
          this.channels = previousChannel;
          throw e;
        }
      });
      return success;
    }
    this.selected = id;
    if (requested === null && this.stream) this.rememberInput();
    this.config({ selected: id });
    this.onChange();
    return true;
  }
  async changeChannels(value: string): Promise<void> {
    await this.routeOperation(async () => {
      this.channels = value;
      this.rememberInput();
      this.saveRoute();
      this.restoreCorrection();
    });
  }
  private async applyOutput(id: string): Promise<void> {
    if (!this.context) return;
    if (!this.outputSelectable) {
      if (id && id !== this.defaultDevice('audiooutput')?.deviceId)
        throw Error(
          'Dieser Browser unterstützt nur den System-Audioausgang. Ausgang in Windows wechseln.',
        );
      this.activeOutputId = id;
      return;
    }
    await (this.context as AudioContext & { setSinkId: (id: string) => Promise<void> }).setSinkId(
      id,
    );
    this.activeOutputId = id;
  }
  async changeOutput(id: string): Promise<void> {
    await this.routeOperation(async () => {
      await this.applyOutput(id);
      this.outputId = id;
      await this.refreshDevices();
      this.saveRoute();
      this.restoreCorrection();
      this.status = 'Ausgang gewechselt · Korrekturprofil geladen';
    });
  }
  async refreshDevices(): Promise<void> {
    const devices = (await navigator.mediaDevices?.enumerateDevices()) ?? [];
    this.allDevices = devices;
    const unique = (kind: string) =>
      devices.filter(
        (d, i) =>
          d.kind === kind &&
          this.concreteId(d.deviceId) &&
          devices.findIndex((x) => x.kind === kind && x.deviceId === d.deviceId) === i,
      );
    this.inputs = unique('audioinput');
    this.outputs = unique('audiooutput');
    if (
      !this.stream?.active &&
      this.inputs.length &&
      !this.inputs.some((d) => d.deviceId === this.inputId)
    ) {
      if (this.inputId)
        this.preferenceNotice =
          'Zuletzt gewählter Eingang nicht verfügbar; Standardgerät vorgewählt.';
      this.inputId = (this.defaultDevice('audioinput') ?? this.inputs[0]).deviceId;
    }
    if (
      this.outputs.length &&
      (this.activeOutputId === null || !this.outputSelectable) &&
      !this.outputs.some((d) => d.deviceId === this.outputId)
    ) {
      if (this.outputId)
        this.preferenceNotice =
          'Zuletzt gewählter Ausgang nicht verfügbar; Standardgerät vorgewählt.';
      this.outputId = (this.defaultDevice('audiooutput') ?? this.outputs[0]).deviceId;
    }
    if (!this.outputSelectable && this.context) {
      this.outputId = this.defaultDevice('audiooutput')?.deviceId ?? this.outputId;
      this.activeOutputId = this.outputId;
    }
    if (!this.stream?.active) {
      this.resolvedInput = this.inputId;
      this.actualInput =
        this.inputs.find((d) => d.deviceId === this.inputId)?.label || 'Noch kein Eingang aktiv';
    }
    this.resolvedOutput = this.outputId;
    this.actualOutput =
      this.outputs.find((d) => d.deviceId === this.outputId)?.label ||
      'Ausgang noch nicht freigegeben';
    this.deviceNotice =
      this.preferenceNotice ||
      (!this.stream?.active
        ? 'Audio freigeben, damit der Browser zusätzliche Geräte und Namen freigibt.'
        : !this.inputs.length
          ? 'Keine konkreten Geräte freigegeben. Seitenberechtigung/Brave Shields prüfen und Geräte neu suchen.'
          : 'Konkrete Geräte ohne Standard-/Kommunikations-Aliase. Auswahl und Korrekturprofil werden lokal gespeichert.');
    if (!this.state.captureBusy && !this.calibrationActive) this.restoreCorrection();
    this.onChange();
  }
  async rescan(): Promise<void> {
    this.error = '';
    try {
      if (!this.ready) await this.connect();
      await this.refreshDevices();
    } catch (e) {
      this.error = this.describe(e);
    }
    this.onChange();
  }
  private deviceChange = (): void => {
    const old = this.resolvedOutput;
    void this.refreshDevices()
      .then(() => {
        if (this.outputId && !this.outputs.some((d) => d.deviceId === this.outputId)) {
          this.monitor = false;
          this.config({ monitor: false });
          this.error = 'Gewählter Ausgang getrennt. Ausgabe und Korrekturprofil prüfen.';
        } else if (old && old !== this.resolvedOutput) {
          this.monitor = false;
          this.config({ monitor: false });
          if (this.calibrationActive)
            void this.cancelCalibration(
              'Ausgang während der Messung gewechselt. Signalweg prüfen und erneut starten.',
            );
          this.restoreCorrection();
          this.status = 'Systemausgang geändert · anderes Korrekturprofil';
        }
        this.onChange();
      })
      .catch((e) => {
        this.error = this.describe(e);
        this.onChange();
      });
  };
  config(values: Record<string, unknown>): void {
    this.node?.port.postMessage({ type: 'config', ...values });
  }
  async send(command: Record<string, unknown>, transfer: Transferable[] = []): Promise<void> {
    if (!this.node) throw Error('Audio zuerst freigeben.');
    const ack = ++this.request;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.awaiting.delete(ack);
        reject(Error('Audio-Engine antwortet nicht. Audio fortsetzen oder Seite neu laden.'));
      }, 4000);
      this.awaiting.set(ack, (error) => {
        clearTimeout(timeout);
        if (error) reject(Error(error));
        else resolve();
      });
      this.node!.port.postMessage({ ...command, ack }, transfer);
    });
  }
  async press(id: number, fixedBars: number | null = null): Promise<void> {
    this.error = '';
    await this.initialize();
    const t = this.state.tracks[id];
    this.rememberInput();
    if (t.state === 'empty') {
      const size = Math.ceil(this.context!.sampleRate * MAX_SECONDS),
        a = new Float32Array(size),
        b = new Float32Array(size);
      await this.send({ type: 'press', id, fixedBars, buffers: [a, b] }, [a.buffer, b.buffer]);
    } else await this.send({ type: 'press', id });
  }
  async startCalibration(method: 'tap' | 'loopback' = 'tap'): Promise<void> {
    if (this.routeLocked) return;
    const run = ++this.calibrationRun;
    this.calibration = {
      phase: 'starting',
      method,
      message: 'Audio vorbereiten und Aufnahme-Nachlauf abwarten …',
      suggested: 0,
    };
    this.error = '';
    this.onChange();
    try {
      await this.initialize();
      await this.prepareRoute();
      this.monitor = false;
      this.config({ monitor: false });
      if (run !== this.calibrationRun) return;
      if (this.master < 0.15) {
        this.calibration.phase = 'error';
        this.calibration.message =
          'Gesamtlautstärke zuerst auf mindestens 15 % stellen. Testklicks müssen gut hörbar sein.';
        return;
      }
      await this.send({ type: 'calibrate', method });
      if (run === this.calibrationRun) {
        this.calibration.phase = 'running';
        this.calibration.message = '';
      }
    } catch (e) {
      if (run === this.calibrationRun) {
        this.calibration.phase = 'error';
        this.calibration.message = this.describe(e);
      }
    } finally {
      this.onChange();
    }
  }
  private handleCalibration(data: {
    samples: Float32Array;
    starts: number[];
    rate: number;
    method: 'tap' | 'loopback';
  }): void {
    if (this.calibration.phase !== 'running') return;
    this.state.calibrating = false;
    const result = data.method === 'tap' ? analyzeTaps(data.samples, data.starts, data.rate) : null;
    const loopback =
      data.method === 'loopback' ? measureLatency(data.samples, data.starts, data.rate) : null;
    this.calibration.result = result ?? undefined;
    if (result?.ok || loopback !== null) {
      this.calibration.phase = 'result';
      this.calibration.suggested = result?.suggestedMs ?? Math.round(loopback! * 10) / 10;
      this.calibration.message =
        'Vorschlag prüfen. Erst „Übernehmen“ speichert ihn; bestehende Loops werden nicht verändert.';
    } else {
      this.calibration.phase = 'error';
      this.calibration.message =
        result?.reason ||
        'Kein stabiler Kabel-Loopback erkannt. Geeigneten Kabelweg und Pegel prüfen.';
    }
  }
  acceptCalibration(): void {
    if (this.calibration.phase !== 'result' || !Number.isFinite(this.calibration.suggested)) return;
    const adjusted =
      this.calibration.method === 'tap' &&
      this.calibration.suggested !== this.calibration.result?.suggestedMs;
    const kind = adjusted ? 'manual' : this.calibration.method === 'tap' ? 'tap' : 'loopback';
    this.setCorrection(this.calibration.suggested, kind, this.calibration.result?.spreadMs);
    this.status = `Einspiel-Korrektur übernommen: ${this.compensationMs.toFixed(1)} ms`;
    this.onChange();
  }
  async cancelCalibration(message = ''): Promise<void> {
    this.calibrationRun++;
    this.calibration.phase = message ? 'error' : 'idle';
    this.calibration.message = message;
    if (this.node)
      try {
        await this.send({ type: 'cancelCalibration' });
      } catch {}
    this.onChange();
  }
  dispose(): void {
    this.disposed = true;
    navigator.mediaDevices?.removeEventListener('devicechange', this.deviceChange);
    this.disconnectInput();
    this.node?.disconnect();
    if (this.context) this.context.onstatechange = null;
    void this.context?.close();
    for (const resolve of this.awaiting.values()) resolve();
    this.awaiting.clear();
  }
}
