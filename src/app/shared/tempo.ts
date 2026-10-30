import { MidiEvent } from '../features/midi/loop-engine';
export interface TempoCandidate {
  bpm: number;
  beats: number;
  denominator: number;
  bars: number;
  score: number;
  evidence: 'Notenraster' | 'Nur Loop-Länge';
}
// A ranked hypothesis, not a claim to identify meter uniquely.
export function suggestTempo(
  length: number,
  events: MidiEvent[],
  preferred = 120,
): TempoCandidate[] {
  if (length < 100) return [];
  const onsets = events
    .filter((e) => (e.data[0] & 240) === 144 && e.data[2] > 0)
    .map((e) => e.at)
    .sort((a, b) => a - b)
    .filter((v, i, a) => i === 0 || v - a[i - 1] > 35);
  const result: TempoCandidate[] = [];
  for (const [beats, denominator] of [
    [4, 4],
    [3, 4],
    [6, 8],
    [5, 4],
  ])
    for (const bars of [1, 2, 3, 4, 6, 8, 12, 16]) {
      const bpm = (60000 * bars * beats * 4) / denominator / length;
      if (bpm < 45 || bpm > 220) continue;
      const beat = 60000 / bpm;
      const offset = onsets[0] ?? 0;
      const error =
        onsets.reduce((sum, t) => {
          const n = ((t - offset) / beat) * 4;
          return sum + Math.abs(n - Math.round(n));
        }, 0) / Math.max(1, onsets.length);
      const quarterHits =
        onsets.filter((t) => {
          const x = (t - offset) / beat;
          return Math.abs(x - Math.round(x)) < 0.08;
        }).length / Math.max(1, onsets.length);
      const score =
        (onsets.length >= 3 ? 1 - error * 2 + quarterHits * 0.18 : 0) +
        (beats === 4 && denominator === 4 ? 0.1 : 0) -
        0.12 * Math.abs(Math.log2(bpm / preferred)) -
        (bars === 3 || bars === 6 || bars === 12 ? 0.04 : 0);
      result.push({
        bpm,
        beats,
        denominator,
        bars,
        score,
        evidence: onsets.length >= 3 ? 'Notenraster' : 'Nur Loop-Länge',
      });
    }
  return result.sort((a, b) => b.score - a.score).slice(0, 8);
}
