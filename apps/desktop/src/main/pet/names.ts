import { normalizeDesktopPetName } from '@runova/core';

const BUILTIN_PET_NAMES: Record<string, string> = {
  fandi: 'Fandi',
  claude: 'Claude',
  gremlin: 'Gremlin',
  opencode: 'OpenCode',
  tide: 'Tide',
  pip: 'Pip',
  brick: 'Brick',
  ember: 'Ember',
  nori: 'Nori',
  bolt: 'Bolt',
  moss: 'Moss',
  cocoa: 'Cocoa',
  hex: 'Hex',
};

/**
 * What to call the pet. A nickname the user typed in Settings wins over the
 * character's own name.
 */
export function petDisplayName(
  characterId: string,
  customs: { id: string; name: string }[] = [],
  nickname?: string,
): string {
  const nick = normalizeDesktopPetName(nickname);
  if (nick) return nick;
  const custom = customs.find((item) => item.id === characterId);
  if (custom) return custom.name;
  return BUILTIN_PET_NAMES[characterId] ?? 'Your pet';
}
