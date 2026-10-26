import type { SecurityScanRecord } from '@runova/core';
import {
  buildSecurityFixPrompt,
  buildSecurityJson,
  buildSecurityReportMarkdown,
} from '@runova/core';
import { toast } from 'sonner';
import { Check, ChevronDown, Copy, FileCode, Sparkles } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/**
 * The three whole-report copy formats. The fix prompt is the one that matters: it is what turns
 * the report from something to read into something an agent can act on, so it leads.
 */
export function SecurityCopyMenu({ record }: { record: SecurityScanRecord }): React.JSX.Element {
  async function copy(label: string, build: () => string): Promise<void> {
    try {
      const text = build();
      await navigator.clipboard.writeText(text);
      const kb = Math.round(text.length / 1024);
      toast.success(`${label} copied to clipboard.`, {
        description: kb > 0 ? `About ${kb} KB.` : undefined,
      });
    } catch {
      toast.error(`Could not copy the ${label.toLowerCase()}.`);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="gap-1.5">
          <Copy className="h-4 w-4" />
          Copy report
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-72">
        <DropdownMenuLabel>Copy for</DropdownMenuLabel>
        <DropdownMenuItem
          onClick={() => void copy('Fix prompt', () => buildSecurityFixPrompt(record))}
        >
          <Sparkles className="h-4 w-4" />
          <span className="flex flex-col">
            <span>AI fix prompt</span>
            <span className="text-xs text-muted-foreground">
              Ready to paste at an agent, worst findings first
            </span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => void copy('Markdown report', () => buildSecurityReportMarkdown(record))}
        >
          <Check className="h-4 w-4" />
          <span className="flex flex-col">
            <span>Markdown report</span>
            <span className="text-xs text-muted-foreground">For an issue, a PR, or docs</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => void copy('JSON', () => buildSecurityJson(record))}>
          <FileCode className="h-4 w-4" />
          <span className="flex flex-col">
            <span>Raw JSON</span>
            <span className="text-xs text-muted-foreground">
              Normalized findings, for other tooling
            </span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
