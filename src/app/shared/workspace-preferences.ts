/** Workstation controls only: never transport, loop data, permissions or live monitoring. */
export interface WorkspacePreferences {
  bpm?: number;
  signature?: string;
  metroVolume?: number;
  master?: number;
  monitorVolume?: number;
  afterRecord?: 'dub' | 'play';
  commonRing?: boolean;
  startToleranceMs?: number;
  unmuteMode?: 'cycle' | 'immediate';
  useMeasuredMetronome?: boolean;
}
function normalize(value: unknown, mode: 'audio' | 'midi'): WorkspacePreferences {
  if (!value || typeof value !== 'object') return {};
  const source = value as Record<string, unknown>,
    result: Record<string, unknown> = {};
  for (const [key, min, max] of [
    ['bpm', 30, 300],
    ['metroVolume', 0, mode === 'audio' ? 0.5 : 1],
    ['master', 0, 1],
    ['monitorVolume', 0, 1],
    ['startToleranceMs', 0, 100],
  ] as const) {
    const n = source[key];
    if (typeof n === 'number' && Number.isFinite(n)) result[key] = Math.max(min, Math.min(max, n));
  }
  if (['4/4', '3/4', '6/8', '5/4'].includes(String(source.signature)))
    result.signature = source.signature;
  if (source.afterRecord === 'dub' || source.afterRecord === 'play')
    result.afterRecord = source.afterRecord;
  if (typeof source.commonRing === 'boolean') result.commonRing = source.commonRing;
  if (typeof source.useMeasuredMetronome === 'boolean')
    result.useMeasuredMetronome = source.useMeasuredMetronome;
  if (source.unmuteMode === 'cycle' || source.unmuteMode === 'immediate')
    result.unmuteMode = source.unmuteMode;
  return result;
}
export function readWorkspacePreferences(mode: 'audio' | 'midi'): WorkspacePreferences {
  try {
    return normalize(JSON.parse(localStorage.getItem(`${mode}-workspace-v1`) ?? 'null'), mode);
  } catch {
    return {};
  }
}
export function saveWorkspacePreferences(
  mode: 'audio' | 'midi',
  value: WorkspacePreferences,
): void {
  try {
    localStorage.setItem(`${mode}-workspace-v1`, JSON.stringify(normalize(value, mode)));
  } catch {}
}
