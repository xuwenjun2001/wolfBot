import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Bound cold PI imports and filesystem-heavy skill mirrors on shared dev/CI hosts.
    maxWorkers: 2,
    clearMocks: true,
    restoreMocks: true,
  },
});
