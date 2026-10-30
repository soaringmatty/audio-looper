import { Component, inject } from '@angular/core';
import { AudioWorkspace } from './audio-workspace';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import { InfoHint } from '../../shared/ui/info-hint';

@Component({
  selector: 'section[app-input-effects]',
  imports: [FormsModule, DecimalPipe, InfoHint],
  templateUrl: './input-effects.html',
})
export class InputEffects {
  readonly workspace = inject(AudioWorkspace);
}
