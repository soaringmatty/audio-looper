import {
  afterNextRender,
  Component,
  ElementRef,
  inject,
  OnDestroy,
  signal,
  viewChild,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { MidiWorkspace } from './midi-workspace';

@Component({
  imports: [DecimalPipe],
  selector: 'app-midi-timing-dialog',
  styles: `
    dialog {
      width: min(520px, calc(100vw - 32px));
      max-width: none;
      max-height: calc(100dvh - 32px);
      overflow: auto;
      margin: auto;
      padding: 24px;
      color: var(--al-text);
      background: linear-gradient(145deg, #27292d, var(--al-surface) 75%);
      border: 1px solid var(--al-border);
      border-radius: var(--al-radius);
      box-shadow:
        inset 0 1px #ffffff0b,
        0 16px 50px #0008;
      font-size: 16px;
      line-height: 1.5;
    }
    dialog::backdrop {
      background: #0009;
    }
    h2 {
      margin: 0 0 12px;
      font-size: 20px;
    }
    p {
      color: var(--al-muted);
      margin: 12px 0;
    }
    .measurement-status {
      min-height: 48px;
    }
    .measurement-result {
      padding: 12px 16px;
      background: var(--al-field);
      border: 1px solid var(--al-border);
      border-radius: 8px;
    }
    .measurement-result strong {
      color: var(--al-text);
      font-size: 24px;
      font-variant-numeric: tabular-nums;
    }
    .measurement-result p {
      margin: 4px 0 0;
      font-size: 14px;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 10px;
      margin-top: 20px;
    }
  `,
  template: `
    @let vm = workspace.view();
    <dialog
      #dialog
      aria-labelledby="timing-title"
      aria-describedby="timing-description"
      (keydown)="trapTab($event)"
      (cancel)="$event.preventDefault(); vm.closeTimingDialog()"
    >
      <h2 id="timing-title">Timing kalibrieren</h2>
      <p id="timing-description">
        Nach dem Start zwei Klicks abwarten. Danach sechs einzelne Noten gleichmäßig zum Klick
        spielen.
      </p>
      @if (vm.midi.inputId === 'piano') {
        <p>
          Nutze die Piano-Tasten Deiner Computertastatur, zum Beispiel Y. Die Aufnahme-Shortcuts
          sind hier deaktiviert.
        </p>
      }
      @if (vm.engine.busy) {
        <p>
          Die Messung kann nur bei leeren Spuren gestartet werden. Vorhandene Loops bleiben
          unverändert.
        </p>
      } @else if (vm.engine.paused) {
        <p>Vor der Messung die Session fortsetzen.</p>
      } @else if (vm.metro.outputMode !== 'laptop') {
        <p>
          Die Kalibrierung ist für den Lautsprecher-Klick verfügbar. Dazu im Metronom „Lautsprecher“
          wählen.
        </p>
      }
      <div class="measurement-status" role="status" aria-live="polite">
        @if (starting()) {
          <p>Metronom wird gestartet …</p>
        } @else if (vm.timing.active) {
          <p>
            <strong>{{ vm.timing.samples.length }}/6 Anschläge</strong> · Im Klickpuls
            weiterspielen.
          </p>
        } @else {
          <p>{{ vm.timing.message }}</p>
        }
      </div>
      @if (!vm.timing.active && vm.timing.result; as result) {
        <div class="measurement-result">
          <strong>{{ result.offsetMs | number: '1.0-1' }} ms</strong> Versatz
          <p>Streuung: {{ result.spreadMs | number: '1.0-1' }} ms · Positiv = nach dem Klick.</p>
          @if (vm.midi.outputId !== 'browser' && vm.metro.outputMode === 'laptop') {
            <p>Aktiver Klick-Vorlauf: {{ vm.metro.advanceMs | number: '1.0-1' }} ms</p>
          }
        </div>
      }
      <p>
        Die Messung enthält Spielverhalten und Signalweg, keine isolierte Hardwarelatenz. Noten und
        Loops werden nicht verschoben.
      </p>
      @if (vm.warning) {
        <p role="alert">{{ vm.warning }}</p>
      }
      <div class="actions">
        <button autofocus (click)="vm.closeTimingDialog()">Schließen</button>
        @if (vm.timing.active) {
          <button (click)="vm.timing.cancel(); vm.syncMetronomeAdvance(); workspace.refresh()">
            Messung abbrechen
          </button>
        } @else {
          <button
            [disabled]="
              starting() || vm.engine.busy || vm.engine.paused || vm.metro.outputMode !== 'laptop'
            "
            (click)="start()"
          >
            {{ vm.timing.result ? 'Erneut messen' : 'Messung starten' }}
          </button>
        }
      </div>
    </dialog>
  `,
})
export class MidiTimingDialog implements OnDestroy {
  readonly workspace = inject(MidiWorkspace);
  readonly starting = signal(false);
  private readonly opener = document.activeElement as HTMLElement | null;
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
  }
  trapTab(event: KeyboardEvent): void {
    if (event.key !== 'Tab') return;
    const buttons = Array.from(
      this.dialog().nativeElement.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
    );
    const first = buttons[0],
      last = buttons.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }
  async start(): Promise<void> {
    this.starting.set(true);
    try {
      await this.workspace.startTiming();
      if (!this.workspace.timingOpen) {
        this.workspace.timing.cancel();
        this.workspace.syncMetronomeAdvance();
      }
    } finally {
      this.starting.set(false);
      this.workspace.refresh();
    }
  }
  ngOnDestroy(): void {
    this.dialog().nativeElement.close();
    setTimeout(() => {
      if (this.opener?.isConnected) this.opener.focus({ preventScroll: true });
    });
  }
}
