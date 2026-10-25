import { StudioEditor } from './editor/StudioEditor';
import { StudioHome } from './home/StudioHome';
import { useStudioEvents } from './useStudioEvents';

export interface StudioViewProps {
  /** The open video, or null for the library. */
  videoId: string | null;
  navigate: (path: string) => void;
}

/** Studio's top level: the library, or one video open in the editor. */
export function StudioView({ videoId, navigate }: StudioViewProps): React.JSX.Element {
  useStudioEvents();
  if (videoId)
    return <StudioEditor key={videoId} videoId={videoId} onBack={() => navigate('/studio')} />;
  return <StudioHome onOpen={(video) => navigate(`/studio/${video.id}`)} />;
}
