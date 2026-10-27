/** Tag of the shadow host that holds the button (or the verdict) under a result card. */
export const BUTTON_HOST_TAG = 'fripon-grid-button';
/** Tag of the shadow host of the bar above the results. */
export const BAR_HOST_TAG = 'fripon-grid-bar';

/**
 * One stylesheet for every host of the page: a hundred cards are a hundred shadow roots, and they
 * all adopt the same constructed sheet instead of carrying a copy of the CSS.
 */
export interface SharedStyles {
  apply(shadow: ShadowRoot): void;
}

/**
 * `makeSheet` is only there for tests. Without constructed stylesheets (an old browser, or one
 * that refuses a sheet made by a content script for a page's shadow root), each root gets its own
 * `<style>` element.
 */
export function createSharedStyles(
  css: string,
  makeSheet: () => CSSStyleSheet = () => new CSSStyleSheet(),
): SharedStyles {
  let sheet: CSSStyleSheet | null | undefined;
  const constructed = () => {
    if (sheet === undefined) {
      try {
        const created = makeSheet();
        created.replaceSync(css);
        sheet = created;
      } catch {
        sheet = null;
      }
    }
    return sheet;
  };

  return {
    apply(shadow) {
      const shared = constructed();
      if (shared) {
        try {
          shadow.adoptedStyleSheets = [shared];
          return;
        } catch {
          // Refused for this root: fall back on a style element.
        }
      }
      const style = shadow.ownerDocument.createElement('style');
      style.textContent = css;
      shadow.append(style);
    },
  };
}

/**
 * The box of a host, as inline `!important` declarations: Vinted's own CSS (and the `*` rules of
 * its design system) must not reach it, and it must sit above the link that covers the card
 * (`--overlay-link`) to be clickable at all. `all: initial` first, so nothing is inherited.
 */
const HOST_BOX = [
  'all: initial',
  'display: block',
  'position: relative',
  'z-index: 5',
  'width: 100%',
  'box-sizing: border-box',
  'pointer-events: auto',
]
  .map((declaration) => `${declaration} !important`)
  .join('; ');

export interface Host {
  /** The element that goes into the page. */
  element: HTMLElement;
  /** Where Preact renders, inside the shadow root. */
  container: HTMLElement;
}

/** An element with a shadow root that holds a container, styled by the shared sheet. */
export function createHost(
  doc: Document,
  tag: string,
  styles: SharedStyles,
  margin = '4px 0 0',
): Host {
  const element = doc.createElement(tag);
  element.style.cssText = `${HOST_BOX}; margin: ${margin} !important`;
  const shadow = element.attachShadow({ mode: 'open' });
  styles.apply(shadow);
  const container = doc.createElement('div');
  shadow.append(container);
  return { element, container };
}

/**
 * Whether the keyboard focus is inside the shadow tree of `host` right now. Asked of the document,
 * which names the host while a control of its shadow tree has the focus (and the body once that
 * control is gone), not of the shadow root: with a hundred hosts on the page, it must not depend on
 * how each root answers when the focus is in another one.
 */
export function hasFocus(host: Host): boolean {
  return host.element.ownerDocument.activeElement === host.element;
}

/**
 * Gives the focus to `element` without scrolling the page to it. Every focus the grid moves goes
 * through here: it only ever restores a focus that was already in our own UI, and the page must not
 * jump (the bar can be far from the card that was just analysed) because we did.
 */
export function focusInPlace(element: HTMLElement | null | undefined) {
  element?.focus({ preventScroll: true });
}

/**
 * Draws a host again without losing the keyboard focus. Redrawing swaps a control for another one
 * (the button that gives way to the verdict, "Analyser" to "Lancer"): the element that had the focus
 * leaves the page and the focus falls back on the page. When the focus was in the host and is lost
 * that way, `target` says which control of the new drawing takes it. A focus that was not in the
 * host is never touched.
 */
export function redrawKeepingFocus(
  host: Host,
  draw: () => void,
  target: (root: ShadowRoot) => HTMLElement | null,
) {
  const had = hasFocus(host);
  draw();
  const root = host.element.shadowRoot;
  if (had && root && !hasFocus(host)) focusInPlace(target(root));
}

/**
 * Moves a host in the page (`after`, `before`) without losing the keyboard focus: a browser drops
 * the focus of an element that is taken out of the document, even to be put back at once. The
 * control that had it, if the host had it, gets it back. A focus that was not in the host is never
 * touched.
 */
export function moveKeepingFocus(host: Host, move: () => void) {
  // Only asked of a root that has the focus: this is the control, not some other root's.
  const control = hasFocus(host) ? host.element.shadowRoot?.activeElement : null;
  move();
  if (control && !hasFocus(host)) focusInPlace(control as HTMLElement);
}
