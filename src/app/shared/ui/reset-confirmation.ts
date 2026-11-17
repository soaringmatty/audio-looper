import {
  afterNextRender,
  Component,
  ElementRef,
  OnDestroy,
  input,
  output,
  viewChild,
} from '@angular/core';

@Component({
  selector: 'reset-confirmation',
  template: `
    <dialog
      #dialog
      aria-labelledby="reset-title"
      aria-describedby="reset-description"
      (cancel)="$event.preventDefault(); cancelled.emit()"
      (keydown)="$event.stopPropagation()"
    >
      <h2 id="reset-title">{{ title() }}</h2>
      <p id="reset-description">
        {{ description() }}
        @if (resetPianoRanges()) {
          Auch alle Piano-Tastenbereiche werden zurückgesetzt.
        }
      </p>
      <div class="actions">
        <button autofocus [disabled]="busy()" (click)="cancelled.emit()">Abbrechen</button>
        <button class="danger" [disabled]="busy()" (click)="confirmed.emit()">
          {{ actionLabel() }}
        </button>
      </div>
    </dialog>
  `,
  styles: `
    dialog {
      color: var(--text, #e6edf7);
      background: var(--panel, #182130);
      border: 1px solid #526079;
      border-radius: 12px;
      padding: 24px;
      max-width: min(440px, calc(100vw - 40px));
    }
    dialog::backdrop {
      background: #0009;
    }
    h2 {
      margin: 0 0 12px;
      font-size: 20px;
    }
    p {
      line-height: 1.5;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 12px;
      margin-top: 20px;
    }
    .danger {
      border-color: #d17878;
    }
  `,
})
export class ResetConfirmation implements OnDestroy {
  readonly title = input('Alle Tracks zurücksetzen?');
  readonly description = input(
    'Alle Aufnahmen und Taktvorgaben werden gelöscht. Die Track-Lautstärken werden zurückgesetzt.',
  );
  readonly actionLabel = input('Alle zurücksetzen');
  readonly busy = input(false);
  readonly resetPianoRanges = input(false);
  readonly confirmed = output<void>();
  readonly cancelled = output<void>();
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  constructor() {
    afterNextRender(() => this.dialog().nativeElement.showModal());
  }
  ngOnDestroy(): void {
    this.dialog().nativeElement.close();
  }
}
