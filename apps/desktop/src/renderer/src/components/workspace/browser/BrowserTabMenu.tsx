import { toast } from 'sonner';
import { Copy, ExternalLink, RotateCw } from '@/components/icons';
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu';
import { browserRuntime } from '@/lib/browser/browserRuntime';
import type { WorkspaceBrowserTab } from '@/stores/workspaceStore';

/** The right-click menu of a browser tab in a pane's tab strip. */
export function BrowserTabMenu({
  tab,
  onClose,
}: {
  tab: WorkspaceBrowserTab;
  onClose: () => void;
}): React.JSX.Element {
  const hasPage = tab.url !== '';
  return (
    <ContextMenuContent className="w-56">
      <ContextMenuItem disabled={!hasPage} onSelect={() => browserRuntime.reload(tab.id, false)}>
        <RotateCw className="h-3.5 w-3.5 text-muted-foreground" />
        Reload
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!hasPage}
        onSelect={() => {
          void navigator.clipboard.writeText(tab.url);
          toast.success('Address copied');
        }}
      >
        <Copy className="h-3.5 w-3.5 text-muted-foreground" />
        Copy address
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!hasPage}
        onSelect={() => void window.runova.shell.openExternal(tab.url)}
      >
        <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
        Open in system browser
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem tone="danger" onSelect={onClose}>
        Close
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
