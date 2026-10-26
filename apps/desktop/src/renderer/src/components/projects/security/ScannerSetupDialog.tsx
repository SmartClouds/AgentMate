import type { SecurityScannerId, SecurityScannerSettings } from '@runova/core';
import {
  CODEQL_LANGUAGES,
  codeqlLanguageNeedsBuild,
  getSecurityScanner,
  SEMGREP_RULESETS,
  STRIX_DEFAULT_MODEL,
} from '@runova/core';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Per-scanner setup. Only three of the six need anything: Semgrep picks a ruleset, CodeQL needs a
 * language (and a build command for compiled ones), SonarQube and Strix need credentials.
 *
 * Secrets typed here go to settings.json in plaintext, which is the same convention the Token
 * Usage page's API keys already use. They are handed to scanners through the environment rather
 * than the command line, and are stripped out of logs and reports before either is shown or
 * copied.
 */
export function ScannerSetupDialog({
  scannerId,
  config,
  projectName,
  onClose,
  onSave,
  onSuggestLanguage,
}: {
  scannerId: SecurityScannerId | null;
  config: SecurityScannerSettings;
  projectName: string;
  onClose: () => void;
  onSave: (patch: SecurityScannerSettings) => void;
  onSuggestLanguage: () => Promise<string | null>;
}): React.JSX.Element {
  // Seeded once. The caller keys this component by scanner id, so opening a different scanner
  // mounts a fresh dialog with that scanner's saved settings. Syncing from `config` on every
  // render instead would wipe what the user is typing, since the query hands back a new object
  // each time it resolves.
  const [draft, setDraft] = useState<SecurityScannerSettings>(config);
  const [suggesting, setSuggesting] = useState(false);

  const scanner = scannerId ? getSecurityScanner(scannerId) : null;

  function patch(update: Partial<SecurityScannerSettings>): void {
    setDraft((current) => ({ ...current, ...update }));
  }

  async function suggest(): Promise<void> {
    setSuggesting(true);
    try {
      const language = await onSuggestLanguage();
      if (language) patch({ codeqlLanguage: language });
    } finally {
      setSuggesting(false);
    }
  }

  return (
    <Dialog open={scannerId !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set up {scanner?.name ?? 'scanner'}</DialogTitle>
          <DialogDescription>These settings apply to {projectName} only.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {scannerId === 'semgrep' && (
            <div className="space-y-1.5">
              <Label>Ruleset</Label>
              <Combobox
                value={draft.semgrepConfig ?? 'auto'}
                onChange={(value) => patch({ semgrepConfig: value })}
                options={SEMGREP_RULESETS}
                placeholder="Choose a ruleset"
              />
              <p className="text-xs text-muted-foreground">
                Auto downloads rules from semgrep.dev on every scan. Pick one of the p/ packs to
                stay offline. Runova always runs Semgrep with metrics off.
              </p>
            </div>
          )}

          {scannerId === 'codeql' && (
            <>
              <div className="space-y-1.5">
                <Label>Language</Label>
                <div className="flex gap-2">
                  <Combobox
                    className="flex-1"
                    value={draft.codeqlLanguage ?? ''}
                    onChange={(value) => patch({ codeqlLanguage: value })}
                    options={CODEQL_LANGUAGES.map((l) => ({ value: l.value, label: l.label }))}
                    placeholder="Choose a language"
                  />
                  <Button
                    variant="soft"
                    className="h-9"
                    disabled={suggesting}
                    onClick={() => void suggest()}
                  >
                    {suggesting ? 'Looking...' : 'Detect'}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  CodeQL analyzes one language per run, so pick the one that matters most here.
                </p>
              </div>

              {codeqlLanguageNeedsBuild(draft.codeqlLanguage ?? null) && (
                <div className="space-y-1.5">
                  <Label>Build command</Label>
                  <Input
                    value={draft.codeqlBuildCommand ?? ''}
                    onChange={(event) => patch({ codeqlBuildCommand: event.target.value })}
                    placeholder="e.g. dotnet build, mvn -B clean install"
                  />
                  <p className="text-xs text-muted-foreground">
                    This language is compiled, so CodeQL has to watch a real build to see the code.
                    Without a command it finds nothing and stops.
                  </p>
                </div>
              )}
            </>
          )}

          {scannerId === 'sonarqube' && (
            <>
              <div className="space-y-1.5">
                <Label>Server URL</Label>
                <Input
                  value={draft.sonarUrl ?? 'http://localhost:9000'}
                  onChange={(event) => patch({ sonarUrl: event.target.value })}
                  placeholder="http://localhost:9000"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Project key</Label>
                <Input
                  value={draft.sonarProjectKey ?? ''}
                  onChange={(event) => patch({ sonarProjectKey: event.target.value })}
                  placeholder="my-project"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Token</Label>
                <Input
                  type="password"
                  value={draft.sonarToken ?? ''}
                  onChange={(event) => patch({ sonarToken: event.target.value })}
                  placeholder="squ_..."
                />
                <p className="text-xs text-muted-foreground">
                  Create one in SonarQube under My Account &gt; Security. It is stored in this
                  machine's settings file and never appears in a scan report.
                </p>
              </div>
            </>
          )}

          {scannerId === 'strix' && (
            <>
              <div className="space-y-1.5">
                <Label>Model</Label>
                <Input
                  value={draft.strixModel ?? STRIX_DEFAULT_MODEL}
                  onChange={(event) => patch({ strixModel: event.target.value })}
                  placeholder={STRIX_DEFAULT_MODEL}
                />
              </div>
              <div className="space-y-1.5">
                <Label>LLM API key</Label>
                <Input
                  type="password"
                  value={draft.strixApiKey ?? ''}
                  onChange={(event) => patch({ strixApiKey: event.target.value })}
                  placeholder="sk-..."
                />
                <p className="text-xs text-muted-foreground">
                  Strix drives a model to find and prove vulnerabilities, so a run bills against
                  this key. It is stored in this machine's settings file and never appears in a scan
                  report.
                </p>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onSave(draft);
              onClose();
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
