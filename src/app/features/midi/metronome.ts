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
  private advanceOverrideMs?: number;
  get advanceMs(): number {
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
  constructor(private readonly sharedContext?: () => AudioContext | undefined) {}
  async toggle(now: number, origin: number, restart = false): Promise<void> {
    const requested = performance.now();
    if (!this.context) {
      this.context = this.sharedContext?.() ?? new AudioContext({ latencyHint: 'interactive' });
      this.gain = this.context.createGain();
      this.gain.connect(this.context.destination);
    }
    await this.context.resume();
    this.enabled = !this.enabled;
    if (this.enabled && restart) {
      const start = now + Math.max(0, performance.now() - requested) + this.advanceMs;
      this.align(start, start);
      this.cursor = start + 0.01;
      this.emitBeat(0, this.context.currentTime);
    } else {
      if (!this.established) {
        this.origin = origin;
        this.established = true;
      }
      this.cursor = now;
    }
    this.setVolume();
  }
  setVolume(): void {
    if (this.context && this.gain)
      this.gain.gain.setValueAtTime(this.enabled ? this.volume : 0, this.context.currentTime);
  }
  align(origin: number, now: number): void {
    for (const osc of this.voices) {
      try {
        osc.stop();
      } catch {}
    }
    this.voices.clear();
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
  tick(now: number): void {
    if (!this.enabled || !this.context || !this.gain) return;
    const beat = ((60000 / this.bpm) * 4) / this.denominator;
    const renderFor = now + this.advanceMs;
    const from = Math.max(this.cursor, renderFor);
    for (
      let n = Math.max(0, Math.ceil((from - this.origin) / beat));
      this.origin + n * beat < renderFor + 50;
      n++
    ) {
      const at = this.context.currentTime + Math.max(0, this.origin + n * beat - renderFor) / 1000;
      this.emitBeat(n, at);
    }
    this.cursor = Math.max(this.cursor, renderFor + 50);
  }
}
