import { MonitoringView } from '@/components/health/MonitoringView';
import { usePageHeader } from '@/stores/pageHeaderStore';

/** Monitoring: every project's health checks (E22) and the errors Sentry recorded (E24). */
export default function HealthPage(): React.JSX.Element {
  usePageHeader(
    'Monitoring',
    'Watch each environment’s health endpoint and the errors your users hit, and see what broke and why.',
  );
  return (
    <div className="p-2">
      <MonitoringView />
    </div>
  );
}
