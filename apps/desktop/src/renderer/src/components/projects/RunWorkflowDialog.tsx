import type { GithubWorkflowDispatchInput, GithubWorkflowInfo } from '@shared/apiTypes';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { GitBranch, Spinner, Tag } from '@/components/icons';
import { useAutoFixActions } from '@/components/pipelines/autoFix/useAutoFix';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
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
import { OverflowScroll } from '@/components/ui/overflow-scroll';
import { queryKeys } from '@/lib/queryKeys';
import { confirmDialog } from '@/stores/confirmStore';

function defaultValues(inputs: GithubWorkflowDispatchInput[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const input of inputs) {
    if (input.default) values[input.name] = input.default;
    else if (input.type === 'boolean') values[input.name] = 'false';
    else if (input.type === 'choice') values[input.name] = input.options[0] ?? '';
    else values[input.name] = '';
  }
  return values;
}

/** The filled-in inputs, spelled out in the confirmation so nothing gets dispatched unseen. */
function inputSummary(
  fields: GithubWorkflowDispatchInput[],
  values: Record<string, string>,
): string {
  const filled = fields
    .map((field) => [field.name, (values[field.name] ?? '').trim()] as const)
    .filter(([, value]) => value !== '')
    .map(([name, value]) => `${name}=${value.length > 60 ? `${value.slice(0, 60)}…` : value}`);
  return filled.length > 0 ? ` Inputs: ${filled.join(', ')}.` : '';
}

function InputField({
  field,
  value,
  onChange,
}: {
  field: GithubWorkflowDispatchInput;
  value: string;
  onChange: (next: string) => void;
}): React.JSX.Element {
  const id = `workflow-input-${field.name}`;

  if (field.type === 'boolean') {
    return (
      <div className="flex items-start gap-2.5">
        <Checkbox
          id={id}
          className="mt-0.5"
          checked={value === 'true'}
          onCheckedChange={(checked) => onChange(checked === true ? 'true' : 'false')}
        />
        <div className="min-w-0">
          <Label htmlFor={id} className="cursor-pointer font-mono text-xs">
            {field.name}
          </Label>
          {field.description ? (
            <p className="mt-1 text-xs text-muted-foreground">{field.description}</p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="font-mono text-xs">
        {field.name}
        {field.required ? <span className="ml-1 text-destructive">*</span> : null}
      </Label>
      {field.description ? (
        <p className="text-xs text-muted-foreground">{field.description}</p>
      ) : null}
      {field.type === 'choice' && field.options.length > 0 ? (
        <Combobox
          options={field.options.map((option) => ({ value: option, label: option }))}
          value={value}
          onChange={onChange}
          placeholder="Pick a value…"
        />
      ) : (
        <Input
          id={id}
          type={field.type === 'number' ? 'number' : 'text'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.required ? 'Required' : 'Optional'}
        />
      )}
    </div>
  );
}

/** GitHub's "Run workflow" button: pick a ref, fill the declared inputs, start a run. */
export function RunWorkflowDialog({
  open,
  onOpenChange,
  repo,
  workflow,
  projectId,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repo: string;
  workflow: GithubWorkflowInfo;
  /** The project the repo is checked out in. Without it, auto-fix has nowhere to fix the run. */
  projectId?: string;
  onStarted: () => void;
}): React.JSX.Element {
  const [ref, setRef] = useState('');
  const [autoFix, setAutoFix] = useState(false);
  const autoFixActions = useAutoFixActions();
  const [values, setValues] = useState<Record<string, string>>(() =>
    defaultValues(workflow.dispatchInputs),
  );

  const refsQuery = useQuery({
    queryKey: queryKeys.pipelineRefs(repo),
    queryFn: () => window.runova.pipelines.refs(repo),
    enabled: open,
    staleTime: 60_000,
  });

  const refs = refsQuery.data?.ok ? refsQuery.data : null;
  const defaultBranch = refs?.defaultBranch ?? '';

  // Reopening the dialog starts from the workflow's own defaults again, not from whatever was
  // typed the last time around. Only on the closed -> open edge though: the status query behind
  // `workflow` refetches on a timer, and resetting on that would wipe what is being typed.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) setValues(defaultValues(workflow.dispatchInputs));
    wasOpen.current = open;
  }, [open, workflow.dispatchInputs]);

  useEffect(() => {
    if (open && !ref && defaultBranch) setRef(defaultBranch);
  }, [open, ref, defaultBranch]);

  const refOptions = useMemo<ComboboxOption[]>(() => {
    if (!refs) return [];
    const branches = refs.branches.map((name) => ({
      value: name,
      label: name,
      keywords: ['branch'],
      icon: <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />,
    }));
    const seen = new Set(refs.branches);
    const tags = refs.tags
      .filter((name) => !seen.has(name))
      .map((name) => ({
        value: name,
        label: name,
        keywords: ['tag'],
        icon: <Tag className="h-3 w-3 shrink-0 text-muted-foreground" />,
      }));
    return [...branches, ...tags];
  }, [refs]);

  // A fix is pushed to the branch the run was on, which a tag is not.
  const canAutoFix = Boolean(projectId) && Boolean(refs?.branches.includes(ref));

  const missing = workflow.dispatchInputs.filter(
    (field) => field.required && !(values[field.name] ?? '').trim(),
  );

  const runMutation = useMutation({
    mutationFn: () =>
      window.runova.pipelines.dispatch({
        repo,
        workflowId: workflow.id,
        ref,
        inputs: values,
      }),
    onSuccess: (result) => {
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success(`${workflow.name} started on ${ref}.`);
      // GitHub has not created the run yet, so auto-fix waits for the first one dispatched now.
      if (autoFix && canAutoFix && projectId) {
        void autoFixActions.start({
          projectId,
          repo,
          workflowId: workflow.id,
          workflowName: workflow.name,
          branch: ref,
        });
      }
      onOpenChange(false);
      onStarted();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : 'Could not start that workflow.');
    },
  });

  async function handleRun(): Promise<void> {
    const confirmed = await confirmDialog({
      title: `Run ${workflow.name} on ${ref}?`,
      description: `This starts a real run on ${repo} and it will do whatever the workflow does, including anything it publishes.${inputSummary(workflow.dispatchInputs, values)}`,
      confirmLabel: 'Run workflow',
    });
    if (confirmed) runMutation.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Run {workflow.name}</DialogTitle>
          <DialogDescription>
            Starts this workflow by hand on {repo}, the same as the Run workflow button on GitHub.
          </DialogDescription>
        </DialogHeader>

        <OverflowScroll className="-mx-1 max-h-[min(24rem,50vh)] px-1">
          <div className="space-y-4 py-1">
            <div className="space-y-1.5">
              <Label className="text-xs">Branch or tag</Label>
              {refsQuery.isPending ? (
                <div className="flex h-9 items-center gap-2 text-sm text-muted-foreground">
                  <Spinner className="h-3.5 w-3.5 animate-spin" />
                  Reading branches…
                </div>
              ) : refsQuery.data && !refsQuery.data.ok ? (
                <p className="text-sm text-destructive">{refsQuery.data.error}</p>
              ) : (
                <Combobox
                  options={refOptions}
                  value={ref}
                  onChange={setRef}
                  placeholder="Pick a branch or tag…"
                  searchPlaceholder="Search refs…"
                  emptyText="No matching branch or tag."
                />
              )}
            </div>

            {canAutoFix ? (
              <div className="flex items-start gap-2.5 rounded-lg bg-foreground/[0.03] p-2.5 ring-1 ring-inset ring-foreground/[0.06]">
                <Checkbox
                  id="run-workflow-auto-fix"
                  checked={autoFix}
                  onCheckedChange={(checked) => setAutoFix(checked === true)}
                  aria-describedby="run-workflow-auto-fix-hint"
                  className="mt-0.5"
                />
                <div className="space-y-0.5">
                  <Label htmlFor="run-workflow-auto-fix" className="cursor-pointer text-xs">
                    Auto-fix if it fails
                  </Label>
                  <p id="run-workflow-auto-fix-hint" className="text-[11px] text-muted-foreground">
                    {`An agent fixes the failure and Runova pushes the fix to ${ref}, using the CLI from Settings.`}
                  </p>
                </div>
              </div>
            ) : null}

            {workflow.dispatchInputs.map((field) => (
              <InputField
                key={field.name}
                field={field}
                value={values[field.name] ?? ''}
                onChange={(next) => setValues((prev) => ({ ...prev, [field.name]: next }))}
              />
            ))}
          </div>
        </OverflowScroll>

        <DialogFooter>
          <Button variant="soft" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!ref || missing.length > 0 || runMutation.isPending}
            onClick={() => void handleRun()}
          >
            {runMutation.isPending ? <Spinner className="h-3.5 w-3.5 animate-spin" /> : null}
            {missing.length > 0 ? `Fill in ${missing[0].name}` : 'Run workflow'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
