import { X509Certificate } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { type FakeRdpServer, startFakeRdpServer } from '../src/main/rdp/testing/fakeRdpServer';
import { rdpStyleCertificate, type TestCertificate } from '../src/main/rdp/testing/rdpCertificate';
import { type LaunchedApp, launchApp } from './app';

/**
 * A Windows Server reinstalled with its own Remote Desktop certificate (Key Usage: Key
 * Encipherment, Data Encipherment). The app's TLS stack (BoringSSL, in the real Electron main
 * process) refused it with KEY_USAGE_BIT_INCORRECT, before the saved fingerprint was compared, and
 * the window showed that error with its source path. No Docker: a small Node server answers like
 * Windows does up to the end of the TLS handshake, which is where all of this happens.
 */

const OPTIONS = {
  resolution: 'fitWindow',
  fullscreenOnConnect: false,
  maximizeOnConnect: true,
  clipboard: false,
  fileTransfer: false,
  nla: false,
};

const LIBRARY_TEXT = /error:\d|OPENSSL_internal|boringssl|ssl_cert|third_party/i;

interface SavedServer {
  id: string;
  certFingerprint?: string;
}

interface CertificateCheck {
  ok: boolean;
  check?: { status: string; certificate: { fingerprint: string } };
  failure?: { code: string };
}

let launched: LaunchedApp | undefined;
const servers: FakeRdpServer[] = [];

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function serve(
  certificate: TestCertificate,
  tlsOptions?: Parameters<typeof startFakeRdpServer>[1],
  port?: number,
): Promise<FakeRdpServer> {
  const server = await startFakeRdpServer(certificate, tlsOptions, port);
  servers.push(server);
  return server;
}

async function rdp<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  return (await page.evaluate(
    ([name, params]) =>
      (
        window as unknown as {
          agentmat: { rdp: Record<string, (...input: unknown[]) => Promise<unknown>> };
        }
      ).agentmat.rdp[name as string](...(params as unknown[])),
    [method, args] as const,
  )) as T;
}

async function saveServer(page: Page, port: number): Promise<SavedServer> {
  return rdp<SavedServer>(page, 'saveServer', {
    nickname: 'Reinstalled box',
    host: '127.0.0.1',
    port,
    username: 'Administrator',
    secret: 'pw',
    options: OPTIONS,
  });
}

async function savedFingerprint(page: Page, id: string): Promise<string | undefined> {
  const list = await rdp<SavedServer[]>(page, 'listServers');
  return list.find((server) => server.id === id)?.certFingerprint;
}

/** Opens a session on a saved server and returns its window. */
async function openSession(app: LaunchedApp, id: string): Promise<Page> {
  const opened = app.app.waitForEvent('window', {
    predicate: (win) => win.url().includes('rdp-session'),
    timeout: 30_000,
  });
  await rdp<string>(app.page, 'openSession', id);
  const session = await opened;
  await session.waitForFunction(() => Boolean((window as { agentmat?: unknown }).agentmat));
  return session;
}

async function launch(): Promise<LaunchedApp> {
  launched = await launchApp({});
  return launched;
}

test('reads the certificate of a Windows-style server and trusts it, as on a first connect', async () => {
  const windows = rdpStyleCertificate('windows');
  const server = await serve(windows);
  const { page } = await launch();
  const saved = await saveServer(page, server.port);

  const result = await rdp<CertificateCheck>(page, 'checkCertificate', saved.id);

  // Through the real TLS stack, which refuses this certificate with its normal settings.
  expect(result.failure).toBeUndefined();
  expect(result.ok).toBe(true);
  expect(result.check?.status).toBe('new');
  const fingerprint = new X509Certificate(windows.cert).fingerprint256;
  expect(result.check?.certificate.fingerprint).toBe(fingerprint);

  await rdp(page, 'trustCertificate', saved.id, fingerprint);
  expect(await savedFingerprint(page, saved.id)).toBe(fingerprint);
});

test('shows the new certificate of a reinstalled server in the Certificate dialog and trusts it', async () => {
  const testInfo = test.info();
  const before = rdpStyleCertificate('windows', 'WIN-BEFORE');
  const first = await serve(before);
  const { page } = await launch();
  const saved = await saveServer(page, first.port);
  const oldFingerprint = new X509Certificate(before.cert).fingerprint256;
  await rdp(page, 'checkCertificate', saved.id);
  await rdp(page, 'trustCertificate', saved.id, oldFingerprint);

  // The server is reinstalled: same address, new certificate.
  const port = first.port;
  await first.close();
  const after = rdpStyleCertificate('windows', 'WIN-AFTER');
  await serve(after, undefined, port);
  const newFingerprint = new X509Certificate(after.cert).fingerprint256;

  await page.evaluate(() => {
    location.hash = '#/remote';
  });
  await page.getByRole('button', { name: 'Remote Desktop', exact: true }).click();
  await page.getByRole('button', { name: 'Certificate for Reinstalled box' }).click();
  const dialog = page.getByRole('dialog', { name: 'Certificate for Reinstalled box' });
  await expect(dialog).toContainText(oldFingerprint);
  await expect(dialog).toContainText('CN=WIN-BEFORE');

  await dialog.getByRole('button', { name: /Get certificate from server/ }).click();

  await expect(dialog.getByText(/This is not the certificate AgentMate saved/)).toBeVisible();
  await expect(dialog).toContainText(newFingerprint);
  await testInfo.attach('certificate-changed.png', {
    body: await dialog.screenshot({ animations: 'disabled' }),
    contentType: 'image/png',
  });

  await dialog.getByRole('button', { name: 'Trust this certificate' }).click();
  await expect.poll(() => savedFingerprint(page, saved.id)).toBe(newFingerprint);
  await expect(dialog).toContainText('CN=WIN-AFTER');
  await expect(dialog.getByRole('button', { name: 'Trust this certificate' })).toHaveCount(0);
});

test('forgets the saved certificate from the dialog', async () => {
  const windows = rdpStyleCertificate('windows');
  const server = await serve(windows);
  const { page } = await launch();
  const saved = await saveServer(page, server.port);
  const fingerprint = new X509Certificate(windows.cert).fingerprint256;
  await rdp(page, 'checkCertificate', saved.id);
  await rdp(page, 'trustCertificate', saved.id, fingerprint);

  await page.evaluate(() => {
    location.hash = '#/remote';
  });
  await page.getByRole('button', { name: 'Remote Desktop', exact: true }).click();
  await page.getByRole('button', { name: 'Certificate for Reinstalled box' }).click();
  const dialog = page.getByRole('dialog', { name: 'Certificate for Reinstalled box' });
  await dialog.getByRole('button', { name: /Forget saved certificate/ }).click();
  await page.getByRole('button', { name: 'Forget certificate' }).click();

  await expect.poll(() => savedFingerprint(page, saved.id)).toBeUndefined();
  await expect(dialog.getByText(/Nothing is saved yet/)).toBeVisible();
});

test('explains a certificate the server will not let the app use, without the library error', async () => {
  const testInfo = test.info();
  // Only ECDHE on offer: the normal handshake fails on the certificate's key usage, and so does
  // the RSA retry, because this server has turned RSA key exchange off.
  const server = await serve(rdpStyleCertificate('windows'), {
    ciphers: 'ECDHE-RSA-AES128-GCM-SHA256',
    maxVersion: 'TLSv1.2',
  });
  const app = await launch();
  const saved = await saveServer(app.page, server.port);

  const session = await openSession(app, saved.id);

  const card = session.getByRole('alert');
  await expect(card).toContainText("The server's certificate can't be used", { timeout: 60_000 });
  await expect(card).toContainText('What you can try');
  await expect(card.getByRole('button', { name: 'Reconnect' })).toBeVisible();
  expect(await session.locator('body').innerText()).not.toMatch(LIBRARY_TEXT);

  // The reason is kept for support, folded away, and free of source locations.
  const details = card.locator('details');
  await expect(details).not.toHaveAttribute('open', '');
  await details.getByText('Technical details').click();
  await expect(details).toContainText('KEY_USAGE_BIT_INCORRECT (SSL routines)');
  expect(await session.locator('body').textContent()).not.toMatch(LIBRARY_TEXT);
  await testInfo.attach('key-usage-failure.png', {
    body: await session.screenshot({ animations: 'disabled' }),
    contentType: 'image/png',
  });
});

test('says a server refused the connection in words', async () => {
  const closed = await serve(rdpStyleCertificate('windows'));
  const { port } = closed;
  await closed.close();
  const app = await launch();
  const saved = await saveServer(app.page, port);

  const session = await openSession(app, saved.id);

  const card = session.getByRole('alert');
  await expect(card).toContainText('The server refused the connection', { timeout: 60_000 });
  await expect(card).toContainText(`127.0.0.1:${port} refused the connection.`);
  expect(await session.locator('body').innerText()).not.toMatch(/ECONNREFUSED/);
});

test('lets a person review and trust the changed certificate after saying no', async () => {
  const testInfo = test.info();
  const before = rdpStyleCertificate('windows', 'WIN-BEFORE');
  const first = await serve(before);
  const app = await launch();
  const saved = await saveServer(app.page, first.port);
  await rdp(app.page, 'checkCertificate', saved.id);
  await rdp(
    app.page,
    'trustCertificate',
    saved.id,
    new X509Certificate(before.cert).fingerprint256,
  );

  const port = first.port;
  await first.close();
  const after = rdpStyleCertificate('windows', 'WIN-AFTER');
  await serve(after, undefined, port);
  const newFingerprint = new X509Certificate(after.cert).fingerprint256;

  const session = await openSession(app, saved.id);

  // Reinstalled server: the certificate prompt, not the library error.
  const prompt = session.getByRole('dialog', { name: /The server's certificate changed/ });
  await expect(prompt).toBeVisible({ timeout: 60_000 });
  await expect(prompt).toContainText(newFingerprint);
  await prompt.getByRole('button', { name: "Don't connect" }).click();

  // Saying no is not the end of it: the failed screen brings the question back.
  const card = session.getByRole('alert');
  await expect(card).toContainText("The server's certificate changed");
  expect(await session.locator('body').innerText()).not.toMatch(LIBRARY_TEXT);
  await testInfo.attach('certificate-changed-failure.png', {
    body: await session.screenshot({ animations: 'disabled' }),
    contentType: 'image/png',
  });
  await card.getByRole('button', { name: 'Review certificate' }).click();
  await expect(prompt).toBeVisible();

  await prompt.getByRole('button', { name: 'Trust and connect' }).click();
  await expect.poll(() => savedFingerprint(app.page, saved.id)).toBe(newFingerprint);
  await expect(prompt).toBeHidden();
});
