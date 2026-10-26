import type { FieldChange, GenerationView, ProposalChange } from '@runova/studio';
import { scriptClass } from '../format';
import { Button, Check, cn, GLASS_CARD, Sparkles, X } from '../kit';
import { runLabel } from './runSettings';

function Text({ value, className }: { value: string; className?: string }): React.JSX.Element {
  if (!value) return <span className={cn('italic text-muted-foreground', className)}>empty</span>;
  return (
    <span
      dir="auto"
      className={cn('whitespace-pre-wrap break-words', scriptClass(value), className)}
    >
      {value}
    </span>
  );
}

/** One field before and after. Said in words as well as tint, so it never rests on colour alone. */
function FieldRows({ changes }: { changes: FieldChange[] }): React.JSX.Element {
  return (
    <dl className="mt-1 space-y-1.5">
      {changes.map((change) => (
        <div key={change.field} className="grid gap-x-2 text-xs sm:grid-cols-[7rem_minmax(0,1fr)]">
          <dt className="font-medium text-muted-foreground">{change.label}</dt>
          <dd className="space-y-0.5">
            <p>
              <span className="mr-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                Before
              </span>
              <Text
                value={change.before}
                className="text-muted-foreground line-through decoration-destructive/50"
              />
            </p>
            <p>
              <span className="mr-1.5 text-[10px] uppercase tracking-wide text-success">After</span>
              <Text value={change.after} />
            </p>
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function ChangeItem({ change }: { change: ProposalChange }): React.JSX.Element {
  switch (change.kind) {
    case 'title':
      return (
        <>
          <p className="text-sm font-medium">Video title</p>
          <FieldRows
            changes={[
              { field: 'title', label: 'Title', before: change.before, after: change.after },
            ]}
          />
        </>
      );
    case 'scenario':
      return (
        <>
          <p className="text-sm font-medium">The video as a whole</p>
          <FieldRows changes={change.changes} />
        </>
      );
    case 'scene-added':
      return (
        <>
          <p className="text-sm font-medium">
            New scene {change.position}: <Text value={change.title} />
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            <Text value={change.narration} />
          </p>
        </>
      );
    case 'scene-removed':
      return (
        <p className="text-sm font-medium">
          Remove scene {change.position}: <Text value={change.title} />
        </p>
      );
    case 'scene-moved':
      return (
        <p className="text-sm font-medium">
          Move scene {change.from} (<Text value={change.title} />) to position {change.to}
        </p>
      );
    case 'scene-changed':
      return (
        <>
          <p className="text-sm font-medium">
            Scene {change.position}: <Text value={change.title} />
          </p>
          <FieldRows changes={change.changes} />
        </>
      );
    case 'clip-added':
      return (
        <p className="text-sm font-medium">
          Add <Text value={change.label} /> to the {change.track} track at {change.startSeconds} s
        </p>
      );
    case 'clip-removed':
      return (
        <p className="text-sm font-medium">
          Remove <Text value={change.label} /> from the {change.track} track
        </p>
      );
    case 'clip-changed':
      return (
        <>
          <p className="text-sm font-medium">
            <Text value={change.label} /> on the {change.track} track
          </p>
          <FieldRows changes={change.changes} />
        </>
      );
    case 'captions-added':
      return (
        <p className="text-sm font-medium">
          Caption scene {change.position} from its narration ({change.count}{' '}
          {change.count === 1 ? 'line' : 'lines'})
        </p>
      );
    case 'track-changed':
      return (
        <>
          <p className="text-sm font-medium">The {change.track} track</p>
          <FieldRows changes={change.changes} />
        </>
      );
  }
}

export interface ProposalCardProps {
  generation: GenerationView;
  applying: boolean;
  onApply: () => void;
  onDiscard: () => void;
}

/** What the AI wants to change, spelled out, waiting for the user to apply or discard it. */
export function ProposalCard({
  generation,
  applying,
  onApply,
  onDiscard,
}: ProposalCardProps): React.JSX.Element | null {
  const proposal = generation.proposal;
  if (!proposal) return null;
  return (
    <section className={cn(GLASS_CARD, 'space-y-3 p-3')} aria-label="AI proposal">
      <div className="flex items-start gap-2">
        <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold" dir="auto">
            {proposal.summary}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            You asked: <Text value={generation.instruction} /> · {runLabel(generation)}
          </p>
        </div>
      </div>
      <ol className="space-y-2">
        {proposal.changes.map((change, i) => (
          <li
            key={`${change.kind}-${i}`}
            className="rounded-lg bg-foreground/[0.03] px-2.5 py-2 ring-1 ring-inset ring-foreground/[0.06]"
          >
            <ChangeItem change={change} />
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={onApply} disabled={applying}>
          <Check /> {applying ? 'Applying...' : 'Apply'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDiscard} disabled={applying}>
          <X /> Discard
        </Button>
        <span className="text-xs text-muted-foreground">
          Applied as one step, so Undo takes it all back.
        </span>
      </div>
    </section>
  );
}
