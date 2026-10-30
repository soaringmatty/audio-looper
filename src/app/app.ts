import { Component } from '@angular/core';
import { MidiLooper } from './features/midi/midi-looper';
import { AudioLooper } from './features/audio/audio-looper';
@Component({
  selector: 'app-root',
  imports: [MidiLooper, AudioLooper],
  template: `
    @if (mode === 'audio') {
      <app-audio-looper />
    } @else {
      <app-midi-looper />
    }
  `,
})
export class App {
  protected readonly mode = initialMode();
}
function initialMode(): string {
  let saved = 'midi';
  try {
    saved = localStorage.getItem('looper-mode') ?? 'midi';
  } catch {
    /* Storage can be disabled. */
  }
  return new URL(location.href).searchParams.get('mode') ?? saved;
}
