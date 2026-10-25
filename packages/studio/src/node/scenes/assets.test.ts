import { describe, expect, it } from 'vitest';
import { readStudioAsset } from './assets.js';
import { STUDIO_ASSETS } from './sceneServer.js';

describe('readStudioAsset', () => {
  it('has every file the scene server offers', async () => {
    for (const path of Object.values(STUDIO_ASSETS)) {
      const bytes = await readStudioAsset(path);
      expect(bytes?.length, path).toBeGreaterThan(100);
    }
  });

  it('reads nothing outside the assets folder', async () => {
    expect(await readStudioAsset('../package.json')).toBeNull();
    expect(await readStudioAsset('/etc/hosts')).toBeNull();
    expect(await readStudioAsset('fonts/missing.woff2')).toBeNull();
  });
});
