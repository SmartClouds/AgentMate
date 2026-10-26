import * as pkg from '@runova/protocol';
import { describe, expect, it } from 'vitest';
import * as shared from './remoteProtocol';

/**
 * `@shared/remoteProtocol` is a bare `export *` over the package the mobile
 * controller also compiles against. It exists so main and renderer code can
 * keep the short import path, which means the only thing that can go wrong is
 * the re-export drifting from the package (a named list creeping in, or a stale
 * build in packages/protocol/dist). That is what these tests watch.
 */

describe('@shared/remoteProtocol', () => {
  it('re-exports the whole protocol surface, nothing dropped', () => {
    expect(Object.keys(shared).sort()).toEqual(Object.keys(pkg).sort());
  });

  it('hands back the same function objects, not copies or wrappers', () => {
    expect(shared.encodeScreenTile).toBe(pkg.encodeScreenTile);
    expect(shared.decodeScreenTile).toBe(pkg.decodeScreenTile);
    expect(shared.encodeFileChunk).toBe(pkg.encodeFileChunk);
    expect(shared.decodeFileChunk).toBe(pkg.decodeFileChunk);
    expect(shared.encodePairingCode).toBe(pkg.encodePairingCode);
    expect(shared.decodePairingCode).toBe(pkg.decodePairingCode);
  });

  it('carries the protocol version the host advertises', () => {
    expect(shared.REMOTE_PROTOCOL_VERSION).toBe(pkg.REMOTE_PROTOCOL_VERSION);
    // Pinned in packages/protocol/src/index.test.ts as well; this side proves
    // the desktop app is reading the same number and not a stale dist build.
    expect(shared.REMOTE_PROTOCOL_VERSION).toBe(4);
  });

  it('works through this path, so a broken protocol build fails here too', () => {
    const jpeg = new Uint8Array([1, 2, 3, 4]);
    const tile = shared.decodeScreenTile(
      shared.encodeScreenTile({ frameId: 9, x: 16, y: 32, w: 64, h: 48, jpeg }),
    );
    expect(tile).toMatchObject({ frameId: 9, x: 16, y: 32, w: 64, h: 48 });
    expect(Array.from(tile.jpeg)).toEqual([1, 2, 3, 4]);

    const code = shared.encodePairingCode({
      ip: '10.0.0.7',
      port: 44444,
      token: 'tok',
      deviceName: 'Host',
      v: shared.REMOTE_PROTOCOL_VERSION,
    });
    expect(shared.decodePairingCode(code)?.ip).toBe('10.0.0.7');
  });
});
