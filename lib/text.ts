/** Removes accents and other combining marks: "Très bon état" -> "Tres bon etat". */
export function stripAccents(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '');
}
