import type { DockerContainer } from '@shared/apiTypes';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { DockerContainerRow } from './DockerContainerRow';

const container: DockerContainer = {
  id: 'c1',
  name: 'web',
  image: 'nginx:latest',
  state: 'running',
  status: 'Up 2 hours',
  composeProject: 'shop',
  cpuPercent: null,
  memUsedBytes: null,
  memLimitBytes: null,
};

function renderRow(variant?: 'card' | 'row', onLogs?: () => void) {
  const handlers = {
    onStart: vi.fn(),
    onStop: vi.fn(),
    onRestart: vi.fn(),
    onRemove: vi.fn(),
  };
  const view = render(
    <TooltipProvider>
      <DockerContainerRow
        container={container}
        pending={false}
        variant={variant}
        onLogs={onLogs}
        {...handlers}
      />
    </TooltipProvider>,
  );
  return { ...view, handlers };
}

describe('DockerContainerRow', () => {
  it('stands as its own inset well by default', () => {
    const { container: root } = renderRow();
    expect(root.firstElementChild?.className).toContain('ring-inset');
    expect(screen.getByText('Running')).toBeTruthy();
    expect(screen.getByText('shop')).toBeTruthy();
  });

  it('draws flat in the row variant, for a hairline list, and keeps its named actions', () => {
    const { container: root, handlers } = renderRow('row');
    const row = root.firstElementChild as HTMLElement;
    expect(row.className).not.toContain('rounded-lg');
    expect(row.className).not.toContain('ring-1');

    fireEvent.click(screen.getByRole('button', { name: 'Stop web' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restart web' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove web' }));
    expect(handlers.onStop).toHaveBeenCalledTimes(1);
    expect(handlers.onRestart).toHaveBeenCalledTimes(1);
    expect(handlers.onRemove).toHaveBeenCalledTimes(1);
  });

  it('opens the logs from their own button, even while an action is under way', () => {
    const onLogs = vi.fn();
    render(
      <TooltipProvider>
        <DockerContainerRow
          container={container}
          pending
          onStart={vi.fn()}
          onStop={vi.fn()}
          onRestart={vi.fn()}
          onRemove={vi.fn()}
          onLogs={onLogs}
        />
      </TooltipProvider>,
    );

    const button = screen.getByRole('button', { name: 'Show logs of web' });
    expect(button).not.toBeDisabled();
    fireEvent.click(button);
    expect(onLogs).toHaveBeenCalledTimes(1);
  });

  it('has no logs button where nothing would open them', () => {
    renderRow('row');

    expect(screen.queryByRole('button', { name: 'Show logs of web' })).toBeNull();
  });
});
