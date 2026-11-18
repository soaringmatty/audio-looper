import { Component, inject, input } from '@angular/core';
import { MidiWorkspace } from './midi-workspace';
import { Track } from './loop-engine';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import { InstrumentPicker } from '../../shared/ui/instrument-picker/instrument-picker';

@Component({
  selector: 'article[app-midi-track]',
  imports: [FormsModule, DecimalPipe, InstrumentPicker],
  templateUrl: './midi-track.html',
})
export class MidiTrack {
  readonly workspace = inject(MidiWorkspace);
  readonly track = input.required<Track>();
}
