export interface TapResult {
  ok: boolean;
  offsetMs: number;
  suggestedMs: number;
  spreadMs: number;
  accepted: number;
  rejected: number;
  offsets: (number | null)[];
  reason: string;
}
export function analyzeTaps(samples: Float32Array, starts: number[], rate: number): TapResult;
