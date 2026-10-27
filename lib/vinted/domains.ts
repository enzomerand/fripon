/** Vinted country domains. Match patterns cannot wildcard the TLD, so each one is listed. */
export const VINTED_HOSTS = [
  'vinted.fr',
  'vinted.be',
  'vinted.es',
  'vinted.it',
  'vinted.de',
  'vinted.at',
  'vinted.nl',
  'vinted.lu',
  'vinted.pt',
  'vinted.pl',
  'vinted.cz',
  'vinted.sk',
  'vinted.lt',
  'vinted.lv',
  'vinted.ee',
  'vinted.hu',
  'vinted.ro',
  'vinted.hr',
  'vinted.si',
  'vinted.gr',
  'vinted.se',
  'vinted.fi',
  'vinted.dk',
  'vinted.ie',
  'vinted.co.uk',
  'vinted.com',
] as const;

/** The listing card only runs on item pages: `https://www.<host>/items/*`. */
export const VINTED_ITEM_MATCHES = VINTED_HOSTS.map((host) => `https://www.${host}/items/*`);

/**
 * Every page of Vinted. The grid buttons run on all of them (catalogue, search, wardrobe, home
 * feed) except the item pages, which have their own card (`VINTED_ITEM_MATCHES`).
 */
export const VINTED_PAGE_MATCHES = VINTED_HOSTS.map((host) => `https://www.${host}/*`);
