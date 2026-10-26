import type { FilesConflictChoice, FilesPlanNotice } from '@shared/deployFilesTypes';
import { useRef, useState } from 'react';
import { CircleInfo, CloudUpload, Server, Spinner, TriangleAlert } from '@/components/icons';
import { Chip, GLASS_CARD, Notice, SECTION_WELL } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { FilesReview } from '@/stores/deployFilesRunStore';
import { ConflictsCard, REVIEW_PAGE, rovingRadio } from './ConflictsCard';
import { NOTICE_TEXT, plural } from './copy';
import { canContinue, reviewConflicts } from './deployPlan';
import { SelectBox } from './SelectBox';

/**
 * What the check of the server found before anything is sent (E23): conflicts to settle, a first
 * deploy over a folder that already has files, files gone from the server, and notes that need
 * no choice. Continue stays off until every conflict has an answer.
 */

/** Paths of a long list shown before "and N more". */
const LIST_LIMIT = 10;

export interface DeployReviewProps {
  review: FilesReview;
  /** The paths that go (the ticked files), so only their conflicts are asked about. */
  allowed: ReadonlySet<string>;
  onChooseConflicts: (choices: Record<string, FilesConflictChoice>) => void;
  onChooseFirstDeploy: (choice: 'adoptSameSize' | 'overwrite') => void;
  onReupload: (paths: string[]) => void;
  onContinue: () => void;
  onCancel: () => void;
  /** The deploy call is going out. */
  continuing?: boolean;
}

export function DeployReview({
  review,
  allowed,
  onChooseConflicts,
  onChooseFirstDeploy,
  onReupload,
  onContinue,
  onCancel,
  continuing = false,
}: DeployReviewProps): React.JSX.Element {
  const { plan } = review;
  const conflicts = reviewConflicts(review, allowed);
  const ready = canContinue(review, allowed);
  const notices = plan.notices.filter((notice) => notice !== 'clockShift');
  const clockShift = plan.clockShiftHours !== null || plan.notices.includes('clockShift');

  return (
    <section aria-label="Review before deploying" className={cn(GLASS_CARD, 'space-y-3 p-4')}>
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary [&_svg]:size-4">
          <Server />
        </div>
        <div className="min-w-0 flex-1 space-y-0.5 pt-0.5">
          <h3 className="text-sm font-semibold leading-tight">Checked the server</h3>
          <p className="text-xs text-muted-foreground">
            A few things need a look before anything is sent.
          </p>
        </div>
      </div>

      {plan.massDelete && (
        <Notice tone="destructive" size="sm" role="alert">
          <p className="font-medium">
            This deploy deletes {plural(plan.deleteCount, 'file')} from the server.
          </p>
          <p className="mt-0.5 text-muted-foreground">
            That's more than usual, so Deploy on save would not do it on its own. Check that the
            deploy folder is the right one and that the list below is what you meant.
          </p>
        </Notice>
      )}

      <ConflictsCard
        conflicts={conflicts}
        choices={review.conflicts}
        onChoose={onChooseConflicts}
        disabled={continuing}
      />

      {plan.firstDeploy && (
        <FirstDeployCard
          existing={plan.firstDeploy.existing}
          sameSize={plan.firstDeploy.sameSize}
          value={review.firstDeploy}
          onChange={onChooseFirstDeploy}
          disabled={continuing}
        />
      )}

      {plan.missingOnServer.length > 0 && (
        <MissingOnServer
          paths={plan.missingOnServer}
          chosen={review.reupload}
          onChange={onReupload}
          disabled={continuing}
        />
      )}

      {clockShift && (
        <Notice size="sm" icon={CircleInfo}>
          {NOTICE_TEXT.clockShift(plan.clockShiftHours)}
        </Notice>
      )}
      {notices.map((notice) => (
        <Notice key={notice} size="sm" icon={CircleInfo}>
          {NOTICE_TEXT[notice as Exclude<FilesPlanNotice, 'clockShift'>]}
        </Notice>
      ))}

      {plan.serverOnlyDrift.length > 0 && (
        <div className={cn(SECTION_WELL, 'space-y-1.5')}>
          <p className="text-xs font-medium">
            {plural(plan.serverOnlyDrift.length, 'file')} changed on the server only
          </p>
          <p className="text-[11px] text-muted-foreground">
            You didn't change these here, so this deploy leaves them as they are on the server.
          </p>
          <PathList label="Changed on the server only" paths={plan.serverOnlyDrift} />
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
        {!ready && (
          <p className="mr-auto flex items-center gap-1.5 text-xs text-warning">
            <TriangleAlert className="h-3.5 w-3.5" />
            {plan.firstDeploy && !review.firstDeploy
              ? 'Choose how to treat the files already on the server first.'
              : 'Choose what to do with each conflict first.'}
          </p>
        )}
        <Button size="sm" variant="ghost" disabled={continuing} onClick={onCancel}>
          Back
        </Button>
        <Button size="sm" disabled={!ready || continuing} onClick={onContinue}>
          {continuing ? <Spinner className="motion-safe:animate-spin" /> : <CloudUpload />}
          {continuing ? 'Starting…' : 'Continue'}
        </Button>
      </div>
    </section>
  );
}

function PathList({ label, paths }: { label: string; paths: readonly string[] }) {
  const shown = paths.slice(0, LIST_LIMIT);
  return (
    <>
      <ul aria-label={label} className="space-y-0.5">
        {shown.map((path) => (
          <li key={path} className="truncate font-mono text-[11px] text-foreground/85">
            {path}
          </li>
        ))}
      </ul>
      {paths.length > shown.length && (
        <p className="text-[11px] text-muted-foreground">and {paths.length - shown.length} more</p>
      )}
    </>
  );
}

type FirstDeployChoice = 'adoptSameSize' | 'overwrite';

const FIRST_DEPLOY_ORDER: readonly FirstDeployChoice[] = ['adoptSameSize', 'overwrite'];

function FirstDeployCard({
  existing,
  sameSize,
  value,
  onChange,
  disabled,
}: {
  existing: number;
  sameSize: number;
  value: 'adoptSameSize' | 'overwrite' | null;
  onChange: (value: 'adoptSameSize' | 'overwrite') => void;
  disabled: boolean;
}): React.JSX.Element {
  const refs = useRef<Partial<Record<FirstDeployChoice, HTMLButtonElement | null>>>({});
  const options = [
    {
      value: 'adoptSameSize' as const,
      title: 'Skip files with the same size',
      recommended: true,
      detail: `The ${plural(sameSize, 'file')} with the same size as here count as already deployed. Only the others are uploaded.`,
    },
    {
      value: 'overwrite' as const,
      title: 'Overwrite all',
      recommended: false,
      detail:
        "Every file is uploaded, replacing the server's copy. Slower, but nothing is guessed.",
    },
  ];
  return (
    <section aria-label="First deploy" className={cn(SECTION_WELL, 'space-y-2.5')}>
      <div className="space-y-0.5">
        <h4 className="text-sm font-medium">
          This folder on the server already has {plural(existing, 'file')}
        </h4>
        <p className="text-xs text-muted-foreground">
          This is the first deploy of this site, so Runova doesn't know which of them came from your
          folder. Files only on the server are never touched either way.
        </p>
      </div>
      <div
        role="radiogroup"
        aria-label="Files already on the server"
        className="grid gap-1.5 sm:grid-cols-2"
      >
        {options.map((option, index) => {
          const active = value === option.value;
          return (
            <button
              key={option.value}
              ref={(node) => {
                refs.current[option.value] = node;
              }}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              {...rovingRadio({
                order: FIRST_DEPLOY_ORDER,
                index,
                value,
                onChange,
                focus: (next) => refs.current[next]?.focus(),
              })}
              onClick={() => onChange(option.value)}
              className={cn(
                'flex cursor-pointer items-start gap-2.5 rounded-lg p-2.5 text-left ring-1 ring-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
                active
                  ? 'bg-primary/8 ring-primary/40'
                  : 'bg-background/40 ring-foreground/[0.08] hover:ring-foreground/20',
              )}
            >
              <span
                aria-hidden
                className={cn(
                  'mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full ring-[1.5px] ring-inset',
                  active ? 'ring-primary' : 'ring-foreground/30',
                )}
              >
                {active && <span className="h-1.5 w-1.5 rounded-full bg-primary" />}
              </span>
              <span className="min-w-0 space-y-0.5">
                <span className="flex flex-wrap items-center gap-1.5 text-xs font-medium">
                  {option.title}
                  {option.recommended && <Chip tone="primary">Recommended</Chip>}
                </span>
                <span className="block text-[11px] leading-relaxed text-muted-foreground">
                  {option.detail}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function MissingOnServer({
  paths,
  chosen,
  onChange,
  disabled,
}: {
  paths: readonly string[];
  chosen: readonly string[];
  onChange: (paths: string[]) => void;
  disabled: boolean;
}): React.JSX.Element {
  const [limit, setLimit] = useState(REVIEW_PAGE);
  const picked = new Set(chosen);
  const shown = paths.slice(0, limit);
  const hidden = paths.length - shown.length;
  return (
    <div className={cn(SECTION_WELL, 'space-y-2')}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <p className="text-xs font-medium">
            {plural(paths.length, 'file')} from your last deploy {paths.length === 1 ? 'is' : 'are'}{' '}
            gone from the server
          </p>
          <p className="text-[11px] text-muted-foreground">
            You didn't change them here. Tick the ones to upload again; the rest stay as they are.
          </p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button size="xs" variant="soft" disabled={disabled} onClick={() => onChange([...paths])}>
            Upload all again
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled || chosen.length === 0}
            onClick={() => onChange([])}
          >
            Upload none
          </Button>
        </div>
      </div>
      <ul aria-label="Missing on the server" className="space-y-0.5">
        {shown.map((path) => (
          <li key={path}>
            <label className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 hover:bg-foreground/[0.04]">
              <SelectBox
                checked={picked.has(path)}
                disabled={disabled}
                aria-label={`Upload ${path} again`}
                onCheckedChange={(checked) =>
                  onChange(
                    checked === true ? [...chosen, path] : chosen.filter((one) => one !== path),
                  )
                }
              />
              <span className="min-w-0 truncate font-mono text-[11px]">{path}</span>
            </label>
          </li>
        ))}
      </ul>
      {hidden > 0 && (
        <Button
          size="sm"
          variant="soft"
          className="w-full"
          onClick={() => setLimit((current) => current + REVIEW_PAGE)}
        >
          Show {Math.min(hidden, REVIEW_PAGE)} more
        </Button>
      )}
    </div>
  );
}
