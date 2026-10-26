import {
  type CatalogInstall,
  catalogInstallFacts,
  checkCatalogUpdate,
  type RenderedCatalogFact,
} from '@runova/core';
import { useState } from 'react';
import { toast } from 'sonner';
import { Copy, Eye, EyeOff, History, Lock, Plug, RefreshCw, Spinner } from '@/components/icons';
import { FOOTER_HAIRLINE } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { type UpdateOffer, updateOffers } from '@/lib/deploy/appStore/format';
import { DeployCard } from '../deployKit';

/**
 * After an install: how to reach the app, with every password and connection string masked
 * until someone asks to see it, and the updates the catalog has for it. Updates are never
 * applied by themselves; each is a new revision of the app, so it rolls back like any other.
 */

async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied.`);
  } catch {
    toast.error(`Could not copy the ${what.toLowerCase()}.`);
  }
}

function FactRow({
  fact,
  showing,
  known,
}: {
  fact: RenderedCatalogFact;
  showing: boolean;
  known: boolean;
}): React.JSX.Element {
  const hidden = fact.sensitive && !showing;
  const canCopy = !fact.sensitive || known;
  const button = (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      aria-label={`Copy ${fact.label}`}
      disabled={!canCopy}
      onClick={() => void copy(fact.value, fact.label)}
    >
      <Copy />
    </Button>
  );
  return (
    <li aria-label={fact.label} className="flex items-center gap-3 py-2">
      <span className="w-36 shrink-0 text-xs text-muted-foreground">{fact.label}</span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5 font-mono text-xs text-foreground">
        {fact.sensitive && <Lock className="h-3 w-3 shrink-0 text-muted-foreground" />}
        <span className="min-w-0 break-all">{hidden ? fact.masked : fact.value}</span>
      </span>
      {canCopy ? (
        <SimpleTooltip label={`Copy ${fact.label.toLowerCase()}`}>{button}</SimpleTooltip>
      ) : (
        <SimpleTooltip label="Reveal the passwords first" wrapTrigger>
          {button}
        </SimpleTooltip>
      )}
    </li>
  );
}

export function PostInstallCard({
  name,
  install,
  secrets,
  canOperate,
  canAdmin,
  revealing,
  busy,
  rollbackTo,
  onReveal,
  onUpdate,
  onRollback,
}: {
  name: string;
  install: CatalogInstall;
  /** The real values: still held right after the install, or revealed from the server. */
  secrets: Record<string, string> | null;
  canOperate: boolean;
  canAdmin: boolean;
  revealing: boolean;
  /** A job runs on the app: updates wait. */
  busy: boolean;
  /** The revision a rollback would bring back, when there is one. */
  rollbackTo: number | null;
  onReveal: () => void;
  onUpdate: (offer: Exclude<UpdateOffer, { kind: 'none' }>) => void;
  onRollback: () => void;
}): React.JSX.Element {
  const [showing, setShowing] = useState(false);
  const facts = catalogInstallFacts(install, secrets);
  const pinned = install.template.versions.find((version) => version.id === install.version);
  const label = pinned?.label ?? `${install.template.name} ${install.version}`;
  const offers = updateOffers(checkCatalogUpdate(install.template, install.installed), label);
  const known = secrets !== null;
  const anySensitive = facts.ok && facts.facts.some((fact) => fact.sensitive);

  return (
    <DeployCard
      icon={<Plug />}
      title={`Connect to ${name}`}
      description={`${label}${install.domain ? ` on ${install.domain}` : ', on this server only'}`}
      actions={
        anySensitive &&
        (known ? (
          <Button size="sm" variant="soft" onClick={() => setShowing((value) => !value)}>
            {showing ? <EyeOff /> : <Eye />}
            {showing ? 'Hide passwords' : 'Show passwords'}
          </Button>
        ) : canAdmin ? (
          <Button
            size="sm"
            variant="soft"
            disabled={revealing}
            onClick={() => {
              setShowing(true);
              onReveal();
            }}
          >
            {revealing ? <Spinner className="motion-safe:animate-spin" /> : <Eye />}
            Reveal passwords
          </Button>
        ) : (
          <p className="max-w-56 text-xs text-muted-foreground">
            Only an Admin can reveal the passwords.
          </p>
        ))
      }
      bodyClassName="space-y-4"
    >
      {facts.ok ? (
        <ul aria-label="Connection details" className="settings-rows">
          {facts.facts.map((fact) => (
            <FactRow key={fact.id} fact={fact} showing={showing && known} known={known} />
          ))}
        </ul>
      ) : (
        <p role="alert" className="text-sm text-destructive">
          {facts.reason}
        </p>
      )}

      <section aria-label="Updates" className={`space-y-2 pt-3 ${FOOTER_HAIRLINE}`}>
        {offers.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Up to date: it runs the images the App Store pins for {label}.
          </p>
        ) : (
          offers.map((offer) =>
            offer.kind === 'none' ? null : (
              <div
                key={offer.kind}
                className="flex flex-wrap items-center gap-3 rounded-xl bg-primary/8 px-3 py-2 ring-1 ring-inset ring-primary/25"
              >
                <RefreshCw className="h-3.5 w-3.5 shrink-0 text-primary" />
                <div className="min-w-0 flex-1 text-sm">
                  <p>{offer.text}</p>
                  {offer.kind === 'digest' && (
                    <p className="font-mono text-[11px] text-muted-foreground">{offer.detail}</p>
                  )}
                  {offer.kind === 'line' && (
                    <p className="text-xs text-muted-foreground">
                      A new release line can change how data is stored. Back up first.
                    </p>
                  )}
                </div>
                {canOperate && (
                  <Button size="sm" disabled={busy} onClick={() => onUpdate(offer)}>
                    {offer.kind === 'digest' ? 'Update' : `Move to ${offer.version.label}`}
                  </Button>
                )}
              </div>
            ),
          )
        )}
        {canOperate && rollbackTo !== null && (
          <Button size="sm" variant="soft" disabled={busy} onClick={onRollback}>
            <History /> Roll back to revision {rollbackTo}
          </Button>
        )}
      </section>
    </DeployCard>
  );
}
