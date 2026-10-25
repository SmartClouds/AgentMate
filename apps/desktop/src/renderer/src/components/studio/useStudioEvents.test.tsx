import type { StudioEvent } from '@agentmat/studio';
import { useQueryClient } from '@tanstack/react-query';
import { act } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { studioKeys } from './queryKeys';
import { useStudioEvents } from './useStudioEvents';

/** Keeps Studio's cached lists in step with what the service reports. */

function setup() {
  const listeners: ((event: StudioEvent) => void)[] = [];
  let invalidate: ReturnType<typeof vi.spyOn> | null = null;
  function Probe() {
    const client = useQueryClient();
    invalidate ??= vi.spyOn(client, 'invalidateQueries');
    useStudioEvents();
    return null;
  }
  renderWithProviders(<Probe />, {
    bridge: {
      'studio.onEvent': (listener: (event: StudioEvent) => void) => {
        listeners.push(listener);
        return () => undefined;
      },
    },
  });
  const emit = (event: StudioEvent) => act(() => listeners.forEach((l) => l(event)));
  return {
    emit,
    keys: () =>
      invalidate?.mock.calls.map((call: unknown[]) => (call[0] as { queryKey: unknown }).queryKey),
  };
}

describe('useStudioEvents', () => {
  it('refreshes the library, a video history or its AI runs, each on its own event', () => {
    const { emit, keys } = setup();
    emit({ type: 'library-changed' });
    emit({ type: 'video-changed', videoId: 'v1', seq: 2 });
    emit({ type: 'generation-changed', videoId: 'v1', generationId: 'g1' });
    expect(keys()).toEqual([
      studioKeys.videos,
      studioKeys.history('v1'),
      studioKeys.generations('v1'),
    ]);
  });

  it('leaves live output to the run card, so a chatty CLI refetches nothing', () => {
    const { emit, keys } = setup();
    emit({ type: 'generation-output', videoId: 'v1', generationId: 'g1', lines: ['x'] });
    expect(keys() ?? []).toEqual([]);
  });
});
