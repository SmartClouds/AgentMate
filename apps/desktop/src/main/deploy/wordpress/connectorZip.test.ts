import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wordPressErrorCode } from '../../../shared/wordpressErrors';
import { CONNECTOR_ZIP_NAME, connectorZipPath, saveConnectorZip } from './connectorZip';

/** The bundled plugin zip: found where packaged and development builds keep it, copied on save. */

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'runova-wp-zip-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('connectorZipPath', () => {
  it('uses resources when packaged and the plugin build output in development', () => {
    expect(connectorZipPath({ isPackaged: true, resourcesPath: '/r', appPath: '/a' })).toBe(
      join('/r', 'wordpress-connector', CONNECTOR_ZIP_NAME),
    );
    expect(
      connectorZipPath({ isPackaged: false, resourcesPath: '/r', appPath: '/repo/apps/desktop' }),
    ).toBe(join('/repo/apps', 'wordpress-connector', 'dist', CONNECTOR_ZIP_NAME));
  });
});

describe('saveConnectorZip', () => {
  function packaged(pick: string | null) {
    const zipDir = join(root, 'resources', 'wordpress-connector');
    mkdirSync(zipDir, { recursive: true });
    writeFileSync(join(zipDir, CONNECTOR_ZIP_NAME), 'PK zip');
    return {
      isPackaged: true,
      resourcesPath: join(root, 'resources'),
      appPath: join(root, 'app'),
      pickSavePath: async (name: string) => {
        expect(name).toBe(CONNECTOR_ZIP_NAME);
        return pick;
      },
    };
  }

  it('copies the zip where the user picked', async () => {
    const target = join(root, 'saved.zip');
    expect(await saveConnectorZip(packaged(target))).toEqual({ saved: true, path: target });
    expect(readFileSync(target, 'utf-8')).toBe('PK zip');
  });

  it('does nothing when the dialog is cancelled', async () => {
    expect(await saveConnectorZip(packaged(null))).toEqual({ saved: false });
  });

  it('says clearly when the zip is missing', async () => {
    const missing = {
      resourcesPath: root,
      appPath: join(root, 'app'),
      pickSavePath: async () => null,
    };
    const packagedError = await saveConnectorZip({ ...missing, isPackaged: true }).catch((e) => e);
    expect(wordPressErrorCode(packagedError)).toBe('internal');
    expect(packagedError.message).toContain('does not include');
    const devError = await saveConnectorZip({ ...missing, isPackaged: false }).catch((e) => e);
    expect(devError.message).toContain('wordpress-connector.mjs build');
  });
});
