/** Drop TMDB adult titles when the household setting is on (default). */
export function withoutAdultTitles<T extends { adult?: boolean }>(
  items: T[],
  hideAdult = true
): T[] {
  if (!hideAdult) return items;
  return items.filter((item) => item.adult !== true);
}
