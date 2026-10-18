import type {
  FilesCertificateInfo,
  FilesTestResult,
  FilesTestStepResult,
} from '@shared/deployFilesTypes';
import { formatHostKeyFingerprint } from '@shared/sshHostKey';
import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { stepLabel, TestConnectionChecklist } from './TestConnectionChecklist';

/**
 * The checklist Test connection draws: one plain line per step, the reason when one fails, and a
 * fix for the failures that have one (trust a host key, use the certificate's own name, trust a
 * certificate).
 */

const ALL_OK: FilesTestStepResult[] = (
  ['reach', 'login', 'folder', 'write', 'replace', 'time', 'cleanup'] as const
).map((step) => ({ step, status: 'ok', message: null }));

function result(overrides: Partial<FilesTestResult> = {}): FilesTestResult {
  return {
    ok: true,
    steps: ALL_OK,
    capabilities: { atomicReplace: true, mtime: 'exact', checkedAt: 1 },
    remoteRoot: '/public_html',
    hostKey: null,
    certificate: null,
    error: null,
    ...overrides,
  };
}

function failedAt(
  failing: FilesTestStepResult['step'],
  message: string | null = null,
): FilesTestStepResult[] {
  const at = ALL_OK.findIndex((one) => one.step === failing);
  return ALL_OK.map((one, index) =>
    index < at
      ? one
      : index === at
        ? { step: one.step, status: 'failed', message }
        : { step: one.step, status: 'skipped', message: null },
  );
}

const certificate: FilesCertificateInfo = {
  fingerprint256: 'ab'.repeat(32),
  subject: 'CN=files.example',
  issuer: 'CN=files.example',
  names: ['files.example'],
  validTo: '2027-06-15T12:00:00.000Z',
  reason: 'selfSigned',
};

function renderChecklist(props: Partial<React.ComponentProps<typeof TestConnectionChecklist>>) {
  const handlers = {
    onTrustHostKey: vi.fn(),
    onUseServername: vi.fn(),
    onTrustCertificate: vi.fn(),
  };
  const view = renderWithProviders(
    <TestConnectionChecklist
      result={null}
      testing={false}
      host="ftp.bakery.example"
      {...handlers}
      {...props}
    />,
  );
  return { ...view, ...handlers };
}

describe('stepLabel', () => {
  it('says each step plainly for every outcome', () => {
    expect(stepLabel('reach', 'ok')).toBe('Reached the server');
    expect(stepLabel('login', 'ok')).toBe('Signed in');
    expect(stepLabel('folder', 'ok')).toBe('Found the folder');
    expect(stepLabel('write', 'ok')).toBe('Can write files');
    expect(stepLabel('replace', 'ok')).toBe('Replaces files in one step');
    expect(stepLabel('time', 'ok')).toBe('Can see when files change on the server');
    expect(stepLabel('cleanup', 'ok')).toBe('Removed the test file');

    expect(stepLabel('replace', 'warning')).toBe('Replaces files in two steps');
    expect(stepLabel('time', 'warning')).toBe('Can only compare file sizes on the server');
    expect(stepLabel('cleanup', 'warning')).toBe("Couldn't remove the test file");
    expect(stepLabel('folder', 'warning')).toBe('Found the folder');

    expect(stepLabel('reach', 'failed')).toBe("Couldn't reach the server");
    expect(stepLabel('login', 'failed')).toBe("Couldn't sign in");
    expect(stepLabel('folder', 'failed')).toBe("Couldn't find the folder");
    expect(stepLabel('write', 'failed')).toBe("Can't write files there");

    expect(stepLabel('login', 'skipped')).toBe('Sign in');
    expect(stepLabel('time', 'skipped')).toBe('Check how changes on the server can be seen');
  });
});

describe('TestConnectionChecklist', () => {
  it('draws nothing before the first test', () => {
    const { container } = renderChecklist({});
    expect(container.textContent).toBe('');
  });

  it('shimmers its rows while a test runs, never an overlay', () => {
    renderChecklist({ testing: true, result: result() });

    const list = screen.getByRole('list', { name: 'Connection test' });
    expect(list.getAttribute('aria-busy')).toBe('true');
    expect(within(list).getAllByRole('listitem')).toHaveLength(7);
    expect(list.querySelectorAll('.shimmer').length).toBeGreaterThan(0);
    expect(screen.getByRole('status').textContent).toMatch(/Testing the connection/);
    expect(screen.queryByText('Reached the server')).toBeNull();
  });

  it('lists every step that passed and says the site is ready', () => {
    renderChecklist({ result: result() });

    const rows = within(screen.getByRole('list', { name: 'Connection test' })).getAllByRole(
      'listitem',
    );
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Reached the server'),
      expect.stringContaining('Signed in'),
      expect.stringContaining('Found the folder'),
      expect.stringContaining('Can write files'),
      expect.stringContaining('Replaces files in one step'),
      expect.stringContaining('Can see when files change on the server'),
      expect.stringContaining('Removed the test file'),
    ]);
    expect(screen.getByText(/Everything works/)).toBeTruthy();
  });

  it('shows warnings with their reason and still counts as working', () => {
    renderChecklist({
      result: result({
        steps: ALL_OK.map((one) =>
          one.step === 'time'
            ? { ...one, status: 'warning', message: 'This server only lists file sizes.' }
            : one,
        ),
        capabilities: { atomicReplace: true, mtime: 'none', checkedAt: 1 },
      }),
    });

    expect(screen.getByText('Can only compare file sizes on the server')).toBeTruthy();
    expect(screen.getByText('This server only lists file sizes.')).toBeTruthy();
    expect(screen.getByText(/Works, with 1 thing to know/)).toBeTruthy();
  });

  it('gives the reason for a failure from the error code, and marks later steps skipped', () => {
    renderChecklist({
      result: result({
        ok: false,
        steps: failedAt('login'),
        error: { code: 'auth', message: 'Login incorrect.' },
      }),
    });

    expect(screen.getByText("Couldn't sign in")).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/didn't accept the username/);
    expect(screen.getByText('Find the folder')).toBeTruthy();
    expect(screen.getAllByText('Skipped')).toHaveLength(5);
  });

  it("uses the server's own words for an error code that carries them", () => {
    renderChecklist({
      result: result({
        ok: false,
        steps: failedAt('write', '550 Permission denied on /public_html.'),
        error: { code: 'permissionDenied', message: '550 Permission denied on /public_html.' },
      }),
    });

    expect(screen.getByRole('alert').textContent).toMatch(/550 Permission denied/);
    // The step does not repeat what the alert already says.
    expect(screen.getAllByText(/550 Permission denied/)).toHaveLength(1);
  });

  it('falls back to the failed step message when there is no error', () => {
    renderChecklist({
      result: result({ ok: false, steps: failedAt('folder', 'No such folder.'), error: null }),
    });
    expect(screen.getByText('No such folder.')).toBeTruthy();
  });

  it('shows a failure of the test call itself', () => {
    renderChecklist({ failure: 'Another deploy or test of this site is still running.' });
    expect(screen.getByRole('alert').textContent).toMatch(/still running/);
  });

  it('shows a first-seen host key in the form OpenSSH prints, and trusts it on request', async () => {
    const presented = 'cd'.repeat(32);
    const { user, onTrustHostKey } = renderChecklist({
      result: result({
        ok: false,
        steps: failedAt('reach'),
        hostKey: { presented, stored: null },
        error: { code: 'hostKeyUnknown', message: 'Not trusted yet.' },
      }),
    });

    expect(screen.getByText('First connection to this server')).toBeTruthy();
    expect(screen.getByText(formatHostKeyFingerprint(presented))).toBeTruthy();
    // The fix card explains it, so the generic "run Test connection" words stay out.
    expect(screen.queryByText(/Run Test connection/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Trust this key' }));
    expect(onTrustHostKey).toHaveBeenCalledWith(presented);
  });

  it('shows both keys when the host key changed', () => {
    const stored = 'ab'.repeat(32);
    const presented = 'cd'.repeat(32);
    renderChecklist({
      result: result({
        ok: false,
        steps: failedAt('reach'),
        hostKey: { presented, stored },
        error: { code: 'hostKeyChanged', message: 'Changed.' },
      }),
    });

    expect(screen.getByText("The server's host key changed")).toBeTruthy();
    expect(screen.getByText(formatHostKeyFingerprint(stored))).toBeTruthy();
    expect(screen.getByText(formatHostKeyFingerprint(presented))).toBeTruthy();
  });

  it("offers the certificate's own names for a name mismatch, skipping wildcards", async () => {
    const { user, onUseServername } = renderChecklist({
      result: result({
        ok: false,
        steps: failedAt('reach'),
        certificate: {
          ...certificate,
          reason: 'nameMismatch',
          names: ['*.sharedhost.example', 'server12.sharedhost.example'],
        },
        error: { code: 'tlsNameMismatch', message: 'Name mismatch.' },
      }),
    });

    expect(screen.getByText(/\*\.sharedhost\.example, server12\.sharedhost\.example/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Use *.sharedhost.example' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Use server12.sharedhost.example' }));
    expect(onUseServername).toHaveBeenCalledWith('server12.sharedhost.example');
  });

  it('says to change the host when a mismatched certificate only has wildcard names', () => {
    renderChecklist({
      result: result({
        ok: false,
        steps: failedAt('reach'),
        certificate: { ...certificate, reason: 'nameMismatch', names: ['*.sharedhost.example'] },
        error: { code: 'tlsNameMismatch', message: 'Name mismatch.' },
      }),
    });
    expect(screen.getByText(/Change Host to a name it covers/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Use / })).toBeNull();
  });

  it.each([
    ['selfSigned', /self-signed/],
    ['untrusted', /issuer this computer doesn't know/],
    ['expired', /expired/],
  ] as const)('shows a %s certificate in full and trusts it on request', async (reason, words) => {
    const { user, onTrustCertificate } = renderChecklist({
      result: result({
        ok: false,
        steps: failedAt('reach'),
        certificate: { ...certificate, reason, subject: 'CN=me', issuer: 'CN=Some CA' },
        error: { code: 'tlsUntrusted', message: 'Untrusted.' },
      }),
    });

    expect(screen.getAllByText(words).length).toBeGreaterThan(0);
    const details = screen.getByRole('group', { name: 'Certificate' });
    expect(within(details).getByText('CN=me')).toBeTruthy();
    expect(within(details).getByText('CN=Some CA')).toBeTruthy();
    expect(within(details).getByText(/2027/)).toBeTruthy();
    expect(within(details).getByText(/^AB:AB:AB/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Trust this certificate' }));
    expect(onTrustCertificate).toHaveBeenCalledWith(certificate.fingerprint256);
  });

  it('keeps a date it cannot read as it came', () => {
    renderChecklist({
      result: result({
        ok: false,
        steps: failedAt('reach'),
        certificate: { ...certificate, validTo: 'whenever' },
        error: { code: 'tlsUntrusted', message: 'Untrusted.' },
      }),
    });
    expect(screen.getByText('whenever')).toBeTruthy();
  });
});
