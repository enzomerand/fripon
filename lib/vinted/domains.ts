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

/** The content script only runs on item pages: `https://www.<host>/items/*`. */
export const VINTED_ITEM_MATCHES = VINTED_HOSTS.map((host) => `https://www.${host}/items/*`);
