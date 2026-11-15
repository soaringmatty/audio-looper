import { outputDelayMs } from '../../shared/audio-presentation';
export class Metronome {
  context?: AudioContext;
  gain?: GainNode;
  enabled = false;
  volume = 0.8;
  origin = 0;
  cursor = 0;
  bpm = 120;
  beats = 4;
  denominator = 4;
  established = false;
  compensateOutput = false;
  outputMode: 'laptop' | 'midi' = 'laptop';
  onMidiBeat: (accent: boolean, at: number, volume: number) => void = () => {};
  onMidiStop: () => void = () => {};
  private advanceOverrideMs?: number;
  get advanceMs(): number {
    if (this.outputMode === 'midi') return 0;
    if (this.compensateOutput && this.advanceOverrideMs !== undefined)
      return this.advanceOverrideMs;
    const estimate = this.compensateOutput ? outputDelayMs(this.context) : 0;
    return estimate !== null && estimate <= 1000 ? estimate : 0;
  }
  setAdvanceOverride(value: number | undefined): void {
    this.advanceOverrideMs =
      typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.min(1000, value))
        : undefined;
    // Keep the existing scheduling cursor: already queued clicks finish once.
    // Subsequent clicks use the new advance, without rewinding the musical origin.
  }
  private voices = new Set<OscillatorNode>();
  setOutput(mode: 'laptop' | 'midi', now: number): void {
    if (mode === this.outputMode) return;
    this.stopVoices();
    this.onMidiStop();
    this.outputMode = mode;
    this.cursor = now;
    this.setVolume();
  }
  private stopVoices(): void {
    for (const osc of this.voices) {
      try {
        osc.stop();
      } catch {}
    }
    this.voices.clear();
  }
  constructor(private readonly sharedContext?: () => AudioContext | undefined) {}
  async toggle(now: number, origin: number, restart = false): Promise<void> {
    const requested = performance.now();
    if (this.outputMode === 'laptop' && !this.context) {
      this.context = this.sharedContext?.() ?? new AudioContext({ latencyHint: 'interactive' });
      this.gain = this.context.createGain();
      this.gain.connect(this.context.destination);
    }
    if (this.outputMode === 'laptop') await this.context!.resume();
    this.enabled = !this.enabled;
    if (this.enabled && restart) {
      const start =
        now +
        Math.max(0, performance.now() - requested) +
        (this.outputMode === 'midi' ? 30 : this.advanceMs);
      this.align(start, start);
      this.cursor = start + 0.01;
      if (this.outputMode === 'midi') this.onMidiBeat(true, start, this.volume);
      else this.emitBeat(0, this.context!.currentTime);
    } else {
      if (!this.established) {
        this.origin = origin;
        this.established = true;
      }
      this.cursor = now;
    }
    if (!this.enabled) {
      this.stopVoices();
      this.onMidiStop();
    }
    this.setVolume();
  }
  setTempo(bpm: number, at: number): void {
    const ratio = this.bpm / bpm;
    if (this.established) this.origin = at + (this.origin - at) * ratio;
    this.bpm = bpm;
    this.cursor = at;
  }
  setVolume(): void {
    if (this.context && this.gain)
      this.gain.gain.setValueAtTime(
        this.enabled && this.outputMode === 'laptop' ? this.volume : 0,
        this.context.currentTime,
      );
  }
  align(origin: number, now: number): void {
    this.stopVoices();
    this.onMidiStop();
    this.origin = origin;
    this.established = true;
    this.cursor = now;
  }
  private emitBeat(n: number, at: number): void {
    const osc = this.context!.createOscillator(),
      envelope = this.context!.createGain();
    this.voices.add(osc);
    osc.frequency.value = n % this.beats === 0 ? 1300 : 850;
    envelope.gain.setValueAtTime(0.6, at);
    envelope.gain.exponentialRampToValueAtTime(0.001, at + 0.035);
    osc.connect(envelope);
    envelope.connect(this.gain!);
    osc.start(at);
    osc.stop(at + 0.04);
    osc.onended = () => {
      this.voices.delete(osc);
      osc.disconnect();
      envelope.disconnect();
    };
  }
  tick(now: number, horizon = now + this.advanceMs + 50): void {
    if (!this.enabled || (this.outputMode === 'laptop' && (!this.context || !this.gain))) return;
    const beat = ((60000 / this.bpm) * 4) / this.denominator;
    const renderFor = now + this.advanceMs;
    const from = Math.max(this.cursor, renderFor);
    for (
      let n = Math.max(0, Math.ceil((from - this.origin) / beat));
      this.origin + n * beat < horizon;
      n++
    ) {
      if (this.outputMode === 'midi')
        this.onMidiBeat(n % this.beats === 0, this.origin + n * beat, this.volume);
      else {
        const at =
          this.context!.currentTime + Math.max(0, this.origin + n * beat - renderFor) / 1000;
        this.emitBeat(n, at);
      }
    }
    this.cursor = Math.max(this.cursor, horizon);
  }
}
