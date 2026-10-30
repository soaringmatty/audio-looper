export type Shortcut =
  | { kind: 'select'; id: number }
  | { kind: 'main' | 'metro' | 'mute' | 'clear' };
export function shortcut(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'repeat' | 'ctrlKey' | 'altKey' | 'metaKey'> & {
    shiftKey?: boolean;
  },
  editing: boolean,
  button: boolean,
): Shortcut | null {
  if (editing || event.repeat || event.ctrlKey || event.altKey || event.metaKey) return null;
  if (event.code === 'KeyM' && event.shiftKey) return { kind: 'mute' };
  if (/^[1-5]$/.test(event.key)) return { kind: 'select', id: +event.key - 1 };
  if ((event.code === 'Space' || event.code === 'Enter' || event.code === 'NumpadEnter') && !button)
    return { kind: 'main' };
  if (event.code === 'KeyT' && !event.shiftKey) return { kind: 'metro' };
  if (event.key === 'Delete') return { kind: 'clear' };
  return null;
}
