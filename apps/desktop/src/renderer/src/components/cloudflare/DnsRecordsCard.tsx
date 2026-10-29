import type {
  CloudflareDnsRecord,
  CloudflareRecordInput,
  CloudflareZone,
} from '@shared/cloudflareTypes';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Globe, Pencil, Plus, Server, Trash2 } from '@/components/icons';
import { Chip, EmptyState, FOOTER_HAIRLINE, SECTION_HEADING } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { TruncatedText } from '@/components/ui/truncated-text';
import { cloudflareFailureText, useCloudflareError } from '@/lib/cloudflare/feedback';
import { relativeName, ttlLabel } from '@/lib/cloudflare/labels';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { CardBody, CloudflareCard, Problem } from './fields';
import { PointDomainDialog } from './PointDomainDialog';
import { RecordDialog } from './RecordDialog';

/** The hairline under the column headings. It sits on the cells, since a row paints no shadow. */
const HEADER_LINE = 'shadow-[inset_0_-1px_0_hsl(var(--foreground)/0.08)]';

/** The same record with the proxy turned on or off, and nothing else changed. */
function withProxy(record: CloudflareDnsRecord, proxied: boolean): CloudflareRecordInput {
  return {
    type: record.type as 'A' | 'AAAA' | 'CNAME',
    name: record.name,
    content: record.content,
    ttl: proxied ? 1 : record.ttl,
    proxied,
  };
}

function RecordsSkeleton(): React.JSX.Element {
  return (
    <div className={cn(FOOTER_HAIRLINE, 'settings-rows')} aria-busy="true">
      {Array.from({ length: 4 }, (_, index) => (
        <div key={index} className="flex items-center gap-3 px-4 py-2.5">
          <Skeleton className="h-5 w-12 rounded-full" />
          <Skeleton className="h-3.5 w-24" />
          <Skeleton className="h-3.5 flex-1" />
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
      ))}
    </div>
  );
}

/**
 * A zone's DNS records (T2). The proxy is a switch with its state written next to it, record
 * types the page does not edit are listed as read-only, and a delete asks first.
 */
export function DnsRecordsCard({ zone }: { zone: CloudflareZone }): React.JSX.Element {
  const queryClient = useQueryClient();
  const recordsKey = queryKeys.cloudflareRecords(zone.id);
  const records = useQuery({
    queryKey: recordsKey,
    queryFn: () => window.runova.cloudflare.listRecords(zone.id),
  });
  const loadError = useCloudflareError(records.error);
  // undefined: no editor open; null: adding a record; a record: editing it.
  const [editing, setEditing] = useState<CloudflareDnsRecord | null | undefined>(undefined);
  const [pointing, setPointing] = useState(false);
  const [changing, setChanging] = useState<string | null>(null);

  async function setProxy(record: CloudflareDnsRecord, proxied: boolean): Promise<void> {
    setChanging(record.id);
    try {
      await window.runova.cloudflare.updateRecord(zone.id, record.id, withProxy(record, proxied));
      toast.success(`${record.name} is ${proxied ? 'proxied' : 'DNS only'} now.`);
      await queryClient.invalidateQueries({ queryKey: recordsKey });
    } catch (error) {
      toast.error(cloudflareFailureText(error, queryClient));
    } finally {
      setChanging(null);
    }
  }

  async function remove(record: CloudflareDnsRecord): Promise<void> {
    const what = `the ${record.type} record for ${record.name}`;
    const confirmed = await confirmDialog({
      title: `Delete ${what}?`,
      description: `${record.name} stops answering with ${record.content}. Anything that relies on it, a website or mail, stops working once resolvers notice.`,
      confirmLabel: 'Delete record',
      variant: 'destructive',
    });
    if (!confirmed) return;
    try {
      await window.runova.cloudflare.deleteRecord(zone.id, record.id);
      toast.success(`Deleted ${what}.`);
      await queryClient.invalidateQueries({ queryKey: recordsKey });
    } catch (error) {
      toast.error(cloudflareFailureText(error, queryClient));
    }
  }

  let body: React.ReactNode;
  if (records.isPending) {
    body = <RecordsSkeleton />;
  } else if (records.isError) {
    body = (
      <CardBody>
        <Problem message={loadError ?? ''} onRetry={() => void records.refetch()} />
      </CardBody>
    );
  } else if (records.data.length === 0) {
    body = (
      <EmptyState
        size="sm"
        icon={Globe}
        title="No DNS records yet"
        description="Add one, or point the domain to one of your servers."
        className={FOOTER_HAIRLINE}
      />
    );
  } else {
    // "Edit on Cloudflare" takes more room than the two buttons.
    const locked = records.data.some((record) => !record.editable);
    body = (
      // Hairline rows like a Settings card. Wider than the card on a narrow window, the table
      // scrolls sideways on its own instead of squeezing the content column away. `relative`
      // makes it the box the hidden parts of the table (the switches' inputs, the Actions
      // heading) are placed in, so they are clipped with the rest instead of widening the page.
      <div className={cn(FOOTER_HAIRLINE, 'relative overflow-x-auto')}>
        {/* A fixed layout: the short columns keep their width and the name and content share
            the rest, cut short with the whole value on hover, so every column stays in view. */}
        <table className="w-full min-w-[46rem] table-fixed border-collapse text-sm">
          <colgroup>
            <col className="w-[5.5rem]" />
            <col />
            <col />
            <col className="w-[9.5rem]" />
            <col className="w-24" />
            <col className={locked ? 'w-[9rem]' : 'w-[5.5rem]'} />
          </colgroup>
          <thead>
            <tr className="text-left">
              {['Type', 'Name', 'Content', 'Proxy', 'TTL'].map((heading) => (
                <th
                  key={heading}
                  className={cn(SECTION_HEADING, HEADER_LINE, 'px-3 py-2 first:pl-4')}
                >
                  {heading}
                </th>
              ))}
              <th className={cn(HEADER_LINE, 'px-3 py-2 pr-4')}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="settings-rows">
            {records.data.map((record) => {
              const what = `the ${record.type} record for ${record.name}`;
              return (
                <tr key={record.id} className="transition-colors hover:bg-foreground/[0.03]">
                  <td className="py-2 pl-4 pr-3">
                    <Chip tone="primary" className="font-mono">
                      {record.type}
                    </Chip>
                  </td>
                  <td className="px-3 py-2">
                    {/* A long name or content shows in full on hover or keyboard focus. */}
                    <TruncatedText
                      text={relativeName(record.name, zone.name)}
                      className="font-mono text-xs"
                    />
                  </td>
                  <td className="px-3 py-2">
                    <TruncatedText text={record.content} className="font-mono text-xs" />
                  </td>
                  <td className="px-3 py-2">
                    <span className="flex items-center gap-2">
                      {record.proxiable && record.editable && (
                        <Switch
                          checked={record.proxied}
                          disabled={changing === record.id}
                          aria-label={`Proxy ${record.name} through Cloudflare`}
                          onCheckedChange={(checked) => void setProxy(record, checked)}
                        />
                      )}
                      <Chip tone={record.proxied ? 'warning' : 'neutral'}>
                        {record.proxied ? 'Proxied' : 'DNS only'}
                      </Chip>
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs text-muted-foreground">
                    {ttlLabel(record.ttl)}
                  </td>
                  <td className="py-2 pl-3 pr-3">
                    {record.editable ? (
                      <span className="flex justify-end gap-0.5">
                        <SimpleTooltip label="Edit record">
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`Edit ${what}`}
                            onClick={() => setEditing(record)}
                          >
                            <Pencil />
                          </Button>
                        </SimpleTooltip>
                        <SimpleTooltip label="Delete record">
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            className="hover:bg-destructive/10 hover:text-destructive"
                            aria-label={`Delete ${what}`}
                            onClick={() => void remove(record)}
                          >
                            <Trash2 />
                          </Button>
                        </SimpleTooltip>
                      </span>
                    ) : (
                      <span className="block whitespace-nowrap pr-1 text-right text-xs text-muted-foreground">
                        Edit on Cloudflare
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <CloudflareCard
      icon={<Globe />}
      title="DNS records"
      description={
        records.data
          ? `${records.data.length} ${records.data.length === 1 ? 'record' : 'records'} in ${zone.name}.`
          : `The records in ${zone.name}.`
      }
      actions={
        <>
          <Button size="sm" variant="soft" onClick={() => setPointing(true)}>
            <Server className="h-3.5 w-3.5" /> Point domain to a server
          </Button>
          <Button size="sm" onClick={() => setEditing(null)}>
            <Plus className="h-3.5 w-3.5" /> Add record
          </Button>
        </>
      }
    >
      {body}
      {editing !== undefined && (
        <RecordDialog
          key={editing?.id ?? 'new'}
          zone={zone}
          record={editing ?? undefined}
          open
          onOpenChange={(open) => {
            if (!open) setEditing(undefined);
          }}
        />
      )}
      {pointing && <PointDomainDialog zone={zone} open onOpenChange={setPointing} />}
    </CloudflareCard>
  );
}
