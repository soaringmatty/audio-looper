import { Component, inject } from '@angular/core';
import { AudioWorkspace } from './audio-workspace';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';

@Component({
  selector: 'section[app-audio-calibration]',
  imports: [FormsModule, DecimalPipe],
  templateUrl: './audio-calibration.html',
})
export class AudioCalibration {
  readonly workspace = inject(AudioWorkspace);
}
