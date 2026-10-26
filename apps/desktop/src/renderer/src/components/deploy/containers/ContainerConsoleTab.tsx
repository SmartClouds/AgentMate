import type { ContainerSummary } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { EXEC_USER } from '@shared/dockerNames';
import { useId, useState } from 'react';
import { Lock, Play, TerminalSquare } from '@/components/icons';
import { EmptyState } from '@/components/pageKit';
import { TerminalPane } from '@/components/terminal/TerminalPane';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { TerminalSessionMeta } from '@/stores/terminalStore';

/**
 * A shell inside a running container (E06 T6), for Admins: docker exec with a terminal, drawn
 * with the app's own terminal pane. It can also run one command of the Admin's choosing (through
 * sh, so pipes and && work) and as another user, such as root. Opening and closing it, with the
 * command and the user, land in the server's audit trail; what is typed does not. It opens on
 * request, not when the tab is shown.
 */

/** The user the image runs as, which docker exec takes when none is given. */
const OWN_USER = 'own';
/** As long as one argument may be, on the core and in main. */
const MAX_COMMAND = 4_096;

const USERS = [
  { value: OWN_USER, label: 'Its own user' },
  { value: 'root', label: 'root' },
];

export function ContainerConsoleTab({
  serverId,
  container,
  canOpen,
}: {
  serverId: string;
  container: ContainerSummary;
  canOpen: boolean;
}): React.JSX.Element {
  const [session, setSession] = useState<TerminalSessionMeta | null>(null);
  const [ended, setEnded] = useState(false);
  const [command, setCommand] = useState('');
  const [user, setUser] = useState(OWN_USER);
  const fields = useId();

  if (!canOpen) {
    return (
      <EmptyState
        size="sm"
        icon={Lock}
        title="Consoles are for Admins"
        description="A shell in a container can read and change everything in it."
      />
    );
  }
  if (container.state !== 'running') {
    return (
      <EmptyState
        size="sm"
        icon={TerminalSquare}
        title="Not running"
        description={`${container.name} is not running. Start it to open a console.`}
      />
    );
  }

  const program = command.trim();
  const userValid = user === OWN_USER || EXEC_USER.test(user);
  const asWho = user === OWN_USER ? '' : ` as ${user}`;

  const open = () => {
    if (!userValid) return;
    setEnded(false);
    setSession({
      id: crypto.randomUUID(),
      title: container.name,
      kind: 'container',
      container: {
        serverId,
        containerId: container.id,
        ...(program ? { command: ['/bin/sh', '-c', program] } : {}),
        ...(user === OWN_USER ? {} : { user }),
      },
    });
  };

  if (!session) {
    return (
      <EmptyState
        size="sm"
        icon={TerminalSquare}
        title={`A shell in ${container.name}`}
        description={`Opens bash (or sh) in ${container.name}, or runs the command you type. Opening and closing it, with the command and the user, are recorded in the server's audit trail; what you type is not.`}
        action={
          <form
            className="flex w-full max-w-xl flex-wrap items-end gap-2 text-left"
            onSubmit={(event) => {
              event.preventDefault();
              open();
            }}
          >
            <div className="min-w-56 flex-1 space-y-1">
              <Label htmlFor={`${fields}-command`} className="text-xs">
                Command
              </Label>
              <Input
                id={`${fields}-command`}
                value={command}
                onChange={(event) => setCommand(event.target.value)}
                placeholder="Empty for a shell, or such as php artisan migrate"
                maxLength={MAX_COMMAND}
                autoComplete="off"
                spellCheck={false}
                className="h-8 font-mono text-xs"
              />
            </div>
            <div className="w-40 space-y-1">
              <Label htmlFor={`${fields}-user`} className="text-xs">
                User
              </Label>
              <Combobox
                id={`${fields}-user`}
                className="h-8 text-xs"
                value={user}
                onChange={(next) => setUser(next.trim() || OWN_USER)}
                options={USERS}
                allowCustom
                customLabel={(text) => `Run as ${text}`}
                searchPlaceholder="A user, or uid:gid"
                invalid={!userValid}
                ariaDescribedBy={userValid ? undefined : `${fields}-user-error`}
              />
            </div>
            <Button type="submit" size="sm" disabled={!userValid}>
              {program ? (
                <>
                  <Play className="h-3.5 w-3.5" /> Run
                </>
              ) : (
                <>
                  <TerminalSquare className="h-3.5 w-3.5" /> Open a console
                </>
              )}
            </Button>
            {!userValid && (
              <p
                id={`${fields}-user-error`}
                role="alert"
                className="w-full text-xs text-destructive"
              >
                That is not a user name or id (such as root, node or 1000:1000).
              </p>
            )}
          </form>
        }
      />
    );
  }

  const ran = session.container?.command?.[2];
  const running = ran
    ? `Running ${ran}${asWho} in ${container.name}`
    : `Console in ${container.name}${asWho}`;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span role="status" className="min-w-0 truncate">
          {ended ? (ran ? 'The command has ended.' : 'The shell has ended.') : running}
        </span>
        <div className="flex shrink-0 gap-2">
          {ended ? (
            <Button size="sm" variant="soft" onClick={open}>
              {ran ? 'Run it again' : 'Open a new one'}
            </Button>
          ) : null}
          <Button size="sm" variant="soft" onClick={() => setSession(null)}>
            {ended ? 'Back' : 'Close the console'}
          </Button>
        </div>
      </div>
      <div
        className="relative min-h-72 flex-1 overflow-hidden rounded-xl bg-[var(--terminal-bg,#111)] ring-1 ring-inset ring-foreground/[0.08]"
        aria-label={`Console in ${container.name}`}
        role="group"
      >
        <TerminalPane key={session.id} meta={session} active onExit={() => setEnded(true)} />
      </div>
    </div>
  );
}
