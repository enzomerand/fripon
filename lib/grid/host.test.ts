import { describe, expect, it, vi } from 'vitest';
import { BUTTON_HOST_TAG, createHost, createSharedStyles } from './host';

const CSS = '.a { color: red; }';

/** A shadow root that records what it was given; happy-dom has no constructed stylesheets. */
function fakeShadow() {
  const appended: Element[] = [];
  const shadow = {
    ownerDocument: document,
    adoptedStyleSheets: [] as CSSStyleSheet[],
    append: (node: Element) => void appended.push(node),
  };
  return { shadow: shadow as unknown as ShadowRoot, appended, raw: shadow };
}

const sheetOf = (replaceSync = vi.fn()) => ({ replaceSync }) as unknown as CSSStyleSheet;

describe('createSharedStyles', () => {
  it('adopts one constructed sheet in every root, built once', () => {
    const replaceSync = vi.fn();
    const makeSheet = vi.fn(() => sheetOf(replaceSync));
    const styles = createSharedStyles(CSS, makeSheet);
    const first = fakeShadow();
    const second = fakeShadow();

    styles.apply(first.shadow);
    styles.apply(second.shadow);

    expect(makeSheet).toHaveBeenCalledOnce();
    expect(replaceSync).toHaveBeenCalledWith(CSS);
    expect(first.raw.adoptedStyleSheets).toHaveLength(1);
    expect(first.raw.adoptedStyleSheets[0]).toBe(second.raw.adoptedStyleSheets[0]);
    expect(first.appended).toEqual([]);
  });

  it('falls back on a style element when constructed sheets do not exist', () => {
    const styles = createSharedStyles(CSS, () => {
      throw new TypeError('Illegal constructor');
    });
    const { shadow, appended, raw } = fakeShadow();
    styles.apply(shadow);
    expect(raw.adoptedStyleSheets).toEqual([]);
    expect(appended).toHaveLength(1);
    expect(appended[0]?.tagName).toBe('STYLE');
    expect(appended[0]?.textContent).toBe(CSS);
  });

  it('falls back on a style element when a root refuses the sheet', () => {
    const styles = createSharedStyles(CSS, () => sheetOf());
    const { shadow, appended, raw } = fakeShadow();
    Object.defineProperty(raw, 'adoptedStyleSheets', {
      set() {
        throw new DOMException('Not allowed', 'NotAllowedError');
      },
    });
    styles.apply(shadow);
    expect(appended[0]?.textContent).toBe(CSS);
  });

  it('does not try to build the sheet again after a failure', () => {
    const makeSheet = vi.fn(() => {
      throw new TypeError('Illegal constructor');
    });
    const styles = createSharedStyles(CSS, makeSheet);
    styles.apply(fakeShadow().shadow);
    styles.apply(fakeShadow().shadow);
    expect(makeSheet).toHaveBeenCalledOnce();
  });
});

describe('createHost', () => {
  it('makes an element with an open shadow root that holds a container', () => {
    const apply = vi.fn();
    const { element, container } = createHost(document, BUTTON_HOST_TAG, { apply });
    expect(element.localName).toBe(BUTTON_HOST_TAG);
    expect(element.shadowRoot?.contains(container)).toBe(true);
    expect(apply).toHaveBeenCalledWith(element.shadowRoot);
  });

  it('puts the host above the covering link of the card, shielded from the page CSS', () => {
    const { element } = createHost(document, BUTTON_HOST_TAG, { apply: vi.fn() });
    const style = element.style;
    expect(style.getPropertyValue('position')).toBe('relative');
    expect(style.getPropertyPriority('position')).toBe('important');
    expect(Number(style.getPropertyValue('z-index'))).toBeGreaterThan(1);
    expect(style.getPropertyValue('display')).toBe('block');
    expect(style.getPropertyValue('pointer-events')).toBe('auto');
  });
});
