import { Component, inject } from '@angular/core';
import { MidiWorkspace } from './midi-workspace';
import { FormsModule } from '@angular/forms';
import { TempoSuggestion } from '../../shared/ui/tempo-suggestion';
import { DecimalPipe } from '@angular/common';

@Component({
  selector: 'section[app-midi-metronome]',
  imports: [FormsModule, TempoSuggestion, DecimalPipe],
  templateUrl: './midi-metronome.html',
})
export class MidiMetronome {
  readonly workspace = inject(MidiWorkspace);
}
