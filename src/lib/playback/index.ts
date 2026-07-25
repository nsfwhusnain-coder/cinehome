import { db } from "@/lib/db";
import { StubPlaybackProvider } from "./stub";
import { ScraperPlaybackProvider } from "./scraper";
import type { PlaybackProvider } from "./types";

export * from "./types";

const PROVIDERS: Record<string, PlaybackProvider> = {
  [ScraperPlaybackProvider.id]: ScraperPlaybackProvider,
  [StubPlaybackProvider.id]: StubPlaybackProvider,
};

export const DEFAULT_PROVIDER_ID = ScraperPlaybackProvider.id;

export async function getProvider(): Promise<PlaybackProvider> {
  const setting = await db.appSetting.findUnique({ where: { key: "playback_provider" } });
  const id = setting?.value || DEFAULT_PROVIDER_ID;
  return PROVIDERS[id] || StubPlaybackProvider;
}

export function listProviders(): { id: string; name: string }[] {
  return Object.values(PROVIDERS).map((p) => ({ id: p.id, name: p.name }));
}
