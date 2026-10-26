import { createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authMessage, createDeviceKey, signMessage } from './deviceKey';

/**
 * The key a desktop proves itself with to a server core: ECDSA P-256, the public half sent as
 * SubjectPublicKeyInfo (base64 DER), signatures in IEEE P1363 (r || s), which is what the core's
 * `DSASignatureFormat.IeeeP1363FixedFieldConcatenation` reads.
 */

describe('createDeviceKey', () => {
  it('makes a P-256 key pair and exports the public half as SPKI', () => {
    const key = createDeviceKey();

    const publicKey = createPublicKey({
      key: Buffer.from(key.publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
    expect(publicKey.asymmetricKeyType).toBe('ec');
    expect(publicKey.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    expect(key.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
  });

  it('makes a different key every time', () => {
    expect(createDeviceKey().publicKey).not.toBe(createDeviceKey().publicKey);
  });
});

describe('signMessage', () => {
  it('signs in the fixed-width r || s form, verifiable with the public key', () => {
    const key = createDeviceKey();
    const message = 'runova-core/auth/v1\nlogin\nabc';

    const signature = Buffer.from(signMessage(key.privateKeyPem, message), 'base64');

    expect(signature).toHaveLength(64);
    const publicKey = createPublicKey({
      key: Buffer.from(key.publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
    expect(
      verify(
        'sha256',
        Buffer.from(message),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        signature,
      ),
    ).toBe(true);
  });
});

describe('authMessage', () => {
  // The same vector is pinned in the core's AuthMessageTests, so both sides sign the same bytes.
  it('matches the text the core verifies, field for field', () => {
    expect(
      authMessage(
        'renew',
        '0b8f1c3e-7c1e-4a8e-9d3a-2f0e5b6c7d8e',
        'bm9uY2U',
        'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
        'f0e1d2c3-b4a5-4968-8776-655443322110',
      ),
    ).toBe(
      'runova-core/auth/v1\nrenew\n0b8f1c3e-7c1e-4a8e-9d3a-2f0e5b6c7d8e\nbm9uY2U\na1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d\nf0e1d2c3-b4a5-4968-8776-655443322110',
    );
    expect(authMessage('login', 'c', 'n', 'd', null)).toBe(
      'runova-core/auth/v1\nlogin\nc\nn\nd\n-',
    );
  });
});
