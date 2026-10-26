import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Key } from '@/components/icons';
import { Button } from '@/components/ui/button';

/**
 * Floats over an SSH terminal while the shell sits on a password prompt (sudo, su, ...) and the
 * server has a saved login password. One click types it in, so the user doesn't have to. The
 * password itself stays in the main process; this only asks for it to be typed.
 */
export function SshPasswordButton({
  sessionId,
  onTyped,
}: {
  sessionId: string;
  /** Hands focus back to the terminal, which is where the user carries on. */
  onTyped: () => void;
}): React.JSX.Element | null {
  const [prompting, setPrompting] = useState(false);
  const [typing, setTyping] = useState(false);

  useEffect(
    () =>
      window.runova.ssh.onPasswordPrompt((payload) => {
        if (payload.sessionId === sessionId) setPrompting(payload.prompting);
      }),
    [sessionId],
  );

  if (!prompting) return null;

  async function typePassword(): Promise<void> {
    setTyping(true);
    try {
      const typed = await window.runova.ssh.typePassword(sessionId);
      if (typed) setPrompting(false);
      else toast.error("Couldn't read the saved password. Type it in the terminal instead.");
    } catch {
      toast.error("Couldn't enter the password. Type it in the terminal instead.");
    } finally {
      setTyping(false);
      onTyped();
    }
  }

  return (
    <div className="pointer-events-none absolute right-3 bottom-3 z-10">
      <Button
        size="sm"
        disabled={typing}
        onClick={() => void typePassword()}
        className="pointer-events-auto gap-1.5 shadow-lg"
      >
        <Key className="h-3 w-3" />
        Enter saved password
      </Button>
    </div>
  );
}
