import { recaptchaErrorCode, recaptchaErrorMessage } from '@shared/recaptchaErrors';
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { queryKeys } from '@/lib/queryKeys';

/**
 * What to tell the user about a failed reCAPTCHA call. A locked vault, a sign-in Google no longer
 * accepts, or an account that is gone also changes what the page should show, so the status is
 * fetched again and the page moves to the matching fix.
 */

function aboutTheSignIn(error: unknown): boolean {
  const code = recaptchaErrorCode(error);
  return code === 'reauth' || code === 'locked' || code === 'no-account';
}

/** For a failed change, in an event handler. */
export function recaptchaFailureText(error: unknown, queryClient: QueryClient): string {
  if (aboutTheSignIn(error)) {
    void queryClient.invalidateQueries({ queryKey: queryKeys.recaptchaStatus });
  }
  return recaptchaErrorMessage(error);
}

/** For a failed query, while rendering, with the status refreshed from an effect. */
export function useRecaptchaError(error: unknown): string | null {
  const queryClient = useQueryClient();
  const aboutSignIn = Boolean(error) && aboutTheSignIn(error);
  const message = error ? recaptchaErrorMessage(error) : null;
  useEffect(() => {
    if (aboutSignIn) void queryClient.invalidateQueries({ queryKey: queryKeys.recaptchaStatus });
  }, [aboutSignIn, message, queryClient]);
  return message;
}
