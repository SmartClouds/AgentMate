import { coreErrorMessage } from '@shared/coreErrors';
import type {
  NginxProblemInfo,
  SiteInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { useState } from 'react';
import { toast } from 'sonner';
import { MonacoDiffEditor } from '@/components/editor/MonacoDiffEditor';
import { MonacoEditor } from '@/components/editor/MonacoEditor';
import { Code, Lock, Save, Spinner } from '@/components/icons';
import { SECTION_HEADING, SECTION_WELL } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { problemsFor, snippetMarks } from '@/lib/deploy/sites/problems';
import { cn } from '@/lib/utils';
import { FieldError, Section } from './fields';

/**
 * Custom nginx directives for one site, the Owner's alone. The core checks them against its
 * allowlist and answers with the line of anything it refuses, which is marked in the editor.
 * Nothing is saved before the change has been seen as a diff.
 */

type Snippet = 'serverSnippet' | 'locationSnippet';

const SNIPPETS: ReadonlyArray<{ key: Snippet; title: string; description: string }> = [
  {
    key: 'serverSnippet',
    title: 'Server block',
    description: "Added inside the site's server { } block, after the settings above.",
  },
  {
    key: 'locationSnippet',
    title: 'Location block',
    description: 'Added inside location / { }, next to the proxy settings.',
  },
];

export function AdvancedTab({
  serverId,
  site,
  owner,
  applyProblems,
  onSaved,
}: {
  serverId: string;
  /** Undefined until the site is saved for the first time. */
  site: SiteInfo | undefined;
  owner: boolean;
  /** What the last apply refused in this site's snippets. */
  applyProblems: readonly NginxProblemInfo[];
  onSaved: (site: SiteInfo) => void;
}): React.JSX.Element {
  const saved = {
    serverSnippet: site?.serverSnippet ?? '',
    locationSnippet: site?.locationSnippet ?? '',
  };
  const [text, setText] = useState(saved);
  const [problems, setProblems] = useState<NginxProblemInfo[]>([]);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const changed =
    text.serverSnippet !== saved.serverSnippet || text.locationSnippet !== saved.locationSnippet;

  if (!site) {
    return (
      <p className="text-sm text-muted-foreground">
        Save the site first, then add custom directives here.
      </p>
    );
  }
  const placed = problemsFor([...problems, ...applyProblems], 'site', site.settings.id);

  async function save(): Promise<void> {
    if (!site) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await window.runova.deploySites.setSnippets(serverId, {
        siteId: site.settings.id,
        ...(text.serverSnippet ? { serverSnippet: text.serverSnippet } : {}),
        ...(text.locationSnippet ? { locationSnippet: text.locationSnippet } : {}),
      });
      setReviewing(false);
      setProblems(result.problems);
      if (result.problems.length === 0 && result.site) {
        toast.success('Custom directives saved. Apply to put them live.');
        onSaved(result.site);
      }
    } catch (error) {
      setFailure(coreErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      {!owner && (
        <p
          className={cn(
            SECTION_WELL,
            'flex items-center gap-2 px-3 py-2 text-sm text-muted-foreground',
          )}
        >
          <Lock className="h-3.5 w-3.5 shrink-0" />
          Only an Owner can change custom directives, since they reach nginx most directly.
        </p>
      )}
      {SNIPPETS.map((snippet) => {
        const marks = snippetMarks(placed, snippet.key);
        return (
          <Section key={snippet.key} title={snippet.title} description={snippet.description}>
            <MonacoEditor
              value={text[snippet.key]}
              onChange={(value) => setText((current) => ({ ...current, [snippet.key]: value }))}
              language="plaintext"
              readOnly={!owner}
              markers={marks}
              className="min-h-[160px]"
            />
            {marks.map((mark) => (
              <FieldError
                key={`${mark.line}:${mark.message}`}
                message={`Line ${mark.line}: ${mark.message}`}
              />
            ))}
          </Section>
        );
      })}
      {placed
        .filter((problem) => problem.path !== 'serverSnippet' && problem.path !== 'locationSnippet')
        .map((problem) => (
          <FieldError key={problem.path + problem.message} message={problem.message} />
        ))}
      {owner && (
        <div className="flex justify-end">
          <Button type="button" disabled={!changed} onClick={() => setReviewing(true)}>
            <Code className="h-3.5 w-3.5" /> Review the change
          </Button>
        </div>
      )}
      <Dialog open={reviewing} onOpenChange={(open) => !busy && setReviewing(open)}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>Save these directives?</DialogTitle>
            <DialogDescription>
              Saved directives go live with the next apply. nginx keeps running what it has if they
              fail its check.
            </DialogDescription>
          </DialogHeader>
          {SNIPPETS.filter((snippet) => text[snippet.key] !== saved[snippet.key]).map((snippet) => (
            <div key={snippet.key} className="space-y-1">
              <p className={SECTION_HEADING}>{snippet.title}</p>
              <MonacoDiffEditor
                path={`${snippet.key}.conf`}
                original={saved[snippet.key]}
                modified={text[snippet.key]}
                sideBySide
                ignoreWhitespace={false}
                className="h-48"
              />
            </div>
          ))}
          {failure && (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="soft"
              disabled={busy}
              onClick={() => setReviewing(false)}
            >
              Keep editing
            </Button>
            <Button type="button" disabled={busy} onClick={() => void save()}>
              {busy ? (
                <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              Save directives
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
