import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  cacheDir: path.join(root, 'node_modules/.vite'),
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    fsModuleCachePath: path.join(root, 'node_modules/.vitest-cache'),
  },
});
