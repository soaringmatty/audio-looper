import { Component, input, output } from '@angular/core';
import { ModeSwitch } from './mode-switch';
@Component({
  selector: 'header[app-workspace-header]',
  imports: [ModeSwitch],
  template: `
    <div class="brand">
      <h1>Audio Looper<span class="dot"></span></h1>
      <span class="eyebrow">{{ mode() === 'midi' ? 'MIDI' : 'AUDIO' }} LOOPSTATION</span>
    </div>
    <nav aria-label="Ansicht">
      <mode-switch [mode]="mode()" [busy]="busy()" /><button (click)="settingsRequested.emit()">
        Einstellungen
      </button>
    </nav>
  `,
})
export class WorkspaceHeader {
  readonly mode = input.required<'midi' | 'audio'>();
  readonly busy = input(false);
  readonly settingsRequested = output<void>();
}
