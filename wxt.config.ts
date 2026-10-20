import preact from '@preact/preset-vite';
import { defineConfig } from 'wxt';

// See https://wxt.dev/api/reference/wxt/interfaces/inlineconfig.html
export default defineConfig({
  manifest: {
    name: 'Fripon',
    description:
      'Repère le dropshipping (Shein, Temu, AliExpress) et les prix incohérents sur Vinted.',
    permissions: ['storage'],
    // Only the image CDN: the background fetches the listing photos from it. The content script
    // talks to Vinted's API same-origin, which needs no host permission.
    host_permissions: ['https://*.vinted.net/*'],
  },
  vite: () => ({ plugins: [preact()] }),
});
