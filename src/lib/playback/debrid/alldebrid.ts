/**
 * Thin AllDebrid client — sibling to realdebrid.ts.
 * Token is read ONLY from `process.env.ALLDEBRID_API_KEY`. Never logged.
 */

const AD_TIMEOUT_MS = 8_000;

export function isAllDebridConfigured(): boolean {
  return Boolean(process.env.ALLDEBRID_API_KEY?.trim());
}

export function getAllDebridToken(): string | null {
  const token = process.env.ALLDEBRID_API_KEY?.trim();
  return token || null;
}

export async function pingAllDebrid(token: string): Promise<boolean> {
  try {
    const url = `https://api.alldebrid.com/v4/user?agent=CineHome&apikey=${encodeURIComponent(token)}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(AD_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { status?: string };
    return body.status === "success";
  } catch {
    return false;
  }
}
