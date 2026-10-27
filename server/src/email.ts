/**
 * The address with its cosmetic variants removed, so that `Jo.Doe+a@googlemail.com` and
 * `jodoe@gmail.com` are the same mailbox. It only serves to spot one person making several
 * accounts (the free trial is once per mailbox); sign-in itself uses the exact address typed.
 *
 * Lower case, the `+tag` of the local part dropped for every domain, the dots of the local part
 * dropped for Gmail only (they mean nothing there, and do elsewhere), `googlemail.com` read as
 * `gmail.com`. Takes the stored form of an address (see `normalizeEmail`).
 */
export function canonicalEmail(email: string): string {
  const address = email.trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (at < 0) return address;

  let domain = address.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';

  const original = address.slice(0, at);
  let local = original.split('+')[0] as string;
  if (domain === 'gmail.com') local = local.replaceAll('.', '');
  // `+tag@...` or `...@gmail.com` would all collapse into one empty name: keep what was typed.
  if (local === '') local = original;
  return `${local}@${domain}`;
}
