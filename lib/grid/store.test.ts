import { describe, expect, it, vi } from 'vitest';
import type { CompactVerdict, QuickOutcome } from './quick-analysis';
import { createGridStore, viewOf, type CardView } from './store';

const verdict: CompactVerdict = {
  level: 'clean',
  title: 'Rien de suspect',
  line: 'Rien trouvé · analyse rapide',
};
const done: CardView = {
  status: 'done',
  url: 'https://www.vinted.fr/items/9000101-robe-test',
  verdict,
};

describe('createGridStore', () => {
  it('says idle for an item nobody touched', () => {
    expect(createGridStore().get('9000101')).toEqual({ status: 'idle' });
  });

  it('keeps the view of each item apart', () => {
    const store = createGridStore();
    store.set('9000101', done);
    store.set('9000102', { status: 'running' });
    expect(store.get('9000101')).toBe(done);
    expect(store.get('9000102')).toEqual({ status: 'running' });
    expect(store.get('9000103')).toEqual({ status: 'idle' });
  });

  it('tells the listeners which item changed', () => {
    const store = createGridStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.set('9000101', { status: 'running' });
    store.set('9000102', done);
    expect(listener.mock.calls).toEqual([['9000101'], ['9000102']]);
  });

  it('stops telling a listener that unsubscribed', () => {
    const store = createGridStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    store.set('9000101', done);
    expect(listener).not.toHaveBeenCalled();
  });

  it('forgets an item put back to idle', () => {
    const store = createGridStore();
    store.set('9000101', done);
    store.set('9000101', { status: 'idle' });
    expect(store.get('9000101')).toEqual({ status: 'idle' });
  });

  it('puts back to idle the items whose view matches, and only those', () => {
    const store = createGridStore();
    const listener = vi.fn();
    store.set('9000101', { status: 'needsKey', section: 'guide' });
    store.set('9000102', { status: 'quota' });
    store.set('9000103', done);
    store.set('9000104', { status: 'running' });
    store.subscribe(listener);

    store.resetWhere((view) => view.status === 'needsKey' || view.status === 'quota');

    expect(store.get('9000101').status).toBe('idle');
    expect(store.get('9000102').status).toBe('idle');
    expect(store.get('9000103')).toBe(done);
    expect(store.get('9000104').status).toBe('running');
    expect(listener.mock.calls).toEqual([['9000101'], ['9000102']]);
  });
});

describe('viewOf', () => {
  it('adds the item page to a verdict', () => {
    const outcome: QuickOutcome = { status: 'done', verdict };
    expect(viewOf(outcome, 'https://www.vinted.fr/items/9000101-robe-test')).toEqual(done);
  });

  it.each<QuickOutcome>([
    { status: 'needsKey', section: 'keys' },
    { status: 'quota' },
    { status: 'noPhoto' },
    { status: 'error', line: 'Recherche impossible' },
  ])('keeps the other outcomes as they are (%o)', (outcome) => {
    expect(viewOf(outcome, 'https://www.vinted.fr/items/9000101')).toEqual(outcome);
  });
});
