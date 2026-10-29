import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  ContainerListSkeleton,
  DockerContainersView,
} from '@/components/docker/DockerContainersView';
import { DockerHubView } from '@/components/docker/DockerHubView';
import { DockerImagesView } from '@/components/docker/DockerImagesView';
import { Docker, Monitor, Package } from '@/components/icons';
import { EmptyState, GLASS_CARD, PillTabs } from '@/components/pageKit';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { usePageHeader } from '@/stores/pageHeaderStore';

/** `?view=` on the page's URL. No value is the containers, the page's first view. */
type DockerView = 'containers' | 'images' | 'hub';

function readView(params: URLSearchParams): DockerView {
  // A container deep link (the status bar popover) always lands on the containers.
  if (params.has('container')) return 'containers';
  const view = params.get('view');
  return view === 'images' || view === 'hub' ? view : 'containers';
}

export default function DockerPage(): React.JSX.Element {
  usePageHeader('Docker', 'Containers, images and your Docker Hub repositories on this machine.');
  const [searchParams, setSearchParams] = useSearchParams();
  const view = readView(searchParams);

  const availabilityQuery = useQuery({
    queryKey: queryKeys.dockerAvailability,
    queryFn: () => window.runova.docker.availability(),
    meta: { silentLoading: true },
  });
  const available = availabilityQuery.data;

  // Kept in the URL so the view survives leaving the page and coming back with Back.
  function openView(next: DockerView): void {
    setSearchParams(next === 'containers' ? {} : { view: next }, { replace: true });
  }

  if (availabilityQuery.isLoading) {
    return (
      <div className="flex flex-col gap-2 p-2">
        <Skeleton className="h-12 w-full rounded-[calc(var(--radius)+2px)]" />
        <ContainerListSkeleton />
      </div>
    );
  }

  // Only a clear "no" says Docker is missing. A check that failed outright falls through to the
  // views, which then show an empty machine rather than a wrong diagnosis.
  if (available === false) {
    return (
      <div className="flex flex-col gap-2 p-2">
        <div className={GLASS_CARD}>
          <EmptyState
            size="lg"
            icon={Docker}
            title="Docker isn't available"
            description="Runova couldn't find the docker command on PATH. Install Docker Desktop (or the Docker Engine CLI) and reopen this page."
          />
        </div>
      </div>
    );
  }

  const images = view !== 'containers';

  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex flex-wrap items-center gap-2 px-1 pt-1">
        <PillTabs<'containers' | 'images'>
          id="docker-views"
          label="Docker views"
          value={images ? 'images' : 'containers'}
          onChange={(next) => openView(next === 'images' && view === 'hub' ? 'hub' : next)}
          items={[
            { value: 'containers', label: 'Containers', icon: <Docker /> },
            { value: 'images', label: 'Images', icon: <Package /> },
          ]}
        />
        {images && (
          <PillTabs<'images' | 'hub'>
            id="docker-image-source"
            kind="toggle"
            size="xs"
            label="Image source"
            value={view}
            onChange={openView}
            items={[
              { value: 'images', label: 'On this machine', icon: <Monitor /> },
              { value: 'hub', label: 'Docker Hub', icon: <Docker /> },
            ]}
          />
        )}
      </div>
      {view === 'containers' && <DockerContainersView />}
      {view === 'images' && <DockerImagesView />}
      {view === 'hub' && <DockerHubView />}
    </div>
  );
}
