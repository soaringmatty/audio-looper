import { Component, inject, input } from '@angular/core';
import { AudioWorkspace } from './audio-workspace';
import { AudioTrackState } from '../../../../public/audio/pcm-engine.js';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';

@Component({
  selector: 'article[app-audio-track]',
  imports: [FormsModule, DecimalPipe],
  templateUrl: './audio-track.html',
})
export class AudioTrack {
  readonly workspace = inject(AudioWorkspace);
  readonly track = input.required<AudioTrackState>();
}
