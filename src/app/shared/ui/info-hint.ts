import { Component, input, signal } from '@angular/core';
let nextId = 0;
@Component({
  selector: 'info-hint',
  template: `<span class="info-hint" [class.open]="open()"
    ><button
      type="button"
      class="info-button"
      [attr.aria-label]="label()"
      [attr.aria-describedby]="id"
      (click)="open.update(toggle)"
      (blur)="open.set(false)"
      (keydown.escape)="open.set(false); $event.stopPropagation()"
    >
      i</button
    ><span class="info-tooltip" role="tooltip" [id]="id">{{ text() }}</span></span
  >`,
})
export class InfoHint {
  readonly text = input('');
  readonly label = input('Information');
  protected readonly open = signal(false);
  protected readonly toggle = (value: boolean) => !value;
  protected readonly id = `info-${nextId++}`;
}
