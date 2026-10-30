// Original, bounded-memory stereo input effects. No lookahead or external dependencies.
export const INPUT_FX_PRESETS = [
  { id: 'clean', name: 'Kein Effekt', description: 'Unveränderter Eingang.' },
  {
    id: 'bass',
    name: 'Bass',
    description:
      'Eine Oktave tiefer, rund gefiltert und leicht gesättigt. Für gesungene Basslinien und stimmhafte Beatbox.',
  },
  {
    id: 'space',
    name: 'Hall',
    description: 'Stereo-Hall für räumliche Klavier-, Stimmen- und Beatbox-Layer.',
  },
  {
    id: 'echo',
    name: 'Echo',
    description: 'Gedämpfte Wiederholungen: im bestätigten Tempo synchron, sonst Millisekunden.',
  },
  {
    id: 'telephone',
    name: 'Telefon',
    description:
      'Mittiger Telefon-/Radio-Klang für Sprüche und kontrastierende Vocal-Layer. Für den vollen Effekt Intensität erhöhen.',
  },
  {
    id: 'punch',
    name: 'Punch',
    description:
      'Subtile Kompression und Präsenz für perkussive Layer. Wirkt stärker bei lauteren Eingangsspitzen.',
  },
];
export const DEFAULT_INPUT_FX = {
  preset: 'clean',
  amount: 0.65,
  bypass: false,
  tone: 0.5,
  room: 0.55,
  echoMs: 300,
  division: 'quarter',
  feedback: 0.35,
};
const clamp = (v, min, max, fallback) =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
export function normalizeInputFx(value = {}) {
  value = value && typeof value === 'object' ? value : {};
  return {
    preset: INPUT_FX_PRESETS.some((p) => p.id === value.preset) ? value.preset : 'clean',
    amount: clamp(value.amount, 0, 1, 0.65),
    bypass: false,
    tone: clamp(value.tone, 0, 1, 0.5),
    room: clamp(value.room, 0, 1, 0.55),
    echoMs: clamp(value.echoMs, 80, 1200, 300),
    division: ['quarter', 'eighth', 'dotted'].includes(value.division) ? value.division : 'quarter',
    feedback: clamp(value.feedback, 0, 0.7, 0.35),
  };
}
class Biquad {
  constructor() {
    this.z1 = [0, 0];
    this.z2 = [0, 0];
    this.b0 = 1;
    this.b1 = this.b2 = this.a1 = this.a2 = 0;
  }
  reset() {
    this.z1.fill(0);
    this.z2.fill(0);
  }
  set(type, freq, q, gain, rate) {
    const w = (2 * Math.PI * Math.min(rate * 0.45, Math.max(5, freq))) / rate,
      c = Math.cos(w),
      s = Math.sin(w),
      alpha = s / (2 * q),
      A = 10 ** (gain / 40);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'lowpass') {
      b0 = (1 - c) / 2;
      b1 = 1 - c;
      b2 = b0;
      a0 = 1 + alpha;
      a1 = -2 * c;
      a2 = 1 - alpha;
    } else if (type === 'highpass') {
      b0 = (1 + c) / 2;
      b1 = -(1 + c);
      b2 = b0;
      a0 = 1 + alpha;
      a1 = -2 * c;
      a2 = 1 - alpha;
    } else if (type === 'peak') {
      b0 = 1 + alpha * A;
      b1 = -2 * c;
      b2 = 1 - alpha * A;
      a0 = 1 + alpha / A;
      a1 = -2 * c;
      a2 = 1 - alpha / A;
    } else {
      const k = (2 * Math.sqrt(A) * s) / Math.sqrt(2);
      b0 = A * (A + 1 - (A - 1) * c + k);
      b1 = 2 * A * (A - 1 - (A + 1) * c);
      b2 = A * (A + 1 - (A - 1) * c - k);
      a0 = A + 1 + (A - 1) * c + k;
      a1 = -2 * (A - 1 + (A + 1) * c);
      a2 = A + 1 + (A - 1) * c - k;
    }
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }
  step(x, ch) {
    const y = this.b0 * x + this.z1[ch];
    this.z1[ch] = this.b1 * x - this.a1 * y + this.z2[ch];
    this.z2[ch] = this.b2 * x - this.a2 * y;
    return y;
  }
}
export class InputFX {
  constructor(rate) {
    this.rate = rate;
    this.config = normalizeInputFx();
    this.pending = null;
    this.mix = 0;
    this.target = 0;
    this.fadeStep = 1 / Math.max(1, rate * 0.015);
    this.filters = [new Biquad(), new Biquad(), new Biquad()];
    this.envelope = [0, 0];
    this.attack = Math.exp(-1 / (rate * 0.003));
    this.release = Math.exp(-1 / (rate * 0.12));
    this.echo = [new Float32Array(Math.ceil(rate * 2.1)), new Float32Array(Math.ceil(rate * 2.1))];
    this.echoPos = 0;
    this.echoLow = [0, 0];
    // Two complementary moving delay heads read at half speed (-12 semitones).
    // Delays span 4–44 ms; this is the wet effect's grain delay, not a route correction.
    this.octaveWindow = Math.max(2, Math.round(rate * 0.04));
    this.octaveBase = Math.max(2, Math.round(rate * 0.004));
    this.octave = [
      new Float32Array(this.octaveWindow + this.octaveBase + 4),
      new Float32Array(this.octaveWindow + this.octaveBase + 4),
    ];
    this.octavePos = 0;
    this.octavePhase = 0;
    this.combs = Array.from({ length: 2 }, (_, ch) =>
      [0.0297, 0.0371, 0.0411, 0.0437].map((t, i) => ({
        buffer: new Float32Array(Math.max(2, Math.round((t + ch * 0.0017 + i * 0.00013) * rate))),
        pos: 0,
        low: 0,
      })),
    );
    this.allpass = Array.from({ length: 2 }, (_, ch) =>
      [0.005, 0.0017].map((t) => ({
        buffer: new Float32Array(Math.max(2, Math.round((t + ch * 0.0003) * rate))),
        pos: 0,
      })),
    );
    this.left = this.right = 0;
    this.bpm = 120;
    this.synced = false;
    this.apply(this.config);
  }
  reset() {
    for (const f of this.filters) f.reset();
    this.envelope.fill(0);
    this.echo.forEach((b) => b.fill(0));
    this.echoLow.fill(0);
    this.echoPos = 0;
    this.octave.forEach((b) => b.fill(0));
    this.octavePos = 0;
    this.octavePhase = 0;
    for (const channel of this.combs)
      for (const c of channel) {
        c.buffer.fill(0);
        c.pos = 0;
        c.low = 0;
      }
    for (const channel of this.allpass)
      for (const a of channel) {
        a.buffer.fill(0);
        a.pos = 0;
      }
    this.mix = 0;
    this.left = this.right = 0;
  }
  set(value) {
    const config = normalizeInputFx(value);
    if (config.preset !== this.config.preset && this.mix > 0) {
      this.pending = config;
      this.target = 0;
      return;
    }
    this.pending = null;
    const changed = config.preset !== this.config.preset;
    if (changed) this.reset();
    this.apply(config);
  }
  apply(config) {
    this.config = config;
    this.target = config.preset === 'clean' ? 0 : config.amount;
    const f = this.filters,
      r = this.rate;
    if (config.preset === 'bass') {
      f[0].set('highpass', 28, 0.707, 0, r);
      f[1].set('shelf', 150, 0.707, 5, r);
      f[2].set('lowpass', 120 + config.tone * 1080, 0.707, 0, r);
    } else if (config.preset === 'punch') {
      f[0].set('highpass', 55, 0.707, 0, r);
      f[1].set('peak', 110, 0.8, 3, r);
      f[2].set('peak', 1700 + config.tone * 3000, 0.9, 3, r);
    } else if (config.preset === 'telephone') {
      f[0].set('highpass', 350 + config.tone * 350, 0.707, 0, r);
      f[1].set('lowpass', 1900 + config.tone * 2300, 0.707, 0, r);
    }
    this.damp = 1 - Math.exp((-2 * Math.PI * (1000 + config.tone * 6500)) / r);
    this.setTiming(this.bpm, this.synced, true);
  }
  setTiming(bpm, synced, force = false) {
    if (!force && this.bpm === bpm && this.synced === synced) return;
    this.bpm = bpm;
    this.synced = synced;
    const factor =
      this.config.division === 'eighth' ? 0.5 : this.config.division === 'dotted' ? 0.75 : 1;
    this.delay = Math.max(
      1,
      Math.min(
        this.echo[0].length - 1,
        Math.round(
          this.rate * (synced ? (60 / Math.max(30, bpm)) * factor : this.config.echoMs / 1000),
        ),
      ),
    );
  }
  readOctave(buffer, phase) {
    const length = buffer.length,
      pos = (this.octavePos - this.octaveBase - phase * this.octaveWindow + length) % length,
      i = Math.floor(pos),
      fraction = pos - i;
    return buffer[i] + (buffer[(i + 1) % length] - buffer[i]) * fraction;
  }
  channel(x, ch) {
    const preset = this.config.preset,
      f = this.filters;
    if (preset === 'bass') {
      const buffer = this.octave[ch];
      buffer[this.octavePos] = x;
      const p = this.octavePhase,
        q = (p + 0.5) % 1,
        weight = 0.5 - 0.5 * Math.cos(2 * Math.PI * p);
      const sub = this.readOctave(buffer, p) * weight + this.readOctave(buffer, q) * (1 - weight);
      const y = f[2].step(f[1].step(f[0].step(sub, ch), ch), ch);
      return Math.tanh(y * 1.8) * 0.7 + x * 0.12;
    }
    if (preset === 'telephone') return Math.tanh(f[1].step(f[0].step(x, ch), ch) * 1.5) * 0.8;
    if (preset === 'punch') {
      const y = f[2].step(f[1].step(f[0].step(x, ch), ch), ch),
        level = Math.abs(y),
        coefficient = level > this.envelope[ch] ? this.attack : this.release;
      const env = (this.envelope[ch] = coefficient * this.envelope[ch] + (1 - coefficient) * level);
      const gain = env > 0.14 ? (0.14 / env) ** 0.7 : 1;
      return Math.tanh(y * gain * 1.7) * 0.85;
    }
    if (preset === 'echo') {
      const buffer = this.echo[ch],
        pos = (this.echoPos - this.delay + buffer.length) % buffer.length;
      const wet = (this.echoLow[ch] += this.damp * (buffer[pos] - this.echoLow[ch]));
      buffer[this.echoPos] = x + wet * this.config.feedback;
      return x + wet * 0.65;
    }
    if (preset === 'space') {
      let sum = 0;
      for (const c of this.combs[ch]) {
        const y = c.buffer[c.pos];
        c.low += this.damp * (y - c.low);
        c.buffer[c.pos] = x * 0.3 + c.low * (0.6 + this.config.room * 0.28);
        c.pos = (c.pos + 1) % c.buffer.length;
        sum += y;
      }
      sum *= 0.5;
      for (const a of this.allpass[ch]) {
        const delayed = a.buffer[a.pos],
          y = delayed - sum * 0.5;
        a.buffer[a.pos] = sum + delayed * 0.5;
        a.pos = (a.pos + 1) % a.buffer.length;
        sum = y;
      }
      return x * 0.8 + sum * 0.9;
    }
    return x;
  }
  process(left, right) {
    if (this.pending && this.mix <= 0) {
      const next = this.pending;
      this.pending = null;
      this.reset();
      this.apply(next);
    }
    this.mix += Math.max(-this.fadeStep, Math.min(this.fadeStep, this.target - this.mix));
    if (this.config.preset === 'clean') {
      this.left = left;
      this.right = right;
      return;
    }
    const l = this.channel(left, 0),
      r = this.channel(right, 1);
    if (this.config.preset === 'bass') {
      this.octavePos = (this.octavePos + 1) % this.octave[0].length;
      this.octavePhase = (this.octavePhase + 0.5 / this.octaveWindow) % 1;
    }
    this.echoPos = (this.echoPos + 1) % this.echo[0].length;
    this.left = left + (l - left) * this.mix;
    this.right = right + (r - right) * this.mix;
    if (!Number.isFinite(this.left) || !Number.isFinite(this.right)) {
      this.reset();
      this.left = left;
      this.right = right;
    }
  }
}
