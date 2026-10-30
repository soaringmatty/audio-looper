import { Component, inject } from '@angular/core';
import { MidiWorkspace } from './midi-workspace';

@Component({ selector: 'section[app-midi-piano]', templateUrl: './midi-piano.html' })
export class MidiPiano {
  readonly workspace = inject(MidiWorkspace);
}
