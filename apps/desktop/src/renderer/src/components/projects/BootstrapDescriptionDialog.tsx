import type { Project } from '@runova/core';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { GrammarTextarea } from '@/components/grammar/GrammarTextarea';
import { ArrowLeft, Languages, Wand2 } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { containsPersian } from '@/lib/rtl';

/** What the Bootstrap tab needs to scaffold the project and record the translation. */
export interface BootstrapDescription {
  /** English text written into the generated md files. Empty means "use the defaults". */
  description: string;
  /** The Persian original, when the description was translated. Null otherwise. */
  translatedFrom: string | null;
}

export interface BootstrapDescriptionDialogProps {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (result: BootstrapDescription) => void;
  /** True while the bootstrap itself is running, so the dialog can't be double-submitted. */
  pending?: boolean;
}

/**
 * Collects the project description right before scaffolding, because that
 * description is what fills the Overview sections of the generated md files.
 *
 * Persian input is translated to English first, since agents read these files
 * on every session and they're written in English. The translation is shown for
 * review rather than applied silently, so a bad machine translation never ends
 * up baked into the repo.
 */
export function BootstrapDescriptionDialog({
  project,
  open,
  onOpenChange,
  onConfirm,
  pending = false,
}: BootstrapDescriptionDialogProps): React.JSX.Element {
  const [draft, setDraft] = useState(project.description);
  const [english, setEnglish] = useState('');
  const [step, setStep] = useState<'input' | 'review'>('input');
  const [translating, setTranslating] = useState(false);

  // Re-seed on open only, so a background project refetch can't wipe out typing.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resets dialog state only when `open` changes
  useEffect(() => {
    if (!open) return;
    setDraft(project.description);
    setEnglish('');
    setStep('input');
    setTranslating(false);
  }, [open]);

  const trimmed = draft.trim();
  const needsTranslation = containsPersian(trimmed);

  async function handleContinue(): Promise<void> {
    if (!needsTranslation) {
      onConfirm({ description: trimmed, translatedFrom: null });
      return;
    }

    setTranslating(true);
    try {
      const result = await window.runova.translate.text({ text: trimmed, targetLang: 'en' });
      const translated = result.trim();
      if (!translated) throw new Error('The translation came back empty.');
      setEnglish(translated);
      setStep('review');
    } catch (error) {
      toast.error(
        `Could not translate the description: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    } finally {
      setTranslating(false);
    }
  }

  function handleBootstrap(): void {
    onConfirm({ description: english.trim(), translatedFrom: trimmed });
  }

  const continueLabel = translating
    ? 'Translating…'
    : needsTranslation
      ? 'Translate & continue'
      : trimmed
        ? 'Bootstrap project'
        : 'Bootstrap with default files';

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Describe {project.name}</DialogTitle>
          <DialogDescription>
            {step === 'input'
              ? 'This description fills the Overview sections of the files Runova is about to create. Persian is translated to English first. Leave it empty to scaffold the default template files.'
              : 'Review the English translation before it goes into the generated files. Edit it here if the wording needs fixing.'}
          </DialogDescription>
        </DialogHeader>

        {step === 'input' ? (
          <div className="space-y-2">
            <GrammarTextarea
              autoFocus
              rows={8}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="What does this project do, who is it for, and what should an agent know before touching it?"
              disabled={translating}
            />
            {needsTranslation ? (
              <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Languages className="h-3.5 w-3.5" /> Persian detected, this will be translated to
                English and saved to the project's prompt history.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {trimmed
                  ? 'Saved on the project and written into the generated files.'
                  : 'No description, the default template files will be created.'}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Files that already exist are never overwritten, so a description added after a first
              bootstrap only lands in files this run creates.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Original (Persian)</p>
              <p
                dir="rtl"
                className="max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 text-sm font-vazirmatn"
              >
                {trimmed}
              </p>
            </div>
            <div className="space-y-1.5">
              <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <Languages className="h-3.5 w-3.5" /> English translation
              </p>
              <GrammarTextarea
                rows={7}
                value={english}
                onChange={(e) => setEnglish(e.target.value)}
              />
            </div>
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          {step === 'review' ? (
            <Button variant="ghost" size="sm" disabled={pending} onClick={() => setStep('input')}>
              <ArrowLeft /> Back
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            {step === 'input' ? (
              <Button
                size="sm"
                disabled={translating || pending}
                onClick={() => void handleContinue()}
              >
                {needsTranslation ? <Languages /> : <Wand2 />} {continueLabel}
              </Button>
            ) : (
              <Button size="sm" disabled={!english.trim() || pending} onClick={handleBootstrap}>
                <Wand2 /> {pending ? 'Bootstrapping…' : 'Bootstrap project'}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
