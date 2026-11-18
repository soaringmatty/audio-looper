import { ResetConfirmation } from '../../shared/ui/reset-confirmation';
import { PerformanceFocus } from '../../shared/ui/performance-focus';
import { WorkspaceHeader } from '../../shared/ui/workspace-header';
import { Component, inject } from '@angular/core';
import { MidiWorkspace } from './midi-workspace';
import { MidiConnections } from './midi-connections';
import { MidiMetronome } from './midi-metronome';
import { MidiTrack } from './midi-track';
import { MidiPiano } from './midi-piano';
import { MidiSettings } from './midi-settings';
import { MidiTimingDialog } from './midi-timing-dialog';
import { PianoRoll } from './piano-roll';
@Component({
  selector: 'app-midi-looper',
  imports: [
    ResetConfirmation,
    PerformanceFocus,
    WorkspaceHeader,
    MidiConnections,
    MidiMetronome,
    MidiTrack,
    MidiPiano,
    MidiSettings,
    MidiTimingDialog,
    PianoRoll,
  ],
  providers: [MidiWorkspace],
  host: {
    '(window:keydown)': 'workspace.key($event); workspace.refresh()',
    '(window:keyup)': 'workspace.keyup($event); workspace.refresh()',
  },
  templateUrl: './midi-looper.html',
})
export class MidiLooper {
  readonly workspace = inject(MidiWorkspace);
}
