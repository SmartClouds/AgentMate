import type { WpHealthCheck } from '@runova/core';
import type { DeployWordPressWarning } from '@shared/deployWordPressTypes';
import type { WordPressErrorCode } from '@shared/wordpressErrors';
import { CircleCheck, CircleInfo, CircleX, TriangleAlert } from '@/components/icons';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import {
  errorHint,
  FORCEABLE_WARNINGS,
  type OutcomeCopy,
  parseSyntaxErrors,
  WARNING_COPY,
} from './wordpressCopy';

/** Pieces the pull, deploy and new project dialogs share (E21). */

/** A small uppercase heading over one part of a review. */
export function ReviewHeading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <h3 className="select-none px-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">
      {children}
    </h3>
  );
}

export function WarningList({
  warnings,
  acknowledged,
  onAcknowledgedChange,
}: {
  warnings: readonly DeployWordPressWarning[];
  /** Only asked for when a warning is one the site refuses unless the deploy is forced. */
  acknowledged?: boolean;
  onAcknowledgedChange?: (value: boolean) => void;
}): React.JSX.Element | null {
  if (warnings.length === 0) return null;
  const forceable = warnings.some((warning) => FORCEABLE_WARNINGS.has(warning));
  return (
    <section aria-label="Warnings" className="space-y-2">
      <ul className="space-y-1.5">
        {warnings.map((warning) => {
          const copy = WARNING_COPY[warning];
          const strong = FORCEABLE_WARNINGS.has(warning) || warning === 'readOnlyScope';
          return (
            <li
              key={warning}
              className={cn(
                'flex items-start gap-2 rounded-lg px-3 py-2 ring-1 ring-inset',
                strong
                  ? 'bg-warning/[0.07] ring-warning/25'
                  : 'bg-foreground/[0.03] ring-foreground/[0.07]',
              )}
            >
              {strong ? (
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              ) : (
                <CircleInfo className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0">
                <p className="text-sm font-medium">{copy.title}</p>
                <p className="text-xs text-muted-foreground">{copy.detail}</p>
              </div>
            </li>
          );
        })}
      </ul>
      {forceable && onAcknowledgedChange ? (
        <label className="flex cursor-pointer items-start gap-2 px-1 text-sm">
          <Checkbox
            className="mt-0.5"
            checked={acknowledged === true}
            onCheckedChange={(checked) => onAcknowledgedChange(checked === true)}
          />
          <span>
            <span className="font-medium">Deploy these anyway</span>
            <span className="block text-xs text-muted-foreground">
              The site refuses changes like these unless you say so.
            </span>
          </span>
        </label>
      ) : null}
    </section>
  );
}

/** Why a run or a plan failed, with the next step when there is an obvious one. */
export function RunError({
  message,
  code,
}: {
  message: string;
  code: WordPressErrorCode | null;
}): React.JSX.Element {
  const hint = errorHint(code);
  const parsed = code === 'syntaxError' || code === 'conflict' ? parseSyntaxErrors(message) : null;
  const issues = parsed?.issues ?? [];
  return (
    <div
      role="alert"
      className="space-y-2 rounded-lg bg-destructive/[0.07] px-3 py-2.5 ring-1 ring-inset ring-destructive/25"
    >
      <div className="flex items-start gap-2">
        <CircleX className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <div className="min-w-0 space-y-1">
          <p className="whitespace-pre-line break-words text-sm">
            {issues.length > 0 ? parsed?.summary : message}
          </p>
          {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        </div>
      </div>
      {issues.length > 0 ? (
        <ul aria-label={code === 'syntaxError' ? 'Syntax errors' : 'Files'} className="space-y-1">
          {issues.map((issue) => (
            <li
              key={`${issue.path}:${issue.line}:${issue.message}`}
              className="rounded-md bg-background/50 px-2.5 py-1.5 text-xs"
            >
              <span className="font-mono">{issue.path}</span>
              <span className="text-muted-foreground">, line {issue.line}</span>
              <span className="block break-words text-foreground/90">{issue.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function OutcomeBanner({ outcome }: { outcome: OutcomeCopy }): React.JSX.Element {
  const Icon =
    outcome.tone === 'success' ? CircleCheck : outcome.tone === 'warning' ? TriangleAlert : CircleX;
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-2.5 rounded-lg px-3 py-2.5 ring-1 ring-inset',
        outcome.tone === 'success' && 'bg-success/[0.07] ring-success/25',
        outcome.tone === 'warning' && 'bg-warning/[0.07] ring-warning/25',
        outcome.tone === 'error' && 'bg-destructive/[0.07] ring-destructive/25',
      )}
    >
      <Icon
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0',
          outcome.tone === 'success' && 'text-success',
          outcome.tone === 'warning' && 'text-warning',
          outcome.tone === 'error' && 'text-destructive',
        )}
      />
      <div className="min-w-0">
        <p className="text-sm font-medium">{outcome.title}</p>
        <p className="text-sm text-muted-foreground">{outcome.detail}</p>
      </div>
    </div>
  );
}

const CHECK_NAME: Record<WpHealthCheck['name'], string> = {
  home: 'Home page, checked by the site',
  ajaxPing: 'WordPress admin calls',
  external: 'Home page, checked from this computer',
};

export function HealthChecks({ checks }: { checks: readonly WpHealthCheck[] }): React.JSX.Element {
  return (
    <ul aria-label="Health checks" className="space-y-1">
      {checks.map((check) => (
        <li key={check.name} className="flex items-center gap-2 text-xs">
          {check.ok === true ? (
            <CircleCheck className="h-3.5 w-3.5 shrink-0 text-success" />
          ) : check.ok === false ? (
            <CircleX className="h-3.5 w-3.5 shrink-0 text-destructive" />
          ) : (
            <CircleInfo className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="shrink-0">{CHECK_NAME[check.name]}</span>
          <span className="min-w-0 truncate text-muted-foreground">
            {check.ok === null
              ? "couldn't run"
              : check.status !== null
                ? `HTTP ${check.status}`
                : check.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}
