import { Download, Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { WordPressMark } from '@/components/wordpress/WordPressMark';
import { cn } from '@/lib/utils';
import { DeployCard } from '../deployKit';
import { useSaveConnectorZip } from './hooks';

/** The three steps from nothing to a connection key, in the words wp-admin uses. */
export function ConnectorSteps({ className }: { className?: string }): React.JSX.Element {
  return (
    <ol
      aria-label="How to install the connector"
      className={cn('list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground', className)}
    >
      <li>Download the plugin zip.</li>
      <li>
        In the site's admin, open Plugins &gt; Add New &gt; Upload Plugin, pick the zip, then
        install and activate it.
      </li>
      <li>
        Open Tools &gt; Runova Connector and make a connection key. Pick read-only if you only want
        to pull files.
      </li>
    </ol>
  );
}

/**
 * Hands over the Runova Connector plugin that ships with the app. This is how a site first gets
 * the plugin, and how one whose connector is too old to update itself gets a newer version. A
 * connector that can update itself is updated from the site's overview instead.
 */
export function ConnectorDownloadCard({
  title = 'Get the Runova Connector',
  description = 'A small WordPress plugin that lets Runova pull and deploy theme and plugin files. It needs WordPress 6.0 and PHP 7.4 or newer.',
  className,
}: {
  title?: string;
  description?: string;
  className?: string;
}): React.JSX.Element {
  const { save, saving } = useSaveConnectorZip();
  return (
    <DeployCard
      className={className}
      icon={<WordPressMark />}
      tone="neutral"
      title={title}
      description={description}
      actions={
        <Button size="sm" variant="soft" disabled={saving} onClick={() => void save()}>
          {saving ? <Spinner className="motion-safe:animate-spin" /> : <Download />}
          Download the plugin
        </Button>
      }
    >
      <ConnectorSteps />
    </DeployCard>
  );
}
