/// <reference types="vitest/config" />
import { getViteConfig } from 'astro/config';

// getViteConfig loads astro.config.mjs, so .astro files and the Astro container work in tests.
export default getViteConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
