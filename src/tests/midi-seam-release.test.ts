// @vitest-environment happy-dom
import '@angular/compiler';
import { expect, it, vi } from 'vitest';
import { ElementRef, Injector, runInInjectionContext } from '@angular/core';
import { LoopEngine } from '../app/features/midi/loop-engine';
import { MidiRouter } from '../app/features/midi/midi-router';
import { MidiEditor, readRollNotes } from '../app/features/midi/midi-editor';
import {
  exportMidiProject,
  parseMidiProject,
  restoreMidiProject,
} from '../app/features/midi/midi-project';
import { PerformanceFocus } from '../app/shared/ui/performance-focus';

function fixture(pitch = 60) {
  const router = new MidiRouter(),
    engine = new LoopEngine(router);
  router.engine = engine;
  engine.reference = 1000;
  engine.origin = 0;
  const send = vi.spyOn(router.browser, 'send').mockImplementation(() => {});
  vi.spyOn(router.browser, 'clearTrack').mockImplementation(() => {});
  vi.spyOn(router.browser, 'cancelScheduled').mockImplementation(() => {});
  const t = engine.tracks[0];
  Object.assign(t, {
    state: 'overdub',
    length: 1000,
    start: 0,
    takeStart: 0,
    layers: [
      [
        { at: 50, data: [144, pitch, 90] },
        { at: 250, data: [128, pitch, 0] },
      ],
    ],
    events: [
      { at: 50, data: [144, pitch, 90] },
      { at: 250, data: [128, pitch, 0] },
    ],
  });
  return { router, engine, t, send };
}

it('seam capture keeps physical note/pedal releases on their original owner without resetting other voices', () => {
  for (const pitch of [60, 64, 65, 67]) {
    const { router, engine, t, send } = fixture();
    router.receive([144, pitch, 100], 900);
    router.receive([176, 64, 127], 920);
    engine.tick(980, 1030); // includes the output-only seam preview
    engine.tick(1000, 1030);
    expect(router.snapshot().liveNotes).toHaveLength(1);
    send.mockClear();
    router.receive([128, pitch, 0], 1100);
    router.receive([176, 64, 80], 1110); // continuous controller update after the seam
    router.receive([176, 64, 0], 1120);
    expect(router.snapshot().liveNotes).toHaveLength(0);
    expect(router.snapshot().livePedals).toHaveLength(0);
    expect(t.take.map((e) => e.data)).toEqual([
      [176, 64, 80],
      [176, 64, 0],
    ]);
    engine.tick(2000, 2030);
    expect(t.take).toEqual([]);
    expect(t.layers![1].some((e) => e.boundary)).toBe(false);
    expect(readRollNotes(t).find((n) => n.layer === 1)).toMatchObject({
      start: 900,
      duration: 200,
    });
    const off = send.mock.calls.filter(([d]) => d[0] === 128 && d[1] === pitch);
    if (pitch !== 60) expect(off.some(([, at]) => at === 1100)).toBe(true);
    else expect(off.some(([, at]) => at === 1100)).toBe(false); // another owner still holds C
    expect(t.events.some((e) => e.data[0] === 176 && e.data[1] === 64 && e.data[2] === 0)).toBe(
      true,
    );
    expect(router.browser.clearTrack).not.toHaveBeenCalled();
  }
  // First recording -> playback has the same release routing, including NoteOn velocity 0.
  const { router, engine, t } = fixture();
  Object.assign(t, {
    state: 'recording',
    length: 0,
    layers: undefined,
    events: [],
    autoEnd: 1000,
    autoAction: 'play',
  });
  router.receive([144, 64, 100], 900);
  engine.tick(1000, 1030);
  router.receive([144, 64, 0], 1100);
  expect(readRollNotes(t)[0]).toMatchObject({ start: 900, duration: 200 });
  const long = fixture();
  long.router.receive([144, 64, 100], 900);
  long.engine.tick(1000, 1030);
  long.engine.tick(2000, 2030);
  long.router.receive([128, 64, 0], 2100);
  const held = readRollNotes(long.t).find((n) => n.pitch === 64)!;
  expect(held.start).toBe(900);
  expect(held.duration).toBeCloseTo(999.999, 3);
  expect(held.continuous).toBeFalsy();
});

it('seam notes remain finite through editor moves, overlapping additions, undo and aloop roundtrip', () => {
  const { router, engine, t } = fixture();
  router.receive([144, 64, 100], 900);
  engine.tick(1000, 1030);
  router.receive([128, 64, 0], 1100);
  engine.finishCaptures(1200);
  const editor = new MidiEditor(engine);
  const old = editor.notes.find((n) => n.pitch === 64)!;
  expect(editor.change(old.id, { start: 850 })).toBeDefined();
  expect(editor.notes.find((n) => n.pitch === 64)).toMatchObject({ start: 850, duration: 200 });
  expect(editor.change(null, { pitch: 64, start: 900, duration: 250 })).toBeDefined();
  expect(editor.notes.every((n) => !n.continuous)).toBe(true);
  expect(t.events.some((e) => e.at === 150 && e.data[0] === 128 && e.data[1] === 64)).toBe(true);
  editor.undo();
  editor.undo();
  expect(editor.notes.find((n) => n.pitch === 64)).toMatchObject({ start: 900, duration: 200 });
  const saved = parseMidiProject(JSON.stringify(exportMidiProject(engine, 'generaluser')));
  const restored = new LoopEngine({ send() {}, reset() {} });
  restoreMidiProject(restored, saved, 2000);
  expect(readRollNotes(restored.tracks[0]).find((n) => n.pitch === 64)).toMatchObject({
    start: 900,
    duration: 200,
  });
});

it('BPM pointer stepping restores performance focus but text editing and keyboard stepping retain input focus', async () => {
  document.body.innerHTML =
    '<main data-performance tabindex="-1"><input type="number" data-return-spinner-focus value="120"></main>';
  const main = document.querySelector('main')!,
    input = document.querySelector('input')!;
  const injector = Injector.create({
    providers: [{ provide: ElementRef, useValue: new ElementRef(main) }],
  });
  const focus = runInInjectionContext(injector, () => new PerformanceFocus());
  const event = (type: string) => {
    const e = new Event(type);
    input.dispatchEvent(e);
    return e as PointerEvent;
  };
  input.focus();
  focus.pointer(event('pointerdown'));
  focus.pointerup(event('pointerup'));
  await Promise.resolve();
  expect(document.activeElement).toBe(input);
  focus.pointer(event('pointerdown'));
  input.value = '121';
  focus.pointerup(event('pointerup'));
  await Promise.resolve();
  expect(document.activeElement).toBe(main);
  input.focus();
  focus.pointer(event('pointerdown'));
  const key = new KeyboardEvent('keydown', { key: 'ArrowUp' });
  input.dispatchEvent(key);
  focus.key(key);
  input.value = '122';
  focus.pointerup(event('pointerup'));
  await Promise.resolve();
  expect(document.activeElement).toBe(input);
  injector.destroy();
  document.body.innerHTML = '';
});
