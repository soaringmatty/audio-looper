import { Component, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DecimalPipe } from '@angular/common';
import { InfoHint } from './info-hint';
import { TempoCandidate } from '../tempo';
@Component({
  selector: 'tempo-suggestion',
  imports: [FormsModule, DecimalPipe, InfoHint],
  host: { '(keydown)': 'key($event)' },
  template: `
    <label class="tempo-choice"
      >Tempo aus Aufnahme<select
        aria-label="Tempo-Vorschlag"
        [disabled]="locked()"
        [ngModel]="index()"
        (ngModelChange)="choose.emit(+$event)"
      >
        <option [ngValue]="-1" disabled>Vorschlag wählen …</option>
        @for (c of candidates(); track $index) {
          <option [ngValue]="$index">
            {{ c.bpm | number: '1.0-2' }} BPM · {{ c.beats }}/{{ c.denominator }} · {{ c.bars }}
            {{ c.bars === 1 ? 'Takt' : 'Takte' }}
          </option>
        }
      </select></label
    >
    <info-hint
      label="Info zur Tempo-Einteilung"
      text="Auswahl übernimmt die Einteilung, startet aber nicht das Metronom. Vorschläge sind keine sichere Taktarterkennung. Bestehende Loops bleiben unverändert."
    />
  `,
})
export class TempoSuggestion {
  readonly locked = input(false);
  readonly candidates = input<TempoCandidate[]>([]);
  readonly index = input(-1);
  readonly choose = output<number>();
  key(event: KeyboardEvent): void {
    event.stopPropagation();
  }
}
