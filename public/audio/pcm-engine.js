// Audio-clock transport and bounded PCM buffers. No UI timers or encoded blobs.
import { InputFX, normalizeInputFx } from './input-fx.js';
export const MAX_SECONDS = 120;
const mod = (n, d) => ((n % d) + d) % d;
export function calibrationPulse() {
  const pulse = new Float32Array(256);
  let seed = 12345;
  for (let i = 0; i < pulse.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pulse[i] = ((seed / 4294967296) * 2 - 1) * Math.sin((Math.PI * i) / 255) * 0.2;
  }
  return pulse;
}
export function measureLatency(samples, starts, rate) {
  const pulse = calibrationPulse(),
    results = [];
  const pulseEnergy = pulse.reduce((sum, v) => sum + v * v, 0);
  for (const start of starts) {
    let best = 0,
      lag = 0;
    for (let d = 0; d <= rate * 0.5 && start + d + pulse.length <= samples.length; d++) {
      let dot = 0,
        energy = 0;
      for (let i = 0; i < pulse.length; i++) {
        const v = samples[start + d + i];
        dot += v * pulse[i];
        energy += v * v;
      }
      const score = Math.abs(dot) / Math.sqrt(Math.max(1e-12, energy * pulseEnergy));
      if (score > best) {
        best = score;
        lag = d;
      }
    }
    if (best < 0.6) return null;
    results.push(lag);
  }
  if (Math.max(...results) - Math.min(...results) > rate * 0.003) return null;
  return (results.sort((a, b) => a - b)[1] / rate) * 1000;
}
export class PCMEngine {
  constructor(rate = 48000) {
    this.rate = rate;
    this.frame = 0;
    this.selected = 0;
    this.origin = null;
    this.reference = 0;
    this.mode = 'free';
    this.bpm = 120;
    this.beats = 4;
    this.denominator = 4;
    this.metro = false;
    this.metroOrigin = 0;
    this.metroEstablished = false;
    this.metroVolume = 0.4;
    this.monitor = false;
    this.monitorVolume = 0.7;
    this.master = 0.8;
    this.compensation = 0;
    this.afterRecord = 'dub';
    this.channels = 'stereo';
    this.error = '';
    this.inputPeak = 0;
    this.outputPeak = 0;
    this.clickAt = -1e9;
    this.clickBeat = -1;
    this.calibration = null;
    this.selectionHistory = new Uint8Array(Math.ceil(rate) + 1);
    this.inputEffects = Array.from({ length: 5 }, () => new InputFX(rate));
    this.fxPeak = 0;
    this.tracks = Array.from({ length: 5 }, (_, id) => ({
      id,
      state: 'empty',
      pending: null,
      start: 0,
      length: 0,
      muted: false,
      volume: 0.8,
      buffer: null,
      capture: null,
      written: 0,
    }));
  }
  get busy() {
    return this.tracks.some((t) => t.state !== 'empty');
  }
  get captureBusy() {
    return this.tracks.some(
      (t) => t.state === 'recording' || t.state === 'armed' || t.capture || t.pending,
    );
  }
  get bar() {
    return Math.max(
      1,
      Math.round((((this.rate * 60) / this.bpm) * this.beats * 4) / this.denominator),
    );
  }
  boundary(now, origin, unit) {
    return origin + Math.max(0, Math.ceil((now - origin) / unit)) * unit;
  }
  config(c) {
    for (const key of [
      'monitor',
      'monitorVolume',
      'master',
      'metroVolume',
      'afterRecord',
      'selected',
    ])
      if (c[key] !== undefined) this[key] = c[key];
    if (!this.busy && !this.calibration) {
      for (const key of ['bpm', 'beats', 'denominator'])
        if (c[key] !== undefined) this[key] = c[key];
    }
    // New settings only affect future takes; active windows keep their own correction/channels.
    if (!this.calibration) {
      if (c.channels !== undefined) this.channels = c.channels;
      if (c.compensationMs !== undefined)
        this.compensation = Math.round(
          (Math.max(0, Math.min(1000, c.compensationMs)) * this.rate) / 1000,
        );
    }
  }
  command(c) {
    this.error = '';
    if (c.type === 'config') return this.config(c);
    if (c.type === 'cancelCalibration') {
      this.calibration = null;
      for (const fx of this.inputEffects) fx.reset();
      return;
    }
    if (c.type === 'inputFx') {
      if (this.calibration) {
        this.error = 'Input FX sind während der Kalibrierung überbrückt.';
        return;
      }
      this.inputEffects[c.id]?.set(normalizeInputFx(c.fx));
      return;
    }
    if (c.type === 'resetInputFx') {
      if (!this.captureBusy) for (const fx of this.inputEffects) fx.reset();
      return;
    }
    if (c.type === 'prepareRoute') {
      if (this.tracks.some((t) => t.state === 'recording' || t.state === 'armed')) {
        this.error = 'Erst die laufende/vorgemerkte Erstaufnahme abschließen.';
        return;
      }
      for (const t of this.tracks) {
        if (t.state === 'overdub') {
          t.state = 'playing';
          if (t.capture) t.capture.end = this.frame;
        }
        if (t.pending?.action === 'dub') t.pending = null;
      }
      this.monitor = false;
      return;
    }
    if (c.type === 'metro') {
      if (!this.metro && this.busy && this.mode === 'free') {
        this.error = 'Zuerst die Tempo-Einteilung bestätigen.';
        return;
      }
      if (!this.metro && (!this.busy || !this.metroEstablished)) {
        this.metroOrigin = this.busy ? this.origin : this.frame;
        this.metroEstablished = true;
        this.clickBeat = -1;
        this.clickAt = -1e9;
      }
      this.metro = !this.metro;
      return;
    }
    if (c.type === 'tempo') {
      if (
        !this.reference ||
        this.tracks.some((t) => t.state === 'recording' || t.state === 'armed')
      )
        return;
      this.bpm = c.bpm;
      this.beats = c.beats;
      this.denominator = c.denominator;
      // Preserve the exact free-loop duration, including non-integer frames/bar.
      this.confirmedBar = this.reference / c.bars;
      this.mode = 'tempo';
      this.metroOrigin = this.origin;
      this.metroEstablished = true;
      for (const track of this.tracks) if (track.length) track.barDuration = this.confirmedBar;
      return;
    }
    if (c.type === 'calibrate') {
      if (this.captureBusy) {
        this.error = 'Aufnahme/Overdub und Nachlauf zuerst beenden.';
        return;
      }
      const method = c.method === 'tap' ? 'tap' : 'loopback',
        beat = this.rate * 0.5;
      const starts =
        method === 'tap'
          ? Array.from({ length: 8 }, (_, i) => Math.round(this.rate * 0.25 + beat * 4 * (i + 1)))
          : [0.2, 0.9, 1.6].map((v) => Math.round(v * this.rate));
      const count =
        method === 'tap' ? starts.at(-1) + Math.ceil(this.rate * 1.1) : Math.ceil(this.rate * 2.5);
      this.monitor = false;
      for (const fx of this.inputEffects) fx.reset();
      this.calibration = {
        method,
        start: this.frame,
        samples: new Float32Array(count),
        starts,
        pulse: calibrationPulse(),
        done: false,
      };
      return;
    }
    const t = this.tracks[c.id];
    if (!t || this.calibration) return;
    if (c.type === 'volume') {
      t.volume = Math.max(0, Math.min(1, c.value));
      return;
    }
    if (c.type === 'mute') {
      if (t.unmuteAt !== undefined) {
        t.unmuteAt = undefined;
        return;
      }
      if (t.muted && t.length && c.unmuteMode !== 'immediate') {
        const at = Math.round(this.boundary(this.frame, t.start, t.length));
        if (at > this.frame) {
          t.unmuteAt = at;
          return;
        }
      }
      t.muted = !t.muted;
      return;
    }
    if (c.type === 'clear') {
      this.inputEffects[t.id].reset();
      Object.assign(t, {
        state: 'empty',
        pending: null,
        unmuteAt: undefined,
        length: 0,
        start: 0,
        buffer: null,
        capture: null,
        written: 0,
        fixedBars: null,
        autoEnd: undefined,
        autoAction: undefined,
        plannedLength: undefined,
        barDuration: undefined,
      });
      if (!this.busy) {
        this.origin = null;
        this.reference = 0;
        this.confirmedBar = undefined;
        this.mode = 'free';
      }
      return;
    }
    if (c.type !== 'press') return;
    this.selected = t.id;
    const now = this.frame;
    if (t.state === 'empty') {
      if (this.mode === 'free' && !this.reference && this.busy) {
        this.error = 'Zuerst die freie Erstaufnahme abschließen.';
        return;
      }
      if (!c.buffers || c.buffers.length !== 2) {
        this.error = 'Aufnahmespeicher fehlt.';
        return;
      }
      const fixed = Number.isInteger(c.fixedBars) && c.fixedBars >= 1 && c.fixedBars <= 64,
        first = !this.busy;
      const bar = this.mode === 'tempo' ? (this.confirmedBar ?? this.bar) : this.bar;
      const planned = fixed ? Math.round(c.fixedBars * bar) : undefined;
      if (planned > c.buffers[0].length) {
        this.error = 'Die feste Taktzahl überschreitet 120 Sekunden. Weniger Takte wählen.';
        return;
      }
      t.buffer = c.buffers;
      t.fixedBars = fixed ? c.fixedBars : null;
      t.plannedLength = planned;
      t.barDuration = fixed || this.mode === 'tempo' ? bar : undefined;
      if (!this.busy) {
        this.mode = this.metro || fixed ? 'tempo' : 'free';
        this.confirmedBar = undefined;
        this.origin = this.metro ? this.metroOrigin : now;
        if (fixed) t.barDuration = this.bar;
      }
      const grid = this.mode === 'tempo' ? (this.confirmedBar ?? this.bar) : this.reference;
      if (first && fixed && !this.metro) this.begin(t, now);
      else if (grid) {
        t.state = 'armed';
        t.pending = { at: Math.round(this.boundary(now, this.origin, grid)), action: 'start' };
      } else this.begin(t, now);
    } else if (t.state === 'armed') {
      t.state = 'empty';
      t.pending = null;
      t.buffer = null;
      if (!this.busy) {
        this.origin = null;
        this.reference = 0;
      }
    } else if (t.state === 'recording') {
      if (t.autoEnd !== undefined) {
        t.autoAction = t.autoAction === 'dub' ? 'play' : 'dub';
        return;
      }
      if (t.pending) {
        t.pending.action = t.pending.action === 'dub' ? 'play' : 'dub';
        return;
      }
      if (now - t.start < this.rate * 0.1) return;
      let end;
      if (this.mode === 'free' && !this.reference) {
        this.reference = now - t.start;
        end = now;
      } else if (this.mode === 'tempo') {
        const bar = this.confirmedBar ?? this.bar;
        end = Math.max(t.start + Math.round(bar), Math.round(this.boundary(now, this.origin, bar)));
      } else {
        const duration = now - t.start;
        const candidates = [1 / 8, 1 / 4, 1 / 2, 1, 2, 3, 4, 5, 6, 7, 8].map((v) =>
          Math.round(v * this.reference),
        );
        end =
          t.start +
          (duration > 8 * this.reference
            ? Math.round(duration / this.reference) * this.reference
            : candidates.reduce((a, b) =>
                Math.abs(a - duration) <= Math.abs(b - duration) ? a : b,
              ));
      }
      if (end - t.start > t.buffer[0].length) {
        this.error = 'Maximale Loop-Länge: 120 Sekunden. Aufnahme wird begrenzt.';
        end = t.start + t.buffer[0].length;
      }
      if (end <= now) this.finish(t, end, this.afterRecord);
      else t.pending = { at: end, action: this.afterRecord };
    } else if (t.state === 'overdub') {
      if (t.pending?.action === 'play') t.pending = null;
      else {
        const phase = mod(now - t.start, t.length);
        if (phase >= t.length / 2) t.pending = { at: now + t.length - phase, action: 'play' };
        else {
          t.state = 'playing';
          t.pending = null;
          if (t.capture) t.capture.end = now;
        }
      }
    } else if (t.pending) t.pending = null;
    else
      t.pending = {
        at: this.boundary(
          Math.max(
            now,
            t.capture && Number.isFinite(t.capture.end)
              ? t.capture.end + t.capture.compensation
              : now,
          ),
          t.start,
          t.length,
        ),
        action: 'dub',
      };
  }
  begin(t, at) {
    t.state = 'recording';
    t.pending = null;
    t.start = at;
    t.written = 0;
    t.capture = {
      start: at,
      end: Infinity,
      compensation: this.compensation,
      channels: this.channels,
    };
    t.correctionMs = (this.compensation / this.rate) * 1000;
    t.recordedChannels = this.channels;
    t.autoEnd = t.plannedLength ? at + t.plannedLength : undefined;
    t.autoAction = this.afterRecord;
    if (this.mode === 'tempo') t.barDuration = this.confirmedBar ?? this.bar;
  }
  finish(t, end, action) {
    t.length = Math.max(1, end - t.start);
    t.state = action === 'dub' ? 'overdub' : 'playing';
    t.pending = null;
    if (!this.reference) this.reference = t.length;
    t.autoEnd = undefined;
    t.plannedLength = undefined;
    if (action === 'play' && t.capture) t.capture.end = end;
    // A late, shortened free take is cropped, not replayed at phase zero.
    if (action === 'dub')
      for (let n = t.length; n < t.written; n++)
        for (let ch = 0; ch < 2; ch++) t.buffer[ch][n % t.length] += t.buffer[ch][n];
  }
  render(input, output, frame) {
    const size = output[0].length;
    this.frame = frame;
    let peakIn = 0,
      peakOut = 0,
      peakFx = 0;
    for (const fx of this.inputEffects) fx.setTiming(this.bpm, this.mode === 'tempo' || this.metro);
    const left = input[0],
      right = input[1] ?? left;
    for (let i = 0; i < size; i++) {
      const now = frame + i;
      this.frame = now;
      this.selectionHistory[now % this.selectionHistory.length] = this.selected;
      const rawL = left?.[i] ?? 0,
        rawR = right?.[i] ?? 0;
      let l = rawL,
        r = rawR;
      if (this.channels === 'left') r = l;
      else if (this.channels === 'right') l = r;
      else if (this.channels === 'mono') l = r = (l + r) * 0.5;
      peakIn = Math.max(peakIn, Math.abs(l), Math.abs(r));
      let outL = 0,
        outR = 0;
      if (this.calibration) {
        const c = this.calibration,
          pos = now - c.start;
        if (pos < c.samples.length) {
          c.samples[pos] = (l + r) * 0.5;
          outL = outR = 0;
          if (c.method === 'tap') {
            const elapsed = pos - this.rate * 0.25,
              beat = this.rate * 0.5,
              n = Math.floor(elapsed / beat),
              age = (elapsed - n * beat) / this.rate;
            if (n >= 0 && n <= 32 && age < 0.035)
              outL = outR =
                Math.sin(2 * Math.PI * (n % 4 === 0 ? 1300 : 850) * age) *
                Math.exp(-age * 150) *
                0.22;
          } else
            for (const start of c.starts)
              if (pos >= start && pos < start + c.pulse.length) outL = outR = c.pulse[pos - start];
        } else c.done = true;
      } else {
        for (const t of this.tracks) {
          if (t.unmuteAt !== undefined && t.unmuteAt <= now) {
            t.unmuteAt = undefined;
            t.muted = false;
          }
          if (t.pending && t.pending.at <= now) {
            const p = t.pending;
            t.pending = null;
            if (p.action === 'start') this.begin(t, p.at);
            else if (t.state === 'recording') this.finish(t, p.at, p.action);
            else if (p.action === 'play') {
              t.state = 'playing';
              if (t.capture) t.capture.end = p.at;
            } else {
              t.state = 'overdub';
              t.capture = {
                start: p.at,
                end: Infinity,
                compensation: this.compensation,
                channels: this.channels,
              };
              t.correctionMs = (this.compensation / this.rate) * 1000;
              t.recordedChannels = this.channels;
            }
          }
          if (t.state === 'recording' && t.autoEnd !== undefined && t.autoEnd <= now)
            this.finish(t, t.autoEnd, t.autoAction ?? this.afterRecord);
          if (t.state === 'recording' && now >= t.start + t.buffer[0].length) {
            if (!this.reference) this.reference = t.buffer[0].length;
            this.finish(t, t.start + t.buffer[0].length, 'play');
            this.error = '120 Sekunden erreicht; Aufnahme abgeschlossen.';
          }
          const capture = t.capture,
            logical = now - (capture?.compensation ?? this.compensation);
          const inputTrack = this.selectionHistory[mod(logical, this.selectionHistory.length)];
          const receiving =
            capture && inputTrack === t.id && logical >= capture.start && logical < capture.end;
          let inL = rawL,
            inR = rawR;
          const channels = capture?.channels ?? this.channels;
          if (channels === 'left') inR = inL;
          else if (channels === 'right') inL = inR;
          else if (channels === 'mono') inL = inR = (inL + inR) * 0.5;
          const fx = this.inputEffects[t.id],
            feed = t.id === this.selected || receiving;
          fx.process(feed ? inL : 0, feed ? inR : 0);
          if (t.id === this.selected) {
            peakFx = Math.max(peakFx, Math.abs(fx.left), Math.abs(fx.right));
            if (this.monitor && !t.muted) {
              outL += fx.left * this.monitorVolume;
              outR += fx.right * this.monitorVolume;
            }
          }
          if (t.length && !t.muted) {
            const pos = mod(now - t.start, t.length);
            const fade = Math.max(1, Math.min(Math.round(this.rate * 0.002), t.length / 4));
            const gain = Math.min(1, pos / fade, (t.length - 1 - pos) / fade) * t.volume;
            outL += t.buffer[0][pos] * gain;
            outR += t.buffer[1][pos] * gain;
          }
          if (receiving) {
            const offset = logical - t.start;
            const index = t.length ? mod(offset, t.length) : offset;
            if (index >= 0 && index < t.buffer[0].length) {
              t.buffer[0][index] += fx.left;
              t.buffer[1][index] += fx.right;
              if (!t.length) t.written = Math.max(t.written, index + 1);
            }
          }
          if (capture && logical >= capture.end) t.capture = null;
        }
        if (this.metro) {
          const bar = this.confirmedBar ?? this.bar,
            beat = bar / this.beats;
          const n = Math.floor((now - this.metroOrigin) / beat);
          const at = Math.round(this.metroOrigin + n * beat);
          if (n >= 0 && n !== this.clickBeat && now >= at) {
            this.clickBeat = n;
            this.clickAt = at;
          }
          const age = (now - this.clickAt) / this.rate;
          if (age >= 0 && age < 0.035) {
            const sound =
              Math.sin(2 * Math.PI * (mod(n, this.beats) === 0 ? 1300 : 850) * age) *
              Math.exp(-age * 150) *
              this.metroVolume;
            outL += sound;
            outR += sound;
          }
        }
      }
      outL *= this.master;
      outR *= this.master;
      peakOut = Math.max(peakOut, Math.abs(outL), Math.abs(outR));
      output[0][i] = Math.max(-1, Math.min(1, outL));
      output[1][i] = Math.max(-1, Math.min(1, outR));
    }
    this.frame = frame + size;
    this.inputPeak = Math.max(peakIn, this.inputPeak * 0.9);
    this.outputPeak = Math.max(peakOut, this.outputPeak * 0.9);
    this.fxPeak = Math.max(peakFx, this.fxPeak * 0.9);
  }
  snapshot() {
    return {
      frame: this.frame,
      rate: this.rate,
      selected: this.selected,
      origin: this.origin,
      reference: this.reference,
      mode: this.mode,
      metro: this.metro,
      bpm: this.bpm,
      beats: this.beats,
      denominator: this.denominator,
      busy: this.busy,
      error: this.error,
      inputPeak: this.inputPeak,
      outputPeak: this.outputPeak,
      fxPeak: this.fxPeak,
      calibrating: !!this.calibration,
      captureBusy: this.captureBusy,
      calibrationInfo: this.calibration
        ? {
            method: this.calibration.method,
            elapsed: (this.frame - this.calibration.start) / this.rate,
            total: this.calibration.samples.length / this.rate,
            bar: Math.max(
              0,
              Math.min(
                8,
                Math.floor(((this.frame - this.calibration.start) / this.rate - 0.25) / 2),
              ),
            ),
          }
        : null,
      tracks: this.tracks.map(({ buffer, capture, ...t }) => ({
        ...t,
        draining: !!capture && Number.isFinite(capture.end),
      })),
    };
  }
}
