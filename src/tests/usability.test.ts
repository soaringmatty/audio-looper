import { midiTemplates } from './source-fixtures';
import { it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { InstrumentFocus } from '../app/shared/ui/instrument-focus';
import { shortcut } from '../app/shared/shortcuts';
import { PROGRAMS, PROGRAM_GROUP_NAMES } from '../app/features/midi/programs';

it('Instrumentwahl gibt Fokus erst beim Commit frei; T kollidiert weder mit Piano noch Browser-Modifiertasten', () => {
  const commit = vi.fn(),
    focus = new InstrumentFocus(commit);
  focus.pointer();
  focus.change();
  expect(commit).toHaveBeenCalledTimes(1);
  focus.keydown('ArrowDown');
  focus.change();
  expect(commit).toHaveBeenCalledTimes(1);
  focus.keyup('Enter');
  expect(commit).toHaveBeenCalledTimes(2);
  const key = {
    key: 't',
    code: 'KeyT',
    repeat: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
  };
  expect(shortcut(key, false, false)).toEqual({ kind: 'metro' });
  for (const modifier of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey', 'repeat'])
    expect(shortcut({ ...key, [modifier]: true }, false, false)).toBeNull();
  expect(shortcut(key, true, false)).toBeNull();
  expect(shortcut({ ...key, key: 'm', code: 'KeyM', shiftKey: true }, false, false)).toBeNull();
  expect(PROGRAM_GROUP_NAMES).toHaveLength(16);
  expect(PROGRAMS).toHaveLength(128);
  const html = midiTemplates();
  expect(html).toContain('<optgroup');
  expect(html).toContain('[attr.data-state]="vm.audioState"');
  expect(html).not.toContain('Shift+M');
});

// The former smplr adapter cases are superseded by soundfont.test.ts and live Worklet checks.
