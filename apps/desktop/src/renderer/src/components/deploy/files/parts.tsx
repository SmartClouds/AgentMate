import type { FileSiteProtocol, FilesPendingFile } from '@shared/deployFilesTypes';
import { Key, Lock, LockOpen } from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { CHANGE_LABEL } from './copy';
import { PROTOCOL_DESCRIPTION, PROTOCOL_LABEL } from './messages';

/** Small pieces the FTP and SFTP screens share: the change chip and the protocol marks. */

const CHANGE_TONE = {
  added: 'success',
  modified: 'warning',
  deleted: 'destructive',
} as const;

/** What happened to a file, as a word in a tinted chip, so it never rests on colour alone. */
export function ChangeChip({
  change,
  className,
}: {
  change: FilesPendingFile['change'];
  className?: string;
}): React.JSX.Element {
  return (
    <Chip tone={CHANGE_TONE[change]} className={cn('w-[4.75rem] justify-center', className)}>
      {CHANGE_LABEL[change]}
    </Chip>
  );
}

const PROTOCOL_ICON = { sftp: Key, ftps: Lock, ftp: LockOpen } as const;

/** The protocol's icon, for beside its name: a key for SSH, a lock open for plain FTP. */
export function ProtocolIcon({
  protocol,
  className,
}: {
  protocol: FileSiteProtocol;
  className?: string;
}): React.JSX.Element {
  const Icon = PROTOCOL_ICON[protocol];
  return (
    <Icon
      aria-hidden
      className={cn(className, protocol === 'ftp' ? 'text-warning' : 'text-muted-foreground')}
    />
  );
}

/** The protocol as a small chip: its icon and its name. */
export function ProtocolChip({
  protocol,
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { protocol: FileSiteProtocol }): React.JSX.Element {
  return (
    <Chip className={cn('gap-1', className)} {...props}>
      <ProtocolIcon protocol={protocol} />
      {PROTOCOL_LABEL[protocol]}
    </Chip>
  );
}

/** "Not encrypted", for plain FTP, with what that means on hover or focus. */
export function NotEncryptedChip({ focusable = false }: { focusable?: boolean }) {
  const chip = (
    <Chip
      tone="warning"
      tabIndex={focusable ? 0 : undefined}
      className={cn(focusable && 'outline-none focus-visible:ring-2 focus-visible:ring-ring')}
    >
      Not encrypted
    </Chip>
  );
  return focusable ? <SimpleTooltip label={PROTOCOL_DESCRIPTION.ftp}>{chip}</SimpleTooltip> : chip;
}
