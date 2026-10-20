import preact from '@preact/preset-vite';
import { defineConfig } from 'wxt';

// See https://wxt.dev/api/reference/wxt/interfaces/inlineconfig.html
export default defineConfig({
  manifest: {
    name: 'Fripon',
    description:
      'Repère le dropshipping (Shein, Temu, AliExpress) et les prix incohérents sur Vinted.',
    permissions: ['storage'],
    // The toolbar button opens the options page.
    action: { default_title: 'Fripon' },
    host_permissions: [
      // The image CDN: the background fetches the listing photos from it. The content script
      // talks to Vinted's API same-origin, which needs no host permission.
      'https://*.vinted.net/*',
      // The paid services reached with the user's own keys (called from the background only).
      'https://vision.googleapis.com/*',
      'https://generativelanguage.googleapis.com/*',
    ],
  },
  vite: () => ({ plugins: [preact()] }),
});
