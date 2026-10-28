import { configDefaults, defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    projects: [
      {
        // The extension: browser code, so happy-dom and the WXT fake browser.
        extends: true,
        test: {
          name: 'extension',
          environment: 'happy-dom',
          // Local scratch work (live API checks spend real credits) is never part of the suite.
          // server/ is its own project below, in Node: happy-dom must not run it.
          exclude: [...configDefaults.exclude, '.claude/**', 'server/**'],
        },
      },
      // The Fripon Cloud server (server/vitest.config.ts): Node, no WXT.
      'server',
    ],
  },
});
