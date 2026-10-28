import { createAiReviewer } from '../lib/ai/review';
import { createCloudAccount } from '../lib/cloud/account';
import { createCloudClient, storedSession } from '../lib/cloud/client';
import { clearExpired, sessionState } from '../lib/cloud/session';
import { createRouter, sectionFor } from '../lib/cloud/router';
import { createCloudGates, createStatusKeeper } from '../lib/cloud/status';
import { createCloudSteps } from '../lib/cloud/steps';
import { createImageAnalyzer, fetchGuardedImage, type PixelResult } from '../lib/image/analyzer';
import { createImageSearcher } from '../lib/image/search';
import { dHash, catalogScore, hashToHex } from '../lib/image/pixels';
import { setToolbarBadge } from '../lib/background/badge';
import { handleMessage, isAllowedSender, type BackgroundDeps } from '../lib/background/handlers';
import { loadGates, loadVisionRemaining } from '../lib/gate';
import { reviewListing } from '../lib/google/gemini';
import { checkKey } from '../lib/google/key-check';
import { webDetect } from '../lib/google/vision';
import { isRuntimeMessage } from '../lib/messages';
import { openOptionsAt } from '../lib/options-nav';
import { PROVIDERS, SETTINGS_KEY, parseSettings, type Provider } from '../lib/settings';

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

const fetchPhoto = (url: string) => fetchGuardedImage((input, init) => fetch(input, init), url);

const searchImage = createImageSearcher({ fetchPhoto, webDetect });

const aiReview = createAiReviewer({ fetchPhoto, reviewListing });

// Fripon Cloud: signed in, the paid steps go to the Fripon server instead of the user's own keys.
const cloudClient = createCloudClient({
  fetch: (input, init) => fetch(input, init),
  session: storedSession,
});
const cloudStatus = createStatusKeeper({ client: cloudClient });
const cloudSteps = createCloudSteps({
  client: cloudClient,
  status: cloudStatus,
  token: storedSession.token,
});
const cloudAccount = createCloudAccount({
  client: cloudClient,
  status: cloudStatus,
  openTab: (url) => browser.tabs.create({ url }),
});

const paidSteps = createRouter({
  sessionState,
  cloud: { ...cloudSteps, ...createCloudGates(cloudStatus) },
  personal: { searchImage, aiReview, loadGates, loadVisionRemaining },
});

function forgetKeyFailure(provider: Provider) {
  if (provider === 'vision') searchImage.forgetKeyFailure();
  else aiReview.forgetKeyFailure();
}

const deps: BackgroundDeps = {
  analyzeImage,
  ...paidSteps,
  checkKey: async (provider, key) => {
    const result = await checkKey(provider, key);
    // A key that tests fine: whatever was wrong is fixed, so stop remembering the refusal.
    if (result.ok) forgetKeyFailure(provider);
    return result;
  },
  // The guide, the keys and the credits are the user's own keys' business: a subscriber (signed in,
  // or whose session expired and has to sign in again) is led to its subscription instead.
  openOptions: async (section) =>
    openOptionsAt(
      sectionFor(await sessionState().catch((): 'signed_out' => 'signed_out'), section),
    ),
  // Chrome calls the toolbar button `action`, Firefox MV2 `browserAction`.
  setBadge: (tabId, verdict) =>
    setToolbarBadge(browser.action ?? browser.browserAction, tabId, verdict),
  cloud: cloudAccount,
};

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (!isRuntimeMessage(message)) return false;
    const own = { id: browser.runtime.id, origin: browser.runtime.getURL('/') };
    if (!isAllowedSender(message, sender, own)) return false;
    void handleMessage(message, deps, { tabId: sender.tab?.id }).then(sendResponse);
    return true;
  });

  // Chrome calls it `action`, Firefox MV2 `browserAction`.
  const toolbarButton = browser.action ?? browser.browserAction;
  toolbarButton?.onClicked.addListener(() => {
    void openOptionsAt().catch(() => undefined);
  });

  // A refused key is only remembered for as long as it is the stored one: a changed key (even one
  // that is put back later) starts from a clean slate.
  browser.storage.onChanged.addListener((changes, area) => {
    const change = area === 'local' ? changes[SETTINGS_KEY] : undefined;
    if (!change) return;
    const before = parseSettings(change.oldValue).keys;
    const after = parseSettings(change.newValue).keys;
    for (const provider of PROVIDERS) {
      if (before[provider] !== after[provider]) forgetKeyFailure(provider);
    }
    // A key saved is the user choosing their own keys: an expired subscription session no longer
    // has anything to say.
    if (
      PROVIDERS.some((provider) => after[provider] !== '' && after[provider] !== before[provider])
    ) {
      void clearExpired().catch(() => undefined);
    }
  });

  browser.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === 'install') void openOptionsAt('welcome').catch(() => undefined);
  });
});
