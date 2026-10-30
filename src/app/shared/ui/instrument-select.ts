import { Directive, output } from '@angular/core';
import { InstrumentFocus } from './instrument-focus';

@Directive({
  selector: 'select[instrumentSelect]',
  host: {
    '(pointerdown)': 'pointer()',
    '(keydown)': 'keydown($event)',
    '(keyup)': 'keyup($event)',
    '(change)': 'change()',
    '(blur)': 'blur()',
  },
})
export class InstrumentSelect {
  readonly instrumentCommit = output<void>();
  private readonly focus = new InstrumentFocus(() => this.instrumentCommit.emit());
  pointer(): void {
    this.focus.pointer();
  }
  keydown(e: KeyboardEvent): void {
    this.focus.keydown(e.key);
  }
  keyup(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
    }
    this.focus.keyup(e.key);
  }
  change(): void {
    // Let Angular's select value accessor apply the choice before moving focus.
    queueMicrotask(() => this.focus.change());
  }
  blur(): void {
    this.focus.blur();
  }
}
