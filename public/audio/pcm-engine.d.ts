export const MAX_SECONDS: number;
export interface AudioTrackState {
  id: number;
  state: 'empty' | 'armed' | 'recording' | 'playing' | 'overdub';
  pending: { at: number; action: string } | null;
  start: number;
  length: number;
  muted: boolean;
  unmuteAt?: number;
  volume: number;
  written: number;
  draining: boolean;
  correctionMs?: number;
  recordedChannels?: string;
  fixedBars?: number | null;
  plannedLength?: number;
  autoEnd?: number;
  autoAction?: 'dub' | 'play';
  barDuration?: number;
}
export interface AudioState {
  frame: number;
  rate: number;
  selected: number;
  origin: number | null;
  reference: number;
  mode: 'free' | 'tempo';
  metro: boolean;
  bpm: number;
  beats: number;
  denominator: number;
  busy: boolean;
  error: string;
  inputPeak: number;
  outputPeak: number;
  fxPeak: number;
  calibrating: boolean;
  captureBusy: boolean;
  calibrationInfo: { method: string; elapsed: number; total: number; bar: number } | null;
  tracks: AudioTrackState[];
}
export function calibrationPulse(): Float32Array;
export function measureLatency(
  samples: Float32Array,
  starts: number[],
  rate: number,
): number | null;
export class PCMEngine {
  constructor(rate?: number);
  snapshot(): AudioState;
  command(command: any): void;
  render(input: Float32Array[], output: Float32Array[], frame: number): void;
  tracks: any[];
  frame: number;
  reference: number;
  origin: number | null;
  rate: number;
  mode: string;
  metro: boolean;
  compensation: number;
  afterRecord: string;
  busy: boolean;
}
