"use client";

import { useEffect, useState } from "react";

/**
 * Returns `false` on the server and on the first client render,
 * then `true` after `useEffect` runs.
 *
 * Use this to avoid hydration mismatches in views that depend on
 * async data — render a skeleton until mounted, then show the real content.
 */
export function useMounted() {
  const [mounted, setMounted] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMounted(true), []);
  return mounted;
}
