// Physical positions: KeyZ is labelled Y on the requested German QWERTZ layout.
export const PIANO_KEYS = [
  { code: 'KeyZ', label: 'Y', offset: 0, black: false, position: 0 },
  { code: 'KeyS', label: 'S', offset: 1, black: true, position: 1 },
  { code: 'KeyX', label: 'X', offset: 2, black: false, position: 1 },
  { code: 'KeyD', label: 'D', offset: 3, black: true, position: 2 },
  { code: 'KeyC', label: 'C', offset: 4, black: false, position: 2 },
  { code: 'KeyV', label: 'V', offset: 5, black: false, position: 3 },
  { code: 'KeyG', label: 'G', offset: 6, black: true, position: 4 },
  { code: 'KeyB', label: 'B', offset: 7, black: false, position: 4 },
  { code: 'KeyH', label: 'H', offset: 8, black: true, position: 5 },
  { code: 'KeyN', label: 'N', offset: 9, black: false, position: 5 },
  { code: 'KeyJ', label: 'J', offset: 10, black: true, position: 6 },
  { code: 'KeyM', label: 'M', offset: 11, black: false, position: 6 },
];
const NOTE_NAMES = ['C', 'Cis', 'D', 'Dis', 'E', 'F', 'Fis', 'G', 'Gis', 'A', 'Ais', 'H'];
let whiteCount = 0;
export const FULL_PIANO = Array.from({ length: 88 }, (_, i) => {
  const note = i + 21,
    pitch = note % 12,
    black = [1, 3, 6, 8, 10].includes(pitch);
  const position = whiteCount;
  if (!black) whiteCount++;
  return { note, black, position, name: `${NOTE_NAMES[pitch]}${Math.floor(note / 12) - 1}` };
});
export function octaveShortcut(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'metaKey' | 'repeat'>,
): number {
  if (e.ctrlKey || e.altKey || e.metaKey || e.repeat) return 0;
  if (e.key === '+' || e.code === 'NumpadAdd') return 1;
  if (e.key === '-' || e.code === 'NumpadSubtract') return -1;
  return 0;
}
export class PianoController {
  octave = 4;
  private held = new Map<string, number>();
  constructor(private emit: (data: number[]) => void) {}
  note(offset: number): number {
    return (this.octave + 1) * 12 + offset;
  }
  down(source: string, offset: number): void {
    this.downNote(source, this.note(offset));
  }
  downNote(source: string, note: number): void {
    if (note < 21 || note > 108) return;
    if (this.held.has(source)) return;
    const alreadyPlaying = [...this.held.values()].includes(note);
    this.held.set(source, note);
    if (!alreadyPlaying) this.emit([0x90, note, 100]);
  }
  up(source: string): void {
    const note = this.held.get(source);
    if (note === undefined) return;
    this.held.delete(source);
    if (![...this.held.values()].includes(note)) this.emit([0x80, note, 0]);
  }
  active(offset: number): boolean {
    return [...this.held.values()].includes(this.note(offset));
  }
  activeNote(note: number): boolean {
    return [...this.held.values()].includes(note);
  }
  mapped(note: number): boolean {
    return note >= this.note(0) && note <= this.note(11);
  }
  binding(note: number): string {
    return PIANO_KEYS.find((k) => this.note(k.offset) === note)?.label ?? '';
  }
  release(): void {
    for (const source of [...this.held.keys()]) this.up(source);
  }
  shift(delta: number): void {
    this.release();
    this.octave = Math.max(1, Math.min(7, this.octave + delta));
  }
}
