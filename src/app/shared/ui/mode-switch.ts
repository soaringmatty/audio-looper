import { Component, input } from '@angular/core';
@Component({
  selector: 'mode-switch',
  template: `<div class="mode-switch segmented" role="group" aria-label="Looper-Modus">
    <button
      [class.active]="mode() === 'midi'"
      [attr.aria-pressed]="mode() === 'midi'"
      (click)="choose('midi')"
    >
      MIDI</button
    ><button
      [class.active]="mode() === 'audio'"
      [attr.aria-pressed]="mode() === 'audio'"
      (click)="choose('audio')"
    >
      Audio
    </button>
  </div>`,
})
export class ModeSwitch {
  readonly mode = input<'midi' | 'audio'>('midi');
  readonly busy = input(false);
  choose(mode: 'midi' | 'audio'): void {
    if (mode === this.mode()) return;
    if (
      this.busy() &&
      !window.confirm('Modus wechseln? Die Seite lädt neu und alle aktuellen Loops gehen verloren.')
    )
      return;
    try {
      localStorage.setItem('looper-mode', mode);
    } catch {}
    const url = new URL(location.href);
    url.searchParams.set('mode', mode);
    location.assign(url.href);
  }
}
