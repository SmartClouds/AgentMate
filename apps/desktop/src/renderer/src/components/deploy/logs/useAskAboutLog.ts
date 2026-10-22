import { useDeployAssistantStore } from '@/stores/deployAssistantStore';
import type { LogSource } from './useLogSource';

/** "Ask the AI" from a log viewer: opens the Deploy AI on what the viewer shows. */
export function useAskAboutLog(serverId: string): (source: LogSource) => void {
  const open = useDeployAssistantStore((state) => state.open);
  return (source) =>
    open(serverId, {
      prompt: 'Read this log and tell me what is going wrong.',
      context: {
        title: `Logs: ${source.label}`,
        ...(source.kind === 'container' ? { containerId: source.containerId } : {}),
        facts:
          source.kind === 'journal'
            ? [`The systemd unit ${source.unit}. journalctl -u ${source.unit} reads its journal.`]
            : source.kind === 'stack'
              ? [
                  `The compose project ${source.project}, services ${source.containers.map((c) => c.service).join(', ')}.`,
                ]
              : [],
      },
    });
}
