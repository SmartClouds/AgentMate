import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Download, ExternalLink, Github, Globe, RefreshCw, Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { closeAbout, openAbout, useAboutStore } from '@/stores/aboutStore';
import { openUpdateDialog, useUpdateStore } from '@/stores/updateStore';
import { AppIcon, VERSION_CHIP } from './AboutCard';
import { PUBLISHER, useUpdateCheck } from './mainNav';
import { SmartCloudsLogo } from './SmartCloudsLogo';

export const SMARTCLOUDS_URL = 'https://smartclouds.co';
/** Runova's own site, the same as `homepage` in package.json. */
export const WEBSITE_URL = 'https://runovahq.com';
/** The repository, the same as `repository` in package.json. */
export const SOURCE_URL = 'https://github.com/SmartClouds/Runova';

/**
 * About Runova: what the app is and where its name comes from, the running version, a way to
 * check for updates, links to the website and the source, and a credit to SmartClouds, who make
 * it. Opened from the sidebar's about card or
 * the top bar's version chip, and mounted once in AppShell.
 */
export function AboutDialog(): React.JSX.Element {
  const open = useAboutStore((s) => s.open);
  const updateDialogOpen = useUpdateStore((s) => s.dialogOpen);

  // Once a check finds something, or "View update" is pressed, the update dialog takes over.
  // About steps aside rather than leaving a second modal stacked under it.
  useEffect(() => {
    if (updateDialogOpen) closeAbout();
  }, [updateDialogOpen]);

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? openAbout() : closeAbout())}>
      {/* .search-panel is unlayered CSS, so its frosted surface, edge and corner replace the
          dialog's default background, border and radius. */}
      <DialogContent className="search-panel max-w-[400px] gap-0 p-0">
        <AboutBody />
      </DialogContent>
    </Dialog>
  );
}

/** The dialog's contents. Radix only renders them while open, so the version query waits too. */
function AboutBody(): React.JSX.Element {
  const { versionText, checking, updatePending, checkForUpdates } = useUpdateCheck();
  // The main process reports "checking" a moment after the call goes out, so the button tracks
  // its own request as well and shows progress from the first click.
  const [requesting, setRequesting] = useState(false);
  const busy = checking || requesting;

  async function runCheck(): Promise<void> {
    if (busy) return;
    setRequesting(true);
    try {
      await checkForUpdates();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't check for updates.");
    } finally {
      setRequesting(false);
    }
  }

  // A plain link would load the page inside the app window, so it goes to the browser instead.
  const openInBrowser =
    (url: string) =>
    (event: React.MouseEvent<HTMLAnchorElement>): void => {
      event.preventDefault();
      void window.runova.shell.openExternal(url);
    };

  return (
    <div className="flex flex-col">
      <div className="relative flex flex-col items-center px-8 pb-6 pt-10 text-center">
        {/* A wide wash of the accent, and a tighter one right behind the icon so it seems lit
            from behind rather than pasted on. */}
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-3 h-32 w-60 -translate-x-1/2 rounded-full bg-primary/15 blur-3xl"
        />
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-12 h-16 w-16 -translate-x-1/2 rounded-full bg-primary/30 blur-2xl"
        />
        <AppIcon size={72} alt="Runova" className="relative" />

        <div className="relative mt-4 flex items-center gap-2">
          {/* It reads as "Runova" on screen, and as "About Runova" to a screen reader. */}
          <DialogTitle aria-label="About Runova" className="text-xl font-semibold tracking-tight">
            Runova
          </DialogTitle>
          {versionText && (
            <span className={cn(VERSION_CHIP, 'h-5 px-2 text-[11px]')}>{versionText}</span>
          )}
        </div>

        {/* The primitive's cn() replaces its own text-sm with the size given here. Only this
            paragraph is the dialog's description; the lines below it are extra. */}
        <DialogDescription className="relative mt-4 text-[13px] leading-relaxed text-muted-foreground">
          Runova is an Agentic Development Environment (ADE) for AI coding agents. Run Claude Code,
          Codex, Cursor, Gemini, Grok, OpenCode or a plain shell side by side in workspace panes.
          The git panel, diffs, editor, tests and pipelines sit right next to them, so a change goes
          from prompt to review to commit without leaving the app.
        </DialogDescription>
        <p className="relative mt-2 text-[13px] leading-relaxed text-muted-foreground">
          The name joins two words: a runway, where launches happen, and a nova, a new star. Your
          ideas take off here.
        </p>
        <p className="relative mt-2 text-[13px] leading-relaxed text-foreground/80">
          It's free and open source under the MIT license.
        </p>

        {/* The update action sits on a row of its own with a fixed minimum width, so the shorter
            "Checking…" label can't move anything while a check runs. The two links share the
            row below it. */}
        <div className="relative mt-6 flex flex-col items-center gap-2">
          {updatePending && !busy ? (
            <Button className="min-w-44" onClick={openUpdateDialog}>
              <Download />
              View update
            </Button>
          ) : (
            <Button
              className="min-w-44"
              onClick={() => void runCheck()}
              // aria-disabled rather than disabled, so focus stays on the button while it works.
              aria-disabled={busy}
              aria-busy={busy}
            >
              {busy ? <Spinner className="motion-safe:animate-spin" /> : <RefreshCw />}
              {busy ? 'Checking…' : 'Check for updates'}
            </Button>
          )}
          {/* The credit at the foot already links to smartclouds.co, so these are Runova's own
              site and its source code. */}
          <div className="flex items-center gap-2">
            <Button variant="soft" asChild>
              <a href={WEBSITE_URL} onClick={openInBrowser(WEBSITE_URL)}>
                <Globe />
                Website
                <span className="sr-only">, opens in your browser</span>
                <ExternalLink className="opacity-70" />
              </a>
            </Button>
            <Button variant="soft" asChild>
              <a href={SOURCE_URL} onClick={openInBrowser(SOURCE_URL)}>
                <Github />
                Source on GitHub
                <span className="sr-only">, opens in your browser</span>
                <ExternalLink className="opacity-70" />
              </a>
            </Button>
          </div>
        </div>

        <p className="relative mt-6 text-xs text-muted-foreground">
          Runova is built and maintained by {PUBLISHER}.
        </p>
      </div>

      {/* A hairline drawn as a fill: the app's global border colour would win over a utility. */}
      <div aria-hidden className="h-px bg-foreground/[0.08]" />
      {/* The maker's credit. It names SmartClouds once, so the copyright beside it only needs
          the year. */}
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <a
          href={SMARTCLOUDS_URL}
          onClick={openInBrowser(SMARTCLOUDS_URL)}
          // An explicit name, so the logo's alt and the word beside it aren't read out twice.
          aria-label={`A product of ${PUBLISHER}, opens in your browser`}
          className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 outline-hidden transition-colors hover:bg-foreground/[0.05] focus-visible:outline-2 focus-visible:outline-ring/60"
        >
          {/* The logo is white and grey and sits straight on the panel. On the light theme a
              thin shadow traces its edge so the cloud doesn't fade into the glass; the dark
              theme only needs a hint of one. */}
          <SmartCloudsLogo
            size="md"
            alt={PUBLISHER}
            className="[filter:drop-shadow(0_0_0.75px_hsl(var(--foreground)/0.55))_drop-shadow(0_1px_2px_hsl(var(--foreground)/0.25))] dark:[filter:drop-shadow(0_1px_1px_hsl(0_0%_0%/0.35))]"
          />

          <span className="flex flex-col text-left">
            <span className="text-[10px] font-medium uppercase leading-tight tracking-wider text-muted-foreground">
              A product of
            </span>
            <span className="text-[13px] font-semibold leading-tight text-foreground">
              {PUBLISHER}
            </span>
          </span>
        </a>
        <p className="px-2 text-xs tabular-nums text-muted-foreground">
          © {new Date().getFullYear()}
        </p>
      </div>
    </div>
  );
}
