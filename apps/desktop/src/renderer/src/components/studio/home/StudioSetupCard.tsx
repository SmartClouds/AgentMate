import { useQuery } from '@tanstack/react-query';
import { studioRenderClient } from '../client';
import { Button, Notice, Wrench } from '../kit';
import { studioKeys } from '../queryKeys';

/**
 * Tells the user, before they get as far as rendering, that Studio needs ffmpeg and where to get
 * it. Shows nothing while it looks, and nothing once ffmpeg is there.
 */
export function StudioSetupCard({
  onOpenDevSetup,
}: {
  onOpenDevSetup: () => void;
}): React.JSX.Element | null {
  const tools = useQuery({
    queryKey: studioKeys.renderTools,
    queryFn: () => studioRenderClient().tools(),
    staleTime: 30_000,
  });
  if (!tools.data || (tools.data.ffmpeg.found && tools.data.ffprobe.found)) return null;
  return (
    <Notice
      tone="warning"
      size="sm"
      action={
        <Button size="sm" variant="soft" onClick={onOpenDevSetup}>
          <Wrench /> Open Dev Setup
        </Button>
      }
    >
      Studio renders videos with ffmpeg, which is not installed yet. You can write and animate
      scenes without it; install it from Dev Setup before you render.
    </Notice>
  );
}
