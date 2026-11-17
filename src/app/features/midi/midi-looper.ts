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
  ],
  providers: [MidiWorkspace],
  host: {
    '(window:keydown)': 'workspace.key($event); workspace.refresh()',
    '(window:keyup)': 'workspace.keyup($event); workspace.refresh()',
  },
  templateUrl: './midi-looper.html',
  styles: `
    header {
      flex-wrap: wrap;
      height: auto;
    }
    .workspace {
      grid-template-rows: max-content max-content max-content minmax(320px, 1fr) max-content;
    }
    .workspace.with-piano {
      grid-template-rows: max-content max-content max-content minmax(
          320px,
          0.64fr
        ) max-content minmax(168px, 0.36fr);
    }
    .project-controls {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-left: auto;
      justify-content: flex-end;
    }
    .project-controls .reset-all-tracks {
      margin-left: 0;
    }
    .project-controls button {
      white-space: nowrap;
    }
    .project-status:empty {
      display: none;
    }
    .project-status {
      font-size: 12px;
      flex-basis: 100%;
    }
    footer {
      flex-wrap: wrap;
    }
    @media (max-width: 1000px) {
      .workspace,
      .workspace.with-piano {
        grid-template-rows: max-content max-content max-content minmax(300px, 1fr) max-content 36px;
      }
      .workspace.with-piano {
        grid-template-rows: max-content max-content max-content minmax(
            300px,
            0.65fr
          ) max-content 36px minmax(180px, 0.35fr);
      }
      header {
        gap: 8px;
      }
    }
  `,
})
export class MidiLooper {
  readonly workspace = inject(MidiWorkspace);
}
