import { Track } from './loop-engine';
export function targetState(t: Track): 'empty' | 'recording' | 'playing' | 'overdub' {
  if (t.pending)
    return t.pending.action === 'start'
      ? 'recording'
      : t.pending.action === 'dub'
        ? 'overdub'
        : 'playing';
  return t.state === 'armed' ? 'recording' : t.state;
}
export function buttonLabel(t: Track): string {
  if (t.state === 'overdub' && t.pending?.action === 'play') return 'Overdub → Wiedergabe';
  const label = {
    empty: 'Aufnehmen',
    recording: 'Aufnahme',
    playing: 'Wiedergabe',
    overdub: 'Overdub',
  }[targetState(t)];
  return label;
}
export function countdown(t: Track, now: number): string {
  return t.pending
    ? `${t.state === 'overdub' && t.pending.action === 'play' ? 'Ende am Loop-Ende' : 'Vorgemerkt'} · in ${(Math.max(0, t.pending.at - now) / 1000).toFixed(1)} s`
    : '';
}
