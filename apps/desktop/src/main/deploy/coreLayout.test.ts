import { describe, expect, it } from 'vitest';
import { LEGACY_CORE_NAMES } from '../../shared/deploy/coreLegacyNames';
import {
  coreNames,
  FIRST_RUNOVA_CORE,
  isOlderCore,
  LEGACY_CORE,
  layoutOf,
  RUNOVA_CORE,
} from './coreLayout';

/**
 * The two server layouts and their names. A record saved before the rename has no layout and is
 * on the old one; the old wire names go out until the core is known to be on the new one.
 */
describe('coreLayout', () => {
  it('reads a record without a layout as one from before the rename', () => {
    expect(layoutOf(undefined)).toBe('legacy');
    expect(layoutOf({})).toBe('legacy');
    expect(layoutOf({ layout: 'runova' })).toBe('runova');
  });

  it('names each layout its own paths and wire names', () => {
    expect(coreNames('runova')).toBe(RUNOVA_CORE);
    expect(RUNOVA_CORE.binaryPath).toBe('/opt/runova-core/current/runova-core');
    expect(RUNOVA_CORE.socketPath).toBe('/run/runova-core/core.sock');
    expect(RUNOVA_CORE.unitPath).toBe('/etc/systemd/system/runova-core.service');
    expect(coreNames('legacy')).toBe(LEGACY_CORE);
    expect(LEGACY_CORE.socketPath).toBe(LEGACY_CORE_NAMES.socketPath);
    expect(LEGACY_CORE.binaryPath).toBe(
      `${LEGACY_CORE_NAMES.root}/current/${LEGACY_CORE_NAMES.binary}`,
    );
    expect(LEGACY_CORE.host).toBe(LEGACY_CORE_NAMES.host);
  });

  it('compares versions by their numbers, as the core does', () => {
    expect(FIRST_RUNOVA_CORE).toBe('1.64.0');
    expect(isOlderCore('1.63.0')).toBe(true);
    expect(isOlderCore('1.9.0')).toBe(true);
    expect(isOlderCore('1.64.0')).toBe(false);
    expect(isOlderCore('1.100.0')).toBe(false);
    expect(isOlderCore('2.0.0-rc.1')).toBe(false);
    expect(isOlderCore('nightly')).toBe(true);
  });
});
