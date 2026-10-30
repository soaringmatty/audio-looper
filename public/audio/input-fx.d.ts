export type InputFxPreset = 'clean' | 'bass' | 'punch' | 'telephone' | 'space' | 'echo';
export interface InputFxSettings {
  preset: InputFxPreset;
  amount: number;
  bypass: boolean;
  tone: number;
  room: number;
  echoMs: number;
  division: 'quarter' | 'eighth' | 'dotted';
  feedback: number;
}
export const INPUT_FX_PRESETS: { id: InputFxPreset; name: string; description: string }[];
export const DEFAULT_INPUT_FX: InputFxSettings;
export function normalizeInputFx(value?: Partial<InputFxSettings> | unknown): InputFxSettings;
export class InputFX {
  constructor(rate: number);
  config: InputFxSettings;
  left: number;
  right: number;
  set(config: Partial<InputFxSettings>): void;
  setTiming(bpm: number, synced: boolean): void;
  process(left: number, right: number): void;
  reset(): void;
}
