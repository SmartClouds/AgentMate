import type { DesktopPetCardView } from '@runova/core';
import { PET_BOX } from '@shared/pet';
import { useUsageSummary } from '@/hooks/useUsageSummary';
import { formatCost, formatTokens } from '@/lib/usageFormat';
import { cn } from '@/lib/utils';
import { type PetCharacter } from './characters';
import { PetNetworkPanel, PetSystemPanel } from './PetStatsPanels';

const CARD_W = 268;
/** First-paint estimate. The overlay measures the real box and re-places. */
const CARD_H = 280;
const CARD_GAP = 10;
const CARD_PAD = 10;

export { CARD_H, CARD_W };

export type CardSide = 'top' | 'bottom' | 'left' | 'right';

export function placePetCard(
  x: number,
  y: number,
  w: number,
  h: number,
  stageW: number,
  stageH: number,
  cardW = CARD_W,
  cardH = CARD_H,
): { left: number; top: number; side: CardSide } {
  const hitW = w || PET_BOX;
  const hitH = h || PET_BOX;
  const maxLeft = Math.max(CARD_PAD, stageW - cardW - CARD_PAD);
  const maxTop = Math.max(CARD_PAD, stageH - cardH - CARD_PAD);
  const clampLeft = (value: number) => Math.min(maxLeft, Math.max(CARD_PAD, value));
  const clampTop = (value: number) => Math.min(maxTop, Math.max(CARD_PAD, value));

  const petLeft = x;
  const petRight = x + hitW;
  const petTop = y;
  const petBottom = y + hitH;
  const midX = x + hitW / 2;
  const midY = y + hitH / 2;

  const candidates: Array<{ side: CardSide; left: number; top: number }> = [
    { side: 'right', left: petRight + CARD_GAP, top: midY - cardH / 2 },
    { side: 'left', left: petLeft - cardW - CARD_GAP, top: midY - cardH / 2 },
    { side: 'bottom', left: midX - cardW / 2, top: petBottom + CARD_GAP },
    { side: 'top', left: midX - cardW / 2, top: petTop - cardH - CARD_GAP },
  ];

  function overlapsPet(left: number, top: number): boolean {
    return !(
      left + cardW <= petLeft - 2 ||
      left >= petRight + 2 ||
      top + cardH <= petTop - 2 ||
      top >= petBottom + 2
    );
  }

  function score(candidate: (typeof candidates)[number]): number {
    const left = clampLeft(candidate.left);
    const top = clampTop(candidate.top);
    const shift = Math.abs(left - candidate.left) + Math.abs(top - candidate.top);
    const roomAbove = petTop;
    const roomBelow = stageH - petBottom;
    const noRoom =
      (candidate.side === 'top' && roomAbove < cardH + CARD_PAD + CARD_GAP) ||
      (candidate.side === 'bottom' && roomBelow < cardH + CARD_PAD + CARD_GAP)
        ? 5_000
        : 0;
    return (overlapsPet(left, top) ? 10_000 : 0) + noRoom + shift;
  }

  const best = [...candidates].sort((a, b) => score(a) - score(b))[0] ?? candidates[0];
  return {
    side: best.side,
    left: clampLeft(best.left),
    top: clampTop(best.top),
  };
}

function MiniBurn({ values }: { values: number[] }): React.JSX.Element | null {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const width = 244;
  const height = 36;
  const path = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - 3 - (value / max) * (height - 6);
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-9 w-full" aria-hidden>
      <path
        d={path}
        fill="none"
        stroke="hsl(var(--primary))"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

const VIEW_TABS: { id: DesktopPetCardView; label: string; title: string }[] = [
  { id: 'tokens', label: 'Tokens', title: 'Token report' },
  { id: 'system', label: 'System', title: 'System state' },
  { id: 'network', label: 'Network', title: 'Network status' },
];

function PetTokensPanel(): React.JSX.Element {
  const summary = useUsageSummary(true);
  const topAgents = summary.agents.slice(0, 3);

  return (
    <>
      {summary.isPending ? (
        <p className="mt-4 text-xs text-muted-foreground">Reading usage…</p>
      ) : (
        <>
          <div className="mt-3 flex items-end justify-between gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Today</p>
              <p className="font-mono text-2xl leading-none text-foreground">
                {formatTokens(summary.todayTokens)}
              </p>
            </div>
            {summary.hasCost ? (
              <p className="font-mono text-sm text-primary">{formatCost(summary.todayCost)}</p>
            ) : (
              <p className="text-xs text-muted-foreground">{summary.okCount} tracked</p>
            )}
          </div>

          <div className="mt-2">
            <MiniBurn values={summary.series} />
          </div>

          <div className="mt-1 grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-md bg-foreground/5 px-2 py-1.5">
              <p className="text-[10px] text-muted-foreground">7 days</p>
              <p className="font-mono text-foreground">{formatTokens(summary.weekTokens)}</p>
            </div>
            <div className="rounded-md bg-foreground/5 px-2 py-1.5">
              <p className="text-[10px] text-muted-foreground">30 days</p>
              <p className="font-mono text-foreground">{formatTokens(summary.monthTokens)}</p>
            </div>
          </div>

          {topAgents.length > 0 ? (
            <ul className="mt-2 space-y-1">
              {topAgents.map((agent) => (
                <li key={agent.id} className="flex items-center justify-between gap-2 text-[11px]">
                  <span className="flex min-w-0 items-center gap-1.5 truncate text-muted-foreground">
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: agent.accentColor }}
                    />
                    <span className="truncate">{agent.name}</span>
                  </span>
                  <span className="font-mono text-foreground">
                    {formatTokens(agent.todayTokens)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-[11px] text-muted-foreground">
              No token sources connected yet. Open Token Usage to add some.
            </p>
          )}
        </>
      )}
    </>
  );
}

export function PetStatsCard({
  pet,
  side,
  view,
  onSelectView,
  onClose,
}: {
  pet: PetCharacter;
  side: CardSide;
  view: DesktopPetCardView;
  onSelectView: (view: DesktopPetCardView) => void;
  onClose: () => void;
}): React.JSX.Element {
  const title = VIEW_TABS.find((tab) => tab.id === view)?.title ?? 'Token report';

  return (
    <div
      data-pet-hit="card"
      className={cn(
        'widget-glass pet-token-card pointer-events-auto w-[268px] overflow-hidden rounded-xl p-3.5',
        `is-${side}`,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {title}
          </p>
          <p className="truncate text-sm font-semibold text-foreground">{pet.name}</p>
        </div>
        <button
          type="button"
          className="cursor-pointer rounded-md px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onClose}
        >
          Close
        </button>
      </div>

      <div className="mt-2.5 flex gap-1 rounded-lg bg-foreground/5 p-0.5">
        {VIEW_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => onSelectView(tab.id)}
            className={cn(
              'flex-1 cursor-pointer rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors',
              tab.id === view
                ? 'bg-background/80 text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {view === 'system' ? (
        <PetSystemPanel />
      ) : view === 'network' ? (
        <PetNetworkPanel />
      ) : (
        <PetTokensPanel />
      )}
    </div>
  );
}
