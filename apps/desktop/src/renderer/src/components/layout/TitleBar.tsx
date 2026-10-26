import { MAC_TRAFFIC_LIGHTS_SPACER } from '@shared/windowChrome';
import { useEffect, useState } from 'react';
import appIconDark from '@/assets/app-icon.png';
import appIconLight from '@/assets/app-icon-light.png';
import { Search } from '@/components/icons';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { useIsDarkMode } from '@/lib/chartColors';
import { isTitleBarBlankDoubleClick } from '@/lib/titleBar';
import { cn } from '@/lib/utils';
import { useSearchStore } from '@/stores/searchStore';
import { useShortcutLabel } from '@/stores/shortcutStore';
import { HistoryNav } from './HistoryNav';

/**
 * Keeps the title bar clear for macOS's own traffic lights. The window hides only its title bar
 * (see titleBarFrameOptions in the main process), so the OS draws the real buttons over this
 * space, with their native look, hover glyphs and grey inactive state.
 */
export function MacTrafficLightsSpace(): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      data-traffic-lights-space=""
      className="h-full shrink-0"
      style={{ width: MAC_TRAFFIC_LIGHTS_SPACER }}
    />
  );
}

export interface WindowControlsProps {
  isMaximized: boolean;
  onMinimize: () => void;
  onMaximizeToggle: () => void;
  onClose: () => void;
}

// Windows 11 style caption buttons: flat 46px rectangles, right-aligned,
// rendered with the system's Segoe Fluent Icons glyphs so they look native.
// Hover follows the OS: subtle wash for minimize/maximize, red for close.
const GLYPH = { minimize: '\uE921', maximize: '\uE922', restore: '\uE923', close: '\uE8BB' };

export function NativeCaptionButtons({
  isMaximized,
  onMinimize,
  onMaximizeToggle,
  onClose,
}: WindowControlsProps): React.JSX.Element {
  return (
    <div className="flex h-11 items-stretch [-webkit-app-region:no-drag]">
      <SimpleTooltip label="Minimize" side="bottom">
        <button
          type="button"
          onClick={onMinimize}
          className="flex w-[46px] items-center justify-center text-foreground/80 transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
        >
          <span className="caption-glyph" aria-hidden="true">
            {GLYPH.minimize}
          </span>
        </button>
      </SimpleTooltip>
      <SimpleTooltip label={isMaximized ? 'Restore' : 'Maximize'} side="bottom">
        <button
          type="button"
          onClick={onMaximizeToggle}
          className="flex w-[46px] items-center justify-center text-foreground/80 transition-colors hover:bg-black/5 hover:text-foreground dark:hover:bg-white/10"
        >
          <span className="caption-glyph" aria-hidden="true">
            {isMaximized ? GLYPH.restore : GLYPH.maximize}
          </span>
        </button>
      </SimpleTooltip>
      <SimpleTooltip label="Close" side="bottom">
        <button
          type="button"
          onClick={onClose}
          className="flex w-[46px] items-center justify-center text-foreground/80 transition-colors hover:bg-[#c42b1c] hover:text-white"
        >
          <span className="caption-glyph" aria-hidden="true">
            {GLYPH.close}
          </span>
        </button>
      </SimpleTooltip>
    </div>
  );
}

function SearchTrigger(): React.JSX.Element {
  const openSearch = useSearchStore((s) => s.setOpen);
  const searchOpen = useSearchStore((s) => s.open);
  const searchShortcut = useShortcutLabel('search.toggle');

  return (
    <button
      type="button"
      data-search-anchor=""
      onClick={() => openSearch(true)}
      className={cn(
        'search-pill flex h-8 w-full cursor-pointer items-center gap-2 rounded-full pl-3.5 pr-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground',
        // The open search panel sits right on top of this box and is see-through, so the box
        // steps aside while it is open instead of showing its placeholder through the glass.
        searchOpen && 'invisible',
      )}
    >
      <Search className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1 truncate text-left">Search projects, history, skills…</span>
      {searchShortcut ? (
        <kbd className="hidden shrink-0 items-center gap-0.5 rounded-full bg-foreground/[0.07] px-2 py-0.5 font-sans text-[10px] font-medium text-muted-foreground sm:flex">
          {searchShortcut}
        </kbd>
      ) : null}
    </button>
  );
}

export function TitleBar(): React.JSX.Element {
  const [isMaximized, setIsMaximized] = useState(false);
  const isMac = window.runova.platform === 'darwin';
  const isDark = useIsDarkMode();

  useEffect(() => {
    window.runova.window.isMaximized().then(setIsMaximized);
    return window.runova.window.onMaximizedChange(setIsMaximized);
  }, []);

  const controlProps: WindowControlsProps = {
    isMaximized,
    onMinimize: () => void window.runova.window.minimize(),
    onMaximizeToggle: () => void window.runova.window.maximizeToggle(),
    onClose: () => void window.runova.window.close(),
  };

  return (
    <div
      className="relative flex h-11 shrink-0 items-center justify-between border-b border-border/80 pl-4 [-webkit-app-region:drag] glass:border-b-0"
      onDoubleClick={(e) => {
        if (isTitleBarBlankDoubleClick(e)) void window.runova.window.maximizeToggle();
      }}
    >
      <div className="flex items-center gap-3">
        {isMac && <MacTrafficLightsSpace />}
        <div className="flex items-center gap-2">
          {/* macOS apps don't put an icon beside the traffic lights. */}
          {!isMac && <img src={isDark ? appIconDark : appIconLight} alt="" className="h-6 w-6" />}
          <span className="text-sm font-semibold tracking-tight text-foreground">Runova</span>
        </div>
      </div>

      {/* VS Code style command center: history arrows sit just left of the
          centered search box. */}
      <div className="absolute left-1/2 top-1/2 flex w-full max-w-xl -translate-x-1/2 -translate-y-1/2 items-center gap-1 px-4">
        <HistoryNav />
        <div className="min-w-0 flex-1 [-webkit-app-region:no-drag]">
          <SearchTrigger />
        </div>
      </div>

      <div className={cn('flex items-center gap-1 [-webkit-app-region:no-drag]', isMac && 'pr-3')}>
        {!isMac && <NativeCaptionButtons {...controlProps} />}
      </div>
    </div>
  );
}
