import { PerformanceFocus } from '../../shared/ui/performance-focus';
import { WorkspaceHeader } from '../../shared/ui/workspace-header';
import { Component, inject } from '@angular/core';
import { MidiWorkspace } from './midi-workspace';
import { MidiConnections } from './midi-connections';
import { MidiMetronome } from './midi-metronome';
import { MidiTrack } from './midi-track';
import { MidiPiano } from './midi-piano';
import { MidiSettings } from './midi-settings';
@Component({
  selector: 'app-midi-looper',
  imports: [
    PerformanceFocus,
    WorkspaceHeader,
    MidiConnections,
    MidiMetronome,
    MidiTrack,
    MidiPiano,
    MidiSettings,
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
