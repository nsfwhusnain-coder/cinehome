/**
 * Primary IA routes for desktop pill + mobile dock (KD9 / PR-06).
 * Continue lives on home row + /continue only — not primary nav.
 */
export const PRIMARY_NAV = [
  { label: "Home", path: "/" },
  { label: "Movies", path: "/movies" },
  { label: "Shows", path: "/shows" },
  { label: "My List", path: "/watchlist" },
] as const;

export type PrimaryNavPath = (typeof PRIMARY_NAV)[number]["path"];

/** Whether a primary (or utility) nav path is active for the current location. */
export function isNavPathActive(pathname: string, path: string): boolean {
  if (path === "/") return pathname === "/";
  return pathname === path || pathname.startsWith(`${path}/`);
}
