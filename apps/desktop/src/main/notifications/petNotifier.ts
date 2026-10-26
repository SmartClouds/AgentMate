import type { AppSettings } from '@runova/core';
import type { PetPipelineMessage } from '../../shared/pet';
import { petDisplayName } from '../pet/names';
import { petManager } from '../pet/petWindow';

/**
 * Speaks a notification through the desktop companion. The companion only has a window while
 * Runova is running with the pet turned on and not snoozed, so a closed app or a hidden pet
 * drops the message instead of failing. Returns whether the pet actually said it.
 */
export function speakOnPet(
  settings: AppSettings,
  projectName: string,
  text: string,
  kind: PetPipelineMessage['kind'] = 'pass',
): boolean {
  if (!settings.desktopPetEnabled || !petManager.isOpen()) return false;
  petManager.sendPipelineMessage({
    kind,
    petName: petDisplayName(
      settings.desktopPetCharacterId,
      settings.desktopPetCustoms ?? [],
      settings.desktopPetName,
    ),
    text,
    projectName,
  });
  return true;
}
