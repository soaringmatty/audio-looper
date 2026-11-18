import { Directive, ElementRef, inject } from '@angular/core';

export function focusPerformance(): void {
  queueMicrotask(() =>
    document
      .querySelector<HTMLElement>('main[data-performance]:not([inert])')
      ?.focus({ preventScroll: true }),
  );
}

@Directive({
  selector: '[performanceFocus]',
  host: {
    '(click)': 'click($event)',
    '(change)': 'change($event)',
    '(pointerdown)': 'pointer($event)',
    '(pointerup)': 'pointerup($event)',
    '(keydown)': 'key($event)',
    '(keyup)': 'keyup($event)',
  },
})
export class PerformanceFocus {
  private readonly root = inject<ElementRef<HTMLElement>>(ElementRef);
  private pointerControl?: HTMLElement;
  private pointerValue?: string;
  pointer(event: PointerEvent): void {
    this.pointerControl = this.control(event) ?? undefined;
    this.pointerValue = this.pointerControl?.matches('input[data-return-spinner-focus]')
      ? (this.pointerControl as HTMLInputElement).value
      : undefined;
  }
  private control(event: Event): HTMLElement | null {
    const target = event.target as HTMLElement;
    if (this.root.nativeElement.hasAttribute('inert') || target.closest('[data-keep-focus]'))
      return null;
    return target.closest<HTMLElement>('button,input,select');
  }
  click(event: MouseEvent): void {
    const el = this.control(event);
    if (
      event.detail > 0 &&
      el?.matches('button,input[type=checkbox],input[type=radio]') &&
      !el.matches('.piano-key,.loop-button')
    )
      focusPerformance();
  }
  change(event: Event): void {
    const el = this.control(event);
    if (
      el === this.pointerControl &&
      el?.matches('select,input[type=checkbox],input[type=radio],input[type=range]')
    )
      focusPerformance();
  }
  pointerup(event: PointerEvent): void {
    const el = this.control(event);
    if (
      el?.matches('input[type=range]') ||
      (el === this.pointerControl &&
        this.pointerValue !== undefined &&
        (el as HTMLInputElement).value !== this.pointerValue)
    )
      focusPerformance();
    this.pointerValue = undefined;
  }
  key(event: KeyboardEvent): void {
    const el = this.control(event);
    this.pointerControl = undefined;
    this.pointerValue = undefined;
    if (
      (event.key === 'Enter' || event.code === 'NumpadEnter') &&
      el?.matches('input:not([type=range]):not([type=checkbox]):not([type=radio])')
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      focusPerformance();
    }
  }
  keyup(event: KeyboardEvent): void {
    if (event.key === 'Enter' && this.control(event)?.matches('select,input[type=range]')) {
      event.preventDefault();
      event.stopPropagation();
      focusPerformance();
    }
  }
}
