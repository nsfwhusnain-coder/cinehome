"use client";

import { useQuery } from "@tanstack/react-query";

export const HIDE_ADULT_QUERY_KEY = ["hide-adult"] as const;

/**
 * Household default is ON. Until the profile loads, treat adult titles as hidden.
 */
export function useHideAdult(): boolean {
  const { data } = useQuery({
    queryKey: HIDE_ADULT_QUERY_KEY,
    queryFn: async () => {
      const res = await fetch("/api/preferences", { cache: "no-store" });
      if (!res.ok) return true;
      const json = (await res.json()) as { hideAdult?: boolean };
      return json.hideAdult !== false;
    },
    staleTime: 5 * 60_000,
  });
  return data ?? true;
}
