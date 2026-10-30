import { MidiTiming } from './midi-timing';
import { audibleNow, outputDelayMs } from '../../shared/audio-presentation';
import { focusPerformance } from '../../shared/ui/performance-focus';
import { Injectable, OnDestroy, signal, computed } from '@angular/core';

import { LoopEngine, Track } from './loop-engine';
import { MidiRouter, OutputProfile } from './midi-router';

import { Metronome } from './metronome';
import { PianoController, PIANO_KEYS, FULL_PIANO, octaveShortcut } from './piano';
import { targetState, buttonLabel, countdown } from './feedback';
import { shortcut } from '../../shared/shortcuts';
import {
  PROGRAMS,
  PROGRAM_GROUP_NAMES,
  STANDARD_DRUM_KIT,
  instrumentName,
  isDrumProgram,
  DRUM_NAMES,
  outputChannel,
  CLP625_VOICES,
} from './programs';

import { SOUND_BANKS, SoundBankId } from './soundbanks';
import { suggestTempo, TempoCandidate } from '../../shared/tempo';

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

@Injectable()
export class MidiWorkspace implements OnDestroy {
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

  midi = new MidiRouter();
  engine = new LoopEngine(this.midi);
  metro = new Metronome(() => this.midi.browser.context);
  piano = new PianoController((data) => this.midi.receive(data));
  keys = PIANO_KEYS;
  fullPiano = FULL_PIANO;
  targetState = targetState;
  buttonLabel = buttonLabel;
  countdown = countdown;
  pianoVisible = true;
  private lastInputId = 'piano';
  settingsOpen = false;
  commonRing = false;
  signature = '4/4';
  settingsTab: 'settings' | 'midi' | 'tempo' | 'help' | 'diagnostics' = 'settings';
  clavinovaVoices = CLP625_VOICES;
  warning = '';
  readonly timing = new MidiTiming();
  useMeasuredMetronome = true;
  diagnosticBusy = false;
  clock = performance.now();
  programs = PROGRAMS.map((name, id) => ({
    id,
    name: `${String(id + 1).padStart(3, '0')} · ${name}`,
  }));
  private worker = new Worker('clock-worker.js');
  private animation = 0;
  programGroups = PROGRAM_GROUP_NAMES.map((name, id) => ({
    name,
    programs: this.programs.slice(id * 8, id * 8 + 8),
  }));
  drumKit = STANDARD_DRUM_KIT;
  instrumentName = instrumentName;
  outputChannel = outputChannel;
  get selectedInstrument(): string {
    return instrumentName(this.engine.tracks[this.engine.selected].program);
  }
  drumLabel(note: number): string {
    return isDrumProgram(this.engine.tracks[this.engine.selected].program)
      ? (DRUM_NAMES[note] ?? '')
      : '';
  }
  soundBanks = SOUND_BANKS;
  get audioState(): 'ready' | 'loading' | 'error' | 'idle' {
    return this.midi.browser.state;
  }
  get audioStatus(): string {
    return {
      ready: 'Audio bereit',
      loading: 'Soundbank lädt',
      error: 'Soundbank-Ladefehler',
      idle: 'Startet beim Spielen',
    }[this.audioState];
  }
  async setSoundBank(id: SoundBankId): Promise<void> {
    this.release();
    try {
      await this.midi.browser.selectBank(id);
      this.warning = '';
    } catch {
      this.warning = this.midi.browser.error;
    }
  }
  instrumentCommitted(id: number): void {
    focusPerformance();
  }
  instrumentGroups(id: number) {
    if (this.midi.clavinova) return [{ name: 'Yamaha CLP-625', programs: this.clavinovaVoices }];
    return id === 4
      ? [
          ...this.programGroups,
          { name: 'Drum Kits', programs: [{ id: this.drumKit, name: 'Standard Drum Kit' }] },
        ]
      : this.programGroups;
  }
  resetVolume(t: Track): void {
    t.volume = 100;
    this.midi.configure(t.id);
  }

  private returnFocus?: HTMLElement;
  tempoOpen = false;
  tempoCandidates: TempoCandidate[] = [];
  tempoConfirmed = false;
  tempoBars = 4;
  tempoSignature = '4/4';
  tempoIndex = -1;
  private waitingNotes = new Map<string, { note: number; track: number }>();
  get tempoBpm(): number {
    const [beats, denominator] = this.tempoSignature.split('/').map(Number);
    return this.engine.reference
      ? (60000 * this.tempoBars * beats * 4) / denominator / this.engine.reference
      : 0;
  }
  get tempoChoiceLocked(): boolean {
    return this.engine.tracks.some((t) => t.state === 'recording' || t.state === 'armed');
  }
  get canConfirmTempo(): boolean {
    return (
      !!this.engine.reference &&
      Number.isInteger(this.tempoBars) &&
      this.tempoBars >= 1 &&
      this.tempoBars <= 64 &&
      Number.isFinite(this.tempoBpm) &&
      this.tempoBpm >= 30 &&
      this.tempoBpm <= 300 &&
      !this.engine.tracks.some((t) => t.state === 'recording' || t.state === 'armed')
    );
  }
  get displayBpm(): number {
    return Math.round(this.engine.bpm * 100) / 100;
  }
  set displayBpm(value: number) {
    this.engine.bpm = value;
  }
  get metroPercent(): number {
    return Math.round(this.metro.volume * 100);
  }
  set metroPercent(value: number) {
    this.metro.volume = Math.max(0, Math.min(100, +value)) / 100;
  }
  constructor() {
    readRecordBars('midi').forEach((bars, i) => (this.engine.tracks[i].fixedBars = bars));
    const preferences = readWorkspacePreferences('midi');
    if (preferences.bpm !== undefined) this.engine.bpm = preferences.bpm;
    if (preferences.signature) {
      this.signature = preferences.signature;
      [this.engine.beats, this.engine.denominator] = this.signature.split('/').map(Number);
    }
    if (preferences.metroVolume !== undefined) this.metro.volume = preferences.metroVolume;
    if (preferences.useMeasuredMetronome !== undefined)
      this.useMeasuredMetronome = preferences.useMeasuredMetronome;
    if (preferences.unmuteMode) this.engine.unmuteMode = preferences.unmuteMode;
    if (preferences.afterRecord) this.engine.afterRecord = preferences.afterRecord;
    if (preferences.commonRing !== undefined) this.commonRing = preferences.commonRing;
    if (preferences.startToleranceMs !== undefined)
      this.engine.startToleranceMs = preferences.startToleranceMs;
    this.syncMetro();
    this.midi.engine = this.engine;
    this.midi.onChange = () => {
      this.timing.setRoute(`${this.midi.inputId}|${this.midi.outputId}`);
      this.syncMetronomeAdvance();
      if (this.lastInputId !== this.midi.inputId) {
        this.lastInputId = this.midi.inputId;
        this.pianoVisible = this.midi.inputId === 'piano';
      }
      this.refresh();
    };
    this.midi.onLoopPedal = () => {
      if (!this.settingsOpen) void this.trigger(this.engine.selected);
    };
    this.midi.onInstrumentChange = (id, program) => this.program(this.engine.tracks[id], program);
    void this.midi.prepareAudio();
    void this.midi.connect();
    this.engine.onFirstFreeLoop = (t) => {
      this.tempoCandidates = suggestTempo(t.length, t.events, this.engine.bpm);
      this.tempoConfirmed = false;
      this.chooseTempo(0);
      this.tempoIndex = -1;
      this.refresh();
    };
    this.midi.onNoteInput = (at) => {
      this.timing.setRoute(`${this.midi.inputId}|${this.midi.outputId}`);
      if (!this.metro.enabled || this.engine.busy) this.timing.cancel();
      if (this.timing.input(at)) this.syncMetronomeAdvance();
      this.refresh();
    };
    this.worker.onmessage = () => {
      const now = performance.now();
      if (this.engine.busy && now - this.engine.lastTick > 250) {
        this.engine.invalidate(now);
        this.warning = 'Timing-Unterbrechung erkannt. App im Vordergrund lassen.';
      }
      this.engine.tick(now);
      this.syncMetronomeAdvance();
      this.metro.tick(now);
    };
    const frame = () => {
      this.clock = performance.now();
      this.refresh();
      this.animation = requestAnimationFrame(frame);
    };
    frame();
    window.addEventListener('blur', this.release);
    window.addEventListener('pagehide', this.pagehide);
    document.addEventListener('visibilitychange', this.visibility);
    document.addEventListener('focusin', this.focusin);
  }
  private dismissedWarning = '';
  get performanceWarning(): string {
    const message =
      this.warning ||
      (this.midi.outputId === 'browser' ? this.midi.browser.error : '') ||
      (this.midi.midiState === 'error' ||
      /fehlgeschlagen|nicht verfügbar|getrennt|keine eindeutige/i.test(this.midi.message)
        ? this.midi.message
        : '');
    return message === this.dismissedWarning ? '' : message;
  }
  dismissWarning(): void {
    this.dismissedWarning = this.performanceWarning;
    this.warning = '';
  }
  openDiagnostics(): void {
    this.midi.trace.record('diagnostics-open-before', { snapshot: this.midi.snapshot() });
    this.midi.trace.checkpoint('diagnostics-open');
    this.openSettings();
    this.settingsTab = 'diagnostics';
  }
  async exportTrace(mark = true): Promise<void> {
    if (this.diagnosticBusy) return;
    this.diagnosticBusy = true;
    try {
      if (mark) {
        this.midi.trace.record('user-reports-stuck-note', { snapshot: this.midi.snapshot() });
        await this.midi.trace.save('incident', 'user-reports-stuck-note');
      }
      const data = await this.midi.trace.exportData();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download =
        'audio-looper-midi-trace-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      this.warning = 'Diagnose-Export fehlgeschlagen. Erneut versuchen.';
    } finally {
      this.diagnosticBusy = false;
      this.refresh();
    }
  }
  async startTiming(): Promise<void> {
    if (this.engine.busy) {
      this.timing.message = 'Messung nur bei leeren Spuren starten.';
      return;
    }
    if (!this.metro.enabled) await this.toggleMetro();
    if (!this.metro.enabled) return;
    this.timing.setRoute(`${this.midi.inputId}|${this.midi.outputId}`);
    this.syncMetronomeAdvance();
    this.timing.start(
      this.metro.origin,
      ((60000 / this.metro.bpm) * 4) / this.metro.denominator,
      this.now(),
      this.metro.compensateOutput ? 0 : (outputDelayMs(this.metro.context) ?? 0),
      this.metro.compensateOutput ? this.metro.advanceMs : undefined,
    );
    this.closeSettings();
    this.refresh();
  }
  now(): number {
    return performance.now();
  }
  syncMetronomeAdvance(): void {
    this.metro.compensateOutput = this.midi.outputId !== 'browser';
    this.metro.setAdvanceOverride(
      this.timing.activeAdvanceMs ??
        (this.useMeasuredMetronome ? this.timing.calibration?.advanceMs : undefined),
    );
  }
  setMeasuredMetronome(enabled: boolean): void {
    this.timing.cancel('Messung bei Änderung der Klickkorrektur abgebrochen.');
    this.useMeasuredMetronome = enabled;
    this.syncMetronomeAdvance();
    this.savePreferences();
  }
  resetMetronomeCalibration(): void {
    this.timing.resetCalibration();
    this.syncMetronomeAdvance();
  }
  release = (): void => {
    this.waitingNotes.clear();
    this.piano.release();
    this.midi.releaseInput();
    this.engine.clearInputHistory();
  };
  select(id: number): void {
    if (this.engine.selected !== id) {
      this.engine.tracks[this.engine.selected].octave = this.piano.octave;
      this.release();
      this.engine.select(id);
      this.piano.octave = this.engine.tracks[id].octave;
    }
  }
  trackReady(id: number): boolean {
    return this.midi.outputId !== 'browser' || this.midi.browser.trackReady(id);
  }
  activateAudio(): void {
    if (this.midi.outputId === 'browser' && !this.midi.browser.ready) void this.midi.enableAudio();
  }
  async trigger(id: number): Promise<void> {
    this.timing.cancel('Messung bei Aufnahmebedienung abgebrochen.');
    this.select(id);
    if (this.midi.outputId === 'browser' && !this.midi.browser.ready) {
      try {
        await this.midi.browser.wake();
      } catch {
        this.warning = 'Audio konnte nicht gestartet werden.';
        return;
      }
    }
    if (!this.trackReady(id)) {
      this.warning = 'Instrument wird vorbereitet. Bitte gleich noch einmal starten.';
      return;
    }
    if (!this.engine.busy) {
      if (this.metro.enabled) this.engine.useMetronome(this.metro.origin);
      else this.engine.useFree();
    }
    this.warning = '';
    this.engine.press(id, this.now());
  }
  press(e: PointerEvent, id: number): void {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).focus();
    this.trigger(id);
  }
  buttonKey(e: KeyboardEvent, id: number): void {
    if (e.code === 'Space' || e.code === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) this.trigger(e.code === 'Space' ? this.engine.selected : id);
    }
  }
  key = (e: KeyboardEvent): void => {
    const target = e.target as HTMLElement;
    if (e.key === 'Escape' && this.tempoOpen && !this.settingsOpen) {
      e.preventDefault();
      this.tempoOpen = false;
      return;
    }
    if (this.settingsOpen) {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.closeSettings();
      }
      if (e.key === 'Tab') this.trapTab(e);
      return;
    }
    const editing = !!target.closest('input,select,textarea,[contenteditable="true"]');
    if (this.pianoVisible && !editing) {
      const delta = octaveShortcut(e);
      if (delta) {
        e.preventDefault();
        this.shiftOctave(delta);
        return;
      }
    }
    if (
      this.pianoVisible &&
      this.midi.inputId === 'piano' &&
      !editing &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.metaKey &&
      !e.shiftKey
    ) {
      const key = this.keys.find((k) => k.code === e.code);
      if (key) {
        e.preventDefault();
        if (!e.repeat) this.playNote(e.code, this.piano.note(key.offset));
        return;
      }
    }
    // Space is a performance shortcut throughout the workspace. Enter still
    // activates focused controls; piano buttons handle their own Space locally.
    const action = shortcut(
      e,
      editing,
      (e.code === 'Enter' || e.code === 'NumpadEnter') &&
        !!target.closest('button:not(.track-select)'),
    );
    if (!action) return;
    e.preventDefault();
    if (action.kind === 'select') this.select(action.id);
    else if (action.kind === 'main') this.trigger(this.engine.selected);
    else if (action.kind === 'metro') void this.toggleMetro();
    else if (action.kind === 'mute') this.mute(this.engine.selected);
    else this.clear(this.engine.selected);
  };
  keyup = (e: KeyboardEvent): void => {
    this.waitingNotes.delete(e.code);
    this.piano.up(e.code);
  };
  private playNote(source: string, note: number): void {
    if (this.trackReady(this.engine.selected)) {
      this.piano.downNote(source, note);
      return;
    }
    if (this.midi.outputId !== 'browser') return;
    const request = { note, track: this.engine.selected };
    this.waitingNotes.set(source, request);
    void this.midi.enableAudio().then(() => {
      if (this.waitingNotes.get(source) !== request) return;
      this.waitingNotes.delete(source);
      if (this.engine.selected === request.track && this.trackReady(request.track))
        this.piano.downNote(source, note);
    });
  }
  focusin = (e: FocusEvent): void => {
    if ((e.target as HTMLElement).closest('input,select,textarea,[contenteditable="true"]'))
      this.release();
  };
  pagehide = (): void => {
    this.release();
    this.midi.reset(this.now());
  };
  visibility = (): void => {
    this.timing.cancel('Messung bei Tabwechsel abgebrochen.');
    this.release();
    if (document.hidden) {
      this.midi.reset(this.now());
      if (this.engine.busy) this.warning = 'Hintergrundbetrieb: Timing nicht garantiert.';
    } else {
      if (this.warning === 'Hintergrundbetrieb: Timing nicht garantiert.') this.warning = '';
      this.engine.invalidate(this.now());
    }
  };
  async togglePiano(): Promise<void> {
    this.release();
    if (this.pianoVisible) {
      this.pianoVisible = false;
      return;
    }
    if (this.midi.outputId === 'browser' && !this.midi.browser.ready) await this.midi.enableAudio();
    this.pianoVisible = true;
    await this.midi.selectInput('piano');
    this.refresh();
    setTimeout(() => document.getElementById('piano-surface')?.focus({ preventScroll: true }));
  }
  pianoDown(e: PointerEvent, note: number): void {
    if (e.button !== 0) return;
    e.preventDefault();
    this.activateAudio();
    if (this.midi.inputId !== 'piano') return;
    document.getElementById('piano-surface')?.focus({ preventScroll: true });
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.playNote(`pointer:${e.pointerId}`, note);
  }
  pianoUp(e: PointerEvent): void {
    this.waitingNotes.delete(`pointer:${e.pointerId}`);
    this.piano.up(`pointer:${e.pointerId}`);
  }
  shiftOctave(delta: number): void {
    this.waitingNotes.clear();
    this.piano.shift(delta);
    this.engine.tracks[this.engine.selected].octave = this.piano.octave;
  }
  pianoKeyboard(e: KeyboardEvent, note: number, down: boolean): void {
    if (e.code !== 'Enter' && e.code !== 'Space') return;
    e.preventDefault();
    e.stopPropagation();
    const source = `accessible:${e.code}:${note}`;
    if (down && !e.repeat && this.midi.inputId === 'piano') this.playNote(source, note);
    else if (!down) {
      this.waitingNotes.delete(source);
      this.piano.up(source);
    }
  }
  setInput(id: string): void {
    this.timing.cancel('Messung bei Eingangswechsel abgebrochen.');
    this.release();
    this.activateAudio();
    void this.midi.selectInput(id);
  }
  setOutput(id: string): void {
    this.timing.cancel('Messung bei Ausgangswechsel abgebrochen.');
    this.release();
    void this.midi.selectOutput(id);
  }
  setProfile(profile: OutputProfile): void {
    this.release();
    this.midi.setProfile(profile);
  }
  monitor(value: boolean): void {
    this.release();
    this.midi.monitor = value;
  }
  program(t: Track, value: number): void {
    if (this.midi.clavinova && !t.length) return;
    this.release();
    this.activateAudio();
    t.program = +value;
    this.engine.invalidateTrack(t.id, this.now());
  }
  clear(id: number): void {
    this.release();
    this.engine.clear(id, this.now());
    if (!this.engine.busy) {
      this.tempoCandidates = [];
      this.tempoConfirmed = false;
      this.tempoOpen = false;
    }
  }
  resetAllTracks(): void {
    if (!window.confirm('Alle Aufnahmen und Taktvorgaben löschen?')) return;
    for (const t of this.engine.tracks) {
      this.clear(t.id);
      this.setRecordBars(t, null);
    }
    this.refresh();
  }
  mute(id: number): void {
    this.release();
    this.engine.mute(id, this.now());
  }
  unmuteHint(t: Track): string {
    return t.unmuteAt === undefined
      ? ''
      : `Aktiv in ${Math.max(0, (t.unmuteAt - this.now()) / 1000).toFixed(1)} s`;
  }
  settings(): void {
    this.timing.cancel('Messung bei Tempoänderung abgebrochen.');
    this.engine.bpm = Math.max(30, Math.min(300, Number(this.engine.bpm) || 120));
    this.syncMetro();
    this.savePreferences();
    this.metro.cursor = this.now();
  }
  savePreferences(): void {
    saveWorkspacePreferences('midi', {
      bpm: this.engine.bpm,
      signature: this.signature,
      metroVolume: this.metro.volume,
      afterRecord: this.engine.afterRecord,
      commonRing: this.commonRing,
      startToleranceMs: this.engine.startToleranceMs,
      unmuteMode: this.engine.unmuteMode,
      useMeasuredMetronome: this.useMeasuredMetronome,
    });
  }
  setSignature(s: string): void {
    this.signature = s;
    [this.engine.beats, this.engine.denominator] = s.split('/').map(Number);
    this.settings();
  }
  syncMetro(): void {
    this.metro.bpm = this.engine.bpm;
    this.metro.beats = this.engine.beats;
    this.metro.denominator = this.engine.denominator;
  }
  async toggleMetro(): Promise<void> {
    this.timing.cancel('Messung bei Metronomwechsel abgebrochen.');
    this.activateAudio();
    this.syncMetronomeAdvance();
    if (
      !this.metro.enabled &&
      this.engine.busy &&
      this.engine.mode === 'free' &&
      !this.tempoConfirmed
    ) {
      if (!this.engine.reference) {
        this.warning = 'Freie Erstaufnahme zuerst abschließen, danach Tempo-Vorschlag bestätigen.';
        return;
      }
      this.warning = 'Zuerst eine Einteilung in der Tempo-Auswahl wählen.';
      return;
    }
    try {
      this.syncMetro();
      const now = this.now();
      if (!this.metro.enabled && this.engine.busy) this.metro.align(this.engine.origin ?? now, now);
      await this.metro.toggle(now, this.engine.origin ?? now, !this.engine.busy);
    } catch {
      this.warning = 'Metronom: Audiofreigabe prüfen.';
    }
  }
  applyTempoChoice(index: number): void {
    this.chooseTempo(index);
    if (index >= 0 || index === -2) void this.confirmTempo();
  }
  setRecordBars(t: Track, value: unknown): void {
    if (t.state !== 'empty') return;
    t.fixedBars = normalizeRecordBars(value);
    saveRecordBars(
      'midi',
      this.engine.tracks.map((t) => t.fixedBars),
    );
  }
  barCount(t: Track): string {
    return t.state === 'recording' || t.state === 'armed'
      ? t.fixedBars
        ? String(t.fixedBars)
        : ''
      : formatBarCount(t.length, t.barDuration);
  }
  autoRemaining(t: Track): number {
    return Math.max(0, ((t.autoEnd ?? this.clock) - this.clock) / 1000);
  }
  chooseTempo(index: number): void {
    this.tempoIndex = Number(index);
    const c = this.tempoCandidates[this.tempoIndex];
    if (c) {
      this.tempoBars = c.bars;
      this.tempoSignature = `${c.beats}/${c.denominator}`;
    }
  }
  async confirmTempo(): Promise<void> {
    const bpm = this.tempoBpm;
    if (
      !this.canConfirmTempo ||
      !Number.isFinite(bpm) ||
      bpm < 30 ||
      bpm > 300 ||
      !Number.isInteger(this.tempoBars) ||
      this.tempoBars < 1 ||
      this.tempoBars > 64
    )
      return;
    this.engine.bpm = bpm;
    [this.engine.beats, this.engine.denominator] = this.tempoSignature.split('/').map(Number);
    this.signature = this.tempoSignature;
    this.tempoConfirmed = true;
    this.engine.mode = 'tempo';
    this.syncMetro();
    this.metro.align(this.engine.origin ?? this.now(), this.now());
    for (const t of this.engine.tracks) if (t.length) t.barDuration = this.engine.bar;
    this.warning = '';
    this.savePreferences();
    this.tempoOpen = false;
    if (this.settingsOpen) this.closeSettings();
  }
  panic(): void {
    this.midi.trace.record('panic-before', { snapshot: this.midi.snapshot() });
    this.midi.trace.checkpoint('panic', true);
    this.release();
    this.midi.reset(this.now());
    for (const t of this.engine.tracks) t.cursor = this.now();
    this.warning = 'Hängende Noten beendet. Kommende Loop-Noten spielen weiter.';
  }
  openSettings(tab: 'settings' | 'midi' | 'tempo' | 'help' = 'settings'): void {
    this.release();
    this.settingsTab = tab;
    this.timing.setRoute(`${this.midi.inputId}|${this.midi.outputId}`);
    this.returnFocus = document.activeElement as HTMLElement;
    this.settingsOpen = true;
    setTimeout(() => document.querySelector<HTMLButtonElement>('#close-settings')?.focus());
  }
  closeSettings(): void {
    this.settingsOpen = false;
    focusPerformance();
  }
  private trapTab(e: KeyboardEvent): void {
    const elements = Array.from(
      document.querySelectorAll<HTMLElement>(
        '.settings-panel button,.settings-panel select,.settings-panel input,.settings-panel a',
      ),
    ).filter((el) => !(el as HTMLButtonElement).disabled);
    const index = elements.indexOf(document.activeElement as HTMLElement);
    if (e.shiftKey && index <= 0) {
      e.preventDefault();
      elements.at(-1)?.focus();
    } else if (!e.shiftKey && index === elements.length - 1) {
      e.preventDefault();
      elements[0]?.focus();
    }
  }
  label(t: Track): string {
    return {
      empty: 'Aufnehmen',
      armed: 'Start geplant',
      recording: 'Aufnahme',
      playing: 'Wiedergabe',
      overdub: 'Overdub',
    }[t.state];
  }
  remaining(t: Track): number {
    return Math.max(0, ((t.pending?.at ?? this.clock) - this.clock) / 1000);
  }
  pending(t: Track): string {
    if (t.autoEnd !== undefined)
      return `Danach ${t.autoAction === 'dub' ? 'Overdub' : 'Wiedergabe'}`;
    if (!t.pending) return '';
    return {
      start: '→ Aufnahme ab nächster Grenze',
      finish: 'Ende vorgemerkt',
      dub: '→ Overdub am Loop-Anfang',
      play: '→ Wiedergabe am Loop-Anfang',
    }[t.pending.action];
  }
  progress(t: Track): number {
    const clock = Math.max(
      t.start,
      this.midi.outputId === 'browser'
        ? audibleNow(this.midi.browser.context, this.clock)
        : this.clock,
    );
    if (t.state === 'recording' && t.autoEnd !== undefined)
      return Math.max(0, Math.min(100, ((clock - t.start) / (t.autoEnd - t.start)) * 100));
    if (t.state === 'armed' && this.engine.reference) {
      return (
        (((clock - (this.engine.origin ?? clock)) % this.engine.reference) /
          this.engine.reference) *
        100
      );
    }
    return this.engine.phase(t, clock, this.commonRing) * 100;
  }
  duration(t: Track): string {
    const ms = t.length || (t.state === 'recording' ? Math.max(0, this.clock - t.start) : 0);
    return ms ? `${(ms / 1000).toFixed(2)} s` : '—';
  }
  ngOnDestroy(): void {
    this.release();
    this.worker.terminate();
    cancelAnimationFrame(this.animation);
    this.midi.reset(this.now());
    this.midi.trace.dispose();
    void this.midi.browser.dispose();
    if (this.metro.context !== this.midi.browser.context) void this.metro.context?.close();
    window.removeEventListener('blur', this.release);
    window.removeEventListener('pagehide', this.pagehide);
    document.removeEventListener('visibilitychange', this.visibility);
    document.removeEventListener('focusin', this.focusin);
  }
}
