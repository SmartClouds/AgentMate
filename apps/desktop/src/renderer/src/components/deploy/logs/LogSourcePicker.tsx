import type {
  ContainerList,
  SiteInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { Combobox } from '@/components/ui/combobox';
import type { LogSource } from './useLogSource';

/**
 * Picks what the logs center shows (E09 T1): one container, every service of an app at once, a
 * systemd unit's journal (any unit name can be typed), a site's access or error log, or the core's
 * audit trail. A choice is a string so the picker can search it; `parseSourceValue` reads it back.
 * Scoped to one app, it offers only that app and its containers.
 */

export const COMMON_UNITS = [
  'docker.service',
  'nginx.service',
  'ssh.service',
  'runova-core.service',
];

export function sourceValue(source: LogSource): string {
  switch (source.kind) {
    case 'container':
      return `container:${source.containerId}`;
    case 'stack':
      return `stack:${source.project}`;
    case 'journal':
      return `journal:${source.unit}`;
    case 'site':
      return `site:${source.logKind}:${source.siteId}`;
    case 'audit':
      return 'audit';
  }
}

export function parseSourceValue(
  value: string,
  containers: ContainerList | undefined,
  sites: readonly SiteInfo[] | undefined,
): LogSource | null {
  const [kind, ...rest] = value.split(':');
  const id = rest.join(':');
  const all = containers?.groups.flatMap((group) => group.containers) ?? [];
  if (kind === 'container') {
    const container = all.find((item) => item.id === id);
    return container
      ? { kind: 'container', containerId: container.id, label: container.name }
      : null;
  }
  if (kind === 'stack') {
    const members = all.filter((item) => item.composeProject === id);
    return members.length === 0
      ? null
      : {
          kind: 'stack',
          project: id,
          label: id,
          containers: members.map((item) => ({
            id: item.id,
            service: item.composeService ?? item.name,
          })),
        };
  }
  if (kind === 'site') {
    const [logKind, ...siteParts] = rest;
    const siteId = siteParts.join(':');
    const site = sites?.find((item) => item.settings.id === siteId);
    if (!site || (logKind !== 'access' && logKind !== 'error')) return null;
    const domain = site.settings.domains[0] ?? siteId;
    return { kind: 'site', siteId, logKind, label: `${domain} ${logKind} log` };
  }
  if (value === 'audit') return { kind: 'audit', label: 'Core audit trail' };
  // A journal choice, or a unit name typed in the search box.
  const unit = kind === 'journal' ? id : value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9@_.:\\-]{0,127}$/.test(unit)
    ? { kind: 'journal', unit, label: unit }
    : null;
}

export function LogSourcePicker({
  value,
  containers,
  sites,
  scope,
  onChange,
}: {
  value: string;
  containers: ContainerList | undefined;
  sites: readonly SiteInfo[] | undefined;
  /** 'stack' offers only the app and its containers, as given in `containers`. */
  scope?: 'stack';
  onChange: (value: string) => void;
}): React.JSX.Element {
  const groups = containers?.groups ?? [];
  const stackOnly = scope === 'stack';
  const options = [
    ...groups
      .filter((group) => group.project)
      .map((group) => ({
        value: `stack:${group.project}`,
        label: `App ${group.project}: every service`,
      })),
    ...groups.flatMap((group) =>
      group.containers.map((container) => ({
        value: `container:${container.id}`,
        label: `Container ${container.name}`,
      })),
    ),
  ];
  if (!stackOnly) {
    options.push(
      ...COMMON_UNITS.map((unit) => ({ value: `journal:${unit}`, label: `Journal ${unit}` })),
      ...(sites ?? []).flatMap((site) =>
        (['access', 'error'] as const).map((logKind) => ({
          value: `site:${logKind}:${site.settings.id}`,
          label: `Site ${site.settings.domains[0] ?? site.settings.id}: ${logKind} log`,
        })),
      ),
      { value: 'audit', label: 'Core audit trail' },
    );
  }
  return (
    <Combobox
      className="h-8 w-72 text-xs"
      value={value}
      onChange={onChange}
      options={options}
      placeholder="Choose a log"
      searchPlaceholder={stackOnly ? 'Search' : 'Search, or type a unit name'}
      allowCustom={!stackOnly}
      customLabel={(text) => `Journal of ${text}`}
      ariaLabel="Log source"
    />
  );
}
