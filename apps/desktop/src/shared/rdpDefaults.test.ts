import { describe, expect, it } from 'vitest';
import type { RdpServerOptions } from './apiTypes';
import { DEFAULT_RDP_OPTIONS, DEFAULT_RDP_PORT, withRdpDefaults } from './rdpDefaults';

/**
 * Saved RDP servers are read back from disk, including records written before a
 * field existed. withRdpDefaults is what stops an older record from arriving at
 * the session window with `undefined` where a boolean is expected.
 */

describe('withRdpDefaults', () => {
  it('fills in everything for a record with no options at all', () => {
    expect(withRdpDefaults(undefined)).toEqual(DEFAULT_RDP_OPTIONS);
    expect(withRdpDefaults({})).toEqual(DEFAULT_RDP_OPTIONS);
  });

  it('keeps the caller values it was given', () => {
    const saved: RdpServerOptions = {
      resolution: { width: 2560, height: 1440 },
      fullscreenOnConnect: true,
      maximizeOnConnect: false,
      clipboard: false,
      fileTransfer: false,
      nla: false,
    };
    expect(withRdpDefaults(saved)).toEqual(saved);
  });

  it('keeps an explicit false rather than treating it as missing', () => {
    // The whole point: `false` is a real choice the user made, so a naive
    // `options.clipboard || default` would silently turn the clipboard back on.
    expect(withRdpDefaults({ clipboard: false }).clipboard).toBe(false);
    expect(withRdpDefaults({ fileTransfer: false }).fileTransfer).toBe(false);
    expect(withRdpDefaults({ nla: false }).nla).toBe(false);
    expect(withRdpDefaults({ fullscreenOnConnect: false }).fullscreenOnConnect).toBe(false);
    expect(withRdpDefaults({ maximizeOnConnect: false }).maximizeOnConnect).toBe(false);
  });

  it('defaults only the fields the record is missing', () => {
    const merged = withRdpDefaults({ resolution: { width: 1280, height: 720 } });
    expect(merged.resolution).toEqual({ width: 1280, height: 720 });
    expect(merged.clipboard).toBe(DEFAULT_RDP_OPTIONS.clipboard);
    expect(merged.nla).toBe(DEFAULT_RDP_OPTIONS.nla);
  });

  it('returns a fresh object, so a saved record cannot be mutated through it', () => {
    const merged = withRdpDefaults({});
    merged.clipboard = false;
    // The shared default must not have moved with it.
    expect(DEFAULT_RDP_OPTIONS.clipboard).toBe(true);
    expect(merged).not.toBe(DEFAULT_RDP_OPTIONS);
  });

  it('covers every field of RdpServerOptions', () => {
    // A field added to the interface but not to the defaults would arrive as
    // undefined for every existing saved server.
    const filled = withRdpDefaults(undefined);
    for (const [key, value] of Object.entries(filled)) {
      expect(value, `${key} has no default`).not.toBeUndefined();
    }
    expect(Object.keys(filled).sort()).toEqual(
      [
        'clipboard',
        'fileTransfer',
        'fullscreenOnConnect',
        'maximizeOnConnect',
        'nla',
        'resolution',
      ].sort(),
    );
  });
});

describe('defaults', () => {
  it('uses the standard RDP port', () => {
    expect(DEFAULT_RDP_PORT).toBe(3389);
  });

  it('starts new servers on the safe, convenient settings', () => {
    // NLA on by default because Windows Server requires it; clipboard and file
    // transfer on because that is what people connect for.
    expect(DEFAULT_RDP_OPTIONS).toEqual({
      resolution: 'fitWindow',
      fullscreenOnConnect: false,
      maximizeOnConnect: false,
      clipboard: true,
      fileTransfer: true,
      nla: true,
    });
  });
});
