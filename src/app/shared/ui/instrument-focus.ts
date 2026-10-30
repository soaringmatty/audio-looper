// Native selects must keep arrow-key navigation, then return to performance
// shortcuts when the choice is committed with Enter/Tab or by pointer.
export class InstrumentFocus {
  private keyboardNavigation = false;
  constructor(private commit: () => void) {}
  pointer(): void {
    this.keyboardNavigation = false;
  }
  keydown(key: string): void {
    if (
      ['ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(key) ||
      key.length === 1
    )
      this.keyboardNavigation = true;
  }
  keyup(key: string): void {
    if (key === 'Enter') {
      this.keyboardNavigation = false;
      this.commit();
    }
  }
  change(): void {
    if (!this.keyboardNavigation) this.commit();
  }
  blur(): void {
    this.keyboardNavigation = false;
  }
}
