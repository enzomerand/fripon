import preact from '@preact/preset-vite';
import { defineConfig } from 'wxt';

// See https://wxt.dev/api/reference/wxt/interfaces/inlineconfig.html
export default defineConfig({
  manifest: ({ browser }) => ({
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
    // Safari 16.4 is the first with `storage.session` and `OffscreenCanvas` (the photo hashing in
    // the background): refuse older versions rather than run with half the checks.
    ...(browser === 'safari' && {
      browser_specific_settings: { safari: { strict_min_version: '16.4' } },
    }),
  }),
  vite: () => ({ plugins: [preact()] }),
});
