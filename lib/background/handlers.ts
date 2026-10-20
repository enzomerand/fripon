import type { ImageGate } from '../gate';
import type { KeyCheckResult } from '../google/key-check';
import {
  type AnalyzeImageResponse,
  type OptionsSection,
  type ResponseFor,
  type RuntimeMessage,
} from '../messages';
import type { Provider, Settings } from '../settings';

/** Everything the background does with the outside world, injected so it can be tested. */
export interface BackgroundDeps {
  analyzeImage(url: string): Promise<AnalyzeImageResponse>;
  loadImageGate(): Promise<ImageGate>;
  loadSettings(): Promise<Settings>;
  checkKey(provider: Provider, key: string): Promise<KeyCheckResult>;
  openOptions(section?: OptionsSection): Promise<void>;
}

export interface MessageSender {
  id?: string;
  url?: string;
}

/** Who the background belongs to: `origin` is `browser.runtime.getURL('/')`. */
export interface OwnIdentity {
  id: string;
  origin: string;
}

/**
 * Only our own content scripts and pages may use the background. Testing a key is further
 * limited to the extension's own pages: a content script runs in the context of a web page.
 */
export function isAllowedSender(
  message: RuntimeMessage,
  sender: MessageSender,
  own: OwnIdentity,
): boolean {
  if (sender.id !== own.id) return false;
  if (message.type === 'testKey') {
    return typeof sender.url === 'string' && sender.url.startsWith(own.origin);
  }
  return true;
}

/** Runs one message. Never rejects: a content script must always get an answer. */
export async function handleMessage<M extends RuntimeMessage>(
  message: M,
  deps: BackgroundDeps,
): Promise<ResponseFor<M>> {
  // The cases are checked against `RuntimeResponses` by `ResponseFor`; TypeScript cannot follow
  // the correlation between the narrowed message and the generic return type.
  const response = await respond(message, deps);
  return response as ResponseFor<M>;
}

async function respond(message: RuntimeMessage, deps: BackgroundDeps) {
  switch (message.type) {
    case 'analyzeImage':
      return deps.analyzeImage(message.url);
    case 'getImageGate':
      // When storage cannot be read, behave as if there were no key: nothing is spent.
      return deps.loadImageGate().catch((): ImageGate => 'no_key');
    case 'openOptions':
      await deps.openOptions(message.section).catch(() => undefined);
      return undefined;
    case 'testKey': {
      try {
        const key = (await deps.loadSettings()).keys[message.provider];
        return await deps.checkKey(message.provider, key);
      } catch {
        return { ok: false, reason: 'network' } satisfies KeyCheckResult;
      }
    }
  }
}
