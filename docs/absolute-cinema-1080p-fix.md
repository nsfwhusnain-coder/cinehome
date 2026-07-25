# Absolute Cinema — Reliable 1080p Always, Pull 4K When Possible

**Status:** Implemented in SoT (`cinehome-sot`) — 2026-07-17  
**Live path:** deploy with `./scripts/deploy.sh` → verify `:4445` + scraper health

## Subagent task breakdown (orchestrator map → real files)

| Report module | Real path | Change |
|---------------|-----------|--------|
| `playwrightScraper.ts` / multi-URL capture | `mini-services/stream-scraper/capture-select.ts` + `index.ts` | 1 |
| `sourceRanker.ts` / `probeResolution` | `quality-probe.ts` + `capture-select.qualityRankScore` + `sortSourcesForDefault` | 2 |
| `scrapeCoordinator.ts` fast/slow | `index.ts` FAST path 8s + full enrich; client `FAST_FETCH_TIMEOUT_MS=8s` | 3 |
| `providerConfig.ts` CinePro 48h | `providers/circuit.ts` (`PROVIDER_CINEPRO` + `CINEPRO_EVAL_UNTIL`) | 4 |
| `scrapedSource.types` quality object | `src/lib/playback/types.ts` `PlaybackSource` + scraper `SourceEntry` | 5 |
| `manifestHandler.ts` headers | `src/lib/hls-proxy.ts` `parseStreamInfRenditions` / `applyResolutionHeaders` | 6 |
| `manifestRewriter.ts` + segment probe | `src/lib/hls/segment-height-probe.ts` + `prepareM3u8ForClient` | 7 |
| `proxyCacheConfig.ts` | `hls-proxy.ts` TTL constants (6h seg / 5m man / SWR / neg 30s×3) | 8 |
| `hlsInit.ts` | `src/components/video-player.tsx` Hls config + MANIFEST_PARSED | 9 |
| `resolutionDetector.ts` | `withDetectedSourceHeight` + `loadedmetadata` + `levelsFromHls` | 10 |
| `qualityGatekeeper.ts` | `source-quality.pickDefaultSource` + `select-best-source.ts` | 11 |
| `qualityValidator.ts` | `findQualityUpgradeSource` + `quality-validator.ts` | 12 |

## What shipped in this pass (gaps closed)

1. **Media-playlist synthetic master wrap** — pure `#EXTINF` playlists with known height become a 1-rung master with `RESOLUTION=WxH` so hls.js exposes a real level (not “Auto only”).
2. **Segment height probe** — Range `bytes=0–131071` + TS/fMP4 header parse when URL tokens missing; **falls back to original manifest on failure**.
3. **`qualityHint` end-to-end** — Settings height → `use-playback` / preresolve → `/api/playback` → scraper ranking.
4. **ABR default estimate 10 Mbps** — faster climb to 1080p band.
5. **Negative cache after 3 consecutive fails** (30s TTL once admitted).
6. **CinePro 48h eval window** via `CINEPRO_EVAL_UNTIL` (feature-flagged).
7. **Single-rung level height fallback** from `source.maxHeight` in `mapHlsLevels`.

## Deployment order

1. **Unit tests (local)**  
   ```bash
   bun test src/lib/hls/ src/lib/playback/select-best-source.test.ts \
     src/lib/playback/quality-validator.test.ts \
     mini-services/stream-scraper/providers/circuit-cinepro.test.ts
   ```
2. **Typecheck**  
   `bunx tsc --noEmit`
3. **Deploy app+scraper** (single image)  
   `./scripts/deploy.sh`
4. **Health**  
   ```bash
   curl -sf http://100.89.184.84:4445/api/system-status
   ssh hussyserver 'docker exec cinehome curl -sf http://127.0.0.1:3030/health'
   ```
5. **Playback smoke**  
   `ssh hussyserver 'docker exec cinehome bun /app/scripts/smoke-playback.ts'`
6. **Manual Moana check** (TMDB `1108427`)  
   - Sign in → play  
   - Quality dock should show **1080p** (or real ladder), not empty Auto-only  
   - Default source ≥1080 when any HD source exists  
   - If 4K present and preferred, auto-selects 4K

### Optional CinePro eval (do not enable permanently yet)

```bash
# On server after eval harness is green:
# CINEPRO_EVAL_UNTIL=$(date -u -v+48H +%Y-%m-%dT%H:%M:%S.000Z)  # macOS
# or: date -u -d '+48 hours' --iso-8601=seconds
# Add to /home/hussy/cinehome/.env and restart cinehome only.
```

## Rollback

| Layer | Rollback |
|-------|----------|
| Full image | `docker compose` previous image / redeploy last known-good SoT commit |
| Proxy wrap only | Revert `prepareM3u8ForClient` / `segment-height-probe` — media playlists pass through unchanged |
| CinePro | Unset `PROVIDER_CINEPRO` and `CINEPRO_EVAL_UNTIL` |
| qualityHint | Harmless if clients omit; server defaults to 1080 ranking floor |

## Success criteria checklist

| Criterion | Mechanism |
|-----------|-----------|
| Moana defaults to 1080p | `pickDefaultSource` HD floor + qualityHint + quality probe |
| Quality selector shows “1080p” | Synthetic master RESOLUTION + `levelsFromHls` fallback + `buildQualityOptions` |
| TTFF &lt; 8s non-Playwright | Fast path 8s; PW background |
| Fewer mid-play drops | Segment cache 6h + SWR + neg-cache after 3 fails |
| 4K preferred when available | Height ranking + preferredHeight 2160 |

## Hard requirements compliance

- [x] Strict TypeScript on new modules  
- [x] Network paths timeout + silent fallback on probe fail  
- [x] `maxHeight` / ladder populated full path via `probeSourceQuality`  
- [x] MANIFEST_PARSED sets start/next level before first play  
- [x] Manifest rewriter never serves broken rewrite (try/catch → original)  
- [x] `selectBestSource` deterministic  
- [x] Non-Playwright providers untouched by capture selection  
- [x] CinePro gated by feature flags only  

---

## Post-deploy fix — 2026-07-18 (Phase 1–4 orchestrator)

Diagnosis-first pass against production symptom “Found N — searching…” / weak 1080 defaults. Live deploy target: `http://100.89.184.84:4445` (image rebuilt multiple times this session; final R6–R9 stack live).

### Final root cause ranking (with evidence)

| ID | Hypothesis (prompt) | Verdict | Notes |
|----|---------------------|---------|--------|
| R2 | All circuits tripped | **Refuted** | `closed` = healthy; pool 5/5; CinePro off |
| R3 | Quality probe no timeout | **Refuted** | 3s/fetch + 10s budget |
| R4 | Manifest silent-fallback broken | **Refuted** | catch → original; probe 800ms |
| R5 | Held for full 10-source pool | **Refuted** | Play on first URL; partial clear ≥2 |
| R1 | Overlay waits for all providers | **Refuted as primary** | Already remapped to first-URL dismiss |
| **R6** | Weak height metadata / maxHeight:0 blocks tokens | **Fixed** | Client + scraper token fall-through |
| **R8** | Dead first CDN chip ≤22s | **Fixed** | Cold multi-source wall **11s** |
| **R7** | Enrich HARD TIMEOUT after success | **Fixed** | `clearTimeout` + settled flag |
| **R9** | Scraper default ≠ client HD tiers | **Fixed** | ≥1080 → unknown → sub-HD |
| **R10** | Synthetic master wrap on multi-variant children | **Fixed** | Variant URLs never re-wrapped; loop gone |

Handoffs: `.claude/handoffs/phase1-diagnosis-2026-07-18.md`, `phase2-r6-fix.md` … `phase2-r10-fix.md`, `phase3-verification-2026-07-18.md`.

### Fixes applied

| Fix | Files | Behavior |
|-----|-------|----------|
| R6 | `source-quality.ts`, `scraper.ts`, `quality-probe.ts` + tests | `maxHeight≤0` falls through to quality/URL tokens; empty-network + token → `qualitySource:"label"` |
| R8 | `first-frame-wall.ts`, `video-player.tsx` + tests | Cold multi **11s**; resume/sole **22s** |
| R7 | `enrich-timeout.ts`, `index.ts` scheduleBackgroundEnrich + tests | No false HARD TIMEOUT after successful enrich |
| R9 | `default-source-rank.ts`, `index.ts` + tests | Scraper `streamUrl` uses same height tiers as client |
| R10 | `shouldWrapPureMedia` + `prepareM3u8ForClient` | Multi-variant children not re-wrapped as synthetic masters |

### Fault-injection tests added

- R6: maxHeight:0 + auto ranks above 480; quality `"1080p"` / URL `/1080/` resolve; explicit 1080 wins over lower token  
- R8: cold multi ≤12s; resume/sole ≥20s  
- R7: work-first no timeout callback; hung work fires once; late work after timeout does not re-fire  
- R9: unknown beats known 720; 1080 beats unknown; 2160 beats 1080; soft-kept loses to verified  
- Hung Range probe: abort/throw/pre-aborted → height 0  
- R10: `rendition=` / quality-folder / `media=1` never wrap-eligible; pure root still wrap-eligible  

### Smoke / health (post R10 deploy)

- `bunx tsc --noEmit` clean  
- Full unit suite: **235 pass / 0 fail**  
- `smoke-playback.ts`: **PASS** (Witcher S1E1)  
- 5-title fast scrape: all streamUrl (Moana, Fight Club, Dark Knight, Forrest Gump, Inception)  
- Circuits: **6** enabled+closed healthy (CinePro disabled)  
- Proxy: hitRate **~0.93**, errors **0**  
- R7 HARD TIMEOUT noise: **0**  
- **R10 browser:** Fight Club HLS net count **~32** (was ~164k); muted play reaches `readyState=4` + `currentTime>0` (path latency can still be tens of seconds over Tailscale headless)

### Remaining known issues

1. Many embeds still lack height tokens → height 0 by design; ranking prefers unknown over known sub-HD.  
2. Moana/API path can lack true 1080 inventory — supply-limited.  
3. Remote headless TTFF often **>15s** (Tailscale + CDN + autoplay); product loop is fixed — human browser remains best TTFF ground truth.  
4. Background enrich 30–60s; compact chip may pulse (non-blocking).

### Rollback

| Layer | Action |
|-------|--------|
| Full image | Redeploy previous known-good SoT commit via `./scripts/deploy.sh` |
| R8 only | Revert `first-frame-wall.ts` + player wire; restore fixed 22s wall |
| R7 only | Revert `enrich-timeout.ts` usage; restore inline setTimeout race (accepts false HARD TIMEOUT logs) |
| R6/R9 | Revert ranking helpers; client may thrash default vs scraper again |
