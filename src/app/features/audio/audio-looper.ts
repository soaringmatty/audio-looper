import { PerformanceFocus } from '../../shared/ui/performance-focus';
import { WorkspaceHeader } from '../../shared/ui/workspace-header';
import { Component, inject } from '@angular/core';
import { AudioWorkspace } from './audio-workspace';
import { AudioRouting } from './audio-routing';
import { InputEffects } from './input-effects';
import { AudioMetronome } from './audio-metronome';
import { AudioTrack } from './audio-track';
import { InputEffectsDialog } from './input-effects-dialog';
import { AudioCalibration } from './audio-calibration';
import { AudioSettings } from './audio-settings';
@Component({
  selector: 'app-audio-looper',
  imports: [
    PerformanceFocus,
    WorkspaceHeader,

    AudioRouting,
    InputEffects,
    AudioMetronome,
    AudioTrack,
    InputEffectsDialog,
    AudioCalibration,
    AudioSettings,
  ],
  providers: [AudioWorkspace],
  host: { '(window:keydown)': 'workspace.key($event); workspace.refresh()' },
  templateUrl: './audio-looper.html',
})
export class AudioLooper {
  readonly workspace = inject(AudioWorkspace);
}
