import { PET_SNOOZE_OPTIONS } from '@shared/pet';
import { Clock, ExternalLink, Pause, Play, Power } from '@/components/icons';

export const MENU_W = 216;
/** First-paint estimate. The overlay measures the real box and re-places. */
export const MENU_H = 252;
const MENU_PAD = 8;
const MENU_GAP = 4;

/**
 * Puts the menu next to the pointer, flipping it left or up when it would run
 * off the screen and clamping whatever is left over.
 */
export function placePetMenu(
  pointerX: number,
  pointerY: number,
  stageW: number,
  stageH: number,
  menuW = MENU_W,
  menuH = MENU_H,
): { left: number; top: number } {
  const maxLeft = Math.max(MENU_PAD, stageW - menuW - MENU_PAD);
  const maxTop = Math.max(MENU_PAD, stageH - menuH - MENU_PAD);
  const left =
    pointerX + menuW + MENU_GAP > stageW - MENU_PAD
      ? pointerX - menuW - MENU_GAP
      : pointerX + MENU_GAP;
  const top =
    pointerY + menuH + MENU_GAP > stageH - MENU_PAD
      ? pointerY - menuH - MENU_GAP
      : pointerY + MENU_GAP;
  return {
    left: Math.min(maxLeft, Math.max(MENU_PAD, left)),
    top: Math.min(maxTop, Math.max(MENU_PAD, top)),
  };
}

export function PetMenu({
  petName,
  canMove,
  failedRun,
  onOpenApp,
  onToggleMove,
  onSnooze,
  onTurnOff,
}: {
  petName: string;
  canMove: boolean;
  /** The pet is still showing a failed pipeline, so opening the app lands on it. */
  failedRun?: boolean;
  onOpenApp: () => void;
  onToggleMove: () => void;
  onSnooze: (minutes: number) => void;
  onTurnOff: () => void;
}): React.JSX.Element {
  const MoveIcon = canMove ? Pause : Play;
  return (
    <div data-pet-hit="menu" className="widget-glass pet-menu">
      <p className="pet-menu-title">{petName}</p>

      <button type="button" className="pet-menu-item" onClick={onOpenApp}>
        <ExternalLink className="h-3.5 w-3.5" />
        <span>{failedRun ? 'Open the failed run' : 'Open Runova'}</span>
      </button>

      <button type="button" className="pet-menu-item" onClick={onToggleMove}>
        <MoveIcon className="h-3.5 w-3.5" />
        <span>{canMove ? 'Stop moving' : 'Start moving again'}</span>
      </button>

      <div className="pet-menu-sep" />

      <p className="pet-menu-label">
        <Clock className="h-3 w-3" />
        <span>Hide for</span>
      </p>
      <div className="grid grid-cols-2 gap-1">
        {PET_SNOOZE_OPTIONS.map((option) => (
          <button
            key={option.minutes}
            type="button"
            className="pet-menu-chip"
            onClick={() => onSnooze(option.minutes)}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="pet-menu-sep" />

      <button type="button" className="pet-menu-item is-danger" onClick={onTurnOff}>
        <Power className="h-3.5 w-3.5" />
        <span>Turn the pet off</span>
      </button>
    </div>
  );
}
