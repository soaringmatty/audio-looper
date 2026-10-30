import { Component, inject } from '@angular/core';
import { AudioWorkspace } from './audio-workspace';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import { InfoHint } from '../../shared/ui/info-hint';

@Component({
  selector: 'section[app-audio-routing]',
  imports: [FormsModule, DecimalPipe, InfoHint],
  templateUrl: './audio-routing.html',
})
export class AudioRouting {
  readonly workspace = inject(AudioWorkspace);
}
