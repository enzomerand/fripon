/**
 * Who publishes Fripon Cloud: the ONE place the legal pages (`/cgv`, `/confidentialite`) read the
 * seller's details from. The seller is a French company.
 *
 * Fill `PUBLISHER` below and redeploy: nothing else has to change. A field left at `null` is not
 * filled yet and shows up in the pages as an `[À COMPLÉTER : …]` placeholder
 * (`grep -rn "À COMPLÉTER" server/src/legal` lists the other ones; the server warns at start when
 * `LEGAL_PAGES_FINAL=true` while one is left).
 *
 * Write each value as it must read on the page, in French: « Fripon SAS », « 10 000 euros »,
 * « 12 rue Example, 44000 Nantes », « Nantes B 123 456 789 »... Plain text, no HTML.
 */
export interface Publisher {
  /** Dénomination sociale. */
  companyName: string | null;
  /** Forme juridique : SAS, SARL, SASU, EURL... */
  legalForm: string | null;
  /** Capital social, with its currency: « 1 000 euros ». */
  shareCapital: string | null;
  /** Adresse du siège social. */
  registeredOffice: string | null;
  /** Registre du commerce et des sociétés: city of the registry and number, « Nantes B 123 456 789 ». */
  rcs: string | null;
  /** Numéro SIRET (14 digits). */
  siret: string | null;
  /** Numéro de TVA intracommunautaire, or the mention of the franchise en base de TVA. */
  vat: string | null;
  /** Nom du directeur de la publication. */
  publicationDirector: string | null;
  /** The address users write to (rights, complaints, the terms' « écrivez à l'éditeur »). */
  contactEmail: string | null;
  /** Médiateur de la consommation: name. Not chosen yet. */
  mediatorName: string | null;
  /** Médiateur de la consommation: postal address. */
  mediatorAddress: string | null;
  /** Médiateur de la consommation: website (shown as text, not as a link). */
  mediatorWebsite: string | null;
}

/** Every field is listed on purpose (no optional key): a forgotten one is a type error. */
export const PUBLISHER: Publisher = {
  companyName: null,
  legalForm: null,
  shareCapital: null,
  registeredOffice: null,
  rcs: null,
  siret: null,
  vat: null,
  publicationDirector: null,
  contactEmail: null,
  mediatorName: null,
  mediatorAddress: null,
  mediatorWebsite: null,
};

/**
 * The host (hébergeur) of the server: known and public, so it is a filled value, not a
 * placeholder. The server runs in an OVH data centre in France (Strasbourg).
 */
export const HOST = {
  name: 'OVH SAS',
  address: '2 rue Kellermann, 59100 Roubaix, France',
  /** Where the data is processed, as a phrase for the privacy policy. */
  processing: 'en France',
  /** The data centre, as the terms and the privacy policy say it. */
  datacentre: 'un centre de données OVH situé à Strasbourg, en France',
} as const;

/**
 * The service that sends the sign-in codes: known and public, so a filled value too. It processes
 * the data in the European Union.
 */
export const MAIL_PROVIDER = {
  name: 'Brevo',
  /** The company behind the service. */
  company: 'Sendinblue SAS',
  address: '106 boulevard Haussmann, 75008 Paris, France',
  /** Where the data is processed, as a phrase for the privacy policy. */
  processing: "dans l'Union européenne",
} as const;
