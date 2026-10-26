import { HTTP_METHODS } from '@runova/core';
import { ChevronDown, Save, Send, StopCircle } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { methodTone } from './format';

interface UrlBarProps {
  method: string;
  url: string;
  sending: boolean;
  onMethodChange: (method: string) => void;
  onUrlChange: (url: string) => void;
  onSend: () => void;
  onCancel: () => void;
  onSave: () => void;
}

/**
 * Method, URL, Send and Save: the row every request starts from. The method, the address and
 * Send share one pill, like the search field in the title bar, so they read as one control.
 * Save sits beside it. Labels drop to icons when the request area is narrow (it is a container
 * query on the request panel, see ApiClientPage).
 */
export function UrlBar({
  method,
  url,
  sending,
  onMethodChange,
  onUrlChange,
  onSend,
  onCancel,
  onSave,
}: UrlBarProps): React.JSX.Element {
  const canSend = url.trim().length > 0;

  return (
    <div className="flex items-center gap-2">
      <div className="search-pill flex h-10 min-w-0 flex-1 items-center gap-1 rounded-full p-1 transition-colors">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Method ${method}`}
              className={cn(
                'flex h-8 w-[5.75rem] shrink-0 items-center justify-between gap-1 rounded-full bg-current/10 pl-3.5 pr-2.5 font-mono text-xs font-bold tracking-wide transition-colors hover:bg-current/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-current/15',
                methodTone(method),
              )}
            >
              {method}
              <ChevronDown className="h-3 w-3 opacity-70" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[8rem]">
            {HTTP_METHODS.map((m) => (
              <DropdownMenuItem
                key={m}
                onSelect={() => onMethodChange(m)}
                className={cn('font-mono text-xs font-bold', methodTone(m))}
              >
                {m}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <input
          aria-label="Request URL"
          value={url}
          onChange={(event) => onUrlChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && canSend && !sending) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder="Enter a URL, like https://api.example.com/users or {{baseUrl}}/users"
          spellCheck={false}
          autoComplete="off"
          className="h-full min-w-0 flex-1 bg-transparent px-2 font-mono text-[13px] outline-none placeholder:font-sans placeholder:text-muted-foreground/70"
        />
        {sending ? (
          <Button variant="soft" className="shrink-0 @lg/request:w-[6rem]" onClick={onCancel}>
            <StopCircle /> Cancel
          </Button>
        ) : (
          <SimpleTooltip label="Send (Ctrl+Enter)" wrapTrigger={!canSend}>
            <Button
              className="shrink-0 px-3.5 @lg/request:w-[6rem]"
              disabled={!canSend}
              onClick={onSend}
            >
              <Send /> Send
            </Button>
          </SimpleTooltip>
        )}
      </div>

      <SimpleTooltip label="Save (Ctrl+S)">
        <Button
          variant="soft"
          aria-label="Save"
          className="h-10 shrink-0 px-3 @lg/request:px-4"
          onClick={onSave}
        >
          <Save />
          <span className="hidden @lg/request:inline">Save</span>
        </Button>
      </SimpleTooltip>
    </div>
  );
}
