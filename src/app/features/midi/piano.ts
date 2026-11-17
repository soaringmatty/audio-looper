// Physical German QWERTZ positions; every lower-row key stays on a white note.
const WHITE_BINDINGS = [
  ['IntlBackslash', '<'],
  ['KeyZ', 'Y'],
  ['KeyX', 'X'],
  ['KeyC', 'C'],
  ['KeyV', 'V'],
  ['KeyB', 'B'],
  ['KeyN', 'N'],
  ['KeyM', 'M'],
  ['Comma', ','],
  ['Period', '.'],
  ['Slash', '-'],
];
const BLACK_BINDINGS = [
  ['KeyA', 'A'],
  ['KeyS', 'S'],
  ['KeyD', 'D'],
  ['KeyF', 'F'],
  ['KeyG', 'G'],
  ['KeyH', 'H'],
  ['KeyJ', 'J'],
  ['KeyK', 'K'],
  ['KeyL', 'L'],
  ['Semicolon', 'Ö'],
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
const WHITE_NOTES = FULL_PIANO.filter((key) => !key.black);
const MAX_START = WHITE_NOTES.length - WHITE_BINDINGS.length;
function keysForStart(index: number) {
  const start = WHITE_NOTES[index].note;
  return WHITE_BINDINGS.flatMap(([code, label], position) => {
    const note = WHITE_NOTES[index + position].note;
    const white = { code, label, offset: note - start, black: false, position };
    if (
      position === WHITE_BINDINGS.length - 1 ||
      WHITE_NOTES[index + position + 1].note - note !== 2
    )
      return [white];
    const [blackCode, blackLabel] = BLACK_BINDINGS[position];
    return [
      white,
      {
        code: blackCode,
        label: blackLabel,
        offset: note + 1 - start,
        black: true,
        position: position + 1,
      },
    ];
  });
}
export const PIANO_KEYS = keysForStart(
  WHITE_NOTES.findIndex((key) => key.note === defaultPianoStart(false)),
);
export function defaultPianoStart(drums: boolean): number {
  // H directly below C: the second lower-row key (Y) plays C2/C4.
  return drums ? 35 : 59;
}
export function octaveShortcut(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'metaKey' | 'repeat'>,
): number {
  if (e.ctrlKey || e.altKey || e.metaKey || e.repeat) return 0;
  if (e.code === 'ArrowUp') return 1;
  if (e.code === 'ArrowDown') return -1;
  return 0;
}
export class PianoController {
  private startIndex = WHITE_NOTES.findIndex((key) => key.note === defaultPianoStart(false));
  keys = keysForStart(this.startIndex);
  private held = new Map<string, number>();
  constructor(private emit: (data: number[]) => void) {}
  get startNote(): number {
    return WHITE_NOTES[this.startIndex].note;
  }
  set startNote(note: number) {
    const index = WHITE_NOTES.findIndex((key) => key.note >= note);
    this.setStart(index < 0 ? MAX_START : index);
  }
  get octave(): number {
    return Math.floor(this.startNote / 12) - 1;
  }
  set octave(value: number) {
    this.startNote = (value + 1) * 12;
  }
  get rangeLabel(): string {
    return `${WHITE_NOTES[this.startIndex].name}–${WHITE_NOTES[this.startIndex + WHITE_BINDINGS.length - 1].name}`;
  }
  canShiftWhite(delta: number): boolean {
    return this.startIndex + delta >= 0 && this.startIndex + delta <= MAX_START;
  }
  private setStart(index: number): void {
    const next = Math.max(0, Math.min(MAX_START, index));
    if (next === this.startIndex) return;
    this.release();
    this.startIndex = next;
    this.keys = keysForStart(next);
  }
  note(offset: number): number {
    return this.startNote + offset;
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
    return this.keys.some((key) => this.note(key.offset) === note);
  }
  binding(note: number): string {
    return this.keys.find((k) => this.note(k.offset) === note)?.label ?? '';
  }
  release(): void {
    for (const source of [...this.held.keys()]) this.up(source);
  }
  shift(delta: number): void {
    if (this.canShiftWhite(delta * 7)) this.shiftWhite(delta * 7);
  }
  shiftWhite(delta: number): void {
    this.setStart(this.startIndex + delta);
  }
}
