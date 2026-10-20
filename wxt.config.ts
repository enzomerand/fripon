import preact from '@preact/preset-vite';
import { defineConfig } from 'wxt';
import { VINTED_MATCHES } from './lib/vinted/domains';

// See https://wxt.dev/api/reference/wxt/interfaces/inlineconfig.html
export default defineConfig({
  manifest: {
    name: 'Fripon',
    description:
      'Repère le dropshipping (Shein, Temu, AliExpress) et les prix incohérents sur Vinted.',
    permissions: ['storage'],
    // vinted.net serves the listing photos, which the background fetches to analyse them.
    host_permissions: [...VINTED_MATCHES, 'https://*.vinted.net/*'],
  },
  vite: () => ({ plugins: [preact()] }),
});
