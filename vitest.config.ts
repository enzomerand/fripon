import { configDefaults, defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    environment: 'happy-dom',
    // Local scratch work (live API checks spend real credits) is never part of the suite.
    exclude: [...configDefaults.exclude, '.claude/**', 'safari/**'],
  },
});
