import type { StudioEvent } from '@runova/studio';
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
  let queryClient: ReturnType<typeof useQueryClient> | null = null;
  function Probe() {
    const client = useQueryClient();
    queryClient = client;
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
    client: () => queryClient as NonNullable<typeof queryClient>,
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

  it('refetches the render lists when a render changes, and patches progress in without asking', () => {
    const { emit, keys, client } = setup();
    const job = { id: 'j1', status: 'running', phase: 'capture', done: 0, total: 90 };
    const other = { id: 'j2', status: 'queued', phase: null, done: 0, total: 30 };
    client().setQueryData(studioKeys.renderList('v1'), [job, other]);
    client().setQueryData(studioKeys.renderList(undefined), [job]);
    emit({
      type: 'render-progress',
      jobId: 'j1',
      videoId: 'v1',
      phase: 'encode',
      done: 40,
      total: 80,
    });
    expect(client().getQueryData(studioKeys.renderList('v1'))).toEqual([
      { ...job, phase: 'encode', done: 40, total: 80 },
      other,
    ]);
    expect(client().getQueryData(studioKeys.renderList(undefined))).toEqual([
      { ...job, phase: 'encode', done: 40, total: 80 },
    ]);
    expect(keys() ?? []).toEqual([]);
    emit({ type: 'render-changed', jobId: 'j1', videoId: 'v1' });
    expect(keys()).toEqual([studioKeys.renders]);
    emit({ type: 'media-changed', videoId: 'v1' });
    expect(keys()).toEqual([studioKeys.renders, studioKeys.media('v1')]);
  });
});
