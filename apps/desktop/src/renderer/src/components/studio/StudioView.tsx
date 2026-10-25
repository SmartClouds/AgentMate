import { StudioEditor } from './editor/StudioEditor';
import { StudioHome } from './home/StudioHome';
import { useStudioEvents } from './useStudioEvents';

/** Dev Setup with Studio's stack (ffmpeg, ffprobe) switched on. */
export const STUDIO_DEV_SETUP = '/tools?tab=dev-setup&stack=studio';

export interface StudioViewProps {
  /** The open video, or null for the library. */
  videoId: string | null;
  navigate: (path: string) => void;
}

/** Studio's top level: the library, or one video open in the editor. */
export function StudioView({ videoId, navigate }: StudioViewProps): React.JSX.Element {
  useStudioEvents();
  const openDevSetup = () => navigate(STUDIO_DEV_SETUP);
  if (videoId)
    return (
      <StudioEditor
        key={videoId}
        videoId={videoId}
        onBack={() => navigate('/studio')}
        onOpenDevSetup={openDevSetup}
      />
    );
  return (
    <StudioHome onOpen={(video) => navigate(`/studio/${video.id}`)} onOpenDevSetup={openDevSetup} />
  );
}
