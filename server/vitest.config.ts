import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'server',
    // The server runs in Node, unlike the extension (happy-dom): the root config lists this folder
    // as its own project.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
