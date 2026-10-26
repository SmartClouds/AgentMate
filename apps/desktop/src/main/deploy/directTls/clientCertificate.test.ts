import { createPrivateKey, generateKeyPairSync, X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDeviceKey } from '../auth/deviceKey';
import { clientCertificate, integer, objectIdentifier } from './clientCertificate';

describe('clientCertificate', () => {
  it('carries the device key and is signed by it', () => {
    const device = createDeviceKey();
    const made = clientCertificate(device.privateKeyPem, new Date('2026-10-02T12:00:00Z'));
    const parsed = new X509Certificate(made.certificate);

    expect(parsed.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')).toBe(
      device.publicKey,
    );
    expect(parsed.checkPrivateKey(createPrivateKey(device.privateKeyPem))).toBe(true);
    expect(parsed.verify(parsed.publicKey)).toBe(true);
    expect(parsed.subject).toBe('CN=runova-device');
    expect(parsed.issuer).toBe(parsed.subject);
    expect(parsed.keyUsage).toEqual(['1.3.6.1.5.5.7.3.2']);
    expect(parsed.ca).toBe(false);
    expect(new Date(parsed.validFrom).toISOString()).toBe('2026-10-02T11:00:00.000Z');
    expect(new Date(parsed.validTo).toISOString()).toBe('2026-10-03T12:00:00.000Z');
    expect(made.key).toBe(device.privateKeyPem);
  });

  it('gets a fresh serial number every time', () => {
    const device = createDeviceKey();

    const first = new X509Certificate(clientCertificate(device.privateKeyPem).certificate);
    const second = new X509Certificate(clientCertificate(device.privateKeyPem).certificate);

    expect(first.serialNumber).not.toBe(second.serialNumber);
  });

  it('writes dates from 2050 on as GeneralizedTime', () => {
    const device = createDeviceKey();
    const parsed = new X509Certificate(
      clientCertificate(device.privateKeyPem, new Date('2050-06-01T00:00:00Z')).certificate,
    );

    expect(new Date(parsed.validTo).getUTCFullYear()).toBe(2050);
  });

  it('refuses a key that is not P-256', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();

    expect(() => clientCertificate(pem)).toThrow(/P-256/);
  });

  it('parses with a serial number that starts with zero bytes', () => {
    // One draw in 256 clears the whole first byte and leaves the next one's top bit clear too.
    // Written as is, that leading zero is padding OpenSSL refuses (ASN1 illegal padding).
    const device = createDeviceKey();
    const serial = Buffer.alloc(16, 0x11);
    serial[0] = 0;
    serial[1] = 0;

    const parsed = new X509Certificate(
      clientCertificate(device.privateKeyPem, new Date(), serial).certificate,
    );

    expect(parsed.serialNumber).toBe('11'.repeat(14).toUpperCase());
  });

  it('writes integers in their shortest form', () => {
    expect(integer(Buffer.from([0x00, 0x10])).toString('hex')).toBe('020110');
    expect(integer(Buffer.from([0x00, 0x00, 0x80])).toString('hex')).toBe('02020080');
    expect(integer(Buffer.from([0x00])).toString('hex')).toBe('020100');
  });

  it('keeps an integer with its top bit set positive', () => {
    expect(integer(Buffer.from([0x80])).toString('hex')).toBe('02020080');
    expect(integer(Buffer.from([0x7f])).toString('hex')).toBe('02017f');
  });

  it('encodes object identifiers with multi-byte arcs', () => {
    expect(objectIdentifier('1.2.840.10045.4.3.2').toString('hex')).toBe('06082a8648ce3d040302');
  });
});
