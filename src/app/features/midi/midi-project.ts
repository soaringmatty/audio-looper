import { LoopEngine, MidiEvent } from './loop-engine';
import { compileLoop } from './loop-seam';
import { CLP625_VOICES } from './programs';
import { SoundBankId, SOUND_BANKS } from './soundbanks';

export const MAX_PROJECT_BYTES = 16 * 1024 * 1024;
interface ProjectTrack {
  length: number;
  offset: number;
  layers: MidiEvent[][];
  program: number;
  volume: number;
  muted: boolean;
  pianoStart: number;
  fixedBars: number | null;
  barDuration: number | null;
}
export interface MidiProject {
  format: 'audio-looper-midi';
  version: 1;
  mode: 'free' | 'tempo';
  bpm: number;
  beats: number;
  denominator: number;
  reference: number;
  selected: number;
  soundBank: SoundBankId;
  tracks: ProjectTrack[];
}

/** Deliberately read-only: unfinished first takes and the current overdub take are omitted. */
export function exportMidiProject(engine: LoopEngine, soundBank: SoundBankId): MidiProject {
  const origin = engine.origin ?? 0;
  return {
    format: 'audio-looper-midi',
    version: 1,
    mode: engine.mode,
    bpm: engine.bpm,
    beats: engine.beats,
    denominator: engine.denominator,
    reference: engine.reference,
    selected: engine.selected,
    soundBank,
    tracks: engine.tracks.map((t) => {
      const complete = t.length > 0 && ['playing', 'overdub'].includes(t.state);
      return {
        length: complete ? t.length : 0,
        offset: complete ? (((t.start - origin) % t.length) + t.length) % t.length : 0,
        layers: complete
          ? (t.layers ?? [[...(t.carry ?? []).map((data) => ({ at: -1, data })), ...t.events]]).map(
              (layer) => layer.map((e) => ({ ...e, data: [...e.data] })),
            )
          : [],
        program: t.program,
        volume: t.volume,
        muted: t.muted,
        pianoStart: t.pianoStart ?? (t.octave + 1) * 12,
        fixedBars: t.fixedBars ?? null,
        barDuration: complete ? (t.barDuration ?? null) : null,
      };
    }),
  };
}

/** Never pass untrusted objects to the engine; construct a bounded, validated DTO. */
export function parseMidiProject(text: string): MidiProject {
  const fail = (): never => {
    throw Error('Ungültige oder nicht unterstützte MIDI-Projektdatei.');
  };
  if (text.length > MAX_PROJECT_BYTES) fail();
  const p = JSON.parse(text);
  if (!p || p.format !== 'audio-looper-midi' || p.version !== 1) fail();
  const num = (v: unknown, min: number, max: number, integer = false): number => {
    if (
      typeof v !== 'number' ||
      !Number.isFinite(v) ||
      v < min ||
      v > max ||
      (integer && !Number.isInteger(v))
    )
      fail();
    return v as number;
  };
  if (
    !['free', 'tempo'].includes(p.mode) ||
    !SOUND_BANKS.some((b) => b.id === p.soundBank) ||
    !Array.isArray(p.tracks) ||
    p.tracks.length !== 5
  )
    fail();
  const bpm = num(p.bpm, 30, 300);
  const beats = num(p.beats, 1, 16, true);
  const denominator = num(p.denominator, 1, 16, true);
  if (![1, 2, 4, 8, 16].includes(denominator)) fail();
  let budget = 200000;
  const tracks: ProjectTrack[] = p.tracks.map((t: any) => {
    if (!t || typeof t.muted !== 'boolean') fail();
    const length = num(t.length, 0, 86400000);
    if (length > 0 && length < 100) fail();
    const offset = num(t.offset, 0, length);
    if (length && offset >= length) fail();
    const program = num(t.program, 0, 265, true);
    if (program > 128 && !CLP625_VOICES.some((v) => v.id === program)) fail();
    const pianoStart = num(t.pianoStart, 21, 91, true);
    if ([1, 3, 6, 8, 10].includes(pianoStart % 12)) fail();
    if (!Array.isArray(t.layers) || t.layers.length > 10000 || (!length && t.layers.length)) fail();
    const layers = t.layers.map((layer: any) => {
      if (!Array.isArray(layer)) fail();
      let previous = -1;
      return layer.map((e: any): MidiEvent => {
        if (--budget < 0 || !e || !Array.isArray(e.data)) fail();
        const at = num(e.at, -1, Math.max(0, length));
        if ((at < 0 && at !== -1) || at >= length || at < previous) fail();
        previous = at;
        const data = e.data.map((v: unknown, i: number) =>
          num(v, i ? 0 : 128, i ? 127 : 239, true),
        );
        const op = data[0] & 0xf0;
        if (
          ![0x80, 0x90, 0xa0, 0xb0, 0xd0, 0xe0].includes(op) ||
          data.length !== (op === 0xd0 ? 2 : 3)
        )
          fail();
        if (op === 0xb0 && [0, 7, 11, 32, 120, 121, 122, 123, 124, 125, 126, 127].includes(data[1]))
          fail();
        if (e.boundary !== undefined && typeof e.boundary !== 'boolean') fail();
        return { at, data, ...(e.boundary === undefined ? {} : { boundary: e.boundary }) };
      });
    });
    return {
      length,
      offset,
      layers,
      program,
      pianoStart,
      muted: t.muted,
      volume: num(t.volume, 0, 127, true),
      fixedBars: t.fixedBars === null ? null : num(t.fixedBars, 1, 64, true),
      barDuration: t.barDuration === null ? null : num(t.barDuration, 1, 86400000),
    };
  });
  const reference = num(p.reference, 0, 86400000);
  if (tracks.some((t) => t.length) && reference < 100) fail();
  return {
    format: 'audio-looper-midi',
    version: 1,
    mode: p.mode,
    bpm,
    beats,
    denominator,
    reference,
    selected: num(p.selected, 0, 4, true),
    soundBank: p.soundBank,
    tracks,
  };
}

// Generalized CRT compatibility: periodic starts have a common zero iff every
// pair's offset difference is divisible by the GCD of their lengths. Use a
// microsecond tolerance so fractional-BPM loops don't fail on float roundoff.
const START_EPS_MS = 0.001;
function timingGcd(a: number, b: number): number {
  while (b > START_EPS_MS) {
    const remainder = a % b;
    if (remainder <= START_EPS_MS || b - remainder <= START_EPS_MS) return b;
    a = b;
    b = remainder;
  }
  return a;
}
function hasCommonStart(tracks: ProjectTrack[]): boolean {
  return tracks.every((a, i) =>
    tracks.slice(i + 1).every((b) => {
      const unit = timingGcd(a.length, b.length);
      const difference = a.offset - b.offset;
      return Math.abs(difference - Math.round(difference / unit) * unit) <= START_EPS_MS;
    }),
  );
}

/** Caller validates and prepares soundbank first. Loaded loops wait for an explicit start. */
export function restoreMidiProject(engine: LoopEngine, p: MidiProject, now: number): void {
  const loops = p.tracks.filter((t) => t.length > 0);
  const commonStart = hasCommonStart(loops);
  const longest = loops.reduce<ProjectTrack | undefined>(
    (longest, t) => (!longest || t.length > longest.length ? t : longest),
    undefined,
  );
  engine.sink.reset(now);
  for (const t of engine.tracks) engine.clear(t.id, now);
  engine.mode = p.mode;
  engine.bpm = p.bpm;
  engine.beats = p.beats;
  engine.denominator = p.denominator;
  engine.reference = p.reference;
  engine.origin = now;
  engine.selected = p.selected;
  engine.pausedAt = now;
  for (const [id, saved] of p.tracks.entries()) {
    const { offset, barDuration, ...values } = saved;
    let phase =
      saved.length && !commonStart
        ? (((longest!.offset - offset) % saved.length) + saved.length) % saved.length
        : 0;
    if (phase < START_EPS_MS || saved.length - phase < START_EPS_MS) phase = 0;
    const t = engine.tracks[id];
    Object.assign(t, values, compileLoop(saved.layers), {
      state: saved.length ? 'playing' : 'empty',
      start: now - phase,
      takeStart: now - phase,
      cursor: now,
      octave: Math.floor(saved.pianoStart / 12) - 1,
      barDuration: barDuration ?? undefined,
    });
  }
  engine.lastTick = now;
  engine.clearInputHistory();
  for (const t of engine.tracks) engine.invalidateTrack(t.id, now);
}
