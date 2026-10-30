import { Component, inject } from '@angular/core';
import { AudioWorkspace } from './audio-workspace';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';

@Component({
  selector: 'section[app-input-effects-dialog]',
  imports: [FormsModule, DecimalPipe],
  templateUrl: './input-effects-dialog.html',
})
export class InputEffectsDialog {
  readonly workspace = inject(AudioWorkspace);
}
