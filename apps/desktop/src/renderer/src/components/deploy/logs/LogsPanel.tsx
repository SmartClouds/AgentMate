import type { DeployServer } from '@shared/deployTypes';
import { useQuery } from '@tanstack/react-query';
import { GLASS_CARD } from '@/components/pageKit';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { useTabParam } from '../useTabParam';
import { LogViewer } from './LogViewer';
import { ProblemsFeed } from './ProblemsFeed';
import { useAskAboutLog } from './useAskAboutLog';

/** The tab strip as a pill track whose selection is the main menu's tinted pill. */
const TAB_LIST = 'search-pill mb-0 h-auto w-auto gap-0.5 rounded-full p-0.5';
const TAB = cn(
  'h-7 rounded-full border-none px-3 text-xs text-muted-foreground hover:bg-foreground/[0.06] focus-visible:ring-inset',
  'data-[state=active]:bg-primary/12 data-[state=active]:text-primary data-[state=active]:ring-1 data-[state=active]:ring-inset data-[state=active]:ring-primary/20 data-[state=active]:hover:bg-primary/12',
);

/**
 * A server's Logs section (E09): what is broken right now (the problems feed), and every log in
 * one viewer. "Ask the AI" from the viewer opens the Deploy AI on what is shown.
 */

const LOGS_TABS = ['problems', 'logs'] as const;

export function LogsPanel({ server }: { server: DeployServer }): React.JSX.Element {
  const [tab, setTab] = useTabParam(LOGS_TABS, 'problems');
  const containers = useQuery({
    queryKey: queryKeys.deployContainers(server.id),
    queryFn: () => window.runova.deployDocker.listContainers(server.id),
    enabled: tab === 'logs',
    retry: false,
    meta: { silentLoading: true },
  });
  const sites = useQuery({
    queryKey: queryKeys.deploySites(server.id),
    queryFn: async () => (await window.runova.deploySites.list(server.id)) ?? [],
    enabled: tab === 'logs',
    retry: false,
    meta: { silentLoading: true },
  });

  const askAi = useAskAboutLog(server.id);

  return (
    <Tabs
      value={tab}
      onValueChange={(next) => setTab(next as (typeof LOGS_TABS)[number])}
      className="flex flex-col gap-2"
    >
      <TabsList containerClassName="self-start border-b-0" className={TAB_LIST}>
        <TabsTrigger value="problems" className={TAB}>
          Problems
        </TabsTrigger>
        <TabsTrigger value="logs" className={TAB}>
          Log viewer
        </TabsTrigger>
      </TabsList>
      <TabsContent value="problems" className="mt-0">
        <ProblemsFeed server={server} />
      </TabsContent>
      <TabsContent value="logs" className={cn(GLASS_CARD, 'mt-0 flex min-h-[32rem] flex-col p-3')}>
        <LogViewer
          serverId={server.id}
          containers={containers.data}
          sites={sites.data}
          onAskAi={askAi}
        />
      </TabsContent>
    </Tabs>
  );
}
