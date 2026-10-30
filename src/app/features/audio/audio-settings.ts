import { Component, inject } from '@angular/core';
import { AudioWorkspace } from './audio-workspace';
import { FormsModule } from '@angular/forms';
import { InfoHint } from '../../shared/ui/info-hint';

@Component({
  selector: 'section[app-audio-settings]',
  imports: [FormsModule, InfoHint],
  templateUrl: './audio-settings.html',
})
export class AudioSettings {
  readonly workspace = inject(AudioWorkspace);
}
