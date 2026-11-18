// @vitest-environment happy-dom
import '@angular/compiler';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LoopEngine } from '../app/features/midi/loop-engine';
import { MidiEditor, readRollNotes, translateNotes } from '../app/features/midi/midi-editor';
import { compileLoop } from '../app/features/midi/loop-seam';
import { readRollPedals } from '../app/features/midi/midi-pedals';
import { alignNotes } from '../app/features/midi/midi-align';
import type { RollNote } from '../app/features/midi/midi-editor';
import {
  exportMidiProject,
  parseMidiProject,
  restoreMidiProject,
} from '../app/features/midi/midi-project';
import { MidiWorkspace } from '../app/features/midi/midi-workspace';
import { MidiRouter } from '../app/features/midi/midi-router';

const sink = () => ({ send: vi.fn(), reset: vi.fn(), resetTrack: vi.fn() });
it('auto align snaps exactly to the grid beyond 40ms, reports conflicts and applies one guarded undoable aloop transaction', () => {
  const note = (id: string, start: number, duration: number, pitch = 60): RollNote => ({
    id,
    layer: 0,
    channel: 0,
    velocity: 90,
    start,
    duration,
    pitch,
  });
  const notes = [
    note('chord1', 112, 300),
    note('chord2', 118, 300, 64),
    note('end', 512, 240, 67),
    note('unclear', 560, 100, 68),
    note('short', 1512, 25, 70),
    note('wrap', 1950, 100, 72),
    note('edge', 897, 200, 74),
    note('repeat1', 1100, 210, 55),
    note('repeat2', 1315, 200, 55),
  ];
  const pedal = [
    { at: 890, data: [176, 66, 127] },
    { at: 1300, data: [176, 66, 0] },
  ];
  const plain = alignNotes(notes, 2000, 125, false, pedal),
    ends = alignNotes(notes, 2000, 125, true, pedal);
  const get = (id: string, r = plain) => r.notes.find((n) => n.id === id)!;
  expect(get('chord1').start).toBe(125);
  expect(get('chord2').start).toBe(125);
  expect(get('chord1').duration).toBe(300);
  expect(get('end').start).toBe(500);
  expect(get('end', ends).duration).toBe(250);
  expect(get('short', ends).duration).toBe(25);
  expect(get('unclear').start).toBe(500);
  expect(get('wrap').start).toBe(0);
  for (const id of ['edge']) expect(get(id)).toEqual(notes.find((n) => n.id === id));
  const converging = alignNotes([note('a', 105, 30), note('b', 145, 30, 65)], 1000, 125, false, []);
  expect(converging.changed).toBe(2);
  const collision = alignNotes([note('a', 105, 30), note('b', 145, 30)], 1000, 125, false, []);
  expect(collision.changed).toBe(0);
  expect(collision.skipped.some((s) => s.reason.includes('Notenkonflikt'))).toBe(true);
  const zero = alignNotes([note('zero', 130, 10)], 1000, 125, true, []);
  expect(zero.changed).toBe(0);
  expect(zero.skipped[0].reason).toContain('Notenlänge');
  const legato = alignNotes([note('a', 112, 100), note('b', 220, 100, 65)], 1000, 125, false, []);
  expect(legato.changed).toBe(2); // explicit quantization may change cross-pitch articulation
  const output = sink(),
    engine = new LoopEngine(output),
    editor = seed(engine),
    t = engine.tracks[0];
  t.muted = false;
  expect(editor.previewAlign(4)).toBeUndefined();
  engine.mode = 'tempo';
  expect(editor.previewAlign(0)).toBeUndefined();
  const original = structuredClone(t.layers),
    originalPedals = structuredClone(editor.pedals),
    other = structuredClone(engine.tracks[1]);
  const preview = editor.previewAlign(4)!;
  expect(preview.changed).toBeGreaterThan(0);
  expect(t.layers).toEqual(original);
  expect(editor.applyAlign(preview)).toBe(true);
  expect(editor.pedals).toEqual(originalPedals);
  expect(engine.tracks[1]).toEqual(other);
  expect(t.start).toBe(100);
  expect(t.length).toBe(1000);
  expect(editor.applyAlign(preview)).toBe(false);
  const aligned = structuredClone(t.layers);
  editor.undo();
  expect(t.layers).toEqual(original);
  editor.redo();
  expect(t.layers).toEqual(aligned);
  const restored = new LoopEngine(sink());
  restoreMidiProject(
    restored,
    parseMidiProject(JSON.stringify(exportMidiProject(engine, 'generaluser'))),
    10000,
  );
  expect(readRollPedals(restored.tracks[0])).toEqual(editor.pedals);
  expect(
    readRollNotes(restored.tracks[0]).map(({ start, duration, pitch }) => ({
      start,
      duration,
      pitch,
    })),
  ).toEqual(editor.notes.map(({ start, duration, pitch }) => ({ start, duration, pitch })));
  const stale = editor.previewAlign(4)!;
  editor.changePedal(64, null, { start: 800, duration: 100, value: 32 });
  expect(editor.applyAlign(stale)).toBe(false);
  const running = editor.previewAlign(4)!;
  engine.pausedAt = null;
  expect(editor.applyAlign(running)).toBe(false);
  expect(output.send).not.toHaveBeenCalled();
  expect(output.resetTrack).not.toHaveBeenCalled();
});
it('multi edit commits cross-layer moves/deletes atomically, clamps one shared delta and remaps selection without losing pedals, seams or undo', () => {
  const output = sink(),
    engine = new LoopEngine(output),
    editor = seed(engine),
    t = engine.tracks[0];
  const original = structuredClone(t.layers),
    pedals = structuredClone(editor.pedals),
    other = structuredClone(engine.tracks[1]);
  const source = editor.notes,
    chosen = [source[0], source.find((n) => n.pitch === 67)!];
  const moved = translateNotes(chosen, 500, 100, t.length);
  expect(moved[1].pitch).toBe(127);
  expect(moved[0].pitch).toBe(120);
  expect(moved[1].start - moved[0].start).toBeCloseTo(chosen[1].start - chosen[0].start, 8);
  expect(moved[1].start).toBeCloseTo(999.999, 6);
  editor.changeMany(source, [
    { id: source[0].id, patch: { pitch: 61 } },
    { id: source[1].id, patch: { pitch: 128 } },
  ]);
  expect(t.layers).toEqual(original);
  expect(editor.canUndo).toBe(false);
  const result = editor.changeMany(
    source,
    moved.map((n) => ({ id: n.id, patch: { start: n.start, pitch: n.pitch } })),
  )!;
  expect(result).toHaveLength(2);
  expect(result.map((n) => n.pitch)).toEqual([120, 127]);
  expect(result.map((n) => Math.round(n.duration))).toEqual(
    chosen.map((n) => Math.round(n.duration)),
  );
  expect(editor.pedals).toEqual(pedals);
  expect(engine.tracks[1]).toEqual(other);
  expect(t.start).toBe(100);
  expect(t.length).toBe(1000);
  const installed = structuredClone(t.layers);
  expect(editor.changeMany(source, [{ id: source[0].id, patch: null }])).toBeUndefined();
  editor.undo();
  expect(t.layers).toEqual(original);
  expect(editor.canUndo).toBe(false);
  editor.redo();
  expect(t.layers).toEqual(installed);
  engine.mode = 'tempo';
  const target = editor.notes.find((n) => n.pitch === 60)!;
  const scope = editor.previewAlign(4, false, [target.id])!;
  expect(scope.changed + scope.unchanged).toBe(1);
  expect(scope.notes.filter((n) => n.id !== target.id)).toEqual(
    editor.notes.filter((n) => n.id !== target.id),
  );
  const loaded = new LoopEngine(sink());
  restoreMidiProject(
    loaded,
    parseMidiProject(JSON.stringify(exportMidiProject(engine, 'generaluser'))),
    10000,
  );
  expect(readRollPedals(loaded.tracks[0])).toEqual(editor.pedals);
  expect(readRollNotes(loaded.tracks[0]).map((n) => [n.pitch, n.start, n.duration])).toEqual(
    editor.notes.map((n) => [n.pitch, n.start, n.duration]),
  );
  const all = editor.notes;
  editor.changeMany(
    all,
    all.map((n) => ({ id: n.id, patch: null })),
  );
  expect(editor.notes).toHaveLength(0);
  expect(editor.pedals).toEqual(pedals);
  editor.undo();
  expect(t.layers).toEqual(installed);
  const beforeRunning = structuredClone(t.layers);
  engine.pausedAt = null;
  expect(
    editor.changeMany(editor.notes, [{ id: editor.notes[0].id, patch: { pitch: 1 } }]),
  ).toBeUndefined();
  expect(t.layers).toEqual(beforeRunning);
  expect(output.send).not.toHaveBeenCalled();
  expect(output.resetTrack).not.toHaveBeenCalled();
});
it('pedal editing paints all owners, preserves intermediate values and untouched data, handles seams and shared atomic history with aloop roundtrip', () => {
  const output = sink(),
    engine = new LoopEngine(output),
    t = engine.tracks[0];
  engine.origin = 0;
  engine.reference = 1000;
  engine.pausedAt = 500;
  const layers = [
    [
      { at: 100, data: [144, 60, 100] },
      { at: 100, data: [176, 64, 127] },
      { at: 150, data: [176, 66, 127] },
      { at: 300, data: [128, 60, 0] },
      { at: 350, data: [144, 62, 100] },
      { at: 600, data: [128, 62, 0] },
      { at: 650, data: [176, 66, 0] },
      { at: 700, data: [176, 64, 0] },
    ],
    [
      { at: 200, data: [177, 64, 64] },
      { at: 150, data: [177, 66, 127] },
      { at: 650, data: [177, 66, 0] },
      { at: 900, data: [177, 64, 0] },
    ].sort((a, b) => a.at - b.at),
  ];
  Object.assign(t, { state: 'playing', start: 0, length: 1000, layers, ...compileLoop(layers) });
  const editor = new MidiEditor(engine),
    original = structuredClone(t.layers);
  const untouched = () =>
    t.layers!.map((l) => l.filter((e) => e.data[1] !== 64 || (e.data[0] & 240) !== 176));
  const otherData = structuredClone(untouched());
  const value = (cc: number, at: number) => {
    let v = t.carry?.find((d) => d[1] === cc)?.[2] ?? 0;
    for (const e of t.events)
      if (e.at <= at && e.data[1] === cc && (e.data[0] & 240) === 176) v = e.data[2];
    return v;
  };
  expect(editor.pedals.filter((p) => p.cc === 64).map((p) => p.value)).toEqual([127, 64]);
  const high = editor.pedals.find((p) => p.cc === 64 && p.value === 127)!;
  editor.changePedal(64, high.id, null);
  expect(value(64, 350)).toBe(0);
  expect(value(64, 750)).toBe(64);
  expect(untouched()).toEqual(otherData);
  editor.undo();
  expect(t.layers).toEqual(original);
  editor.redo();
  const beforeWrap = structuredClone(t.layers);
  const wrapped = editor.changePedal(64, null, { start: 850, duration: 300, value: 32 })!;
  expect(wrapped).toMatchObject({ start: 850, duration: 300, value: 32 });
  expect(value(64, 50)).toBe(32);
  expect(value(64, 200)).toBe(0);
  expect(value(64, 800)).toBe(64);
  editor.undo();
  expect(t.layers).toEqual(beforeWrap);
  editor.redo();
  const pedalSnapshot = structuredClone(t.layers);
  editor.change(editor.notes[0].id, { pitch: 61 });
  editor.undo();
  expect(t.layers).toEqual(pedalSnapshot);
  editor.undo();
  expect(t.layers).toEqual(beforeWrap);
  editor.redo();
  editor.redo();
  const loaded = new LoopEngine(sink());
  restoreMidiProject(
    loaded,
    parseMidiProject(JSON.stringify(exportMidiProject(engine, 'generaluser'))),
    10000,
  );
  expect(readRollPedals(loaded.tracks[0])).toEqual(editor.pedals);
  const snapshot = JSON.stringify(t.layers);
  editor.changePedal(64, null, { value: 128 });
  engine.pausedAt = null;
  editor.changePedal(64, null, { value: 30 });
  expect(JSON.stringify(t.layers)).toBe(snapshot);
  engine.pausedAt = 500;
  // A synchronized Sostenuto-off reaches the output once, before a new attack.
  const sostenuto = editor.pedals.find((p) => p.cc === 66)!;
  editor.changePedal(66, sostenuto.id, { duration: 200 });
  const at350 = t.events.filter((e) => e.at === 350);
  expect(at350.findIndex((e) => e.data[1] === 66 && e.data[2] === 0)).toBeLessThan(
    at350.findIndex((e) => e.data[0] === 144),
  );
  // An explicit ending at the seam resets only this edited pedal at zero.
  editor.changePedal(69, null, { start: 800, duration: 200, value: 100 });
  expect(value(69, 900)).toBe(100);
  expect(value(69, 0)).toBe(0);
  expect(output.send).not.toHaveBeenCalled();
  expect(output.resetTrack).not.toHaveBeenCalled();
  expect(t.start).toBe(0);
  expect(t.length).toBe(1000);
  // Recorded through-pedals use a boundary-derived seed, not an invented off.
  const held = [
    [
      { at: 400, data: [176, 67, 87] },
      { at: 999.99, data: [176, 67, 0], boundary: true },
    ],
  ];
  Object.assign(t, { layers: held, ...compileLoop(held) });
  expect(editor.pedals.find((p) => p.cc === 67)).toMatchObject({
    start: 0,
    duration: 1000,
    value: 87,
  });
  editor.changePedal(67, null, { start: 200, duration: 200, value: 0 });
  expect(value(67, 100)).toBe(87);
  expect(value(67, 300)).toBe(0);
  expect(value(67, 500)).toBe(87);
  editor.undo();
  expect(t.layers).toEqual(held);
});
function seed(engine: LoopEngine) {
  engine.origin = 100;
  engine.reference = 1000;
  engine.pausedAt = 600;
  const layers = [
    [
      { at: 100, data: [0x90, 60, 95] },
      { at: 150, data: [0xb0, 64, 127] },
      { at: 300, data: [0x80, 60, 40] },
      { at: 400, data: [0x90, 60, 90] },
      { at: 600, data: [0x80, 60, 0] },
      { at: 700, data: [0xb0, 64, 0] },
    ],
    [
      { at: -1, data: [0x90, 67, 80] },
      { at: 100, data: [0x80, 67, 0] },
      { at: 800, data: [0x90, 67, 80] },
    ],
  ];
  Object.assign(engine.tracks[0], {
    state: 'playing',
    start: 100,
    length: 1000,
    layers,
    ...compileLoop(layers),
    muted: true,
  });
  Object.assign(engine.tracks[1], {
    state: 'playing',
    start: 350,
    length: 2000,
    events: [],
    layers: [],
  });
  return new MidiEditor(engine);
}
it('edits paused notes atomically, preserves takes/pedals/seams, supports add/delete and exact undo/redo without output or timing changes', () => {
  const engine = new LoopEngine(sink()),
    editor = seed(engine),
    t = engine.tracks[0];
  const original = structuredClone(t.layers),
    other = structuredClone(engine.tracks[1]);
  const controls = t.layers![0].filter((e) => (e.data[0] & 0xf0) === 0xb0);
  expect(editor.notes).toHaveLength(3);
  expect(editor.notes.find((n) => n.pitch === 67)).toMatchObject({
    start: 800,
    duration: 300,
    layer: 1,
  });
  let n = editor.change(editor.notes[0].id, { start: 200, pitch: 62, duration: 350 })!;
  expect(n).toMatchObject({ start: 200, pitch: 62, duration: 350, velocity: 95 });
  expect(t.layers![1]).toEqual(original![1]);
  expect(t.layers![0].filter((e) => (e.data[0] & 0xf0) === 0xb0)).toEqual(controls);
  expect(engine.sink.send).not.toHaveBeenCalled();
  expect(engine.sink.resetTrack).not.toHaveBeenCalled();
  editor.undo();
  expect(t.layers).toEqual(original);
  editor.redo();
  expect(editor.notes.find((v) => v.pitch === 62)).toMatchObject({ start: 200, duration: 350 });
  n = editor.notes.find((v) => v.pitch === 67)!;
  editor.change(n.id, { duration: 400 });
  expect(editor.notes.find((v) => v.pitch === 67)).toMatchObject({ start: 800, duration: 400 });
  expect(t.carry!.some((data) => data[1] === 67)).toBe(true);
  const added = editor.change(null, { start: 950, pitch: 72, duration: 200 })!;
  expect(editor.notes.find((v) => v.id === added.id)).toMatchObject({ start: 950, duration: 200 });
  editor.change(added.id, null);
  expect(editor.notes.some((v) => v.pitch === 72)).toBe(false);
  const beforeInvalid = JSON.stringify(t);
  editor.change(null, { pitch: 128 });
  editor.change(null, { start: NaN });
  editor.change(null, { duration: 1001 });
  expect(JSON.stringify(t)).toBe(beforeInvalid);
  expect(engine.tracks[1]).toEqual(other);
  expect(t).toMatchObject({ start: 100, length: 1000, muted: true });
  expect(engine.pausedAt).toBe(600);
  expect(engine.origin).toBe(100);
  // Repeated attacks at exactly the previous release must not become zero-length.
  const repeated = [
    { at: 0, data: [144, 64, 90] },
    { at: 200, data: [128, 64, 0] },
    { at: 200, data: [144, 64, 90] },
    { at: 500, data: [128, 64, 0] },
  ];
  Object.assign(t, { layers: [repeated], ...compileLoop([repeated]) });
  expect(readRollNotes(t).map((v) => v.duration)).toEqual([200, 300]);
  expect(editor.canUndo).toBe(false);
});

it('finite editor notes release at the loop seam after resume while untouched recorded ties, overlapping takes and undo remain intact', () => {
  const output = sink(),
    engine = new LoopEngine(output),
    editor = seed(engine),
    t = engine.tracks[0];
  const tied = [
    { at: 0, data: [144, 55, 80] },
    { at: 999.999, data: [128, 55, 0], boundary: true },
  ];
  const ordinary = [
    { at: 100, data: [144, 60, 90] },
    { at: 250, data: [128, 60, 0] },
  ];
  Object.assign(t, { layers: [tied, ordinary], ...compileLoop([tied, ordinary]), muted: false });
  expect(editor.notes.find((n) => n.pitch === 55)?.continuous).toBe(true);
  const full = editor.change(null, { pitch: 72, start: 0, duration: t.length })!;
  expect(t.carry!.some((data) => data[1] === 72)).toBe(false);
  expect(
    t.events.some((e) => e.data[0] === 128 && e.data[1] === 72 && e.at > 999 && e.at < 1000),
  ).toBe(true);
  // Rewriting the original tied layer for another note must retain the original tie.
  const shared = [
    { at: 400, data: [144, 57, 90] },
    { at: 600, data: [128, 57, 0] },
  ];
  t.layers![0] = [...tied, ...shared].sort((a, b) => a.at - b.at);
  Object.assign(t, compileLoop(t.layers!));
  const release = editor.notes.find((n) => n.pitch === 57)!;
  editor.change(release.id, { pitch: 59 });
  expect(editor.notes.find((n) => n.pitch === 55)?.continuous).toBe(true);
  expect(t.carry!.some((data) => data[1] === 55)).toBe(true);
  // Editing a recorded full-cycle hold makes that explicit editor note finite.
  const hold = editor.notes.find((n) => n.pitch === 55)!;
  editor.change(hold.id, { pitch: 56 });
  expect(t.carry!.some((data) => data[1] === 56)).toBe(false);
  expect(t.events.some((e) => (e.data[0] & 240) === 128 && e.data[1] === 56)).toBe(true);
  editor.undo();
  expect(t.carry!.some((data) => data[1] === 55)).toBe(true);
  editor.redo();
  expect(t.carry!.some((data) => data[1] === 56)).toBe(false);
  // A finite note ending exactly at the seam must not acquire a phantom carry.
  const exact = editor.change(null, { pitch: 74, start: 750, duration: 250 })!;
  expect(exact.duration).toBeCloseTo(250, 2);
  expect(t.carry!.some((data) => data[1] === 74)).toBe(false);
  const wrap = editor.change(null, { pitch: 76, start: 850, duration: 300 })!;
  expect(wrap).toMatchObject({ start: 850, duration: 300 });
  expect(t.carry!.some((data) => data[1] === 76)).toBe(true);
  editor.change(null, { pitch: 72, start: 300, duration: 250 });
  const project = parseMidiProject(JSON.stringify(exportMidiProject(engine, 'generaluser')));
  const loaded = new LoopEngine(sink());
  restoreMidiProject(loaded, project, 10000);
  expect(
    readRollNotes(loaded.tracks[0]).find((n) => n.pitch === 72 && n.start === 0)!.duration,
  ).toBeCloseTo(1000, 2);
  engine.pausedAt = t.start;
  engine.resume(2000);
  output.send.mockClear();
  engine.tick(2000, t.start + 3000);
  const messages = output.send.mock.calls.filter((call) => call[1][1] === 72);
  // Same-pitch added take may retrigger the long note, but each cycle still releases.
  expect(messages.filter((call) => (call[1][0] & 240) === 128).length).toBeGreaterThanOrEqual(3);
  expect(messages.at(-1)![1][0] & 240).toBe(128);
  expect(full.duration).toBeCloseTo(1000, 2);
});

let vm: MidiWorkspace | undefined;
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'Worker',
    class {
      onmessage: any;
      terminate() {}
    },
  );
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn(() => 1),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(MidiRouter.prototype, 'prepareAudio').mockResolvedValue();
  vi.spyOn(MidiRouter.prototype, 'connect').mockResolvedValue();
});
afterEach(() => {
  vm?.ngOnDestroy();
  vm = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('guards running/capture edits, switches views without transport mutations, roundtrips edited MIDI and chases edits on resume', () => {
  vm = new MidiWorkspace();
  seed(vm.engine);
  const editor = vm.editor;
  const n = editor.change(editor.notes[0].id, { pitch: 69, start: 200, duration: 600 })!;
  const json = JSON.stringify(exportMidiProject(vm.engine, 'generaluser'));
  const saved = parseMidiProject(json),
    loaded = new LoopEngine(sink());
  restoreMidiProject(loaded, saved, 10000);
  expect(readRollNotes(loaded.tracks[0]).find((v) => v.pitch === 69)).toMatchObject({
    start: 200,
    duration: 600,
  });
  const before = JSON.stringify(vm.engine.tracks),
    paused = vm.engine.pausedAt;
  vm.setWorkspaceView('editor');
  vm.setWorkspaceView('live');
  expect(vm.engine.pausedAt).toBe(paused);
  expect(JSON.stringify(vm.engine.tracks)).toBe(before);
  vm.engine.pausedAt = null;
  editor.change(n.id, null);
  editor.undo();
  editor.change(null, { pitch: 75 });
  expect(JSON.stringify(vm.engine.tracks)).toBe(before);
  vm.engine.pausedAt = paused;
  vm.engine.tracks[1].state = 'overdub';
  editor.change(n.id, null);
  expect(JSON.stringify(vm.engine.tracks[0])).toBe(JSON.stringify(JSON.parse(before)[0]));
  vm.engine.tracks[1].state = 'playing';
  vm.engine.tracks[0].muted = false;
  const sent = vi.spyOn(vm.midi, 'send').mockImplementation(() => {});
  vm.engine.resume(1600);
  expect(vm.engine.phase(vm.engine.tracks[0], 1600)).toBe(0.5);
  expect(
    sent.mock.calls.some((call) => call[0] === 0 && call[1][0] === 144 && call[1][1] === 69),
  ).toBe(true);
  // Editor shortcuts never delete a whole track or start recording.
  vm.workspaceView = 'editor';
  const beforeKey = JSON.stringify(vm.engine.tracks);
  vm.key(new KeyboardEvent('keydown', { code: 'Delete', key: 'Delete' }));
  expect(JSON.stringify(vm.engine.tracks)).toBe(beforeKey);
});
