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
  styles: `
    /* Replace the removed status row + gap with symmetric dial spacing.
       Container queries use the content box: the original circle size stays. */
    :host(.track) {
      grid-template-rows: 42px minmax(120px, 1fr) 34px 64px 32px;
    }
    :host > .dial-slot {
      grid-row: 2;
      grid-column: 1;
      padding-block: 12px;
    }
    :host > instrument-picker,
    :host > .instrument-follow {
      grid-row: 3;
      grid-column: 1;
    }
    :host > .track-values {
      grid-row: 4;
    }
    :host > .track-actions {
      grid-row: 5;
    }
  `,
})
export class MidiTrack {
  readonly workspace = inject(MidiWorkspace);
  readonly track = input.required<Track>();
}
