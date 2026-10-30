import { RECAPTCHA_FREE_ASSESSMENTS, type RecaptchaProjectRef } from '@shared/deployRecaptchaTypes';
import { useQuery } from '@tanstack/react-query';
import { ChartSimple } from '@/components/icons';
import { GLASS_CARD } from '@/components/pageKit';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';

type Tone = 'primary' | 'warning' | 'destructive';

const BAR: Record<Tone, string> = {
  primary: 'bg-primary',
  warning: 'bg-warning',
  destructive: 'bg-destructive',
};

function toneOf(assessments: number): Tone {
  if (assessments >= RECAPTCHA_FREE_ASSESSMENTS) return 'destructive';
  if (assessments >= RECAPTCHA_FREE_ASSESSMENTS * 0.8) return 'warning';
  return 'primary';
}

const NOTE_TEXT: Record<Tone, string> = {
  primary: 'text-muted-foreground',
  warning: 'text-warning',
  destructive: 'text-destructive',
};

const NOTE: Record<Tone, string> = {
  primary:
    'Google gives 10,000 free checks a month, shared by every project in your Google organization.',
  warning:
    'Close to the free limit. Google gives 10,000 a month, shared by every project in your Google organization.',
  destructive:
    'Past the free limit. Without billing on the project, Google refuses more checks until next month.',
};

/**
 * This month's checks in the project, against Google's free allowance (E40). Google counts the
 * allowance across the whole organization, so the note says so; the number here is this project's.
 */
export function UsageCard({ project }: { project: RecaptchaProjectRef }): React.JSX.Element {
  const usage = useQuery({
    queryKey: queryKeys.recaptchaUsage(project.accountId, project.projectId),
    queryFn: () => window.runova.deployRecaptcha.usage(project),
    staleTime: 5 * 60_000,
  });

  if (usage.isPending) {
    return (
      <div className={cn(GLASS_CARD, 'space-y-2 px-4 py-3')} aria-busy="true">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-1.5 w-full rounded-full" />
      </div>
    );
  }
  if (usage.isError) {
    return (
      <p className={cn(GLASS_CARD, 'px-4 py-3 text-xs text-muted-foreground')}>
        Usage is not available right now. Your keys work as usual.
      </p>
    );
  }

  const { assessments } = usage.data;
  const tone = toneOf(assessments);
  const capped = Math.min(assessments, RECAPTCHA_FREE_ASSESSMENTS);
  return (
    <div className={cn(GLASS_CARD, 'space-y-2 px-4 py-3')}>
      <div className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
        <ChartSimple className="h-3.5 w-3.5 self-center text-muted-foreground" />
        <span className="text-sm font-semibold tabular-nums text-foreground">
          {assessments.toLocaleString('en-US')}
        </span>
        <span className="text-xs text-muted-foreground">
          of {RECAPTCHA_FREE_ASSESSMENTS.toLocaleString('en-US')} free checks this month
        </span>
      </div>
      <div
        role="meter"
        aria-label="Checks this month"
        aria-valuemin={0}
        aria-valuemax={RECAPTCHA_FREE_ASSESSMENTS}
        aria-valuenow={capped}
        data-tone={tone}
        className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/[0.08]"
      >
        <div
          className={cn('h-full rounded-full transition-[width] duration-500', BAR[tone])}
          style={{ width: `${(capped / RECAPTCHA_FREE_ASSESSMENTS) * 100}%` }}
        />
      </div>
      <p className={cn('text-xs', NOTE_TEXT[tone])}>{NOTE[tone]}</p>
    </div>
  );
}
