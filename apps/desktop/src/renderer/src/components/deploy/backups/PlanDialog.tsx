import { coreErrorMessage } from '@shared/coreErrors';
import {
  type BackupSchedule,
  cronOf,
  keepSentence,
  scheduleOf,
  scheduleProblem,
  WEEKDAYS,
} from '@shared/deploy/backupSchedule';
import type {
  BackupDestinationInfo,
  BackupPlanInfo,
  BackupPlanPreview,
} from '@shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import type { DeployServer } from '@shared/deployTypes';
import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, Spinner, TriangleAlert } from '@/components/icons';
import { Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { dateAndTime, localTimeZone, shortDate, timeZones } from './format';

/**
 * Adding or changing a backup plan (E28): a schedule from presets or a cron line of its own, a
 * time zone, the destinations, and how many backups to keep. The core previews it live: the next
 * runs, how many backups stay, about how much room they take and when the oldest goes.
 */

type Kind = BackupSchedule['kind'];

const KINDS: { value: Kind; label: string }[] = [
  { value: 'hours', label: 'Every few hours' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly on a day' },
  { value: 'cron', label: 'Custom cron line' },
];

const PREVIEW_DELAY_MS = 350;

interface Form {
  name: string;
  enabled: boolean;
  kind: Kind;
  every: string;
  time: string;
  day: number;
  cron: string;
  timeZone: string;
  destinationIds: string[];
  keepLast: string;
  keepDays: string;
}

function formOf(plan: BackupPlanInfo | null): Form {
  const schedule = plan
    ? scheduleOf(plan.cron)
    : ({ kind: 'daily', time: '03:00' } as BackupSchedule);
  return {
    name: plan?.name ?? '',
    enabled: plan?.enabled ?? true,
    kind: schedule.kind,
    every: schedule.kind === 'hours' ? String(schedule.every) : '6',
    time: schedule.kind === 'daily' || schedule.kind === 'weekly' ? schedule.time : '03:00',
    day: schedule.kind === 'weekly' ? schedule.day : 0,
    cron: plan?.cron ?? '0 3 * * *',
    timeZone: plan?.timeZone ?? localTimeZone(),
    destinationIds: plan?.destinationIds ?? [],
    keepLast: String(plan?.keepLast ?? 7),
    keepDays: plan?.keepDays ? String(plan.keepDays) : '',
  };
}

function scheduleFrom(form: Form): BackupSchedule {
  switch (form.kind) {
    case 'hours':
      return { kind: 'hours', every: Number(form.every) };
    case 'daily':
      return { kind: 'daily', time: form.time.trim() };
    case 'weekly':
      return { kind: 'weekly', day: form.day, time: form.time.trim() };
    case 'cron':
      return { kind: 'cron', cron: form.cron };
  }
}

function wholeNumber(text: string): number | null {
  return /^\d{1,4}$/.test(text.trim()) ? Number(text.trim()) : null;
}

export function PlanDialog({
  server,
  plan,
  destinations,
  open,
  onOpenChange,
  onSaved,
}: {
  server: DeployServer;
  plan: BackupPlanInfo | null;
  destinations: BackupDestinationInfo[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}): React.JSX.Element {
  const [form, setForm] = useState<Form>(() => formOf(plan));
  const [preview, setPreview] = useState<BackupPlanPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewProblem, setPreviewProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const zones = useMemo(() => timeZones().map((zone) => ({ value: zone, label: zone })), []);

  useEffect(() => {
    if (!open) return;
    setForm(formOf(plan));
    setPreview(null);
    setPreviewProblem(null);
    setProblem(null);
  }, [open, plan]);

  const set = <K extends keyof Form>(key: K, value: Form[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const schedule = scheduleFrom(form);
  const issue = scheduleProblem(schedule);
  const cron = cronOf(schedule);
  const keepLast = wholeNumber(form.keepLast);
  const keepDays = form.keepDays.trim() === '' ? undefined : wholeNumber(form.keepDays);
  const keepIssue =
    keepLast === null || keepLast < 1 || keepLast > 1000
      ? 'Keep 1 to 1000 backups.'
      : keepDays === null || (keepDays !== undefined && (keepDays < 1 || keepDays > 3650))
        ? 'Leave the days empty, or keep 1 to 3650 days.'
        : null;

  // The core's preview follows the form, a moment after the typing stops.
  useEffect(() => {
    if (!open || issue || keepIssue || keepLast === null) return;
    let stale = false;
    setPreviewing(true);
    const timer = setTimeout(() => {
      window.agentmat.deployServerBackups
        .previewPlan({
          serverId: server.id,
          preview: {
            ...(plan ? { planId: plan.id } : {}),
            cron,
            timeZone: form.timeZone,
            keepLast,
            ...(keepDays ? { keepDays } : {}),
          },
        })
        .then(
          (answer) => {
            if (stale) return;
            setPreview(answer ?? null);
            setPreviewProblem(null);
          },
          (error: unknown) => {
            if (stale) return;
            setPreview(null);
            setPreviewProblem(coreErrorMessage(error));
          },
        )
        .finally(() => {
          if (!stale) setPreviewing(false);
        });
    }, PREVIEW_DELAY_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [open, issue, keepIssue, cron, form.timeZone, keepLast, keepDays, plan, server.id]);

  const ready =
    !busy &&
    form.name.trim().length > 0 &&
    issue === null &&
    keepIssue === null &&
    form.destinationIds.length > 0 &&
    !preview?.problem;

  async function save(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!ready || keepLast === null) return;
    setBusy(true);
    setProblem(null);
    try {
      await window.agentmat.deployServerBackups.savePlan({
        serverId: server.id,
        plan: {
          ...(plan ? { id: plan.id } : {}),
          name: form.name.trim(),
          enabled: form.enabled,
          cron,
          timeZone: form.timeZone,
          keepLast,
          ...(keepDays ? { keepDays } : {}),
          destinationIds: form.destinationIds,
        },
      });
      onSaved();
      onOpenChange(false);
    } catch (error) {
      setProblem(coreErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const id = (name: string) => `plan-${name}-${server.id}`;
  const toggle = (destinationId: string, on: boolean) =>
    set(
      'destinationIds',
      on
        ? [...form.destinationIds, destinationId]
        : form.destinationIds.filter((one) => one !== destinationId),
    );

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-xl">
        <form className="space-y-4" onSubmit={(event) => void save(event)}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarDays className="h-4 w-4 text-primary" />
              {plan ? `Edit ${plan.name}` : 'New backup plan'}
            </DialogTitle>
            <DialogDescription>
              The plan runs on the server in the time zone you pick, with this app closed too.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor={id('name')}>Name</Label>
              <Input
                id={id('name')}
                value={form.name}
                onChange={(event) => set('name', event.target.value)}
                placeholder="Nightly"
                autoFocus
              />
            </div>
            <div className="flex items-center gap-2 pb-2">
              <Switch
                id={id('enabled')}
                checked={form.enabled}
                onCheckedChange={(value) => set('enabled', value)}
              />
              <Label htmlFor={id('enabled')} className="font-normal">
                On
              </Label>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={id('kind')}>Schedule</Label>
              <Combobox
                id={id('kind')}
                ariaLabel="Schedule"
                options={KINDS}
                value={form.kind}
                onChange={(value) => set('kind', value as Kind)}
                searchable={false}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={id('zone')}>Time zone</Label>
              <Combobox
                id={id('zone')}
                ariaLabel="Time zone"
                options={zones}
                value={form.timeZone}
                onChange={(value) => value && set('timeZone', value)}
                searchPlaceholder="Search time zones"
              />
            </div>
            {form.kind === 'hours' && (
              <div className="space-y-1.5">
                <Label htmlFor={id('every')}>Every how many hours</Label>
                <Input
                  id={id('every')}
                  inputMode="numeric"
                  value={form.every}
                  onChange={(event) => set('every', event.target.value)}
                />
              </div>
            )}
            {form.kind === 'weekly' && (
              <div className="space-y-1.5">
                <Label htmlFor={id('day')}>Day</Label>
                <Combobox
                  id={id('day')}
                  ariaLabel="Day"
                  options={WEEKDAYS.map((day, index) => ({ value: String(index), label: day }))}
                  value={String(form.day)}
                  onChange={(value) => set('day', Number(value))}
                  searchable={false}
                />
              </div>
            )}
            {(form.kind === 'daily' || form.kind === 'weekly') && (
              <div className="space-y-1.5">
                <Label htmlFor={id('time')}>At</Label>
                <Input
                  id={id('time')}
                  value={form.time}
                  onChange={(event) => set('time', event.target.value)}
                  placeholder="03:30"
                  inputMode="numeric"
                  className="font-mono"
                />
              </div>
            )}
            {form.kind === 'cron' && (
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor={id('cron')}>Cron line</Label>
                <Input
                  id={id('cron')}
                  value={form.cron}
                  onChange={(event) => set('cron', event.target.value)}
                  placeholder="minute hour day-of-month month day-of-week"
                  className="font-mono"
                />
              </div>
            )}
          </div>
          {issue && (
            <p className="text-xs text-muted-foreground" role="status">
              {issue}
            </p>
          )}

          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-medium">Destinations</legend>
            {destinations.map((destination) => (
              <div key={destination.id} className="flex items-center gap-2">
                <Checkbox
                  id={id(destination.id)}
                  checked={form.destinationIds.includes(destination.id)}
                  onCheckedChange={(value) => toggle(destination.id, value === true)}
                />
                <Label htmlFor={id(destination.id)} className="font-normal">
                  {destination.name}
                </Label>
              </div>
            ))}
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={id('keep')}>Keep the last</Label>
              <Input
                id={id('keep')}
                inputMode="numeric"
                value={form.keepLast}
                onChange={(event) => set('keepLast', event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={id('days')}>Also delete backups older than (days, optional)</Label>
              <Input
                id={id('days')}
                inputMode="numeric"
                value={form.keepDays}
                onChange={(event) => set('keepDays', event.target.value)}
                placeholder="No limit"
              />
            </div>
          </div>
          {keepIssue && (
            <p className="text-xs text-muted-foreground" role="status">
              {keepIssue}
            </p>
          )}

          <section
            aria-label="Preview"
            className="space-y-2 rounded-xl bg-foreground/[0.03] p-3 text-sm ring-1 ring-inset ring-foreground/[0.07]"
          >
            {previewing && !preview ? (
              <div aria-busy="true" className="space-y-1.5">
                <Skeleton className="h-3.5 w-4/5" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            ) : preview?.problem ? (
              <p role="alert" className="text-destructive">
                {preview.problem}
              </p>
            ) : previewProblem ? (
              <p role="alert" className="text-destructive">
                {previewProblem}
              </p>
            ) : preview ? (
              <>
                <p className="text-foreground">{keepSentence(preview, shortDate)}</p>
                {preview.nextRunsUnixMs.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground">Next runs</p>
                    <ul aria-label="Next runs" className="text-xs text-foreground">
                      {preview.nextRunsUnixMs.slice(0, 5).map((at) => (
                        <li key={at}>{dateAndTime(at)}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                The preview shows here once the schedule makes sense.
              </p>
            )}
          </section>

          <Notice tone="warning" icon={TriangleAlert} className="text-xs">
            Volumes are copied while the apps keep running. A database that is busy at that moment
            may restore in an inconsistent state.
          </Notice>

          {problem && (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="soft"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!ready}>
              {busy && <Spinner className="h-3.5 w-3.5 motion-safe:animate-spin" />}
              Save the plan
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
