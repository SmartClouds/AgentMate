import {
  allGroups,
  clampRatio,
  findGroup,
  type PaneNode,
  type PaneSplitNode,
  type Project,
} from '@runova/core';
import { useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { type ProjectWorkspace, useWorkspaceStore } from '@/stores/workspaceStore';
import { PaneGroup } from './PaneGroup';

/** Smallest a pane may be dragged to, so its tab strip and a few terminal rows stay usable. */
const MIN_PANE_WIDTH = 220;
const MIN_PANE_HEIGHT = 120;
const KEYBOARD_STEP = 0.02;

function SplitHandle({
  projectId,
  split,
  containerRef,
}: {
  projectId: string;
  split: PaneSplitNode;
  containerRef: React.RefObject<HTMLDivElement | null>;
}): React.JSX.Element {
  const setSplitRatio = useWorkspaceStore((s) => s.setSplitRatio);
  const [dragging, setDragging] = useState(false);
  const row = split.direction === 'row';

  function limits(): [number, number] {
    const el = containerRef.current;
    const size = el ? (row ? el.clientWidth : el.clientHeight) : 0;
    if (size <= 0) return [0.1, 0.9];
    const min = (row ? MIN_PANE_WIDTH : MIN_PANE_HEIGHT) / size;
    return min >= 0.5 ? [0.5, 0.5] : [min, 1 - min];
  }

  function apply(ratio: number): void {
    const [lo, hi] = limits();
    setSplitRatio(projectId, split.id, clampRatio(Math.min(hi, Math.max(lo, ratio))));
  }

  function startDrag(event: React.PointerEvent<HTMLDivElement>): void {
    const el = containerRef.current;
    if (!el || event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    setDragging(true);
    document.body.style.cursor = row ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    let frame = 0;

    const onMove = (move: PointerEvent): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect();
        apply(
          row ? (move.clientX - rect.left) / rect.width : (move.clientY - rect.top) / rect.height,
        );
      });
    };
    const onUp = (up: PointerEvent): void => {
      cancelAnimationFrame(frame);
      handle.releasePointerCapture(up.pointerId);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setDragging(false);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  }

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-valuemin={10}
      aria-valuemax={90}
      aria-valuenow={Math.round(split.ratio * 100)}
      aria-label="Resize panes"
      onPointerDown={startDrag}
      onDoubleClick={() => apply(0.5)}
      onKeyDown={(event) => {
        const back = row ? 'ArrowLeft' : 'ArrowUp';
        const forward = row ? 'ArrowRight' : 'ArrowDown';
        if (event.key !== back && event.key !== forward) return;
        event.preventDefault();
        apply(split.ratio + (event.key === forward ? KEYBOARD_STEP : -KEYBOARD_STEP));
      }}
      className={cn(
        'group relative z-10 flex shrink-0 items-center justify-center focus-visible:outline-none',
        row ? 'w-1.5 cursor-col-resize' : 'h-1.5 cursor-row-resize',
      )}
    >
      <span
        className={cn(
          'rounded-full transition-colors duration-150',
          row ? 'h-10 w-[3px]' : 'h-[3px] w-10',
          dragging
            ? 'bg-primary shadow-[0_0_10px_hsl(var(--primary)/0.7)]'
            : 'bg-transparent group-hover:bg-primary/70 group-focus-visible:bg-primary/70',
        )}
      />
    </div>
  );
}

function PaneNodeView({
  node,
  project,
  workspace,
  multiPane,
}: {
  node: PaneNode;
  project: Project;
  workspace: ProjectWorkspace;
  multiPane: boolean;
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  if (node.type === 'group') {
    return <PaneGroup project={project} workspace={workspace} group={node} multiPane={multiPane} />;
  }
  const row = node.direction === 'row';
  return (
    <div
      ref={containerRef}
      className={cn('flex h-full min-h-0 w-full min-w-0', !row && 'flex-col')}
    >
      <div className="flex min-h-0 min-w-0" style={{ flex: `${node.ratio} 1 0` }}>
        <PaneNodeView
          key={node.a.id}
          node={node.a}
          project={project}
          workspace={workspace}
          multiPane={multiPane}
        />
      </div>
      <SplitHandle projectId={project.id} split={node} containerRef={containerRef} />
      <div className="flex min-h-0 min-w-0" style={{ flex: `${1 - node.ratio} 1 0` }}>
        <PaneNodeView
          key={node.b.id}
          node={node.b}
          project={project}
          workspace={workspace}
          multiPane={multiPane}
        />
      </div>
    </div>
  );
}

/** The center of the workspace: the project's panes, split however the user arranged them. */
export function PaneTree({
  project,
  workspace,
}: {
  project: Project;
  workspace: ProjectWorkspace;
}): React.JSX.Element {
  const multiPane = allGroups(workspace.root).length > 1;
  const zoomed = workspace.zoomedGroupId
    ? findGroup(workspace.root, workspace.zoomedGroupId)
    : null;
  if (zoomed) {
    return <PaneGroup project={project} workspace={workspace} group={zoomed} multiPane />;
  }
  return (
    <PaneNodeView
      node={workspace.root}
      project={project}
      workspace={workspace}
      multiPane={multiPane}
    />
  );
}
