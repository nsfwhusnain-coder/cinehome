/**
 * Next.js instrumentation — runs once when the server process starts.
 *
 * Loads the owner's Real-Debrid token from the database (AppSetting) into
 * `process.env.REAL_DEBRID_API_TOKEN` so the debrid tier uses the token set
 * from the Settings UI even across container restarts (the DB, not `.env`, is
 * the source of truth once the owner saves one). No-ops cleanly when none is
 * set. The token value is never logged.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { syncRealDebridTokenToEnv } = await import("@/lib/debrid-credentials");
    const { syncAllDebridTokenToEnv } = await import("@/lib/alldebrid-credentials");
    const source = await syncRealDebridTokenToEnv();
    const adSource = await syncAllDebridTokenToEnv();
    console.log(`[debrid] boot: Real-Debrid token source = ${source}`);
    console.log(`[debrid] boot: AllDebrid key source = ${adSource}`);
  } catch (err) {
    console.error(
      "[debrid] boot: token sync failed:",
      err instanceof Error ? err.message : String(err)
    );
  }
}
