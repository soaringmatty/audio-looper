import { Component, inject } from '@angular/core';
import { AudioWorkspace } from './audio-workspace';
import { FormsModule } from '@angular/forms';
import { TempoSuggestion } from '../../shared/ui/tempo-suggestion';

@Component({
  selector: 'section[app-audio-metronome]',
  imports: [FormsModule, TempoSuggestion],
  templateUrl: './audio-metronome.html',
})
export class AudioMetronome {
  readonly workspace = inject(AudioWorkspace);
}
