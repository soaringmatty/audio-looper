export class MidiTiming {
  active = false;
  samples: number[] = [];
  message = '';
  calibration?: { advanceMs: number; spreadMs: number; savedAt: string };
  private measurementAdvanceMs?: number;
  get activeAdvanceMs(): number | undefined {
    return this.active ? this.measurementAdvanceMs : undefined;
  }
  result?: {
    offsetMs: number;
    spreadMs: number;
    samples: number;
    savedAt: string;
    outputEstimateMs?: number;
    adjustedOffsetMs?: number;
    metronomeAdvanceMs?: number;
  };
  private outputEstimateMs = 0;
  private origin = 0;
  private beat = 500;
  private firstBeat = 0;
  private lastBeat = -1;
  private route = '';
  private storageKey(route: string): string {
    return `midi-timing-measurement-v1:${route}`;
  }
  setRoute(route: string): void {
    if (route === this.route) return;
    this.cancel('Messung bei Signalwegwechsel abgebrochen.');
    this.route = route;
    try {
      this.result = JSON.parse(localStorage.getItem(this.storageKey(route)) ?? 'null') ?? undefined;
    } catch {
      this.result = undefined;
    }
    this.calibration = undefined;
    try {
      const value = JSON.parse(
        localStorage.getItem(`midi-metronome-calibration-v1:${route}`) ?? 'null',
      );
      if (
        value &&
        typeof value.advanceMs === 'number' &&
        Number.isFinite(value.advanceMs) &&
        value.advanceMs >= 0 &&
        value.advanceMs <= 1000 &&
        typeof value.spreadMs === 'number' &&
        Number.isFinite(value.spreadMs) &&
        value.spreadMs >= 0 &&
        value.spreadMs <= 25 &&
        typeof value.savedAt === 'string'
      )
        this.calibration = value;
    } catch {
      /* Ignore invalid or inaccessible local storage. */
    }
  }
  resetCalibration(): void {
    this.cancel();
    this.calibration = undefined;
    this.message = 'Gemessener Klick-Vorlauf zurückgesetzt.';
    try {
      localStorage.removeItem(`midi-metronome-calibration-v1:${this.route}`);
    } catch {}
  }
  start(
    origin: number,
    beat: number,
    now: number,
    outputEstimateMs = 0,
    metronomeAdvanceMs?: number,
  ): void {
    this.measurementAdvanceMs = metronomeAdvanceMs;
    this.outputEstimateMs = Math.max(0, outputEstimateMs);
    this.origin = origin;
    this.beat = beat;
    this.firstBeat = Math.ceil((now - origin) / beat) + 2;
    this.lastBeat = -1;
    this.samples = [];
    this.active = true;
    this.message =
      'Nach zwei Klicks sechs einzelne Noten im Klickpuls spielen. Akkorde zählen nur einmal.';
  }
  input(at: number): boolean {
    if (!this.active) return false;
    const beat = Math.round((at - this.origin) / this.beat);
    const offset = at - (this.origin + beat * this.beat);
    if (
      beat < this.firstBeat ||
      beat <= this.lastBeat ||
      Math.abs(offset) > Math.min(300, this.beat * 0.45)
    )
      return false;
    this.lastBeat = beat;
    this.samples.push(offset);
    this.message = `${this.samples.length}/6 Noten gemessen`;
    if (this.samples.length === 6) {
      const values = [...this.samples].sort((a, b) => a - b);
      const offsetMs = (values[2] + values[3]) / 2;
      const deviations = values.map((v) => Math.abs(v - offsetMs)).sort((a, b) => a - b);
      this.result = {
        offsetMs,
        spreadMs: (deviations[2] + deviations[3]) / 2,
        samples: 6,
        outputEstimateMs: this.outputEstimateMs,
        adjustedOffsetMs: offsetMs - this.outputEstimateMs,
        metronomeAdvanceMs: this.measurementAdvanceMs,
        savedAt: new Date().toISOString(),
      };
      this.active = false;
      this.message =
        this.result.spreadMs > 25
          ? 'Hohe Streuung: keine stabile Korrektur ableitbar. Messung wiederholen.'
          : 'Messung gespeichert. Kein Eingriff in Live-Spiel oder Aufnahmen.';
      try {
        localStorage.setItem(this.storageKey(this.route), JSON.stringify(this.result));
      } catch {}
      // The measured offset is RESIDUAL to the advance used during this run.
      // Never derive a new correction from a legacy stored result on startup.
      if (
        this.result.spreadMs <= 25 &&
        this.measurementAdvanceMs !== undefined &&
        Number.isFinite(this.measurementAdvanceMs) &&
        Number.isFinite(offsetMs)
      ) {
        const advanceMs = this.measurementAdvanceMs + offsetMs;
        if (advanceMs >= 0 && advanceMs <= 1000) {
          this.calibration = {
            advanceMs,
            spreadMs: this.result.spreadMs,
            savedAt: this.result.savedAt,
          };
          try {
            localStorage.setItem(
              `midi-metronome-calibration-v1:${this.route}`,
              JSON.stringify(this.calibration),
            );
          } catch {}
          this.message =
            'Gemessener Klick-Vorlauf gespeichert. Noten und Loops bleiben unverändert.';
        } else this.message = 'Korrektur außerhalb des gültigen Bereichs. Messung wiederholen.';
      }
      return true;
    }
    return false;
  }
  cancel(message = 'Messung abgebrochen.'): void {
    if (this.active) this.message = message;
    this.active = false;
  }
}
