import type {
  CloudflareSecurityLevel,
  CloudflareSettingChange,
  CloudflareZone,
  CloudflareZoneSettings,
} from '@shared/cloudflareTypes';
import { type UseQueryResult, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { cloudflareFailureText, useCloudflareError } from '@/lib/cloudflare/feedback';
import { queryKeys } from '@/lib/queryKeys';

/**
 * The security level each zone had before I'm Under Attack went on, so switching it off goes back
 * there. It lasts as long as the window does, which covers an attack being ridden out.
 */
const levelsBeforeAttack = new Map<string, CloudflareSecurityLevel>();

/** The level to go back to once an attack is over: the one from before, else Cloudflare's default. */
export function levelBeforeAttack(zoneId: string): CloudflareSecurityLevel {
  return levelsBeforeAttack.get(zoneId) ?? 'medium';
}

export interface ZoneSettings {
  query: UseQueryResult<CloudflareZoneSettings>;
  /** The load error in words, once there is one. */
  loadError: string | null;
  /** The setting being written, so only its control waits. */
  saving: CloudflareSettingChange['setting'] | null;
  /** Writes one setting, keeps Cloudflare's answer and says how it went. */
  change: (next: CloudflareSettingChange, done: string) => Promise<void>;
}

/**
 * A zone's settings, shared by the header switches and the SSL/TLS, Caching and Security tabs.
 * They all read the one query, so a change made in one place shows everywhere at once.
 */
export function useZoneSettings(zone: CloudflareZone): ZoneSettings {
  const queryClient = useQueryClient();
  const key = queryKeys.cloudflareSettings(zone.id);
  const query = useQuery({
    queryKey: key,
    queryFn: () => window.runova.cloudflare.zoneSettings(zone.id),
  });
  const loadError = useCloudflareError(query.error);
  const [saving, setSaving] = useState<CloudflareSettingChange['setting'] | null>(null);

  const level = query.data?.securityLevel.value;
  useEffect(() => {
    if (level && level !== 'under_attack') levelsBeforeAttack.set(zone.id, level);
  }, [level, zone.id]);

  async function change(next: CloudflareSettingChange, done: string): Promise<void> {
    setSaving(next.setting);
    try {
      queryClient.setQueryData(key, await window.runova.cloudflare.changeSetting(zone.id, next));
      toast.success(done);
    } catch (error) {
      toast.error(cloudflareFailureText(error, queryClient));
    } finally {
      setSaving(null);
    }
  }

  return { query, loadError, saving, change };
}
