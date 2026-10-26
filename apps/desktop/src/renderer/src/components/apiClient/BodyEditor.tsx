import type { BodyMode, DraftBody, RawLanguage } from '@runova/core';
import { MonacoEditor } from '@/components/editor/MonacoEditor';
import { ChevronDown, Wand2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { prettyBody } from './format';
import { KeyValueTable } from './KeyValueTable';

/**
 * The Body section of a request. Each body type keeps its own content, so switching from raw to
 * a form and back loses nothing, and only the selected type is sent.
 */

const MODES: { mode: BodyMode; label: string }[] = [
  { mode: 'none', label: 'none' },
  { mode: 'raw', label: 'raw' },
  { mode: 'urlencoded', label: 'x-www-form-urlencoded' },
];

const LANGUAGES: { language: RawLanguage; label: string; monaco: string }[] = [
  { language: 'json', label: 'JSON', monaco: 'json' },
  { language: 'text', label: 'Text', monaco: 'plaintext' },
  { language: 'xml', label: 'XML', monaco: 'xml' },
  { language: 'html', label: 'HTML', monaco: 'html' },
  { language: 'javascript', label: 'JavaScript', monaco: 'javascript' },
];

interface BodyEditorProps {
  body: DraftBody;
  onChange: (body: DraftBody) => void;
}

export function BodyEditor({ body, onChange }: BodyEditorProps): React.JSX.Element {
  const language = LANGUAGES.find((l) => l.language === body.language) ?? LANGUAGES[0]!;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="radiogroup" aria-label="Body type" className="flex flex-wrap items-center gap-1">
          {MODES.map(({ mode, label }) => (
            <label
              key={mode}
              className={cn(
                'flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors hover:bg-accent/60',
                body.mode === mode ? 'font-semibold text-foreground' : 'text-muted-foreground',
              )}
            >
              <input
                type="radio"
                name="body-mode"
                aria-label={label}
                checked={body.mode === mode}
                onChange={() => onChange({ ...body, mode })}
                className="h-3.5 w-3.5 accent-[hsl(var(--primary))]"
              />
              {label}
            </label>
          ))}
        </div>

        {body.mode === 'raw' && (
          <div className="flex items-center gap-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`Body language ${language.label}`}
                  className="flex items-center gap-1 rounded-md px-2 py-1 text-xs font-semibold text-primary transition-colors hover:bg-accent/60"
                >
                  {language.label}
                  <ChevronDown className="h-3 w-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {LANGUAGES.map((l) => (
                  <DropdownMenuItem
                    key={l.language}
                    onSelect={() => onChange({ ...body, language: l.language })}
                  >
                    {l.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {body.language === 'json' && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onChange({ ...body, raw: prettyBody(body.raw, 'json') })}
                className="gap-1 px-2 text-muted-foreground hover:text-foreground"
              >
                <Wand2 className="h-3 w-3" /> Beautify
              </Button>
            )}
          </div>
        )}
      </div>

      {body.mode === 'none' && (
        <p className="py-6 text-center text-xs text-muted-foreground">
          This request does not have a body.
        </p>
      )}

      {body.mode === 'raw' && (
        <div className="min-h-[160px] flex-1">
          <MonacoEditor
            value={body.raw}
            language={language.monaco}
            onChange={(raw) => onChange({ ...body, raw })}
            className="h-full min-h-[160px]"
          />
        </div>
      )}

      {body.mode === 'urlencoded' && (
        <KeyValueTable
          label="Form fields"
          rows={body.urlencoded}
          onChange={(urlencoded) => onChange({ ...body, urlencoded })}
        />
      )}
    </div>
  );
}
