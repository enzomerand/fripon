import { createImageAnalyzer, type PixelResult } from '../lib/image/analyzer';
import { dHash, catalogScore, hashToHex } from '../lib/image/pixels';
import { handleMessage, isAllowedSender, type BackgroundDeps } from '../lib/background/handlers';
import { loadImageGate } from '../lib/gate';
import { checkKey } from '../lib/google/key-check';
import { isRuntimeMessage, type OptionsSection } from '../lib/messages';
import { loadSettings } from '../lib/settings';

/** Photos are shrunk to this many pixels on their longest side before analysis. */
const MAX_ANALYSIS_SIDE = 256;

async function computePixels(blob: Blob): Promise<PixelResult> {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, MAX_ANALYSIS_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const context = new OffscreenCanvas(w, h).getContext('2d');
    if (!context) throw new Error('Canvas unavailable');
    context.drawImage(bitmap, 0, 0, w, h);
    const { data } = context.getImageData(0, 0, w, h);
    return { hash: hashToHex(dHash(data, w, h)), catalogScore: catalogScore(data, w, h) };
  } finally {
    bitmap.close();
  }
}

const analyzeImage = createImageAnalyzer({
  fetch: (url, init) => fetch(url, init),
  computePixels,
});

/** The options page is a full tab; its sections are anchors (`#guide`, `#welcome`...). */
async function openOptionsTab(section?: OptionsSection | 'welcome') {
  const page = `${browser.runtime.getURL('/')}options.html`;
  await browser.tabs.create({ url: section ? `${page}#${section}` : page });
}

const deps: BackgroundDeps = {
  analyzeImage,
  loadImageGate: () => loadImageGate(),
  loadSettings,
  checkKey: (provider, key) => checkKey(provider, key),
  openOptions: openOptionsTab,
};

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!isRuntimeMessage(message)) return false;
    const own = { id: browser.runtime.id, origin: browser.runtime.getURL('/') };
    if (!isAllowedSender(message, sender, own)) return false;
    void handleMessage(message, deps).then(sendResponse);
    return true;
  });

  // Chrome calls it `action`, Firefox MV2 `browserAction`.
  const toolbarButton = browser.action ?? browser.browserAction;
  toolbarButton?.onClicked.addListener(() => {
    void browser.runtime.openOptionsPage();
  });

  browser.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === 'install') void openOptionsTab('welcome');
  });
});
