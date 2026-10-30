import { Component, inject } from '@angular/core';
import { MidiWorkspace } from './midi-workspace';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import { InfoHint } from '../../shared/ui/info-hint';

@Component({
  selector: 'section[app-midi-settings]',
  imports: [FormsModule, DecimalPipe, InfoHint],
  templateUrl: './midi-settings.html',
})
export class MidiSettings {
  readonly workspace = inject(MidiWorkspace);
}
