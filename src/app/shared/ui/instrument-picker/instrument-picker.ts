import { Component, ElementRef, computed, input, output, signal, viewChild } from '@angular/core';

export interface InstrumentGroup {
  name: string;
  programs: { id: number; name: string }[];
}

@Component({
  selector: 'instrument-picker',
  host: { 'data-keep-focus': '', '(keydown)': 'key($event)' },
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .instrument-trigger {
      width: 100%;
      text-align: left;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-height: 34px;
    }
    .instrument-list {
      position: fixed;
      margin: 0;
      padding: 6px;
      box-sizing: border-box;
      height: min(360px, calc(100dvh - 16px));
      overflow: auto;
      overscroll-behavior: contain;
      border: 1px solid #829cba;
      border-radius: 8px;
      background: #152231;
      color: #e4edf8;
      box-shadow: 0 10px 36px #0009;
    }
    .instrument-group {
      padding: 8px 7px 4px;
      font-size: 12px;
      font-weight: 700;
      color: #9cb7d7;
    }
    .instrument-option {
      padding: 7px;
      font-size: 14px;
      border-radius: 4px;
      cursor: pointer;
    }
    .instrument-option:hover,
    .instrument-option.active {
      background: #315c88;
    }
    .instrument-option[aria-selected='true'] {
      outline: 1px solid #94c8ff;
      outline-offset: -1px;
    }
  `,
  templateUrl: './instrument-picker.html',
})
export class InstrumentPicker {
  readonly value = input.required<number>();
  readonly groups = input.required<InstrumentGroup[]>();
  readonly label = input.required<string>();
  readonly pickerId = input.required<string>();
  readonly valueChange = output<number>();
  readonly committed = output<void>();
  readonly opened = signal(false);
  readonly active = signal(0);
  readonly options = computed(() => this.groups().flatMap((g) => g.programs));
  readonly selectedName = computed(
    () => this.options().find((p) => p.id === this.value())?.name ?? 'Instrument wählen',
  );
  readonly popup = viewChild.required<ElementRef<HTMLElement>>('popup');
  readonly trigger = viewChild.required<ElementRef<HTMLButtonElement>>('trigger');
  top = 8;
  left = 8;
  width = 280;
  private search = '';
  private searchAt = 0;
  open(): void {
    this.active.set(this.value());
    const r = this.trigger().nativeElement.getBoundingClientRect();
    this.width = Math.min(Math.max(r.width, 280), window.innerWidth - 16);
    this.left = Math.max(8, Math.min(r.left, window.innerWidth - this.width - 8));
    const height = Math.min(360, window.innerHeight - 16);
    this.top = Math.max(
      8,
      Math.min(r.top + r.height / 2 - height / 2, window.innerHeight - height - 8),
    );
    this.opened.set(true);
    this.popup().nativeElement.showPopover();
    this.trigger().nativeElement.focus({ preventScroll: true });
    requestAnimationFrame(() => this.center());
  }
  center(): void {
    const list = this.popup().nativeElement;
    const option = list.querySelector<HTMLElement>(`[data-program="${this.active()}"]`);
    if (option)
      list.scrollTop = Math.max(
        0,
        option.offsetTop - (list.clientHeight - option.offsetHeight) / 2,
      );
  }
  close(commit = false, returnToPerformance = true): void {
    this.popup().nativeElement.hidePopover();
    this.opened.set(false);
    if (commit) {
      this.valueChange.emit(this.active());
      if (returnToPerformance) this.committed.emit();
    }
  }
  choose(id: number): void {
    this.active.set(id);
    this.close(true);
  }
  toggle(): void {
    if (this.opened()) this.close(true);
    else this.open();
  }
  key(e: KeyboardEvent): void {
    if (e.ctrlKey || e.metaKey) return;
    if (e.key === 'Tab') {
      if (this.opened()) this.close(true, false);
      return;
    }
    if (e.key === 'Escape') {
      if (this.opened()) {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
      return;
    }
    if (
      !['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp', 'Enter', ' '].includes(
        e.key,
      ) &&
      e.key.length !== 1
    )
      return;
    e.preventDefault();
    e.stopPropagation();
    if (e.repeat && (e.key === 'Enter' || e.key === ' ')) return;
    if (e.key === 'Enter' || e.key === ' ') {
      this.toggle();
      return;
    }
    if (!this.opened()) this.open();
    const opts = this.options();
    let i = Math.max(
      0,
      opts.findIndex((p) => p.id === this.active()),
    );
    if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = opts.length - 1;
    else if (e.key === 'ArrowDown') i++;
    else if (e.key === 'ArrowUp') i--;
    else if (e.key === 'PageDown') i += 8;
    else if (e.key === 'PageUp') i -= 8;
    else {
      const now = performance.now();
      this.search = (now - this.searchAt < 700 ? this.search : '') + e.key.toLowerCase();
      this.searchAt = now;
      const found = opts.findIndex((p) =>
        p.name
          .replace(/^\d+\s*·\s*/, '')
          .toLowerCase()
          .startsWith(this.search),
      );
      if (found >= 0) i = found;
    }
    this.active.set(opts[Math.max(0, Math.min(opts.length - 1, i))].id);
    // Arrow navigation auditions sounds without forcing the picker to close.
    if (this.active() !== this.value()) this.valueChange.emit(this.active());
    requestAnimationFrame(() => this.center());
  }
}
