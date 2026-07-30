import * as React from "react"

const MOBILE_BREAKPOINT = 768
const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

/**
 * `matchMedia` IS an external store, so it is read through
 * useSyncExternalStore rather than mirrored into state by an effect. Besides
 * satisfying the compiler, this removes the one-frame flash where the hook
 * reported `false` on mount before the effect corrected it — server and first
 * client render now agree via the explicit server snapshot.
 */
function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(QUERY)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

const getSnapshot = () => window.matchMedia(QUERY).matches
/** No viewport on the server; desktop is the safe assumption for layout. */
const getServerSnapshot = () => false

export function useIsMobile() {
  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
