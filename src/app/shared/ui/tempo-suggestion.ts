import { Component, input, model, output } from '@angular/core';
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
      >Einteilung<select
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
        <option [ngValue]="-2">Eigene Einteilung …</option>
      </select></label
    >
    @if (index() === -2) {
      <label
        >Takte<input
          aria-label="Takte im ersten Loop"
          type="number"
          min="1"
          max="64"
          step="1"
          [ngModel]="bars()"
          (ngModelChange)="bars.set(+$event)"
          (change)="customChange.emit()" /></label
      ><label
        >Taktart<select
          aria-label="Vorgeschlagene Taktart"
          [ngModel]="signature()"
          (ngModelChange)="signature.set($event); customChange.emit()"
        >
          <option>4/4</option>
          <option>3/4</option>
          <option>6/8</option>
          <option>5/4</option>
        </select></label
      ><strong>{{ bpm() | number: '1.0-2' }} BPM</strong>
    }
    <info-hint
      label="Info zur Tempo-Einteilung"
      text="Auswahl übernimmt die Einteilung, startet aber nicht das Metronom. Vorschläge sind keine sichere Taktarterkennung. Bestehende Loops bleiben unverändert. Eigene Einteilung über Taktzahl/Taktart möglich."
    />
  `,
})
export class TempoSuggestion {
  readonly locked = input(false);
  readonly candidates = input<TempoCandidate[]>([]);
  readonly index = input(-1);
  readonly bars = model(4);
  readonly signature = model('4/4');
  readonly bpm = input(0);
  readonly canApply = input(false);
  readonly choose = output<number>();
  readonly customChange = output<void>();
  key(event: KeyboardEvent): void {
    event.stopPropagation();
  }
}
