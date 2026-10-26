import type { KeyValueRow } from '@runova/core';
import { SECTION_HEADING } from '@/components/pageKit';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { type ApiTab, useApiClientTabsStore } from '@/stores/apiClientTabsStore';
import { BodyEditor } from './BodyEditor';
import { KeyValueTable } from './KeyValueTable';

/** Params, Headers and Body for the request in one tab. */
export function RequestEditor({ tab }: { tab: ApiTab }): React.JSX.Element {
  const setParams = useApiClientTabsStore((s) => s.setParams);
  const updateDraft = useApiClientTabsStore((s) => s.updateDraft);
  const { draft } = tab;

  const activeParams = draft.params.filter((p) => p.enabled && p.key).length;
  const activeHeaders = draft.headers.filter((h) => h.enabled && h.key).length;

  return (
    <Tabs defaultValue="params" className="flex h-full min-h-0 flex-col">
      <TabsList
        className="h-9 shrink-0 border-none bg-transparent px-1.5"
        containerClassName="shrink-0 border-b-0 shadow-[inset_0_-1px_0_hsl(var(--border)/0.6)]"
      >
        <TabsTrigger value="params">
          Params <Count value={activeParams} />
        </TabsTrigger>
        <TabsTrigger value="headers">
          Headers <Count value={activeHeaders} />
        </TabsTrigger>
        <TabsTrigger value="body">
          Body
          {draft.body.mode !== 'none' && (
            <span aria-hidden className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-primary" />
          )}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="params" className="mt-0 min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-2.5">
        <SectionTitle>Query parameters</SectionTitle>
        <KeyValueTable
          label="Query parameters"
          rows={draft.params}
          onChange={(rows) => setParams(tab.id, rows)}
        />
        {draft.pathVariables.length > 0 && (
          <div className="mt-4">
            <SectionTitle>Path variables</SectionTitle>
            <PathVariablesTable
              rows={draft.pathVariables}
              onChange={(pathVariables) => updateDraft(tab.id, (d) => ({ ...d, pathVariables }))}
            />
          </div>
        )}
      </TabsContent>

      <TabsContent value="headers" className="mt-0 min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-2.5">
        <KeyValueTable
          label="Headers"
          rows={draft.headers}
          onChange={(headers) => updateDraft(tab.id, (d) => ({ ...d, headers }))}
        />
        <p className="mt-2 text-[11px] text-muted-foreground">
          Content-Type, User-Agent and Content-Length are added for you when they are not set here.
        </p>
      </TabsContent>

      <TabsContent value="body" className="mt-0 min-h-0 flex-1 px-3 pb-3 pt-2.5">
        <BodyEditor
          body={draft.body}
          onChange={(body) => updateDraft(tab.id, (d) => ({ ...d, body }))}
        />
      </TabsContent>
    </Tabs>
  );
}

function Count({ value }: { value: number }): React.JSX.Element | null {
  if (value === 0) return null;
  return (
    <span className="ml-1 rounded-full bg-primary/12 px-1.5 py-px text-[10px] font-semibold tabular-nums text-primary">
      {value}
    </span>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <h3 className={cn(SECTION_HEADING, 'mb-1.5 mt-1')}>{children}</h3>;
}

/** Path variables come from `:name` in the URL, so only their values are edited here. */
function PathVariablesTable({
  rows,
  onChange,
}: {
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
}): React.JSX.Element {
  return (
    <div
      role="table"
      aria-label="Path variables"
      className="overflow-hidden rounded-lg border border-border"
    >
      {rows.map((row) => (
        <div
          key={row.id}
          role="row"
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] border-b border-border last:border-b-0"
        >
          <span className="truncate px-2.5 py-2 font-mono text-xs text-muted-foreground">
            :{row.key}
          </span>
          <input
            aria-label={`Value of ${row.key}`}
            value={row.value}
            placeholder="Value"
            spellCheck={false}
            onChange={(event) =>
              onChange(rows.map((r) => (r.id === row.id ? { ...r, value: event.target.value } : r)))
            }
            className={cn(
              'h-8 w-full min-w-0 border-l border-border bg-transparent px-2.5 font-mono text-xs outline-none placeholder:text-muted-foreground/60 focus-visible:bg-accent/40',
            )}
          />
        </div>
      ))}
    </div>
  );
}
