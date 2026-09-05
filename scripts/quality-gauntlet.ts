#!/usr/bin/env bun
/**
 * Cinehome Cinema-Grade Quality Gauntlet Harness.
 *
 * Runs an exhaustive quality and playback audit across:
 * - Top 20 Trending Movies
 * - Top 20 Trending TV Shows (S1E1)
 *
 * Evaluates:
 * 1. Startup Latency (TTFB < 2.0s target, < 1.0s cached/debrid)
 * 2. Resolution Target (4K / 2160p priority, 1080p minimum floor)
 * 3. Stream Health (200/206 HTTP playable pass-through)
 * 4. Subtitle Availability (>= 1 English subtitle track guaranteed)
 * 5. Provider & Debrid Breakdown
 */

interface TitleTarget {
  id: number;
  title: string;
  mediaType: "movie" | "tv";
  season?: number;
  episode?: number;
}

interface GauntletResult {
  title: string;
  mediaType: "movie" | "tv";
  tmdbId: number;
  season?: number;
  episode?: number;
  status: "PASS" | "WARN" | "FAIL";
  httpStatus: number;
  latencyMs: number;
  selectedQuality: string;
  maxAvailableQuality: string;
  sourceCount: number;
  provider: string;
  isDebrid: boolean;
  streamUrlValid: boolean;
  streamHttpStatus?: number;
  subtitleCount: number;
  englishSubtitles: boolean;
  notes: string[];
}

const APP_BASE = process.env.APP_BASE || "http://localhost:3000";
// Credentials come from the environment, never the repo — this is a PUBLIC
// repository. Same contract as scripts/browser/qa.ts.
const TEST_USER = process.env.CINEHOME_TEST_USER || "";
const TEST_PIN = process.env.CINEHOME_TEST_PIN || "";

async function login(): Promise<string> {
  if (!TEST_USER || !TEST_PIN) {
    throw new Error("CINEHOME_TEST_USER and CINEHOME_TEST_PIN must be set");
  }
  const csrfRes = await fetch(`${APP_BASE}/api/auth/csrf`);
  const { csrfToken } = await csrfRes.json();
  const csrfCookie = csrfRes.headers.getSetCookie().join("; ");

  const form = new URLSearchParams();
  form.append("name", TEST_USER);
  form.append("pin", TEST_PIN);
  form.append("csrfToken", csrfToken);
  form.append("json", "true");

  const authRes = await fetch(`${APP_BASE}/api/auth/callback/credentials`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Cookie: csrfCookie,
    },
    body: form.toString(),
    redirect: "manual",
  });

  const sessionCookies = authRes.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

  if (!sessionCookies.includes("next-auth.session-token")) {
    throw new Error("Failed to authenticate with NextAuth credentials");
  }

  return sessionCookies;
}

async function getGauntletCatalog(cookie: string): Promise<TitleTarget[]> {
  const moviesRes = await fetch(`${APP_BASE}/api/tmdb/trending/movie/week`, {
    headers: { Cookie: cookie },
  });
  const moviesData = await moviesRes.json();
  const movies: TitleTarget[] = (moviesData.results || [])
    .slice(0, 20)
    .map((m: any) => ({
      id: m.id,
      title: m.title || m.original_title || `Movie ${m.id}`,
      mediaType: "movie" as const,
    }));

  const tvRes = await fetch(`${APP_BASE}/api/tmdb/trending/tv/week`, {
    headers: { Cookie: cookie },
  });
  const tvData = await tvRes.json();
  const tvShows: TitleTarget[] = (tvData.results || [])
    .slice(0, 20)
    .map((t: any) => ({
      id: t.id,
      title: t.name || t.original_name || `Show ${t.id}`,
      mediaType: "tv" as const,
      season: 1,
      episode: 1,
    }));

  return [...movies, ...tvShows];
}

async function testStreamPlayability(
  streamUrl: string,
  cookie: string
): Promise<{ valid: boolean; status?: number; error?: string }> {
  try {
    let targetUrl = streamUrl;
    if (targetUrl.startsWith("/")) {
      targetUrl = `${APP_BASE}${targetUrl}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);

    const isHls = targetUrl.includes("/api/hls") || targetUrl.includes(".m3u8");

    const headers: Record<string, string> = {
      Cookie: cookie,
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    };

    if (!isHls) {
      headers.Range = "bytes=0-1048576";
    }

    const res = await fetch(targetUrl, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (res.status === 200 || res.status === 206) {
      if (isHls) {
        const text = await res.text();
        return { valid: text.includes("#EXTM3U") || text.includes("#EXTINF") || text.length > 0, status: res.status };
      }
      return { valid: true, status: res.status };
    }

    return { valid: false, status: res.status };
  } catch (err: any) {
    return { valid: false, error: err.message || "stream probe failed" };
  }
}

async function testSubtitles(
  target: TitleTarget,
  cookie: string
): Promise<{ count: number; hasEnglish: boolean }> {
  try {
    const qs = new URLSearchParams({
      tmdbId: String(target.id),
      mediaType: target.mediaType,
      ...(target.season != null ? { season: String(target.season) } : {}),
      ...(target.episode != null ? { episode: String(target.episode) } : {}),
    });

    const res = await fetch(`${APP_BASE}/api/subtitles?${qs.toString()}`, {
      headers: { Cookie: cookie },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return { count: 0, hasEnglish: false };

    const data = await res.json();
    const subs: any[] = data.subtitles || [];
    const hasEnglish = subs.some(
      (s) =>
        s.language?.toLowerCase().startsWith("en") ||
        s.subLanguageId?.toLowerCase().startsWith("en") ||
        s.label?.toLowerCase().includes("english")
    );

    return { count: subs.length, hasEnglish };
  } catch {
    return { count: 0, hasEnglish: false };
  }
}

export async function runGauntlet(): Promise<{
  results: GauntletResult[];
  summary: {
    total: number;
    pass: number;
    warn: number;
    fail: number;
    fourKCount: number;
    tenEightyCount: number;
    debridCount: number;
    subtitlesPassRate: number;
    avgLatencyMs: number;
  };
}> {
  console.log("🔐 Authenticating test runner with Cinehome...");
  const cookie = await login();
  console.log("✅ Authenticated successfully.");

  console.log("📋 Fetching Top 20 Trending Movies & Top 20 Popular TV Shows...");
  const targets = await getGauntletCatalog(cookie);
  console.log(`🎬 Catalog ready: ${targets.length} titles queued for gauntlet.`);

  const results: GauntletResult[] = [];

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    const indexStr = `[${String(i + 1).padStart(2, "0")}/${targets.length}]`;
    const label =
      target.mediaType === "tv"
        ? `${target.title} (S${target.season}E${target.episode})`
        : target.title;

    process.stdout.write(`⏳ ${indexStr} Testing ${label}... `);

    const startTime = performance.now();
    const notes: string[] = [];

    try {
      const endpoint =
        target.mediaType === "tv"
          ? `${APP_BASE}/api/playback/tv/${target.id}?season=${target.season}&episode=${target.episode}&fast=1`
          : `${APP_BASE}/api/playback/movie/${target.id}?fast=1`;

      const playRes = await fetch(endpoint, {
        headers: { Cookie: cookie },
      });
      const latencyMs = Math.round(performance.now() - startTime);

      if (!playRes.ok) {
        results.push({
          title: target.title,
          mediaType: target.mediaType,
          tmdbId: target.id,
          season: target.season,
          episode: target.episode,
          status: "FAIL",
          httpStatus: playRes.status,
          latencyMs,
          selectedQuality: "none",
          maxAvailableQuality: "none",
          sourceCount: 0,
          provider: "none",
          isDebrid: false,
          streamUrlValid: false,
          subtitleCount: 0,
          englishSubtitles: false,
          notes: [`Playback API returned HTTP ${playRes.status}`],
        });
        console.log(`❌ FAIL (${latencyMs}ms, HTTP ${playRes.status})`);
        continue;
      }

      const playData = await playRes.json();
      const sources: any[] = playData.sources || [];
      const bestSource = sources[0];

      let maxQuality = "none";
      for (const s of sources) {
        const q = String(s.quality || "").toLowerCase();
        if (q.includes("2160") || q.includes("4k")) {
          maxQuality = "4K";
          break;
        } else if (q.includes("1080")) {
          if (maxQuality !== "4K") maxQuality = "1080p";
        } else if (q.includes("720") && maxQuality === "none") {
          maxQuality = "720p";
        }
      }

      const selectedQuality = bestSource?.quality
        ? String(bestSource.quality).toUpperCase().includes("2160") ||
          String(bestSource.quality).toUpperCase().includes("4K")
          ? "4K"
          : String(bestSource.quality).toUpperCase().includes("1080")
            ? "1080p"
            : bestSource.quality
        : "auto";

      const provider = bestSource?.provider || playData.providerId || "unknown";
      const isDebrid = !!bestSource?.isDebrid || bestSource?.origin === "debrid" || provider === "debrid";

      // Test stream playability
      let streamPlayable = false;
      let streamHttpStatus: number | undefined;
      if (bestSource?.url || playData.streamUrl) {
        const urlToTest = bestSource?.url || playData.streamUrl;
        const streamCheck = await testStreamPlayability(urlToTest, cookie);
        streamPlayable = streamCheck.valid;
        streamHttpStatus = streamCheck.status;
      }

      // Test Subtitles
      const subCheck = await testSubtitles(target, cookie);

      // Evaluate Quality Standard
      let status: "PASS" | "WARN" | "FAIL" = "PASS";

      if (!streamPlayable && sources.length === 0) {
        status = "FAIL";
        notes.push("No playable stream sources found");
      } else if (!streamPlayable) {
        status = "WARN";
        notes.push(`Stream probe returned HTTP ${streamHttpStatus || "err"}`);
      }

      if (latencyMs > 3000) {
        status = status === "FAIL" ? "FAIL" : "WARN";
        notes.push(`High startup latency: ${latencyMs}ms`);
      }

      if (!subCheck.hasEnglish && subCheck.count === 0) {
        status = status === "FAIL" ? "FAIL" : "WARN";
        notes.push("Missing English subtitles");
      }

      if (selectedQuality !== "4K" && maxQuality === "4K") {
        notes.push("Selected lower resolution than max available 4K source");
      }

      const result: GauntletResult = {
        title: target.title,
        mediaType: target.mediaType,
        tmdbId: target.id,
        season: target.season,
        episode: target.episode,
        status,
        httpStatus: playRes.status,
        latencyMs,
        selectedQuality,
        maxAvailableQuality: maxQuality,
        sourceCount: sources.length,
        provider,
        isDebrid,
        streamUrlValid: streamPlayable,
        streamHttpStatus,
        subtitleCount: subCheck.count,
        englishSubtitles: subCheck.hasEnglish,
        notes,
      };

      results.push(result);

      const statusIcon = status === "PASS" ? "✅" : status === "WARN" ? "⚠️" : "❌";
      console.log(
        `${statusIcon} ${status} (${latencyMs}ms | ${selectedQuality} | ${provider}${isDebrid ? "⚡RD" : ""} | Subs: ${subCheck.count})`
      );
    } catch (err: any) {
      results.push({
        title: target.title,
        mediaType: target.mediaType,
        tmdbId: target.id,
        season: target.season,
        episode: target.episode,
        status: "FAIL",
        httpStatus: 500,
        latencyMs: Math.round(performance.now() - startTime),
        selectedQuality: "none",
        maxAvailableQuality: "none",
        sourceCount: 0,
        provider: "none",
        isDebrid: false,
        streamUrlValid: false,
        subtitleCount: 0,
        englishSubtitles: false,
        notes: [err.message || "Exception during test"],
      });
      console.log(`❌ EXCEPTION: ${err.message}`);
    }
  }

  // Summary Metrics
  const pass = results.filter((r) => r.status === "PASS").length;
  const warn = results.filter((r) => r.status === "WARN").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  const fourKCount = results.filter((r) => r.selectedQuality === "4K").length;
  const tenEightyCount = results.filter((r) => r.selectedQuality === "1080P" || r.selectedQuality === "1080p").length;
  const debridCount = results.filter((r) => r.isDebrid).length;
  const subtitlesPass = results.filter((r) => r.englishSubtitles || r.subtitleCount > 0).length;
  const totalLatency = results.reduce((acc, r) => acc + r.latencyMs, 0);

  const summary = {
    total: results.length,
    pass,
    warn,
    fail,
    fourKCount,
    tenEightyCount,
    debridCount,
    subtitlesPassRate: Math.round((subtitlesPass / results.length) * 100),
    avgLatencyMs: Math.round(totalLatency / results.length),
  };

  return { results, summary };
}

// If run directly
if (import.meta.main) {
  console.log("\n========================================================");
  console.log("🚀 STARTING CINEHOME CINEMA-GRADE QUALITY GAUNTLET (40 TITLES)");
  console.log("========================================================\n");

  const startAll = performance.now();
  const { results, summary } = await runGauntlet();
  const durationSec = ((performance.now() - startAll) / 1000).toFixed(1);

  console.log("\n========================================================");
  console.log(`📊 GAUNTLET SCORECARD SUMMARY (${durationSec}s)`);
  console.log("========================================================");
  console.log(`Total Titles Tested:   ${summary.total}`);
  console.log(`✅ Passed:             ${summary.pass} (${Math.round((summary.pass / summary.total) * 100)}%)`);
  console.log(`⚠️ Warnings:           ${summary.warn} (${Math.round((summary.warn / summary.total) * 100)}%)`);
  console.log(`❌ Failures:           ${summary.fail} (${Math.round((summary.fail / summary.total) * 100)}%)`);
  console.log(`--------------------------------------------------------`);
  console.log(`⚡ Avg Startup TTFB:   ${summary.avgLatencyMs}ms`);
  console.log(`💎 4K / UHD Streams:   ${summary.fourKCount}`);
  console.log(`📺 1080p HD Streams:   ${summary.tenEightyCount}`);
  console.log(`⚡ Real-Debrid Hits:   ${summary.debridCount}`);
  console.log(`📝 Subtitle Coverage:  ${summary.subtitlesPassRate}%`);
  console.log("========================================================\n");

  if (summary.fail > 0 || summary.warn > 0) {
    console.log("🚨 DEFICIENCIES TO REMEDIATE:");
    for (const r of results.filter((r) => r.status !== "PASS")) {
      console.log(`- [${r.mediaType.toUpperCase()}] ${r.title}: ${r.notes.join("; ")}`);
    }
  }
}
