import type { RecaptchaAccount, RecaptchaSignInInput } from '@shared/deployRecaptchaTypes';
import { recaptchaErrorMessage } from '@shared/recaptchaErrors';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { ArrowLeft, Check, ChevronDown, ExternalLink, Spinner } from '@/components/icons';
import { GLASS_CARD, Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SecretInput } from '@/components/ui/secret-input';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import { GoogleButton } from './GoogleButton';
import { RecaptchaMark } from './RecaptchaMark';

const CREDENTIALS_URL = 'https://console.cloud.google.com/apis/credentials';

const BENEFITS = [
  'A key for any of your sites in a few clicks, with its domains filled in.',
  'The site key, the secret and ready-to-paste code, right when you need them.',
  'Every key in one place, across your Google accounts and projects.',
];

/** Signing in, as the panel and the lapsed-sign-in notice both do it. */
export function useGoogleSignIn(onSignedIn: (account: RecaptchaAccount) => void) {
  const queryClient = useQueryClient();
  const [waiting, setWaiting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function signIn(input: RecaptchaSignInInput): Promise<void> {
    setWaiting(true);
    setProblem(null);
    try {
      const account = await window.runova.deployRecaptcha.signIn(input);
      toast.success(`Signed in as ${account.email}.`);
      await queryClient.invalidateQueries({ queryKey: queryKeys.recaptchaStatus });
      onSignedIn(account);
    } catch (error) {
      const message = recaptchaErrorMessage(error);
      // Cancelling is the user's own doing; it needs no message.
      if (!/cancelled/i.test(message)) setProblem(message);
    } finally {
      setWaiting(false);
    }
  }

  return { signIn, waiting, problem };
}

/** In place of the sign-in buttons while Google's page is open in the browser. */
export function SignInWaiting(): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl bg-primary/8 px-4 py-3 ring-1 ring-inset ring-primary/20">
      <Spinner className="h-4 w-4 text-primary" />
      <p className="min-w-0 flex-1 text-sm">
        Finish signing in in your browser. Runova waits up to 5 minutes.
      </p>
      <Button
        type="button"
        variant="soft"
        size="sm"
        onClick={() => void window.runova.deployRecaptcha.cancelSignIn()}
      >
        Cancel
      </Button>
    </div>
  );
}

function Step({
  number,
  children,
}: {
  number: number;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/12 text-xs font-semibold text-primary ring-1 ring-inset ring-primary/20"
      >
        {number}
      </span>
      <div className="min-w-0 flex-1 space-y-2 pt-0.5 text-sm">{children}</div>
    </li>
  );
}

/** Signing in with an OAuth client the user made in their own Google Cloud. */
export function OwnClientForm({
  waiting,
  onSubmit,
}: {
  waiting: boolean;
  onSubmit: (input: RecaptchaSignInInput) => void;
}): React.JSX.Element {
  const idField = useId();
  const secretField = useId();
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  return (
    <form
      aria-label="Your own OAuth client"
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!clientId.trim()) return;
        onSubmit({
          mode: 'own',
          clientId: clientId.trim(),
          ...(clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {}),
        });
      }}
    >
      <ol className="space-y-4">
        <Step number={1}>
          <p className="font-medium">Open Credentials in Google Cloud</p>
          <Button
            type="button"
            variant="soft"
            size="sm"
            onClick={() => void window.runova.shell.openExternal(CREDENTIALS_URL)}
          >
            <ExternalLink className="h-3.5 w-3.5" /> Open Google Cloud
          </Button>
        </Step>
        <Step number={2}>
          <p className="font-medium">Create an OAuth client ID of type Desktop app</p>
          <p className="text-xs text-muted-foreground">
            In the same project, turn on the Cloud Resource Manager, Service Usage and reCAPTCHA
            Enterprise APIs.
          </p>
        </Step>
        <Step number={3}>
          <p className="font-medium">Paste its client ID and secret here</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor={idField}>Client ID</Label>
              <Input
                id={idField}
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
                placeholder="1234.apps.googleusercontent.com"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={secretField}>Client secret</Label>
              <SecretInput id={secretField} value={clientSecret} onChange={setClientSecret} />
            </div>
          </div>
        </Step>
      </ol>
      {waiting ? <SignInWaiting /> : <GoogleButton type="submit" disabled={!clientId.trim()} />}
    </form>
  );
}

/**
 * The welcome for a page with no Google sign-in yet (or another one being added): what the page
 * does in three lines and a Google sign-in button. A user who would rather use their own OAuth
 * client finds it folded away underneath; in a build without Runova's own client it is the form.
 */
export function SignInPanel({
  runovaClient,
  onSignedIn,
  onBack,
}: {
  runovaClient: boolean;
  onSignedIn: (account: RecaptchaAccount) => void;
  onBack?: () => void;
}): React.JSX.Element {
  const { signIn, waiting, problem } = useGoogleSignIn(onSignedIn);
  const [ownOpen, setOwnOpen] = useState(!runovaClient);

  return (
    <section className={cn(GLASS_CARD, 'relative overflow-hidden p-6 sm:p-8')}>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-[#4a8af4]/15 blur-3xl"
      />
      <div className="relative mx-auto flex max-w-xl flex-col gap-5">
        {onBack && (
          <Button
            type="button"
            variant="link"
            size="xs"
            className="self-start px-0"
            onClick={onBack}
          >
            <ArrowLeft className="h-3 w-3" /> Back to your keys
          </Button>
        )}
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[#4a8af4]/12 shadow-[0_0_28px_-10px_#4a8af4]">
            <RecaptchaMark className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-lg font-semibold tracking-tight text-foreground">
              {onBack ? 'Add another Google account' : 'Stop bots on your sites'}
            </h3>
            <p className="text-sm text-muted-foreground">
              Sign in with Google and Runova makes and keeps your reCAPTCHA keys.
            </p>
          </div>
        </div>

        <ul className="space-y-2">
          {BENEFITS.map((benefit) => (
            <li key={benefit} className="flex items-start gap-2 text-sm text-foreground/90">
              <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" /> {benefit}
            </li>
          ))}
        </ul>

        {problem && <Notice tone="destructive">{problem}</Notice>}

        {runovaClient && (
          <div className="space-y-2">
            {waiting && !ownOpen ? (
              <SignInWaiting />
            ) : (
              <GoogleButton
                className="w-full sm:w-auto"
                disabled={waiting}
                onClick={() => void signIn({ mode: 'runova' })}
              />
            )}
            <p className="text-xs text-muted-foreground">
              Free for up to 10,000 checks a month. No billing account needed. Your sign-in stays on
              this computer, sealed like your server passwords.
            </p>
          </div>
        )}

        {runovaClient ? (
          <div className="space-y-4">
            <button
              type="button"
              aria-expanded={ownOpen}
              onClick={() => setOwnOpen((open) => !open)}
              className="inline-flex items-center gap-1 self-start text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:h-3 [&_svg]:w-3"
            >
              <ChevronDown className={cn('transition-transform', ownOpen && 'rotate-180')} /> Use my
              own OAuth client
            </button>
            {ownOpen && (
              <OwnClientForm waiting={waiting} onSubmit={(input) => void signIn(input)} />
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              This build of Runova signs in to Google with an OAuth client you make in your own
              Google Cloud. It takes about two minutes, once. Free for up to 10,000 checks a month.
            </p>
            <OwnClientForm waiting={waiting} onSubmit={(input) => void signIn(input)} />
          </div>
        )}
      </div>
    </section>
  );
}
