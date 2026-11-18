import { Component, inject } from '@angular/core';
import { MidiWorkspace } from './midi-workspace';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import { InfoHint } from '../../shared/ui/info-hint';

@Component({
  selector: 'section[app-midi-connections]',
  imports: [FormsModule, InfoHint, DecimalPipe],
  templateUrl: './midi-connections.html',
})
export class MidiConnections {
  readonly workspace = inject(MidiWorkspace);
}
