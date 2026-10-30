import { focusPerformance } from '../../shared/ui/performance-focus';
import { audibleNow } from '../../shared/audio-presentation';
import { Injectable, OnDestroy, signal, computed } from '@angular/core';

import { AudioSession } from './audio-session';
import { AudioTrackState } from '../../../../public/audio/pcm-engine.js';

import { shortcut } from '../../shared/shortcuts';

import {
  readRecordBars,
  saveRecordBars,
  normalizeRecordBars,
  formatBarCount,
} from '../../shared/record-length';
import {
  readWorkspacePreferences,
  saveWorkspacePreferences,
} from '../../shared/workspace-preferences';
import { suggestTempo, TempoCandidate } from '../../shared/tempo';
import { INPUT_FX_PRESETS, InputFxPreset } from '../../../../public/audio/input-fx.js';
@Injectable()
export class AudioWorkspace implements OnDestroy {
  private readonly revision = signal(0);
  // The engine stays mutable and clock-driven. Only its UI boundary is reactive.
  // A revision publishes the same workspace without cloning realtime objects.
  readonly view = computed(
    () => {
      this.revision();
      return this;
    },
    { equal: () => false },
  );
  refresh(): void {
    this.revision.update((value) => value + 1);
  }

  audio = new AudioSession();
  settingsOpen = false;
  settingsTab = 'audio';
  working = false;
  calibrationOpen = false;
  calibrationReady = false;
  private calibrationFocus?: HTMLElement;
  fxDetailsOpen = false;
  fxPresets = INPUT_FX_PRESETS;
  private fxFocus?: HTMLElement;
  selected = 0;
  bpm = 120;
  signature = '4/4';
  metroVolume = 0.4;
  unmuteMode: 'cycle' | 'immediate' = 'cycle';
  afterRecord: 'dub' | 'play' = 'dub';
  commonRing = false;
  tempoBars = 4;
  tempoSignature = '4/4';
  recordBars = readRecordBars('audio');
  tempoOpen = false;
  tempoIndex = -1;
  candidates: TempoCandidate[] = [];
  private reference = 0;
  private focus?: HTMLElement;
  midiAccess?: MIDIAccess;
  midiInputs: MIDIInput[] = [];
  midiInput = '';
  pedalEnabled = true;
  private held = new Set<string>();
  private pedalDown = false;
  midiStatus = 'Optional: MIDI-Pedal verbinden';
  constructor() {
    const { master, monitorVolume, ...preferences } = readWorkspacePreferences('audio');
    Object.assign(this, preferences);
    if (master !== undefined) this.audio.master = master;
    if (monitorVolume !== undefined) this.audio.monitorVolume = monitorVolume;
    this.audio.onChange = () => {
      const s = this.audio.state;
      if (s.reference !== this.reference) {
        this.reference = s.reference;
        this.candidates =
          s.reference && s.mode === 'free'
            ? suggestTempo((s.reference / s.rate) * 1000, [], this.bpm)
            : [];
        this.tempoOpen = false;
        this.tempoIndex = -1;
        if (this.candidates.length) {
          this.tempoBars = this.candidates[0].bars;
          this.tempoSignature = `${this.candidates[0].beats}/${this.candidates[0].denominator}`;
        }
      }
      this.refresh();
    };
    window.addEventListener('pagehide', this.pagehide);
    document.addEventListener('visibilitychange', this.visibility);
  }
  get s() {
    return this.audio.state;
  }
  get displayBpm() {
    return Math.round(this.bpm * 100) / 100;
  }
  set displayBpm(value: number) {
    this.bpm = value;
  }
  get metroPercent(): number {
    return Math.round(this.metroVolume * 200);
  }
  set metroPercent(value: number) {
    this.metroVolume = Math.max(0, Math.min(100, +value)) / 200;
  }
  get locked() {
    return this.s.busy || this.s.calibrating || this.working || this.audio.connecting;
  }
  get routeLocked() {
    return this.audio.routeLocked || this.working;
  }
  get fxLocked() {
    return (
      this.working || this.audio.connecting || this.calibrationOpen || this.audio.calibrationActive
    );
  }
  get fxDescription() {
    return this.fxPresets.find((p) => p.id === this.audio.inputFx.preset)?.description ?? '';
  }
  get toneLabel() {
    return {
      clean: '',
      bass: 'Bass: rund ↔ präsent',
      punch: 'Präsenz: tief ↔ hoch',
      telephone: 'Telefon: dunkel ↔ hell',
      space: 'Hall: dunkel ↔ hell',
      echo: 'Wiederholungen: dunkel ↔ hell',
    }[this.audio.inputFx.preset];
  }
  get echoSynced() {
    return this.s.mode === 'tempo' || this.s.metro;
  }
  get echoTimeMs() {
    const factor =
      this.audio.inputFx.division === 'eighth'
        ? 0.5
        : this.audio.inputFx.division === 'dotted'
          ? 0.75
          : 1;
    return this.echoSynced ? (60000 / this.s.bpm) * factor : this.audio.inputFx.echoMs;
  }
  preset(preset: InputFxPreset): void {
    this.audio.updateInputFx({ preset });
  }
  openFx(): void {
    this.fxFocus = document.activeElement as HTMLElement;
    this.fxDetailsOpen = true;
    setTimeout(() => document.getElementById('close-input-fx')?.focus());
  }
  closeFx(): void {
    this.fxDetailsOpen = false;
    focusPerformance();
  }
  get tempoBpm() {
    const [b, d] = this.tempoSignature.split('/').map(Number);
    return this.s.reference
      ? (60 * this.s.rate * this.tempoBars * b * 4) / d / this.s.reference
      : 0;
  }
  get tempoChoiceLocked() {
    return (
      this.s.calibrating ||
      this.working ||
      this.audio.connecting ||
      this.s.tracks.some((t) => t.state === 'recording' || t.state === 'armed')
    );
  }
  get canConfirm() {
    return (
      !!this.s.reference &&
      !this.s.calibrating &&
      !this.working &&
      !this.audio.connecting &&
      Number.isInteger(this.tempoBars) &&
      this.tempoBars >= 1 &&
      this.tempoBars <= 64 &&
      this.tempoBpm >= 30 &&
      this.tempoBpm <= 300 &&
      !this.s.tracks.some((t) => t.state === 'recording' || t.state === 'armed')
    );
  }
  async select(id: number): Promise<void> {
    if (this.working || this.calibrationOpen) return;
    this.working = true;
    try {
      if (await this.audio.selectTrack(id)) this.selected = id;
    } finally {
      this.working = false;
      this.refresh();
    }
  }
  async trigger(id: number): Promise<void> {
    if (this.working || this.audio.connecting || this.calibrationOpen) return;
    this.working = true;
    try {
      if (!(await this.audio.selectTrack(id))) return;
      this.selected = id;
      await this.audio.initialize();
      this.settings();
      await this.audio.press(id, this.recordBars[id]);
    } catch (e) {
      this.audio.error = String((e as Error).message ?? e);
    } finally {
      this.working = false;
      this.refresh();
    }
  }
  async command(type: string, id?: number): Promise<void> {
    this.audio.error = '';
    if (type === 'mute' && id !== undefined && !this.audio.node) {
      this.s.tracks[id].muted = !this.s.tracks[id].muted;
      this.refresh();
      return;
    }
    if (type === 'clear' && id !== undefined && this.s.tracks[id].state === 'empty') {
      this.refresh();
      return;
    }
    try {
      await this.audio.send({
        type,
        id,
        ...(type === 'mute' ? { unmuteMode: this.unmuteMode } : {}),
      });
    } catch (e) {
      this.audio.error = String(e);
    }
    this.refresh();
  }
  async resetAllTracks(): Promise<void> {
    if (!window.confirm('Alle Aufnahmen und Taktvorgaben löschen?')) return;
    this.audio.error = '';
    try {
      for (const t of this.s.tracks) {
        if (t.state !== 'empty') await this.audio.send({ type: 'clear', id: t.id });
      }
      this.recordBars.fill(null);
      saveRecordBars('audio', this.recordBars);
    } catch (e) {
      this.audio.error = String(e);
    }
    this.refresh();
  }
  async toggleMetro(): Promise<void> {
    if (this.s.busy && this.s.mode === 'free' && !this.s.metro) {
      this.audio.error = this.s.reference
        ? 'Zuerst eine Einteilung in der Tempo-Auswahl wählen.'
        : 'Freie Erstaufnahme zuerst abschließen.';
      return;
    }
    try {
      await this.audio.initialize();
      this.settings();
      await this.audio.send({ type: 'metro' });
    } catch (e) {
      this.audio.error = String((e as Error).message ?? e);
    }
    this.refresh();
  }
  settings(): void {
    this.bpm = Math.max(30, Math.min(300, Number(this.bpm) || 120));
    const [beats, denominator] = this.signature.split('/').map(Number);
    this.savePreferences();
    this.audio.config({
      bpm: this.bpm,
      beats,
      denominator,
      metroVolume: this.metroVolume,
      afterRecord: this.afterRecord,
      monitor: this.audio.monitor,
      monitorVolume: this.audio.monitorVolume,
      master: this.audio.master,
      channels: this.audio.channels,
      selected: this.selected,
    });
  }
  savePreferences(): void {
    saveWorkspacePreferences('audio', {
      bpm: this.bpm,
      signature: this.signature,
      metroVolume: this.metroVolume,
      master: this.audio.master,
      monitorVolume: this.audio.monitorVolume,
      afterRecord: this.afterRecord,
      commonRing: this.commonRing,
      unmuteMode: this.unmuteMode,
    });
  }
  async channelChange(value: string): Promise<void> {
    await this.audio.changeChannels(value);
  }
  async confirmTempo(): Promise<void> {
    if (!this.canConfirm) return;
    const [beats, denominator] = this.tempoSignature.split('/').map(Number);
    try {
      const bpm = this.tempoBpm;
      await this.audio.send({ type: 'tempo', bpm, beats, denominator, bars: this.tempoBars });
      this.bpm = bpm;
      this.signature = this.tempoSignature;
      this.audio.error = '';
      this.savePreferences();
      this.tempoOpen = false;
      if (this.settingsOpen) this.closeSettings();
    } catch (e) {
      this.audio.error = String(e);
    }
    this.refresh();
  }
  applyTempoChoice(index: number): void {
    this.chooseTempo(index);
    if (index >= 0 || index === -2) void this.confirmTempo();
  }
  setRecordBars(t: AudioTrackState, value: unknown): void {
    if (t.state !== 'empty') return;
    this.recordBars[t.id] = normalizeRecordBars(value);
    saveRecordBars('audio', this.recordBars);
  }
  barCount(t: AudioTrackState): string {
    return t.state === 'recording' || t.state === 'armed'
      ? t.fixedBars
        ? String(t.fixedBars)
        : ''
      : formatBarCount(t.length, t.barDuration);
  }
  autoRemaining(t: AudioTrackState): number {
    return Math.max(0, ((t.autoEnd ?? this.s.frame) - this.s.frame) / this.s.rate);
  }
  selectCard(event: MouseEvent, id: number): void {
    if (
      !(event.target as HTMLElement).closest('button,input,select,label,a') &&
      id !== this.selected
    )
      void this.select(id);
  }
  chooseTempo(index: number): void {
    this.tempoIndex = +index;
    const c = this.candidates[this.tempoIndex];
    if (c) {
      this.tempoBars = c.bars;
      this.tempoSignature = `${c.beats}/${c.denominator}`;
    }
  }
  target(t: AudioTrackState): string {
    return t.pending
      ? t.pending.action === 'start'
        ? 'recording'
        : t.pending.action === 'dub'
          ? 'overdub'
          : 'playing'
      : t.state;
  }
  label(t: AudioTrackState): string {
    if (t.state === 'overdub' && t.pending?.action === 'play') return 'Overdub → Wiedergabe';
    return (
      {
        empty: 'Aufnehmen',
        armed: 'Aufnahme',
        recording: 'Aufnahme',
        playing: 'Wiedergabe',
        overdub: 'Overdub',
      } as Record<string, string>
    )[this.target(t)];
  }
  remaining(t: AudioTrackState): number {
    return Math.max(0, ((t.pending?.at ?? this.s.frame) - this.s.frame) / this.s.rate);
  }
  progress(t: AudioTrackState): number {
    const now = performance.now();
    const frame = Math.max(
      t.start,
      this.s.frame - ((now - audibleNow(this.audio.context, now)) * this.s.rate) / 1000,
    );
    if (t.state === 'recording' && t.autoEnd !== undefined)
      return Math.max(0, Math.min(100, ((frame - t.start) / (t.autoEnd - t.start)) * 100));
    const len = this.commonRing
      ? this.s.mode === 'tempo'
        ? (((this.s.rate * 60) / this.s.bpm) * this.s.beats * 4) / this.s.denominator
        : this.s.reference
      : t.length;
    const start = this.commonRing ? (this.s.origin ?? t.start) : t.start;
    return len ? (((((frame - start) % len) + len) % len) / len) * 100 : 0;
  }
  duration(t: AudioTrackState): string {
    const frames = t.length || (t.state === 'recording' ? this.s.frame - t.start : 0);
    return frames ? `${(frames / this.s.rate).toFixed(2)} s` : '—';
  }
  hint(t: AudioTrackState): string {
    if (t.unmuteAt !== undefined)
      return `Aktiv in ${Math.max(0, (t.unmuteAt - this.s.frame) / this.s.rate).toFixed(1)} s`;
    return t.autoEnd !== undefined
      ? `Danach ${t.autoAction === 'dub' ? 'Overdub' : 'Wiedergabe'}`
      : t.pending
        ? `${t.state === 'overdub' && t.pending.action === 'play' ? 'Ende am Loop-Ende' : 'Vorgemerkt'} · in ${this.remaining(t).toFixed(1)} s`
        : t.draining
          ? 'Aufnahme-Nachlauf wird übernommen'
          : t.state === 'overdub' && this.selected !== t.id
            ? 'Eingang auf anderer Spur'
            : '';
  }
  peak(value: number): string {
    return value > 0 ? `${Math.max(-60, 20 * Math.log10(value)).toFixed(0)} dBFS` : '−∞ dBFS';
  }
  resetVolume(t: AudioTrackState): void {
    this.volume(t, 0.8);
  }
  volume(t: AudioTrackState, value: number): void {
    if (!this.audio.node) {
      t.volume = +value;
      this.refresh();
      return;
    }
    void this.audio.send({ type: 'volume', id: t.id, value: +value }).catch((e) => {
      this.audio.error = String(e);
    });
  }
  openSettings(tab = 'audio'): void {
    this.settingsTab = tab;
    this.focus = document.activeElement as HTMLElement;
    this.settingsOpen = true;
    setTimeout(() => document.getElementById('close-audio-settings')?.focus());
  }
  closeSettings(): void {
    this.settingsOpen = false;
    focusPerformance();
  }
  openCalibration(method: 'tap' | 'loopback' = 'tap'): void {
    this.calibrationFocus = this.settingsOpen
      ? (document.getElementById('main-calibrate') ?? undefined)
      : (document.activeElement as HTMLElement);
    this.settingsOpen = false;
    this.calibrationReady = false;
    this.audio.calibration = {
      phase: 'idle',
      method,
      message: '',
      suggested: this.audio.compensationMs,
    };
    this.calibrationOpen = true;
    setTimeout(() => document.getElementById('close-calibration')?.focus());
  }
  async closeCalibration(): Promise<void> {
    await this.audio.cancelCalibration();
    this.calibrationOpen = false;
    focusPerformance();
    this.refresh();
  }
  async startCalibration(): Promise<void> {
    await this.audio.startCalibration(this.audio.calibration.method);
    this.refresh();
  }
  acceptCalibration(): void {
    this.audio.acceptCalibration();
    void this.closeCalibration();
  }
  async connectMidi(): Promise<void> {
    try {
      if (!navigator.requestMIDIAccess) throw Error('Web MIDI nicht verfügbar.');
      this.midiAccess ??= await navigator.requestMIDIAccess();
      this.midiAccess.onstatechange = () => {
        this.midiInputs = [...this.midiAccess!.inputs.values()];
        this.bindMidi();
        this.refresh();
      };
      this.midiInputs = [...this.midiAccess.inputs.values()];
      this.midiInput = this.midiInputs[0]?.id ?? '';
      this.bindMidi();
      this.midiStatus = this.midiInputs.length ? 'MIDI-Pedal bereit' : 'Kein MIDI-Eingang gefunden';
    } catch (e) {
      this.midiStatus = String((e as Error).message ?? e);
    }
    this.refresh();
  }
  bindMidi(): void {
    this.held.clear();
    this.pedalDown = false;
    for (const input of this.midiInputs)
      input.onmidimessage = input.id === this.midiInput ? this.pedal : null;
  }
  private pedal = (event: MIDIMessageEvent): void => {
    const data = event.data;
    if (!data || !this.pedalEnabled || (data[0] & 240) !== 176 || data[1] !== 67) return;
    const key = String(data[0] & 15);
    if (data[2] >= 64) this.held.add(key);
    else if (data[2] <= 32) this.held.delete(key);
    const down = this.held.size > 0;
    if (
      down &&
      !this.pedalDown &&
      !this.settingsOpen &&
      !this.calibrationOpen &&
      !this.fxDetailsOpen
    )
      void this.trigger(this.selected);
    this.pedalDown = down;
  };
  key = (e: KeyboardEvent): void => {
    if (
      e.key === 'Escape' &&
      this.tempoOpen &&
      !this.settingsOpen &&
      !this.calibrationOpen &&
      !this.fxDetailsOpen
    ) {
      e.preventDefault();
      this.tempoOpen = false;
      return;
    }
    if (this.settingsOpen || this.calibrationOpen || this.fxDetailsOpen) {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (this.fxDetailsOpen) this.closeFx();
        else if (this.calibrationOpen) void this.closeCalibration();
        else this.closeSettings();
      }
      if (e.key === 'Tab') {
        const root = this.fxDetailsOpen
          ? '.fx-detail-panel'
          : this.calibrationOpen
            ? '.calibration-panel'
            : '.settings-panel';
        const items = [
          ...document.querySelectorAll<HTMLElement>(`${root} button,${root} input,${root} select`),
        ].filter((el) => !(el as HTMLInputElement).disabled);
        const i = items.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) {
          e.preventDefault();
          items.at(-1)?.focus();
        } else if (!e.shiftKey && i === items.length - 1) {
          e.preventDefault();
          items[0]?.focus();
        }
      }
      return;
    }
    const target = e.target as HTMLElement;
    const action = shortcut(
      e,
      !!target.closest('input,select,textarea,[contenteditable="true"]'),
      (e.code === 'Enter' || e.code === 'NumpadEnter') && !!target.closest('button'),
    );
    if (!action) return;
    e.preventDefault();
    if (action.kind === 'select') this.select(action.id);
    else if (action.kind === 'main') void this.trigger(this.selected);
    else if (action.kind === 'metro') void this.toggleMetro();
    else if (action.kind === 'mute') void this.command('mute', this.selected);
    else void this.command('clear', this.selected);
  };
  buttonKey(e: KeyboardEvent, id: number): void {
    if (e.code === 'Space' || e.code === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) void this.trigger(e.code === 'Space' ? this.selected : id);
    }
  }
  private visibility = (): void => {
    this.held.clear();
    this.pedalDown = false;
    if (document.hidden) {
      this.audio.monitor = false;
      this.audio.config({ monitor: false });
      if (this.audio.calibrationActive)
        void this.audio.cancelCalibration(
          'Messung abgebrochen: Tab war im Hintergrund. Im Vordergrund erneut starten.',
        );
    }
  };
  private pagehide = (): void => {
    this.audio.dispose();
  };
  ngOnDestroy(): void {
    this.audio.dispose();
    window.removeEventListener('pagehide', this.pagehide);
    document.removeEventListener('visibilitychange', this.visibility);
    for (const input of this.midiInputs) input.onmidimessage = null;
    if (this.midiAccess) this.midiAccess.onstatechange = null;
  }
}
