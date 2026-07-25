# HLS.js Config Research — CineHome VOD via Home-Server Proxy

**Date:** 2026-07-09  
**Scope:** VOD only (not live/LL-HLS). Playback path: browser → CineHome `/api/hls` proxy → upstream CDN.  
**Goal:** Netflix-like smoothness (fast start, rare stalls, stable quality) under **slow** and **medium** upstream segment latency.  
**Sources:** [hls.js API.md](https://github.com/video-dev/hls.js/blob/master/docs/API.md), [redoPop EWMA notes](https://redopop.com/posts/how-hlsjs-estimates-bandwidth/), CineHome `video-player.tsx` baseline.

---

## 1. Problem model

Assume ~**8s** media segments (common for VOD embeds).

| Profile | Time to fetch one 8s segment | Rough headroom vs realtime | What fails with stock defaults |
|--------|------------------------------|----------------------------|--------------------------------|
| **Slow** | **2–4 s** | 2–4× (tight) | Default `abrEwmaDefaultEstimate` (500 kbps) may under-start; high startLevel overshoots; small buffer + slow fill → mid-watch stalls; ABR thrash on jittery double-hop RTT |
| **Medium** | **200–500 ms** | 16–40× (healthy) | Over-buffering 1080p wastes proxy bandwidth; unnecessary quality flips; `lowLatencyMode` is irrelevant noise for VOD |

**Proxy reality:** every playlist + segment pays home-server RTT + origin latency. Measured “bandwidth” in hls.js is **end-to-end through the proxy**, not client→CDN. Treat EWMA samples as **proxy throughput**, not LAN speed.

**Netflix-like feel (practical definition for CineHome):**

1. First frame ≤ ~2–4s when proxy is up (prefer startable bitrate over best bitrate).
2. After start, buffer grows to a deep safety cushion so brief origin spikes don’t rebuffer.
3. Quality stays stable (no every-segment ladder climbing); step up only after sustained headroom.
4. Stalls self-heal (nudge / hole skip) without killing the session.
5. Auto quality never selects “hero” 1080p+/high-bitrate ladders that starve the buffer on household upstream.

---

## 2. Knob reference (what matters for proxy VOD)

### 2.1 Start & level selection

| Option | Default | Role for CineHome |
|--------|---------|-------------------|
| `startLevel` | `undefined` / API `-1` | Index of first quality. `-1` = auto. For proxy VOD, **set explicitly after `MANIFEST_PARSED`** to ~480p index (or lowest safe) so first fragment is small. |
| `testBandwidth` | `true` | Only useful with `startLevel: -1`. Downloads lowest level first to seed BW. **Disable** when you pick start height yourself (CineHome already does). |
| `autoLevelCapping` | `-1` (none) | Max **level index** ABR may use. Set after manifest parse to the highest level ≤720p (or 480p on slow). Runtime: `hls.autoLevelCapping = n`. |
| `capLevelToPlayerSize` | `false` | Caps ABR to video element pixel size (× DPR unless ignored). **On for TV/desktop UI** — avoids 1080p into a 720p player box. Pair with `ignoreDevicePixelRatio: true` on retina if you want CSS-pixel caps only. |
| `minAutoBitrate` | `0` | Floor for auto. Usually leave 0; use height caps instead. |

### 2.2 ABR / EWMA

hls.js keeps **fast** + **slow** EWMA half-lives and uses the **min** of both → drops fast, climbs slow ([redoPop](https://redopop.com/posts/how-hlsjs-estimates-bandwidth/)).

| Option | Default | Guidance |
|--------|---------|----------|
| `abrEwmaFastVoD` | `3.0` | Lower → more reactive to drops. Slow proxy: keep **2–3**. Medium: default **3**. |
| `abrEwmaSlowVoD` | `9.0` | Higher → climb more cautiously. Slow: **12–15**. Medium: **9–12**. |
| `abrEwmaDefaultEstimate` | `500_000` (500 kbps) | Seed until real samples. **Must match expected proxy throughput**, not LAN. Slow: ~0.8–1.5 Mbps. Medium: ~2–4 Mbps. Persist last `hls.bandwidthEstimate` in `sessionStorage` for next session. |
| `abrEwmaDefaultEstimateMax` | `5_000_000` | Caps the seed after bandwidth tests. Keep low-ish on slow profiles. |
| `abrBandWidthFactor` | `0.95` | Safety margin vs estimate when selecting level. Slow: **0.7–0.8**. Medium: **0.85–0.95**. |
| `abrBandWidthUpFactor` | `0.7` | Extra caution when **upgrading**. Slow: **0.5–0.6**. Medium: **0.65–0.75**. |
| `abrMaxWithRealBitrate` | `false` | Use measured segment bitrates when true. **true** for embed ladders with lying `BANDWIDTH` tags (common). |
| `abrSwitchInterval` | `0` | Min seconds between ABR switches. Slow: **8–16** (≈1–2 segments). Medium: **4–8**. Reduces thrash. |
| `maxStarvationDelay` | `4` | Max predicted rebuffer (s) ABR will tolerate when picking a level. Higher → more aggressive quality under low buffer. **Slow: 2–3** (prefer drop quality). Medium: **4**. |
| `maxLoadingDelay` | `4` | Startup: time budget for first-level selection. **Slow: 6–8**. Medium: **4**. |

### 2.3 Buffer targets

| Option | Default | Guidance |
|--------|---------|----------|
| `maxBufferLength` | `30` | **Target** forward buffer (s) hls.js tries to reach regardless of byte cap. Slow: **60–90** (deep cushion). Medium: **30–45**. Netflix-like = deep once playing, not minimal. |
| `maxMaxBufferLength` | `600` | Hard cap (s). Slow: **120–180**. Medium: **90–120**. Avoid multi-GB fills on long movies. |
| `maxBufferSize` | 60e6 | Byte budget. Slow 480p: **40–60 MB**. Medium 720p: **60–80 MB**. |
| `backBufferLength` | `Infinity` | Keep played media. Set **60–90** for memory (SPA / mobile). |
| `maxBufferHole` | `0.1` | Tolerance for inter-fragment gaps. Proxy remux / bad packs: **0.3–0.5**. |

**Rule of thumb:** if one 8s segment takes **T** seconds, you need roughly **`maxBufferLength ≳ 3–4 × T × (segmentDuration / T)`** headroom in **time** terms — for slow 2–4s loads, **≥ 45–60s** buffer is what keeps mid-show origin blips invisible.

### 2.4 Prefetch / workers / progressive / LL

| Option | Default | CineHome VOD |
|--------|---------|--------------|
| `startFragPrefetch` | `false` | **true** — begin first fragment before/around attach; shaves startup. |
| `enableWorker` | `true` | **true** — demux/remux off main thread (fewer frame drops). |
| `workerPath` | `null` | Required if bundling **ESM** `hls.mjs` without IIFE worker inject. Point at `hls.worker.js` asset. |
| `progressive` | `false` | Experimental fetch streaming of segments. **Leave false** for proxy+cookies/XHR unless you’ve validated `fetchSetup` + credentials path. |
| `lowLatencyMode` | `true` | **false for all VOD.** LL part loading is wrong model and can increase playlist chatter through the proxy. |

### 2.5 Stall detection & recovery

| Option | Default | Guidance |
|--------|---------|----------|
| `detectStallWithCurrentTimeMs` | `1250` | How long without `currentTime` advance before stall (when no `waiting`). Slightly higher on slow decode devices: **1500–2000**. |
| `highBufferWatchdogPeriod` | `2`–`3` | If buffered ahead but playhead stuck → gap jump / nudge. Keep **2**. |
| `nudgeOffset` | `0.1` | Seek nudge step on stuck playhead. |
| `nudgeMaxRetry` | `3` | After this → fatal `BUFFER_STALLED_ERROR`. Proxy/VOD: **5**. |
| `nudgeOnVideoHole` | `true` | Keep **true** (Chromium video-hole workaround). |
| `skipBufferHolePadding` | `0.1` | Bump on TV shells (Tizen etc.) if hole-skip loops. |

**App-level recovery (required for Netflix-like resilience):** on `Hls.Events.ERROR`:

- Non-fatal: ignore or log.
- Fatal `MEDIA_ERROR`: debounce `hls.recoverMediaError()` (e.g. 2s, max 3 tries).
- Fatal `NETWORK_ERROR`: limited `startLoad()` retries, then next source / re-resolve (CineHome already multi-source).

Do **not** spin infinite recover loops — that feels worse than a clean “try next source”.

### 2.6 Load policies (timeouts / retries)

Deprecated `fragLoadingTimeOut` still works in many builds but prefer `fragLoadPolicy`:

```ts
fragLoadPolicy: {
  default: {
    maxTimeToFirstByteMs: 20_000, // slow origin TTFB through proxy
    maxLoadTimeMs: 120_000,       // full segment
    timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
    errorRetry: {
      maxNumRetry: 6,
      retryDelayMs: 1000,
      maxRetryDelayMs: 8000,
      backoff: "linear",
    },
  },
},
```

Slow upstream: longer `maxTimeToFirstByteMs` / `maxLoadTimeMs`. Medium: closer to library defaults (10s TTFB, 120s total).

---

## 3. Fixed 480p/720p vs ABR through proxy?

### Recommendation (CineHome)

| Upstream | Strategy | Why |
|----------|----------|-----|
| **Slow (2–4s / seg)** | **Prefer fixed 480p**, or ABR hard-capped at **480p** with very cautious EWMA | Throughput barely 2–4× realtime at mid bitrates; ABR “probing” 720p/1080p burns the buffer and causes visible rebuffers. Fixed 480p = predictable, Netflix-like **stability over peak sharpness**. |
| **Medium (200–500 ms / seg)** | **ABR with auto cap 720p**, start ~480p | Headroom is large; ABR can climb safely. Cap 720p avoids fat 1080p segments competing with other household traffic through the home server. |
| **Unknown / first play** | Start **480p fixed for N segments** (or until buffer ≥ 20s), then enable ABR under cap | Hybrid gives fast start + later quality when the proxy proves healthy. |

### When pure fixed is better

- Single-variant manifests (many embeds already are).
- Measured segment time consistently > ~2s for 720p-sized segments.
- Mobile clients / weak Wi‑Fi to the home server.
- User explicitly picks quality in UI (honor preference; disable ABR).

### When ABR is better

- Multi-rung ladders with honest bitrates.
- Medium+ upstream and `abrBandWidthUpFactor` ≤ 0.7 so climbs are sticky.
- `autoLevelCapping` + `capLevelToPlayerSize` prevent vanity 1080p.

### Practical product rule

```
auto mode:
  if (profile === "slow")   → fixed 480p  (or ABR cap 480p)
  if (profile === "medium") → ABR, start 480p, cap 720p
  if (user picks height)    → fixed that height, no ABR
```

Optional: classify profile from first 2–3 fragment `stats.loading` durations (or RTT from proxy health endpoint) and switch config without user action.

---

## 4. Recommended configs

### Shared baseline (always for CineHome VOD)

```ts
// Always-on for proxy VOD — not profile-specific
const HLS_SHARED = {
  enableWorker: true,
  // workerPath: "/hls.worker.js", // if using ESM build
  lowLatencyMode: false,
  progressive: false,
  startFragPrefetch: true,
  testBandwidth: false, // we set startLevel ourselves on MANIFEST_PARSED
  abrMaxWithRealBitrate: true,
  capLevelToPlayerSize: true,
  ignoreDevicePixelRatio: true, // cap to CSS player size, not retina pixels
  maxBufferHole: 0.5,
  backBufferLength: 90,
  highBufferWatchdogPeriod: 2,
  nudgeOffset: 0.1,
  nudgeMaxRetry: 5,
  nudgeOnVideoHole: true,
  detectStallWithCurrentTimeMs: 1500,
} as const;
```

---

### 4.1 SLOW upstream — 2–4 s per 8 s segment  
**Priority:** never rebuffer; quality secondary.

```ts
import Hls, { type HlsConfig } from "hls.js";

/** Target: ~480p fixed or ABR ≤480p, deep buffer, conservative ABR. */
export const HLS_CONFIG_SLOW: Partial<HlsConfig> = {
  ...HLS_SHARED,

  // Start/level — refined further on MANIFEST_PARSED
  startLevel: -1,

  // ABR seed ~1 Mbps through proxy; climb very carefully
  abrEwmaDefaultEstimate: 1_000_000,
  abrEwmaDefaultEstimateMax: 2_000_000,
  abrEwmaFastVoD: 2.0,
  abrEwmaSlowVoD: 15.0,
  abrBandWidthFactor: 0.75,
  abrBandWidthUpFactor: 0.5,
  abrSwitchInterval: 16, // ~2× 8s segments
  maxStarvationDelay: 2,
  maxLoadingDelay: 8,

  // Deep cushion: at 2–4s/seg, 60–90s buffer ≈ 15–45 segments of safety
  maxBufferLength: 75,
  maxMaxBufferLength: 150,
  maxBufferSize: 50_000_000, // 50 MB — enough at 480p

  fragLoadPolicy: {
    default: {
      maxTimeToFirstByteMs: 25_000,
      maxLoadTimeMs: 180_000,
      timeoutRetry: { maxNumRetry: 3, retryDelayMs: 0, maxRetryDelayMs: 0 },
      errorRetry: {
        maxNumRetry: 8,
        retryDelayMs: 1500,
        maxRetryDelayMs: 12_000,
        backoff: "linear",
      },
    },
  },
  playlistLoadPolicy: {
    default: {
      maxTimeToFirstByteMs: 15_000,
      maxLoadTimeMs: 30_000,
      timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
      errorRetry: {
        maxNumRetry: 4,
        retryDelayMs: 1000,
        maxRetryDelayMs: 8000,
      },
    },
  },
};

// On MANIFEST_PARSED (slow profile):
// prefer FIXED 480p for Netflix-stable feel:
//   hls.autoLevelCapping = indexOfMaxHeight(levels, 480)
//   hls.startLevel = thatIndex
//   hls.currentLevel = thatIndex   // fixed — not -1
//
// or cautious ABR:
//   hls.autoLevelCapping = indexOfMaxHeight(levels, 480)
//   hls.startLevel = same
//   hls.currentLevel = -1
```

**Why these numbers**

- 75s buffer ≈ 9–10 × 8s segments; even if two segments take 4s each, playhead still has minutes of runway once filled.
- `maxStarvationDelay: 2` forces downshift early instead of hoping the next high-bitrate fragment arrives in time.
- `abrSwitchInterval: 16` stops sawtooth quality.
- Fixed 480p is the default product recommendation on this profile.

---

### 4.2 MEDIUM upstream — 200–500 ms per segment  
**Priority:** smooth start + allow 720p when stable.

```ts
import Hls, { type HlsConfig } from "hls.js";

/** Target: start ~480p, ABR up to 720p, moderate buffer, responsive but sticky ABR. */
export const HLS_CONFIG_MEDIUM: Partial<HlsConfig> = {
  ...HLS_SHARED,

  startLevel: -1,

  abrEwmaDefaultEstimate: 2_500_000,
  abrEwmaDefaultEstimateMax: 5_000_000,
  abrEwmaFastVoD: 3.0,
  abrEwmaSlowVoD: 12.0,
  abrBandWidthFactor: 0.9,
  abrBandWidthUpFactor: 0.65,
  abrSwitchInterval: 8,
  maxStarvationDelay: 4,
  maxLoadingDelay: 4,

  maxBufferLength: 40,
  maxMaxBufferLength: 100,
  maxBufferSize: 60_000_000,

  fragLoadPolicy: {
    default: {
      maxTimeToFirstByteMs: 12_000,
      maxLoadTimeMs: 120_000,
      timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
      errorRetry: {
        maxNumRetry: 6,
        retryDelayMs: 1000,
        maxRetryDelayMs: 8000,
        backoff: "linear",
      },
    },
  },
  playlistLoadPolicy: {
    default: {
      maxTimeToFirstByteMs: 10_000,
      maxLoadTimeMs: 20_000,
      timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
      errorRetry: {
        maxNumRetry: 3,
        retryDelayMs: 1000,
        maxRetryDelayMs: 8000,
      },
    },
  },
};

// On MANIFEST_PARSED (medium profile):
//   hls.autoLevelCapping = indexOfMaxHeight(levels, 720)
//   hls.startLevel = indexOfNearestHeight(levels, 480)
//   hls.nextLoadLevel = hls.startLevel
//   hls.currentLevel = -1  // ABR within cap
```

---

### 4.3 Paste-ready CineHome module (profile switch + stall recovery)

Drop-in style helpers aligned with current `video-player.tsx` constants (`HLS_START_HEIGHT = 480`, `HLS_AUTO_MAX_HEIGHT = 720`).

```ts
// src/lib/playback/hls-config.ts
import Hls, { type ErrorData, type HlsConfig, type Level } from "hls.js";

export type ProxyUpstreamProfile = "slow" | "medium";

const SHARED: Partial<HlsConfig> = {
  enableWorker: true,
  lowLatencyMode: false,
  progressive: false,
  startFragPrefetch: true,
  testBandwidth: false,
  abrMaxWithRealBitrate: true,
  capLevelToPlayerSize: true,
  ignoreDevicePixelRatio: true,
  maxBufferHole: 0.5,
  backBufferLength: 90,
  highBufferWatchdogPeriod: 2,
  nudgeOffset: 0.1,
  nudgeMaxRetry: 5,
  nudgeOnVideoHole: true,
  detectStallWithCurrentTimeMs: 1500,
};

const BY_PROFILE: Record<ProxyUpstreamProfile, Partial<HlsConfig>> = {
  slow: {
    abrEwmaDefaultEstimate: 1_000_000,
    abrEwmaDefaultEstimateMax: 2_000_000,
    abrEwmaFastVoD: 2.0,
    abrEwmaSlowVoD: 15.0,
    abrBandWidthFactor: 0.75,
    abrBandWidthUpFactor: 0.5,
    abrSwitchInterval: 16,
    maxStarvationDelay: 2,
    maxLoadingDelay: 8,
    maxBufferLength: 75,
    maxMaxBufferLength: 150,
    maxBufferSize: 50_000_000,
    fragLoadPolicy: {
      default: {
        maxTimeToFirstByteMs: 25_000,
        maxLoadTimeMs: 180_000,
        timeoutRetry: { maxNumRetry: 3, retryDelayMs: 0, maxRetryDelayMs: 0 },
        errorRetry: {
          maxNumRetry: 8,
          retryDelayMs: 1500,
          maxRetryDelayMs: 12_000,
          backoff: "linear",
        },
      },
    },
  },
  medium: {
    abrEwmaDefaultEstimate: 2_500_000,
    abrEwmaDefaultEstimateMax: 5_000_000,
    abrEwmaFastVoD: 3.0,
    abrEwmaSlowVoD: 12.0,
    abrBandWidthFactor: 0.9,
    abrBandWidthUpFactor: 0.65,
    abrSwitchInterval: 8,
    maxStarvationDelay: 4,
    maxLoadingDelay: 4,
    maxBufferLength: 40,
    maxMaxBufferLength: 100,
    maxBufferSize: 60_000_000,
    fragLoadPolicy: {
      default: {
        maxTimeToFirstByteMs: 12_000,
        maxLoadTimeMs: 120_000,
        timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
        errorRetry: {
          maxNumRetry: 6,
          retryDelayMs: 1000,
          maxRetryDelayMs: 8000,
          backoff: "linear",
        },
      },
    },
  },
};

/** Build hls.js config for a measured/selected upstream profile. */
export function buildHlsConfig(
  profile: ProxyUpstreamProfile,
  opts?: { withCredentials?: boolean; abrDefaultOverrideBps?: number },
): Partial<HlsConfig> {
  const base: Partial<HlsConfig> = {
    ...SHARED,
    ...BY_PROFILE[profile],
    startLevel: -1,
  };

  if (opts?.abrDefaultOverrideBps != null) {
    base.abrEwmaDefaultEstimate = opts.abrDefaultOverrideBps;
  }

  if (opts?.withCredentials) {
    base.xhrSetup = (xhr) => {
      xhr.withCredentials = true;
    };
  }

  return base;
}

export function levelIndexForMaxHeight(levels: Level[], maxHeight: number): number {
  let best = 0;
  for (let i = 0; i < levels.length; i++) {
    const h = levels[i]?.height ?? 0;
    if (h > 0 && h <= maxHeight) best = i;
  }
  return best;
}

export function levelIndexNearestHeight(levels: Level[], targetHeight: number): number {
  let best = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < levels.length; i++) {
    const h = levels[i]?.height ?? 0;
    const d = Math.abs(h - targetHeight);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/**
 * Apply Netflix-like start + cap after MANIFEST_PARSED.
 * slow  → fixed ≤480p (stable)
 * medium → start ~480p, ABR ≤720p
 */
export function applyStartAndCap(
  hls: Hls,
  profile: ProxyUpstreamProfile,
  fixedUserHeight?: number | "auto",
): void {
  const levels = hls.levels;
  if (!levels?.length) return;

  if (typeof fixedUserHeight === "number") {
    const idx = levelIndexNearestHeight(levels, fixedUserHeight);
    hls.autoLevelCapping = -1;
    hls.startLevel = idx;
    hls.currentLevel = idx;
    return;
  }

  if (profile === "slow") {
    const cap = levelIndexForMaxHeight(levels, 480);
    hls.autoLevelCapping = cap;
    hls.startLevel = cap;
    // Fixed 480p for stability on slow proxy — flip to -1 for cautious ABR.
    hls.currentLevel = cap;
    return;
  }

  // medium
  const cap = levelIndexForMaxHeight(levels, 720);
  const start = levelIndexNearestHeight(levels, 480);
  hls.autoLevelCapping = cap;
  hls.startLevel = Math.min(start, cap);
  hls.nextLoadLevel = hls.startLevel;
  hls.currentLevel = -1; // ABR within cap
}

const STALL_DEBOUNCE_MS = 2000;
const MAX_MEDIA_RECOVERIES = 3;
const MAX_NETWORK_RECOVERIES = 2;

/** Wire buffer-stall / fatal recovery. Call once per Hls instance. */
export function attachHlsRecovery(
  hls: Hls,
  onGiveUp: () => void,
): () => void {
  let mediaRecoveries = 0;
  let networkRecoveries = 0;
  let lastMediaRecoveryAt = 0;

  const onError = (_event: string, data: ErrorData) => {
    if (!data.fatal) return;

    if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      const now = Date.now();
      if (now - lastMediaRecoveryAt < STALL_DEBOUNCE_MS) return;
      if (mediaRecoveries >= MAX_MEDIA_RECOVERIES) {
        onGiveUp();
        return;
      }
      lastMediaRecoveryAt = now;
      mediaRecoveries += 1;
      hls.recoverMediaError();
      return;
    }

    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      if (networkRecoveries >= MAX_NETWORK_RECOVERIES) {
        onGiveUp();
        return;
      }
      networkRecoveries += 1;
      hls.startLoad();
      return;
    }

    onGiveUp();
  };

  hls.on(Hls.Events.ERROR, onError);
  return () => {
    hls.off(Hls.Events.ERROR, onError);
  };
}

/** Optional: infer profile from first fragment load time (ms) for an 8s segment. */
export function inferProfileFromSegmentMs(loadDurationMs: number): ProxyUpstreamProfile {
  // 200–500ms → medium; ≥2000ms → slow; in-between → treat as slow-safe
  if (loadDurationMs > 0 && loadDurationMs < 800) return "medium";
  return "slow";
}

/** Persist EWMA for next session (call on destroy / visibilitychange). */
const BW_KEY = "cinehome.hls.bwEstimate";

export function rememberBandwidth(hls: Hls): void {
  const bw = hls.bandwidthEstimate;
  if (Number.isFinite(bw) && bw > 0) {
    try {
      sessionStorage.setItem(BW_KEY, String(Math.round(bw)));
    } catch {
      /* private mode */
    }
  }
}

export function readRememberedBandwidth(): number | undefined {
  try {
    const raw = sessionStorage.getItem(BW_KEY);
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 100_000 ? n : undefined;
  } catch {
    return undefined;
  }
}

// --- usage in video-player.tsx ---
//
// const profile: ProxyUpstreamProfile = "medium"; // or from settings / probe
// const hls = new Hls(
//   buildHlsConfig(profile, {
//     withCredentials: isProxied,
//     abrDefaultOverrideBps: readRememberedBandwidth(),
//   }),
// );
// const detachRecovery = attachHlsRecovery(hls, () => tryNextSource());
// hls.on(Hls.Events.MANIFEST_PARSED, () => {
//   applyStartAndCap(hls, profile, getPreferredQualityHeight());
// });
// // on teardown: rememberBandwidth(hls); detachRecovery(); hls.destroy();
```

---

## 5. Mapping vs current CineHome player

Current `video-player.tsx` (approx):

| Current | Assessment |
|---------|------------|
| `enableWorker: true`, `lowLatencyMode: false` | ✅ Correct for VOD |
| `startFragPrefetch: true`, `testBandwidth: false` | ✅ Correct with custom start |
| `abrEwmaDefaultEstimate: 1.5 Mbps` | ✅ Good middle ground; split by profile |
| `capLevelToPlayerSize: true` | ✅ Keep; consider `ignoreDevicePixelRatio: true` |
| `maxBufferLength: 30`, `maxMaxBufferLength: 60` | ⚠️ Thin for **slow** (2–4s/seg) — raise to 75/150 |
| `maxBufferSize: 40 MB` | OK for 480p; raise to 60 MB on medium 720p |
| Auto cap 720p, start 480p | ✅ Medium profile; on slow prefer **fixed 480p** |
| Deprecated `fragLoadingTimeOut` / `MaxRetry` | Prefer `fragLoadPolicy` on hls.js 1.6+ |
| `nudgeMaxRetry: 5`, `highBufferWatchdogPeriod: 2` | ✅ Good stall recovery baseline |
| No `abrSwitchInterval` / tight `abrBandWidthUpFactor` | Add for thrash control |
| `progressive` not set | ✅ Default false is correct |

---

## 6. Netflix-like checklist (acceptance)

- [ ] `lowLatencyMode: false`, `progressive: false`, `enableWorker: true`
- [ ] First playable segment is ≤480p (or user fixed choice)
- [ ] Auto never exceeds 720p on medium, 480p on slow (unless user override)
- [ ] Forward buffer target ≥ 60s on slow, ≥ 30s on medium after steady state
- [ ] No quality flip more often than ~1 per segment duration (`abrSwitchInterval`)
- [ ] Fatal media errors recover ≤3 times with debounce; then next source
- [ ] Last bandwidth estimate reused next session
- [ ] Credentials/`xhrSetup` only on proxied URLs
- [ ] Profile selectable or auto-inferred from first fragment timing

---

## 7. Decision summary

| Question | Answer |
|----------|--------|
| Best overall for **slow** proxy? | **Fixed 480p** + deep buffer (`maxBufferLength` 75) + long frag timeouts + aggressive ABR if any |
| Best overall for **medium** proxy? | **ABR, start 480p, cap 720p** + `maxBufferLength` 40 + sticky up-factor 0.65 |
| Force fixed instead of ABR? | **Yes on slow** and whenever user picks a height. **No on medium auto** if ladder exists. |
| Keep LL / progressive? | **Off** for this VOD+proxy path |
| Key Netflix levers | Fast low start, deep buffer, slow climb / fast drop EWMA, stall nudge + recoverMediaError, never 1080p auto through household proxy |

---

## 8. Defaults reference (hls.js stock vs CineHome intent)

| Key | hls.js default | CineHome slow | CineHome medium |
|-----|----------------|---------------|-----------------|
| `startLevel` | auto/`undefined` | set → 480p index | set → ~480p index |
| `autoLevelCapping` | none | ≤480p (or fixed) | ≤720p |
| `abrEwmaDefaultEstimate` | 500 kbps | 1.0 Mbps | 2.5 Mbps |
| `abrEwmaFastVoD` / `SlowVoD` | 3 / 9 | 2 / 15 | 3 / 12 |
| `abrBandWidthFactor` / `Up` | 0.95 / 0.7 | 0.75 / 0.5 | 0.9 / 0.65 |
| `maxStarvationDelay` | 4 | 2 | 4 |
| `maxBufferLength` | 30 | 75 | 40 |
| `maxMaxBufferLength` | 600 | 150 | 100 |
| `startFragPrefetch` | false | true | true |
| `enableWorker` | true | true | true |
| `progressive` | false | false | false |
| `lowLatencyMode` | true | **false** | **false** |
| `capLevelToPlayerSize` | false | true | true |
| `nudgeMaxRetry` | 3 | 5 | 5 |

---

*End of research. Snippets are TypeScript-ready for CineHome; wire profile selection via settings or first-fragment probe before treating as production default.*
