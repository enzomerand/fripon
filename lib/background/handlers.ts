import type { AiReviewInput } from '../ai/input';
import { isVintedPageUrl } from '../vinted/domains';
import type { BadgeVerdict } from './badge';
import type { Gates } from '../gate';
import type { KeyCheckResult } from '../google/key-check';
import type { PendingSection } from '../options-nav';
import type {
  AiReviewResponse,
  AnalyzeImageResponse,
  ResponseFor,
  RuntimeMessage,
  SearchImageResponse,
  VisionUsage,
} from '../messages';
import type { Provider } from '../settings';

/** Everything the background does with the outside world, injected so it can be tested. */
export interface BackgroundDeps {
  analyzeImage(url: string): Promise<AnalyzeImageResponse>;
  searchImage(photoUrl: string, cacheOnly: boolean, retry: boolean): Promise<SearchImageResponse>;
  aiReview(input: AiReviewInput, cacheOnly: boolean, retry: boolean): Promise<AiReviewResponse>;
  loadGates(): Promise<Gates>;
  loadVisionRemaining(): Promise<number | null>;
  checkKey(provider: Provider, key: string): Promise<KeyCheckResult>;
  openOptions(section?: PendingSection): Promise<void>;
  setBadge(tabId: number, verdict: BadgeVerdict | null): Promise<void>;
}

export interface MessageSender {
  id?: string;
  url?: string;
  /** Only set for a content script (or any page in a tab). */
  tab?: { id?: number };
  /** 0 is the top frame of the tab. */
  frameId?: number;
}

/** What the listener knows of the sender that the message itself does not say. */
export interface MessageContext {
  tabId?: number | undefined;
}

/** Who the background belongs to: `origin` is `browser.runtime.getURL('/')`. */
export interface OwnIdentity {
  id: string;
  origin: string;
}

/**
 * Only our own content scripts and pages may use the background. Testing a key is further
 * limited to the extension's own pages: a content script runs in the context of a web page. The
 * badge is the other way round: it is for a content script in the top frame of a real tab (not
 * `TAB_ID_NONE`, -1) on a Vinted page.
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
  if (message.type === 'setVerdictBadge') {
    return (
      typeof sender.tab?.id === 'number' &&
      sender.tab.id >= 0 &&
      (sender.frameId === undefined || sender.frameId === 0) &&
      typeof sender.url === 'string' &&
      isVintedPageUrl(sender.url)
    );
  }
  return true;
}

/** Runs one message and resolves with its answer. */
export async function handleMessage<M extends RuntimeMessage>(
  message: M,
  deps: BackgroundDeps,
  context: MessageContext = {},
): Promise<ResponseFor<M>> {
  // The cases are checked against `RuntimeResponses` by `ResponseFor`; TypeScript cannot follow
  // the correlation between the narrowed message and the generic return type.
  const response = await respond(message, deps, context);
  return response as ResponseFor<M>;
}

async function respond(message: RuntimeMessage, deps: BackgroundDeps, context: MessageContext) {
  switch (message.type) {
    case 'analyzeImage':
      return deps.analyzeImage(message.url);
    case 'searchImage':
      // The searcher never rejects; this is the last net before the page gets nothing at all.
      return deps
        .searchImage(message.photoUrl, message.cacheOnly === true, message.retry === true)
        .catch((): SearchImageResponse => ({ status: 'error', reason: 'network' }));
    case 'aiReview':
      // The reviewer never rejects either.
      return deps
        .aiReview(message.input, message.cacheOnly === true, message.retry === true)
        .catch((): AiReviewResponse => ({ status: 'error', reason: 'network' }));
    case 'getGates':
      // When storage cannot be read, behave as if there were no key: nothing is spent.
      return deps.loadGates().catch((): Gates => ({ image: 'no_key', ai: 'no_key' }));
    case 'getVisionUsage':
      // A counter that cannot be read says "no count": the page then shows no figure.
      return deps
        .loadVisionRemaining()
        .then((remaining): VisionUsage => ({ remaining }))
        .catch((): VisionUsage => ({ remaining: null }));
    case 'openOptions':
      await deps.openOptions(message.section).catch(() => undefined);
      return undefined;
    case 'setVerdictBadge':
      // The badge belongs to the sender's tab; without one there is nothing to draw on.
      if (context.tabId !== undefined) {
        await deps.setBadge(context.tabId, message.verdict).catch(() => undefined);
      }
      return undefined;
    case 'testKey':
      return deps.checkKey(message.provider, message.key);
  }
}
