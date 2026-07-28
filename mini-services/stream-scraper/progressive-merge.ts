/**
 * Preserve the measured roster and append only genuinely new late identities.
 *
 * A late provider arm often repeats the same signed source without probe
 * metadata. Letting that duplicate replace a measured failure makes a dead row
 * look healthy again and causes the player to retry it.
 */
export function appendNewSourceIdentities<T>(
  measured: T[],
  late: T[],
  identity: (source: T) => string
): T[] {
  const seen = new Set(measured.map(identity));
  return [
    ...measured,
    ...late.filter((source) => {
      const key = identity(source);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  ];
}
