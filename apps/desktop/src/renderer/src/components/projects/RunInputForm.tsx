import {
  fillRunInputs,
  missingRunInputs,
  parseRunInputs,
  runCommandParts,
  runInputLabel,
} from '@runova/core';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Play, TriangleAlert } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { OverflowScroll } from '@/components/ui/overflow-scroll';
import { cn } from '@/lib/utils';

export interface RunInputFormProps {
  /** The command as saved on the project, placeholders and all. */
  command: string;
  /** Called with the finished command, ready to type into the terminal. */
  onRun: (text: string) => void;
  /** Given when the list of commands is one step back, so the form offers Back instead of Cancel. */
  onBack?: () => void;
  onCancel: () => void;
}

/**
 * Asks for the values a run command needs, then shows exactly what will run. Run stays enabled
 * so Enter always gets an answer: a blank required field is named and focused instead.
 */
export function RunInputForm({
  command,
  onRun,
  onBack,
  onCancel,
}: RunInputFormProps): React.JSX.Element {
  const ids = useId();
  const inputs = useMemo(() => parseRunInputs(command), [command]);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      inputs.map((input): [string, string] => [input.name, input.defaultValue ?? '']),
    ),
  );
  const [attempted, setAttempted] = useState(false);
  const [nothingToRun, setNothingToRun] = useState(false);
  const fields = useRef(new Map<string, HTMLInputElement>());

  // Focus and select the first field on mount. Radix only moves focus when the dialog itself
  // opens, so the list-to-form swap inside an open dialog would otherwise leave focus behind.
  useEffect(() => {
    const [first] = inputs;
    if (!first) return;
    const field = fields.current.get(first.name);
    field?.focus();
    field?.select();
  }, [inputs]);

  const missing = missingRunInputs(inputs, values);
  const parts = runCommandParts(command, values);
  const previewId = `${ids}-preview`;
  const previewLabelId = `${ids}-preview-label`;

  function submit(): void {
    const [firstMissing] = missing;
    if (firstMissing) {
      setAttempted(true);
      fields.current.get(firstMissing.name)?.focus();
      return;
    }
    const text = fillRunInputs(command, values);
    if (text === '') {
      setNothingToRun(true);
      return;
    }
    onRun(text);
  }

  return (
    <form
      className="flex min-h-0 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <OverflowScroll className="-mx-1 max-h-[min(22rem,50vh)] px-1">
        <div className="space-y-4 py-1">
          {inputs.map((input, index) => {
            const id = `${ids}-input-${index}`;
            const errorId = `${id}-error`;
            const label = runInputLabel(input.name);
            const showError = attempted && missing.some((item) => item.name === input.name);
            return (
              <div key={input.name} className="space-y-1.5">
                <Label htmlFor={id} className="text-xs font-semibold">
                  {label}
                  {input.required ? null : (
                    <>
                      {' '}
                      <span className="font-normal text-muted-foreground">(optional)</span>
                    </>
                  )}
                </Label>
                <Input
                  id={id}
                  ref={(element) => {
                    if (element) fields.current.set(input.name, element);
                    else fields.current.delete(input.name);
                  }}
                  value={values[input.name] ?? ''}
                  onChange={(event) => {
                    const next = event.target.value;
                    setValues((prev) => ({ ...prev, [input.name]: next }));
                    setNothingToRun(false);
                  }}
                  placeholder={input.required ? 'Required' : 'Optional'}
                  spellCheck={false}
                  aria-invalid={showError}
                  aria-describedby={showError ? errorId : undefined}
                />
                {showError ? (
                  <p
                    id={errorId}
                    role="alert"
                    className="flex items-start gap-1.5 text-xs text-destructive"
                  >
                    <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
                    {label} is required.
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      </OverflowScroll>

      <div
        role="group"
        aria-labelledby={previewLabelId}
        className="space-y-1.5 rounded-lg border border-border/70 bg-muted/30 px-3 py-2.5"
      >
        <p
          id={previewLabelId}
          className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
        >
          What will run
        </p>
        <p id={previewId} dir="ltr" className="break-all font-mono text-xs leading-relaxed">
          {parts.map((part, index) =>
            part.kind === 'text' ? (
              <span key={index}>{part.text}</span>
            ) : (
              <bdi
                key={index}
                className={cn(
                  'font-semibold',
                  part.kind === 'missing' ? 'text-destructive' : 'text-primary',
                )}
              >
                {part.text}
              </bdi>
            ),
          )}
        </p>
      </div>

      {nothingToRun ? (
        <p role="alert" className="flex items-start gap-1.5 text-xs text-destructive">
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
          There is nothing to run yet.
        </p>
      ) : null}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="hidden text-[11px] text-muted-foreground sm:block">
          Press{' '}
          <kbd className="rounded border border-border bg-background px-1 py-px font-mono text-[10px]">
            Enter
          </kbd>{' '}
          to run
        </p>
        <div className="flex gap-2 sm:ml-auto">
          {onBack ? (
            <Button type="button" variant="soft" onClick={onBack}>
              Back
            </Button>
          ) : (
            <Button type="button" variant="soft" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button type="submit" aria-describedby={previewId}>
            <Play /> Run
          </Button>
        </div>
      </div>
    </form>
  );
}
