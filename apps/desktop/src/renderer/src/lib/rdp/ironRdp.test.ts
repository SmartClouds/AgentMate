import type { RdpProxyErrorPayload } from '@shared/apiTypes';
import { describe, expect, it, vi } from 'vitest';
import { Backend, FakeSession, FakeSessionBuilder } from '../../../../test/renderer/mocks/ironRdp';
import { cleanEngineText, describeConnectError, mountRemoteDesktop, wrapBackend } from './ironRdp';

describe('wrapBackend', () => {
  it('keeps every other member of the backend as it is', () => {
    const wrapped = wrapBackend(Backend as never, () => undefined) as unknown as typeof Backend;
    expect(wrapped.InputTransaction).toBe(Backend.InputTransaction);
    expect(wrapped.DeviceEvent).toBe(Backend.DeviceEvent);
    expect(wrapped.DesktopSize).toBe(Backend.DesktopSize);
    expect(wrapped.SessionBuilder).not.toBe(Backend.SessionBuilder);
  });

  it('hands over the session once connect resolves, and still returns it', async () => {
    const onSession = vi.fn();
    const wrapped = wrapBackend(Backend as never, onSession) as unknown as typeof Backend;
    const builder = new wrapped.SessionBuilder();
    expect(builder).toBeInstanceOf(FakeSessionBuilder);
    // Chained builder calls still reach the real builder.
    expect(builder.renderCanvas()).toBe(builder);
    expect(onSession).not.toHaveBeenCalled();

    const session = await builder.connect();
    expect(session).toBeInstanceOf(FakeSession);
    expect(onSession).toHaveBeenCalledWith(session);
    expect(builder.calls).toEqual(['renderCanvas', 'connect']);
  });

  it('passes a failed connect through without calling back', async () => {
    const onSession = vi.fn();
    class Failing extends FakeSessionBuilder {
      override async connect(): Promise<FakeSession> {
        throw new Error('nope');
      }
    }
    const wrapped = wrapBackend(
      { ...Backend, SessionBuilder: Failing } as never,
      onSession,
    ) as unknown as {
      SessionBuilder: new () => FakeSessionBuilder;
    };
    await expect(new wrapped.SessionBuilder().connect()).rejects.toThrow('nope');
    expect(onSession).not.toHaveBeenCalled();
  });
});

describe('mountRemoteDesktop', () => {
  it('gives the element a wrapped backend and exposes its session and canvas', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onSession = vi.fn();

    const mounting = mountRemoteDesktop(host, { onSession });
    // The engine loads before the element is created.
    await vi.waitFor(() => expect(host.firstElementChild).not.toBeNull());
    const element = host.firstElementChild as HTMLElement & {
      module: typeof Backend;
    };
    const root = element.attachShadow({ mode: 'open' });
    const canvas = document.createElement('canvas');
    root.appendChild(canvas);
    element.dispatchEvent(
      new CustomEvent('ready', { detail: { irgUserInteraction: { kind: 'ui' } } }),
    );
    const mounted = await mounting;

    expect(mounted.element).toBe(element);
    expect(mounted.canvas()).toBe(canvas);
    expect(mounted.backend).toBe(element.module);

    const session = await new element.module.SessionBuilder().connect();
    expect(onSession).toHaveBeenCalledWith(session);
    host.remove();
  });

  it('reports no canvas before the element has drawn one', async () => {
    const host = document.createElement('div');
    const mounting = mountRemoteDesktop(host);
    await vi.waitFor(() => expect(host.firstElementChild).not.toBeNull());
    host.firstElementChild?.dispatchEvent(
      new CustomEvent('ready', { detail: { irgUserInteraction: {} } }),
    );
    const mounted = await mounting;
    expect(mounted.canvas()).toBeNull();
  });
});

function ironError(kind: number, backtrace: string) {
  return { kind: () => kind, backtrace: () => backtrace, rdcleanpathDetails: () => undefined };
}

const CAPABILITIES_FAILURE =
  '[ConnectionActivation::CapabilitiesExchange @ crates/ironrdp-connector/src/lib.rs:409] reason: unexpected Share Control PDU during capabilities exchange: got Data PDU (expected Server Demand Active PDU)';

describe('cleanEngineText', () => {
  it('drops the source location and the label', () => {
    expect(cleanEngineText(CAPABILITIES_FAILURE)).toBe(
      'unexpected Share Control PDU during capabilities exchange: got Data PDU (expected Server Demand Active PDU)',
    );
  });

  it('leaves plain text alone', () => {
    expect(cleanEngineText('server initiated disconnect')).toBe('server initiated disconnect');
  });

  it('skips lines that carry only a location', () => {
    expect(
      cleanEngineText('[Tls @ crates/ironrdp-tls/src/lib.rs:12]\nsource: handshake failed'),
    ).toBe('handshake failed');
  });
});

function proxyFailure(
  failure: Pick<RdpProxyErrorPayload, 'code' | 'message'> & { detail?: string },
): RdpProxyErrorPayload {
  return { sessionId: 's1', ...failure };
}

const LIBRARY_TEXT = /error:|OPENSSL_internal|boringssl|ssl_cert\.cc|third_party|crates|\.rs\b/i;

describe('describeConnectError', () => {
  it('turns an engine failure into a sentence without crate paths', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failure = describeConnectError(ironError(0, CAPABILITIES_FAILURE), null);
    expect(failure.message).toMatch(/stopped partway through setting up the session/);
    expect(failure.message).not.toMatch(/crates|\.rs|PDU/);
    expect(failure.detail).toBe(
      'unexpected Share Control PDU during capabilities exchange: got Data PDU (expected Server Demand Active PDU)',
    );
    expect(failure.detail).not.toMatch(/crates|\.rs/);
  });

  it('shows a reason the server wrote as it is', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failure = describeConnectError(
      ironError(
        0,
        '[ConnectionFinalization @ crates/ironrdp-connector/src/lib.rs:88] reason: The server denied the connection',
      ),
      null,
    );
    expect(failure).toMatchObject({
      title: "Couldn't connect",
      message: 'The server denied the connection.',
    });
    expect(failure.detail).toBeUndefined();
  });

  it('falls back to a general sentence for a stage it does not know', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const failure = describeConnectError(
      ironError(0, '[SomethingNew @ crates/ironrdp-x/src/lib.rs:1] reason: bad_value in field'),
      null,
    );
    expect(failure.message).toBe(
      'The connection failed while setting up the remote session. Try reconnecting.',
    );
    expect(failure.detail).toBe('bad_value in field');
  });

  it('prefers what the proxy saw', () => {
    const failure = describeConnectError(
      ironError(0, CAPABILITIES_FAILURE),
      proxyFailure({ code: 'refused', message: '10.0.0.5:3389 refused the connection.' }),
    );
    expect(failure).toMatchObject({
      code: 'refused',
      title: 'The server refused the connection',
      message: '10.0.0.5:3389 refused the connection.',
    });
    expect(failure.hints.length).toBeGreaterThan(0);
  });

  it('keeps the fixed sentences for known kinds', () => {
    expect(describeConnectError(ironError(1, CAPABILITIES_FAILURE), null)).toMatchObject({
      code: 'sign-in',
      title: 'Sign-in failed',
      message: 'The server did not accept the username or password.',
    });
    expect(describeConnectError(ironError(2, CAPABILITIES_FAILURE), null).code).toBe('sign-in');
    expect(describeConnectError(ironError(3, CAPABILITIES_FAILURE), null)).toMatchObject({
      code: 'access-denied',
      message:
        'The server refused this account. It may not be allowed to sign in over Remote Desktop.',
    });
    expect(describeConnectError(ironError(6, CAPABILITIES_FAILURE), null)).toMatchObject({
      code: 'security-settings',
      message: "Runova and the server couldn't agree on security settings.",
    });
  });

  it('suggests what to try for the kinds a person can fix', () => {
    expect(describeConnectError(ironError(1, ''), null).hints.join(' ')).toMatch(/password/);
    expect(describeConnectError(ironError(6, ''), null).hints.join(' ')).toMatch(
      /Network Level Authentication/,
    );
  });

  it('cleans engine text that arrives as a plain error', () => {
    const failure = describeConnectError(new Error(CAPABILITIES_FAILURE), null);
    expect(failure.message).not.toMatch(/crates|\.rs/);
    expect(failure.detail).not.toMatch(/crates|\.rs/);
  });

  describe('when the secure connection to the server fails', () => {
    // What the proxy reports for a server reinstalled with Windows' own certificate, once the
    // library text is split off (see main/rdp/handshake.ts).
    const keyUsage = proxyFailure({
      code: 'tls-key-usage',
      message:
        "The certificate 176.9.22.106:3389 presented can't be used to set up an encrypted connection.",
      detail: 'KEY_USAGE_BIT_INCORRECT (SSL routines)',
    });

    it.each([
      ['an RDCleanPath error', ironError(4, '')],
      ['a proxy connect error', ironError(5, '')],
      ['an error of no known kind', ironError(0, '[Tls @ crates/x/src/lib.rs:1] reason: failed')],
      ['a plain error from the socket', new Error('WebSocket connection closed')],
    ])('shows the proxy failure, not the engine, for %s', (_name, error) => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const failure = describeConnectError(error, keyUsage);

      expect(failure).toMatchObject({
        code: 'tls-key-usage',
        title: "The server's certificate can't be used",
        message:
          "The certificate 176.9.22.106:3389 presented can't be used to set up an encrypted connection.",
        detail: 'KEY_USAGE_BIT_INCORRECT (SSL routines)',
      });
      expect(failure.hints.length).toBeGreaterThan(0);
    });

    it('keeps library text and source locations out of everything but the details', () => {
      const failure = describeConnectError(ironError(4, ''), keyUsage);
      expect([failure.title, failure.message, ...failure.hints].join(' ')).not.toMatch(
        /KEY_USAGE|SSL routines|error:|boringssl|\.cc/i,
      );
      expect(failure.detail).not.toMatch(LIBRARY_TEXT);
    });

    it('still says something when the proxy never said what went wrong', () => {
      expect(describeConnectError(ironError(4, ''), null)).toMatchObject({
        code: 'other',
        message: 'Could not reach the server.',
      });
    });
  });
});
