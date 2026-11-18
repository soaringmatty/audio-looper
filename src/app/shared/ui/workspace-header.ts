import { Component, input, output } from '@angular/core';
import { ModeSwitch } from './mode-switch';
@Component({
  selector: 'header[app-workspace-header]',
  imports: [ModeSwitch],
  template: `
    <div class="brand">
      <h1>Audio Looper</h1>
      <span class="eyebrow">{{ mode() === 'midi' ? 'MIDI' : 'AUDIO' }} LOOPSTATION</span>
    </div>
    <ng-content />
    <nav aria-label="Ansicht">
      <mode-switch [mode]="mode()" [busy]="busy()" /><button (click)="settingsRequested.emit()">
        <svg
          class="ui-icon "
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.7"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path d="M4 6h16M4 12h16M4 18h16" />
          <circle cx="8" cy="6" r="2" fill="currentColor" />
          <circle cx="16" cy="12" r="2" fill="currentColor" />
          <circle cx="10" cy="18" r="2" fill="currentColor" /></svg
        >Einstellungen
      </button>
    </nav>
  `,
})
export class WorkspaceHeader {
  readonly mode = input.required<'midi' | 'audio'>();
  readonly busy = input(false);
  readonly settingsRequested = output<void>();
}
