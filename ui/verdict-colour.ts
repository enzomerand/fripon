import type { VerdictLevel } from '../lib/model';

/** The colour of the card, and of the compact verdict of a results grid, for each verdict level. */
export const LEVEL_COLOUR: Record<VerdictLevel, 'red' | 'orange' | 'green'> = {
  dropshipping: 'red',
  resold: 'orange',
  review: 'orange',
  clean: 'green',
};
