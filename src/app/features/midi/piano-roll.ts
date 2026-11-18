import {
  afterRenderEffect,
  Component,
  computed,
  ElementRef,
  inject,
  OnDestroy,
  signal,
  linkedSignal,
  viewChild,
  untracked,
} from '@angular/core';
import { MidiWorkspace } from './midi-workspace';
import { AlignPreview, RollNote, translateNotes } from './midi-editor';
import { PEDALS, RollPedal } from './midi-pedals';

@Component({
  imports: [],
  selector: 'piano-roll',
  styleUrl: './piano-roll.css',
  templateUrl: './piano-roll.html',
})
export class PianoRoll implements OnDestroy {
  readonly workspace = inject(MidiWorkspace);
  readonly editor = this.workspace.editor;
  readonly viewport = viewChild<ElementRef<HTMLElement>>('viewport');
  readonly pedalViewport = viewChild<ElementRef<HTMLElement>>('pedalViewport');
  readonly pedalTypes = PEDALS;
  readonly extraPedals = signal<number[]>([]);
  readonly pedalLanes = computed(() =>
    PEDALS.filter(
      (p) =>
        p.cc === 64 ||
        p.cc === 66 ||
        this.extraPedals().includes(p.cc) ||
        this.pedals().some((v) => v.cc === p.cc),
    ),
  );
  readonly pedalDraft = signal<RollPedal | null>(null);
  readonly pedals = computed(() => {
    this.workspace.view();
    return this.editor.pedals;
  });
  readonly selectedPedal = linkedSignal<RollPedal[], string | null>({
    source: this.pedals,
    computation: () => null,
  });
  readonly pedalSelection = computed(() =>
    this.pedals().find((p) => p.id === this.selectedPedal()),
  );
  readonly pedalSegments = computed(() =>
    this.pedals().flatMap((p) => {
      const valid =
        this.pedalDrag?.track === this.editor.track.id &&
        this.pedalDrag.layers === this.editor.track.layers;
      const n = valid && this.pedalDraft()?.id === p.id ? this.pedalDraft()! : p;
      const first = Math.min(n.duration, this.editor.track.length - n.start);
      return [
        { pedal: n, part: 0, start: n.start, duration: first, last: first === n.duration },
        ...(n.duration > first
          ? [{ pedal: n, part: 1, start: 0, duration: n.duration - first, last: true }]
          : []),
      ];
    }),
  );
  readonly zoom = signal(1);
  readonly available = signal(900);
  readonly width = computed(() => Math.max(640, this.available() - 60) * this.zoom());
  readonly snap = signal(2);
  readonly alignDraft = signal<AlignPreview | null>(null);
  readonly alignEnds = signal(false);
  readonly alignment = computed(() => {
    this.workspace.view();
    const p = this.alignDraft();
    return p &&
      this.editor.validAlign(p) &&
      p.step === 60000 / this.workspace.engine.bpm / this.snap()
      ? p
      : null;
  });
  readonly alignReasons = computed(() => {
    const counts = new Map<string, number>();
    for (const p of this.alignment()?.skipped ?? [])
      counts.set(p.reason, (counts.get(p.reason) ?? 0) + 1);
    return [...counts].map(([reason, count]) => count + ' × ' + reason).join(' · ');
  });
  readonly alignReason = computed(() => {
    const vm = this.workspace.view();
    if (!this.editor.editable) return this.editor.reason;
    if (vm.engine.mode !== 'tempo') return 'Freie Aufnahme zuerst in der Tempo-Auswahl einteilen.';
    if (!this.snap()) return 'Für Auto-Align ein Raster auswählen.';
    return 'Exakt zum nächsten Rasterpunkt ausrichten; mit Auswahl nur ausgewählte Noten, sonst ganze Spur.';
  });
  readonly canAlign = computed(() => {
    this.workspace.view();
    return (
      this.editor.editable &&
      this.workspace.engine.mode === 'tempo' &&
      !!this.snap() &&
      this.notes().length > 0
    );
  });
  readonly draft = signal<RollNote[] | null>(null);
  readonly rowHeight = 22;
  readonly pitches = Array.from({ length: 128 }, (_, i) => 127 - i);
  readonly notes = computed(() => {
    this.workspace.view();
    return this.editor.notes;
  });
  // A new take/import/undo must never leave a stale id selecting another note.
  readonly selected = linkedSignal<RollNote[], string[]>({
    source: this.notes,
    computation: () => [],
  });
  readonly selectionSet = computed(() => new Set(this.selected()));
  readonly marquee = signal<{ x: number; y: number; width: number; height: number } | null>(null);
  private focusSuppressed = false;
  private area?: {
    pointer: number;
    element: HTMLElement;
    x: number;
    y: number;
    source: RollNote[];
    base: string[];
    additive: boolean;
    track: number;
    layers: unknown;
    moved: boolean;
  };
  readonly segments = computed(() => {
    const t = this.workspace.view().engine.tracks[this.workspace.engine.selected];
    const preview = this.draft();
    const draft = this.drag?.track === t.id && this.drag.layers === t.layers ? preview : null;
    const draftMap = draft ? new Map(draft.map((n) => [n.id, n])) : null;
    const aligned = this.alignment();
    return this.notes().flatMap((original, index) => {
      const n = draftMap?.get(original.id) ?? aligned?.notes[index] ?? original;
      const first = Math.min(n.duration, t.length - n.start);
      const parts = [
        {
          note: n,
          part: 0,
          start: n.start,
          duration: first,
          last: n.duration <= first,
          preview: !!aligned && (n.start !== original.start || n.duration !== original.duration),
        },
      ];
      if (n.duration > first)
        parts.push({
          note: n,
          part: 1,
          start: 0,
          duration: n.duration - first,
          last: true,
          preview: !!aligned && (n.start !== original.start || n.duration !== original.duration),
        });
      return parts;
    });
  });
  readonly alignOriginals = computed(() => {
    const p = this.alignment(),
      length = this.editor.track.length;
    return p
      ? p.source
          .filter((n, i) => n.start !== p.notes[i].start || n.duration !== p.notes[i].duration)
          .flatMap((n) => {
            const first = Math.min(n.duration, length - n.start);
            return [
              { note: n, part: 0, start: n.start, duration: first },
              ...(n.duration > first
                ? [{ note: n, part: 1, start: 0, duration: n.duration - first }]
                : []),
            ];
          })
      : [];
  });
  readonly ticks = computed(() => {
    const vm = this.workspace.view(),
      length = this.editor.track.length;
    const beat = 60000 / vm.engine.bpm;
    const step = Math.max(beat, Math.ceil(length / beat / 128) * beat);
    return Array.from({ length: Math.min(129, Math.ceil(length / step)) }, (_, i) => ({
      at: i * step,
      label: `${1 + (i * step) / beat}`,
    }));
  });
  private observer?: ResizeObserver;
  private pedalDrag?: {
    pointer: number;
    element: HTMLElement;
    x: number;
    pedal: RollPedal;
    mode: string;
    track: number;
    layers: unknown;
    width: number;
    length: number;
  };
  private drag?: {
    pointer: number;
    element: HTMLElement;
    x: number;
    y: number;
    note: RollNote;
    notes: RollNote[];
    source: RollNote[];
    moved: boolean;
    mode: string;
    track: number;
    layers: unknown;
    width: number;
    length: number;
  };
  constructor() {
    afterRenderEffect(() => {
      if (this.alignDraft() && !this.alignment()) untracked(() => this.alignDraft.set(null));
    });
    afterRenderEffect(() => {
      const el = this.viewport()?.nativeElement;
      this.observer?.disconnect();
      if (!el) return;
      this.observer = new ResizeObserver(() => this.available.set(el.clientWidth));
      this.observer.observe(el);
      untracked(() => this.center());
    });
  }
  name(pitch: number): string {
    return (
      ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'B', 'H'][pitch % 12] +
      (Math.floor(pitch / 12) - 1)
    );
  }
  black(pitch: number): boolean {
    return [1, 3, 6, 8, 10].includes(pitch % 12);
  }
  label(n: RollNote): string {
    return `${this.name(n.pitch)}, ${(n.start / 1000).toFixed(2)} s, Länge ${(n.duration / 1000).toFixed(2)} s, Take ${n.layer + 1}`;
  }
  center(): void {
    const pitches = this.notes().map((n) => n.pitch);
    const middle = pitches.length ? (Math.min(...pitches) + Math.max(...pitches)) / 2 : 60;
    const el = this.viewport()?.nativeElement;
    if (el) el.scrollTop = Math.max(0, (127 - middle) * this.rowHeight - el.clientHeight / 2 + 28);
  }
  chooseTrack(id: number): void {
    this.cancel();
    this.alignDraft.set(null);
    this.selected.set([]);
    this.selectedPedal.set(null);
    this.workspace.select(id);
    this.workspace.refresh();
    requestAnimationFrame(() => this.center());
  }
  private quantize(ms: number): number {
    const unit = this.snap() ? 60000 / this.workspace.engine.bpm / this.snap() : 1;
    return Math.round(ms / unit) * unit;
  }
  private clamp(n: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, n));
  }
  add(event: MouseEvent): void {
    if (
      this.alignment() ||
      !this.editor.editable ||
      (event.target as HTMLElement).closest('button,.roll-ruler,.roll-key')
    )
      return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const length = this.editor.track.length;
    const pitch = 127 - Math.floor((event.clientY - rect.top - 28) / this.rowHeight);
    const start = this.clamp(
      this.quantize(((event.clientX - rect.left - 60) / this.width()) * length),
      0,
      length - 1,
    );
    const n = this.editor.change(null, {
      pitch,
      start,
      duration: Math.min(length, 60000 / this.workspace.engine.bpm / (this.snap() || 4)),
    });
    this.workspace.refresh();
    this.selected.set(n ? [n.id] : []);
  }
  focusNote(n: RollNote): void {
    if (this.focusSuppressed || this.alignment()) return;
    if (!this.selectionSet().has(n.id)) this.selected.set([n.id]);
    this.selectedPedal.set(null);
  }
  begin(event: PointerEvent, n: RollNote): void {
    if (event.button !== 0 || this.alignment()) return;
    event.stopPropagation();
    event.preventDefault();
    const ids = this.selected();
    if (event.shiftKey)
      this.selected.set(ids.includes(n.id) ? ids.filter((id) => id !== n.id) : [...ids, n.id]);
    else if (!ids.includes(n.id)) this.selected.set([n.id]);
    this.selectedPedal.set(null);
    const el = event.currentTarget as HTMLElement;
    this.focusSuppressed = true;
    el.focus({ preventScroll: true });
    this.focusSuppressed = false;
    if (event.shiftKey || !this.editor.editable) return;
    const mode = (event.target as HTMLElement).dataset['edge'] ?? 'move';
    if (mode !== 'move' && this.selected().length > 1) return;
    el.setPointerCapture(event.pointerId);
    this.drag = {
      pointer: event.pointerId,
      element: el,
      x: event.clientX,
      y: event.clientY,
      note: { ...n },
      notes: this.notes()
        .filter((v) => this.selectionSet().has(v.id))
        .map((v) => ({ ...v })),
      source: this.notes(),
      moved: false,
      mode,
      track: this.editor.track.id,
      layers: this.editor.track.layers,
      width: this.width(),
      length: this.editor.track.length,
    };
  }
  move(event: PointerEvent): void {
    const d = this.drag;
    if (!d || d.pointer !== event.pointerId) return;
    if (
      !this.editor.editable ||
      this.editor.track.id !== d.track ||
      this.editor.track.layers !== d.layers ||
      this.notes() !== d.source
    ) {
      this.cancel();
      return;
    }
    if (!d.moved && Math.hypot(event.clientX - d.x, event.clientY - d.y) < 3) return;
    d.moved = true;
    const delta = ((event.clientX - d.x) / d.width) * d.length,
      n = { ...d.note };
    if (d.mode === 'move') {
      const time = this.quantize(n.start + delta) - n.start;
      this.draft.set(
        translateNotes(
          d.notes,
          time,
          -Math.round((event.clientY - d.y) / this.rowHeight),
          d.length,
        ),
      );
    } else {
      if (d.mode === 'start') {
        n.start = this.clamp(
          this.quantize(n.start + delta),
          Math.max(0, n.start + n.duration - d.length),
          Math.min(d.length - 1, n.start + n.duration - 1),
        );
        n.duration = d.note.start + d.note.duration - n.start;
      } else
        n.duration = this.clamp(this.quantize(n.start + n.duration + delta) - n.start, 1, d.length);
      this.draft.set([n]);
    }
  }
  end(event: PointerEvent): void {
    const d = this.drag,
      notes = this.draft();
    if (!d || event.pointerId !== d.pointer) return;
    if (notes && this.editor.track.id === d.track && this.editor.track.layers === d.layers) {
      const changed = this.editor.changeMany(
        d.source,
        notes.map((n) => ({
          id: n.id,
          patch: { start: n.start, pitch: n.pitch, duration: n.duration },
        })),
      );
      this.workspace.refresh();
      if (changed) this.selected.set(changed.map((n) => n.id));
    }
    this.cancel();
  }
  private areaPoint(event: PointerEvent, element: HTMLElement): { x: number; y: number } {
    const r = element.getBoundingClientRect();
    return {
      x: this.clamp(event.clientX - r.left, 60, this.width() + 60),
      y: this.clamp(event.clientY - r.top, 28, 128 * this.rowHeight + 28),
    };
  }
  beginArea(event: PointerEvent): void {
    if (
      event.button !== 0 ||
      !this.editor.editable ||
      this.alignment() ||
      (event.target as HTMLElement).closest('button,.roll-ruler,.roll-key')
    )
      return;
    const element = event.currentTarget as HTMLElement,
      r = element.getBoundingClientRect();
    if (event.clientX - r.left < 60 || event.clientY - r.top < 28) return;
    event.preventDefault();
    this.cancel();
    const point = this.areaPoint(event, element);
    this.area = {
      pointer: event.pointerId,
      element,
      ...point,
      source: this.notes(),
      base: [...this.selected()],
      additive: event.shiftKey,
      track: this.editor.track.id,
      layers: this.editor.track.layers,
      moved: false,
    };
    element.setPointerCapture(event.pointerId);
    this.viewport()?.nativeElement.focus({ preventScroll: true });
  }
  moveArea(event: PointerEvent): void {
    const a = this.area;
    if (!a || event.pointerId !== a.pointer) return;
    if (
      !this.editor.editable ||
      a.track !== this.editor.track.id ||
      a.layers !== this.editor.track.layers ||
      a.source !== this.notes()
    ) {
      this.cancel();
      return;
    }
    const p = this.areaPoint(event, a.element),
      x = Math.min(a.x, p.x),
      y = Math.min(a.y, p.y),
      width = Math.abs(p.x - a.x),
      height = Math.abs(p.y - a.y);
    if (!a.moved && Math.hypot(width, height) < 3) return;
    a.moved = true;
    this.marquee.set({ x, y, width, height });
    const length = this.editor.track.length;
    const hits = this.notes()
      .filter((n) => {
        const top = 28 + (127 - n.pitch) * this.rowHeight + 2;
        if (top > y + height || top + 18 < y) return false;
        const first = Math.min(n.duration, length - n.start);
        const spans = [
          { start: n.start, duration: first },
          ...(n.duration > first ? [{ start: 0, duration: n.duration - first }] : []),
        ];
        return spans.some((s) => {
          const left = 60 + (s.start / length) * this.width(),
            w = Math.max(3, (s.duration / length) * this.width());
          return left <= x + width && left + w >= x;
        });
      })
      .map((n) => n.id);
    this.selected.set([...new Set([...(a.additive ? a.base : []), ...hits])]);
    this.selectedPedal.set(null);
  }
  endArea(event: PointerEvent): void {
    const a = this.area;
    if (!a || a.pointer !== event.pointerId) return;
    if (a.source !== this.notes() || a.track !== this.editor.track.id || !this.editor.editable) {
      this.cancel();
      return;
    }
    if (!a.moved && !a.additive) this.selected.set([]);
    this.area = undefined;
    this.marquee.set(null);
    if (a.element.hasPointerCapture(a.pointer)) a.element.releasePointerCapture(a.pointer);
  }
  cancel(): void {
    const a = this.area;
    this.area = undefined;
    this.marquee.set(null);
    if (a) {
      this.selected.set(a.source === this.notes() ? a.base : []);
      if (a.element.hasPointerCapture(a.pointer)) a.element.releasePointerCapture(a.pointer);
    }
    const d = this.drag;
    this.drag = undefined;
    this.draft.set(null);
    if (d?.element.hasPointerCapture(d.pointer)) d.element.releasePointerCapture(d.pointer);
    const p = this.pedalDrag;
    this.pedalDrag = undefined;
    this.pedalDraft.set(null);
    if (p?.element.hasPointerCapture(p.pointer)) p.element.releasePointerCapture(p.pointer);
  }
  remove(): void {
    if (this.alignment()) return;
    const pedal = this.pedalSelection();
    if (pedal) {
      this.editor.changePedal(pedal.cc, pedal.id, null);
      this.selectedPedal.set(null);
      this.workspace.refresh();
      return;
    }
    const source = this.notes();
    this.editor.changeMany(
      source,
      this.selected().map((id) => ({ id, patch: null })),
    );
    this.selected.set([]);
    this.selectedPedal.set(null);
    this.workspace.refresh();
  }
  scroll(source: HTMLElement): void {
    for (const el of [this.viewport()?.nativeElement, this.pedalViewport()?.nativeElement])
      if (el && el !== source && el.scrollLeft !== source.scrollLeft)
        el.scrollLeft = source.scrollLeft;
  }
  pedalsHave(cc: number): boolean {
    return this.pedals().some((p) => p.cc === cc);
  }
  showPedal(cc: number, show: boolean): void {
    this.extraPedals.update((values) =>
      show ? [...new Set([...values, cc])] : values.filter((v) => v !== cc),
    );
  }
  pedalLabel(p: RollPedal): string {
    return `${PEDALS.find((v) => v.cc === p.cc)?.name}, ${p.value === 127 ? 'An' : 'Gespeicherter Zwischenwert ' + p.value} · CC${p.cc}, ${(p.start / 1000).toFixed(2)} s, Länge ${(p.duration / 1000).toFixed(2)} s`;
  }
  selectPedal(p: RollPedal): void {
    this.selected.set([]);
    this.selectedPedal.set(p.id);
  }
  addPedal(event: MouseEvent, cc: number): void {
    if (
      this.alignment() ||
      !this.editor.editable ||
      (event.target as HTMLElement).closest('button,.pedal-label')
    )
      return;
    const r = (event.currentTarget as HTMLElement).getBoundingClientRect(),
      length = this.editor.track.length;
    if (event.clientX - r.left < 60) return;
    const n = this.editor.changePedal(cc, null, {
      start: this.clamp(
        this.quantize(((event.clientX - r.left - 60) / this.width()) * length),
        0,
        length - 1,
      ),
      duration: Math.min(length, 60000 / this.workspace.engine.bpm / (this.snap() || 4)),
      value: 127,
    });
    this.workspace.refresh();
    this.selected.set([]);
    this.selectedPedal.set(n?.id ?? null);
  }
  beginPedal(event: PointerEvent, pedal: RollPedal): void {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.preventDefault();
    this.selectPedal(pedal);
    const element = event.currentTarget as HTMLElement;
    element.focus({ preventScroll: true });
    if (!this.editor.editable || this.alignment()) return;
    element.setPointerCapture(event.pointerId);
    this.pedalDrag = {
      pointer: event.pointerId,
      element,
      x: event.clientX,
      pedal: { ...pedal },
      mode: (event.target as HTMLElement).dataset['edge'] ?? 'move',
      track: this.editor.track.id,
      layers: this.editor.track.layers,
      length: this.editor.track.length,
      width: this.width(),
    };
  }
  movePedal(event: PointerEvent): void {
    const d = this.pedalDrag;
    if (!d || d.pointer !== event.pointerId) return;
    if (
      !this.editor.editable ||
      this.editor.track.id !== d.track ||
      this.editor.track.layers !== d.layers
    ) {
      this.cancel();
      return;
    }
    if (!this.pedalDraft() && Math.abs(event.clientX - d.x) < 3) return;
    const delta = ((event.clientX - d.x) / d.width) * d.length,
      p = { ...d.pedal };
    if (d.mode === 'start') {
      p.start = this.clamp(
        this.quantize(p.start + delta),
        Math.max(0, p.start + p.duration - d.length),
        Math.min(d.length - 1, p.start + p.duration - 1),
      );
      p.duration = d.pedal.start + d.pedal.duration - p.start;
    } else if (d.mode === 'end')
      p.duration = this.clamp(this.quantize(p.start + p.duration + delta) - p.start, 1, d.length);
    else p.start = this.clamp(this.quantize(p.start + delta), 0, d.length - 1);
    this.pedalDraft.set(p);
  }
  endPedal(event: PointerEvent): void {
    const d = this.pedalDrag,
      p = this.pedalDraft();
    if (!d || event.pointerId !== d.pointer) return;
    if (p && this.editor.track.id === d.track && this.editor.track.layers === d.layers)
      this.patchPedal(p);
    this.cancel();
  }
  patchPedal(patch: Partial<RollPedal>): void {
    if (this.alignment()) return;
    const p = this.pedalSelection();
    if (!p) return;
    const previousFocus = document.activeElement;
    const restoreFocus = this.pedalViewport()?.nativeElement.contains(previousFocus);
    const changed = this.editor.changePedal(p.cc, p.id, patch);
    this.workspace.refresh();
    this.selectedPedal.set(changed?.id ?? null);
    // Moving changes the interval id and replaces its button. Keep subsequent
    // keyboard edits in the lane without stealing focus from another control.
    if (restoreFocus)
      requestAnimationFrame(() => {
        if (document.activeElement !== document.body && document.activeElement !== previousFocus)
          return;
        const viewport = this.pedalViewport()?.nativeElement;
        const id = this.selectedPedal();
        const target = id
          ? viewport?.querySelector<HTMLElement>(`[data-pedal-id="${CSS.escape(id)}"]`)
          : viewport;
        target?.focus({ preventScroll: true });
      });
  }
  history(redo = false): void {
    this.cancel();
    this.alignDraft.set(null);
    redo ? this.editor.redo() : this.editor.undo();
    this.selected.set([]);
    this.workspace.refresh();
  }
  previewAlign(): void {
    this.cancel();
    this.selectedPedal.set(null);
    const scope =
      this.alignDraft()?.scopeIds ?? (this.selected().length ? [...this.selected()] : undefined);
    this.alignDraft.set(this.editor.previewAlign(this.snap(), this.alignEnds(), scope) ?? null);
  }
  applyAlign(): void {
    const p = this.alignment();
    if (p) this.editor.applyAlign(p);
    this.alignDraft.set(null);
    this.workspace.refresh();
  }
  setAlignEnds(ends: boolean): void {
    this.alignEnds.set(ends);
    this.previewAlign();
  }
  key(event: KeyboardEvent): void {
    event.stopPropagation();
    if ((event.target as HTMLElement).closest('.roll-help')) return;
    if (event.key !== 'Escape' && (event.target as HTMLElement).closest('input,select,textarea'))
      return;
    if (event.key === 'Escape') {
      if (this.drag || this.area || this.pedalDrag) {
        this.cancel();
        return;
      }
      this.cancel();
      this.alignDraft.set(null);
      this.selected.set([]);
      this.selectedPedal.set(null);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
      event.preventDefault();
      if (!event.repeat) this.history(event.shiftKey || event.key.toLowerCase() === 'y');
      return;
    }
    if (
      event.code === 'Space' &&
      (!(event.target as HTMLElement).closest('button') ||
        (event.target as HTMLElement).closest('.roll-note'))
    ) {
      event.preventDefault();
      if (!event.repeat) void this.workspace.togglePause();
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      if (!event.repeat) this.remove();
      return;
    }
    if (this.alignment() && event.key.startsWith('Arrow')) {
      event.preventDefault();
      return;
    }
    const n = this.notes().find((v) => v.id === this.selected()[0]);
    const pedal = this.pedalSelection();
    if (
      pedal &&
      event.key.startsWith('Arrow') &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      const unit = this.snap() ? 60000 / this.workspace.engine.bpm / this.snap() : 10;
      const direction = ['ArrowRight', 'ArrowUp'].includes(event.key) ? 1 : -1;
      this.patchPedal(
        ['ArrowUp', 'ArrowDown'].includes(event.key)
          ? { value: event.key === 'ArrowUp' ? 127 : 0 }
          : event.shiftKey
            ? {
                duration: this.clamp(
                  pedal.duration + direction * unit,
                  1,
                  this.editor.track.length,
                ),
              }
            : {
                start: this.clamp(pedal.start + direction * unit, 0, this.editor.track.length - 1),
              },
      );
      return;
    }
    if (!n || !event.key.startsWith('Arrow') || event.ctrlKey || event.metaKey || event.altKey)
      return;
    event.preventDefault();
    const unit = this.snap() ? 60000 / this.workspace.engine.bpm / this.snap() : 10;
    const group = this.notes().filter((v) => this.selectionSet().has(v.id));
    if (event.shiftKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      if (group.length !== 1) return;
      const changed = this.editor.change(n.id, {
        duration: this.clamp(
          n.duration + (event.key === 'ArrowRight' ? unit : -unit),
          1,
          this.editor.track.length,
        ),
      });
      this.workspace.refresh();
      if (changed) this.selected.set([changed.id]);
      return;
    }
    const moved = translateNotes(
      group,
      ['ArrowLeft', 'ArrowRight'].includes(event.key)
        ? event.key === 'ArrowRight'
          ? unit
          : -unit
        : 0,
      event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0,
      this.editor.track.length,
    );
    const changed = this.editor.changeMany(
      this.notes(),
      moved.map((v) => ({ id: v.id, patch: { start: v.start, pitch: v.pitch } })),
    );
    this.workspace.refresh();
    if (changed) this.selected.set(changed.map((v) => v.id));
  }
  ngOnDestroy(): void {
    this.cancel();
    this.observer?.disconnect();
  }
}
