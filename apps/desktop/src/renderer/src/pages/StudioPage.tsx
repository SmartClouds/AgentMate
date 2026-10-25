import { useNavigate, useParams } from 'react-router-dom';
import { StudioView } from '@/components/studio/StudioView';
import { usePageHeader } from '@/stores/pageHeaderStore';

/** Studio: videos for a project or standalone, from a brief to a finished render. */
export default function StudioPage(): React.JSX.Element {
  usePageHeader(
    'Studio',
    'Make videos for your projects: write a brief, shape the scenario, edit and render.',
  );
  const { videoId } = useParams();
  const navigate = useNavigate();
  return (
    <div className="p-2">
      <StudioView videoId={videoId ?? null} navigate={navigate} />
    </div>
  );
}
