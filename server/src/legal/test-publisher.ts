import type { Publisher } from './entity';

/**
 * A publisher with every field filled, for the tests of the legal pages: values nobody would type
 * for real, so that a page printing a typed one instead of the object's would fail a test. Each
 * one is unique, and one holds an `&` to prove the pages escape what they print.
 */
export const FILLED_PUBLISHER: Publisher = {
  companyName: 'Zorglub & Fils',
  legalForm: 'SAS Test',
  shareCapital: '4 242 euros',
  registeredOffice: '7 impasse du Test, 99999 Testville',
  rcs: 'Testville B 000 111 222',
  siret: '000 111 222 00033',
  vat: 'FR00000111222',
  publicationDirector: 'Zoé Directrice',
  contactEmail: 'contact@zorglub.test',
  mediatorName: 'Médiation Test',
  mediatorAddress: '1 place du Médiateur, 99998 Médiaville',
  mediatorWebsite: 'www.mediation.test',
};
