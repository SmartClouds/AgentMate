import type { EditResponse, GenerationView } from '@agentmat/studio';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { studioAiClient, studioClient, studioScenesClient } from '../client';
import { errorMessage } from '../format';
import { type RunSettings, toast } from '../kit';
import { studioKeys } from '../queryKeys';
import { type ScenarioRequest, toRunInput } from './runSettings';

/** Lines of live output kept per run; the full log is in the run's record. */
const MAX_OUTPUT_LINES = 300;

export interface StudioAi {
  generations: GenerationView[];
  loading: boolean;
  /** Live output of runs while they work, by generation id. */
  output: Record<string, string[]>;
  /** The run working on the video right now, if any. */
  running: GenerationView | null;
  startScenario: (request: ScenarioRequest) => Promise<boolean>;
  startEdit: (instruction: string, run: RunSettings) => Promise<boolean>;
  /** Animates a scene, or changes its animation when given what to change. */
  startScene: (sceneId: string, run: RunSettings, instruction?: string) => Promise<boolean>;
  cancel: (generationId: string) => Promise<void>;
  retry: (generationId: string) => Promise<void>;
  applyProposal: (generationId: string) => Promise<boolean>;
  discardProposal: (generationId: string) => Promise<void>;
}

/** One video's AI runs: their records, their live output, and the actions on them. */
export function useStudioAi(
  videoId: string,
  adopt: (result: EditResponse) => Promise<void>,
): StudioAi {
  const queryClient = useQueryClient();
  const list = useQuery({
    queryKey: studioKeys.generations(videoId),
    queryFn: () => studioAiClient().generations(videoId, 50),
  });
  const generations = list.data ?? [];
  const [output, setOutput] = useState<Record<string, string[]>>({});

  useEffect(() => {
    return studioClient().onEvent((event) => {
      if (event.type === 'generation-output' && event.videoId === videoId) {
        setOutput((all) => ({
          ...all,
          [event.generationId]: [...(all[event.generationId] ?? []), ...event.lines].slice(
            -MAX_OUTPUT_LINES,
          ),
        }));
      } else if (event.type === 'generation-changed' && event.videoId === videoId) {
        void queryClient.invalidateQueries({ queryKey: studioKeys.generations(videoId) });
      }
    });
  }, [queryClient, videoId]);

  // A scenario that lands while the user watches gets a word, since the whole scenario changed.
  const seen = useRef(new Map<string, GenerationView['status']>());
  useEffect(() => {
    for (const g of generations) {
      const before = seen.current.get(g.id);
      if (before === 'running' && g.status === 'done' && g.stage === 'scenario') {
        toast.success('The scenario is written. Undo brings back the one before.');
      }
      seen.current.set(g.id, g.status);
    }
  }, [generations]);

  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: studioKeys.generations(videoId) }),
    [queryClient, videoId],
  );

  const attempt = useCallback(
    async <T>(work: () => Promise<T>): Promise<T | null> => {
      try {
        const result = await work();
        await refresh();
        return result;
      } catch (error) {
        toast.error(errorMessage(error));
        return null;
      }
    },
    [refresh],
  );

  const client = studioAiClient;
  return {
    generations,
    loading: list.isPending,
    output,
    running: generations.find((g) => g.status === 'running') ?? null,
    startScenario: async (request) =>
      (await attempt(() => client().startScenario({ videoId, ...request }))) !== null,
    startEdit: async (instruction, run) =>
      (await attempt(() => client().startEdit({ videoId, instruction, run: toRunInput(run) }))) !==
      null,
    startScene: async (sceneId, runSettings, instruction) =>
      (await attempt(() =>
        studioScenesClient().animate({
          videoId,
          sceneId,
          instruction,
          run: toRunInput(runSettings),
        }),
      )) !== null,
    cancel: async (id) => {
      await attempt(() => client().cancel(videoId, id));
    },
    retry: async (id) => {
      await attempt(() => client().retry(videoId, id));
    },
    applyProposal: async (id) => {
      const result = await attempt(() => client().applyProposal(videoId, id));
      if (result) await adopt(result);
      return result !== null;
    },
    discardProposal: async (id) => {
      await attempt(() => client().discardProposal(videoId, id));
    },
  };
}
