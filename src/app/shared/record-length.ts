export function normalizeRecordBars(value: unknown): number | null {
  const n = Number(value);
  return value !== null && value !== '' && Number.isInteger(n) && n >= 1 && n <= 64 ? n : null;
}
export function readRecordBars(mode: 'midi' | 'audio'): (number | null)[] {
  try {
    const data = JSON.parse(localStorage.getItem(`${mode}-record-bars-v1`) ?? 'null');
    return Array.from({ length: 5 }, (_, i) => normalizeRecordBars(data?.[i]));
  } catch {
    return Array(5).fill(null);
  }
}
export function saveRecordBars(mode: 'midi' | 'audio', values: unknown[]): void {
  try {
    localStorage.setItem(
      `${mode}-record-bars-v1`,
      JSON.stringify(Array.from({ length: 5 }, (_, i) => normalizeRecordBars(values[i]))),
    );
  } catch {}
}
export function formatBarCount(length: number, bar: number | undefined): string {
  if (!length || !bar) return '';
  const count = length / bar;
  return `${Number(count.toFixed(3))}`;
}
