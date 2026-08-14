# CINEHOME.md — CineHome Streaming App

**NOT a Godot project.** Ignore workspace `CLAUDE.md` Godot rules for this repo.

## Source of truth (SoT)
- **Authoritative repository**: `github.com/nsfwhusnain-coder/cinehome`
  (private), branch `main`. This is canonical. Every other copy is a working
  clone.
- **The server is a deploy target, not the authority.** `/home/hussy/cinehome`
  on `hussyserver` tracks `origin/main` and pulls; it authenticates with a
  read-write deploy key at `~/.ssh/cinehome_deploy` (SSH host alias
  `github-cinehome`), so no access token is stored on the box.
- This inverts the previous arrangement, and the reversal is worth stating
  plainly because the old rule said the opposite. The deployed tree once had no
  Git history at all, and the server copy was made authoritative as a recovery
  measure. That is no longer true. Do not treat the server tree as canonical,
  and never commit there without pushing.
- **Server DNS**: the tailnet supplies no global upstream resolvers, so
  `/etc/resolv.conf` lists Tailscale MagicDNS first and then `192.168.1.1` and
  `1.1.1.1` as fallbacks. Without those, `github.com` does not resolve on the
  host and every pull fails while the container keeps working (it carries its
  own DNS). Tailscale may rewrite that file; the durable fix is to add global
  nameservers in the Tailscale admin console.
- Historic markers: the pre-ownership running state is commit `11847dd`, tagged
  `production-baseline-20260725`.
- Stale mirrors that must NOT be deployed from: `C:\Users\husna\projects\cinehome-main`,
  `cinehome-authoritative`, `/Users/husnainali/cinehome-sot` (stale un-remoted
  Mac mirror), and the `cinehome-*` copies under `/home/hussy/`.
  Clone fresh from GitHub instead.
- **Canonical App Router**: `src/app` only. There is no root `app/` router.
- **Nothing in `db/` is source.** The whole directory is gitignored — it holds
  user records and their backups. A backup named `custom.db.bak-<timestamp>`
  was once committed by a `git add -A` because the old `db/*.db` pattern did
  not match it; it was stripped from history before reaching the remote.

## Stack
- Next.js 16 on Node 24.18 LTS + Prisma (SQLite)
- Bun 1.3.14 for builds, tests, and the stream-scraper; do not run the Next
  media proxy under Bun without repeating the playback memory stress matrix
- `mini-services/stream-scraper` on port **3030 inside the container only** (never publish 3030)
- HLS proxy: local `/api/hls/[sessionId]` by default (residential uplink — works with embed CDNs)
- Optional Cloudflare Worker only when **`WORKER_PROXY_ENABLED=1`** (many CDNs 403 CF IPs — verify before enabling)
- **CinePro OMSS**: quarantined. `CINEPRO_URL` is not an enable switch (compose
  always injects `http://cinepro-core:3000`). Enable only with
  `PROVIDER_CINEPRO=1` or an open `CINEPRO_EVAL_UNTIL` window. Compose defaults
  `PROVIDER_CINEPRO=0`.
- Watch page: **CineHome** (custom hls.js) + **Embed** mode (iframe servers like Cineby)
- Host publish: **4445 → 3000** (`docker-compose.yml`)
- **Sign-in required** for playback

### Optional CinePro evaluation

CinePro is opt-in only. Compose still injects `CINEPRO_URL` so cinepro-core
stays reachable, and defaults `PROVIDER_CINEPRO=0` so the 8s fast budget cannot
steal the multi-API race. Enable with `PROVIDER_CINEPRO=1` after
`bun scripts/cinepro-eval.ts` looks healthy, or with a time-boxed
`CINEPRO_EVAL_UNTIL`. A dead instance previously added repeated 500s and a
wasteful 20-title boot warmer.

```bash
# .env
CINEPRO_URL=http://cinepro-core:3000
CINEPRO_EVAL_UNTIL=2026-07-28T12:00:00.000Z
# or, only after a successful evaluation:
# PROVIDER_CINEPRO=1
WORKER_PROXY_ENABLED=0
NEXT_PUBLIC_EMBEDIN_URL=http://192.168.1.107:4444   # or Tailscale IP :4444

# compose joins embedin_default so cinehome can resolve cinepro-core
docker compose up -d --build
```

CinePro providers (example): Icefy, VidApi, VixSrc, VidNest, VidZee, Peachify, Tulnex, …

### cinepro-core DNS (fixed 2026-07-30 — read before debugging CinePro)

`cinepro-core` is **not defined in any compose file**. It carries stale
`com.docker.compose.project=embedin` labels, but `/home/hussy/embedin/docker-compose.yml`
only defines `embedin` and `api` — so `docker compose` cannot manage or recreate it,
and `docker compose up -d` in that directory may treat it as an orphan.

It was returning HTTP 500 on **every** request because it inherited the host's
Tailscale MagicDNS (`100.100.100.100`) and could not resolve `api.themoviedb.org`
(`getaddrinfo EAI_AGAIN`), so TMDB validation failed before any provider ran. This
is the same broken host resolver that `CINEHOME_DNS_PRIMARY` / `CINEHOME_DNS_FALLBACK`
exist to work around for CineHome itself.

Recreate it (there is no compose path) with explicit DNS:

```bash
TMDB=$(docker inspect cinepro-core --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep '^TMDB_API_KEY=' | cut -d= -f2-)
docker run -d --name cinepro-core \
  --network embedin_default --network-alias cinepro-core \
  --dns 192.168.1.1 --dns 1.1.1.1 \
  --restart unless-stopped \
  -e TMDB_API_KEY="$TMDB" -e NODE_ENV=production -e HOST=0.0.0.0 -e PORT=3000 \
  -e CACHE_TYPE=memory \
  ghcr.io/cinepro-org/core:latest
```

**Renaming a container does NOT drop its network alias.** A stopped-then-renamed
old copy came back up under `restart: unless-stopped` and still answered to
`cinepro-core` on `embedin_default`, so Docker round-robined between the healthy
and the broken instance and CinePro appeared to fail intermittently — including
for titles that had already been proven warm. When replacing it, always:

```bash
docker update --restart=no cinepro-core-old
docker network disconnect embedin_default cinepro-core-old
docker stop cinepro-core-old
docker exec cinehome getent ahostsv4 cinepro-core   # must return exactly ONE address
```

Expected behaviour: a COLD title takes ~40s upstream (bounded by the slowest
provider — Videasy ~40s, Peachify ~20s), which exceeds CineHome's 12s full budget,
so the arm lands late and enriches the result cache rather than the first response;
the next request is served from cinepro-core's cache in ~3ms. That is precisely what
`providers/cinepro-warmer.ts` exists for. Note also that CinePro `/v1/proxy` URLs
routinely fail cold scraper-side verification and are soft-kept (`verified:false`),
so they are switchable in the Servers panel but never auto-default.

### Scraper resource envelope

`BROWSER_POOL_SIZE` defaults to 1 and is clamped to 1..4. The pool is shared
across requests, so concurrent title enrichment queues instead of spawning an
unbounded browser per request. Each browser owns multiple Chromium processes;
raise the override only after measuring CPU, RSS, queue depth, and user TTFF
from the internal scraper `/health` payload.

### Worker (edge media proxy — opt-in)
See `workers/hls-proxy/README.md`. **Default off.** If enabled: `WORKER_PROXY_ENABLED=1`,
`WORKER_PROXY_BASE`, `WORKER_PROXY_SECRET`, `NEXT_PUBLIC_WORKER_PROXY_HOST`.
If segments return Upstream 403, set `WORKER_PROXY_ENABLED=0` and restart.

## Server
- SSH: `hussy@100.89.184.84:58222`
- Path: `/home/hussy/cinehome`
- URL: `http://100.89.184.84:4445`

## Deploy
Prefer the script (rsync + remote build/up + health check; no passwords hardcoded):

```bash
# From local SoT (uses SSH keys / agent)
./scripts/deploy.sh

# Or already on the server with code in place:
SKIP_RSYNC=1 DEPLOY_PATH=/home/hussy/cinehome ./scripts/deploy.sh
```

Manual equivalent:

```bash
./scripts/disk-preflight.sh   # abort if free disk on / < 20GB
# deploy.sh supplies NODE_DOWNLOAD_IP automatically when host/Tailscale DNS is
# broken but CineHome's explicit container DNS can resolve nodejs.org.
# Manual deploys must also tag BEFORE build. Never rebuild `latest` first.
live_image=$(docker inspect --format '{{.Image}}' cinehome)
docker image inspect "$live_image" >/dev/null
docker image tag "$live_image" \
  "cinehome-cinehome:predeploy-$(date -u +%Y%m%dT%H%M%SZ)"
docker compose build
docker compose up -d
curl -sf http://127.0.0.1:4445
docker exec cinehome curl -s http://127.0.0.1:3030/health
```

Disk hygiene:

```bash
./scripts/disk-prune.sh                      # builder cache older than 7d (host-wide)
./scripts/disk-prune.sh --builder-all        # full host-wide builder cache wipe
./scripts/disk-prune.sh --dangling           # + dangling images
./scripts/disk-prune.sh --keep-last-2-cinehome  # keep last 2 unique cinehome image IDs
```

**Note:** `docker builder prune` is always **host-wide** (every project’s BuildKit cache on the machine), not CineHome-only. Default uses `--filter until=168h` so recent cache is kept; use `--builder-all` only on a dedicated box when you need max reclaim.

Secrets: copy `.env.example` → `.env` on the server. **Never commit `.env`.**
`deploy.sh` rsync includes `.env.example` but never pushes `.env` / other
`.env.*`. `.dockerignore` must continue to exclude `.browser-qa/` because it
contains authenticated Playwright storage state; it also excludes persisted
transcode data. A production image must pass `test ! -e /app/.browser-qa`.

### Player interaction product pass

`scripts/browser/player-product-pass.ts` exercises real playback plus the
user-facing control surface at desktop (1440×900), phone (390×844), and TV
(1920×1080) sizes. It verifies decoded/advancing video, pause/resume, keyboard
seek and volume, mute, shortcuts open/escape, modal focus, D-pad settings
navigation, fullscreen enter/exit, PiP, artwork, overflow, control fit, and
minimum tap targets. Run it from the exact production image with an
authenticated Playwright storage state; never bake that state into an image.

```bash
image_id=$(docker inspect --format '{{.Image}}' cinehome)
docker run --rm --network host \
  -e STORAGE_STATE=/app/.browser-qa/storage-state.json \
  -v /home/hussy/cinehome/.browser-qa:/app/.browser-qa \
  "$image_id" bun scripts/browser/player-product-pass.ts
```

### Cineby-style quality/source acceptance pass

The player has one responsive playback sheet with five stable tabs: **Quality,
Sources, Subtitles, Audio, Speed**. Quality always shows `Auto`, `4K`,
`1080p`, `720p`, `480p`, and `360p`; unavailable rungs remain visible but
disabled. `Auto` is the profile default. A fixed default is stored per user in
`UserSetting` through `/api/preferences`; a one-off in-player switch applies
only to the current watch.

The Sources tab contains the complete currently usable roster, not fake
placeholders. Session-failed, probe-dead, verification-failed, and
browser-unplayable rows are removed. Separate fixed-quality URLs for one
logical server collapse to the best healthy representation. Names are stable,
resolution is a separate badge, known locale/region rows show a flag, unknown
geography shows a globe, and debrid rows also carry the premium crown.

`scripts/browser/cineby-player-pass.ts` is the release gate for this contract.
It exercises real advancing playback, the stable rail, source-row provenance,
dead-row removal, flags, profile persistence/reload, playing and paused source
switches, and desktop/phone sheet bounds.

```bash
image_id=$(docker inspect --format '{{.Image}}' cinehome)
docker run --rm --network embedin_default \
  --dns 192.168.1.1 --dns 1.1.1.1 \
  -e CINEHOME_BASE_URL=http://cinehome:3000 \
  -e STORAGE_STATE=/app/.browser-qa/storage-state.json \
  -v /home/hussy/cinehome/.browser-qa:/app/.browser-qa \
  "$image_id" bun scripts/browser/cineby-player-pass.ts
```

### Runtime memory envelope

The single container deliberately uses two JavaScript runtimes. `start.sh`
runs Next's standalone server with Node and the scraper with Bun. Several HLS
CDNs serve 4–16 MiB video fragments as `image/jpeg`; Bun 1.3.14's
fetch/WebStream-to-Next bridge released the live ArrayBuffers after GC but kept
hundreds of MiB of allocator pages resident. The same eight-playback browser
matrix retained 1,002 MiB in Bun `--smol` versus 121.9 MiB in Node 24.18.
Do not collapse the runtime split based on a compile-only check.

Node is installed from the official versioned archive in `Dockerfile` and
verified against its fixed SHA-256. `NODE_DOWNLOAD_IP` changes only DNS
routing for the TLS-verified download; it does not bypass certificate or
archive verification.

### Transcoder safety

`TRANSCODER_ENABLED=0` is the production default. The retained legacy worker
transcodes a whole remote file into an HLS ladder; a measured cold HEVC/MKV
request reached 1,378% CPU, 17.4 GiB RAM, and 610 container PIDs, then left the
Next process in memory pressure after ffmpeg exited. The app and both transcode
routes therefore fail closed unless the flag is exactly `1`, and incompatible
sources remain visible but disabled in browser pickers.

Do not enable this on the shared production host. It is retained only for
isolated redesign work until the pipeline has hard concurrency/memory limits,
segment-on-demand behavior, cancellation, and load tests proving bounded use.
Native browser-compatible debrid MP4 sources direct-play without this worker.

### Container DNS

CineHome sets `CINEHOME_DNS_PRIMARY` (default `192.168.1.1`) and
`CINEHOME_DNS_FALLBACK` (default `1.1.1.1`) explicitly in Compose. Docker's
embedded resolver still handles service names such as `cinepro-core`; external
TMDB/provider/debrid lookups are forwarded to these resolvers instead of
depending on the host's Tailscale MagicDNS upstream. Override both values if
the server moves off its current LAN.

## Agent workflow (handoffs only)
1. Research → write `.claude/handoffs/research-*.md`
2. Architect → write `.claude/handoffs/architecture-*.md`
3. Coder → implement + write `.claude/handoffs/coder-*.md`
4. Tester → verify on server + write `.claude/handoffs/tester-*.md`

**Do NOT launch parallel Task subagents until baseline files are synced.**
BOSS implements directly when subagents fail.

## Key paths
| Area | Path |
|------|------|
| App Router (canonical) | `src/app/**` |
| Player UI | `src/components/video-player.tsx`, `src/components/player-controls.tsx`, `src/components/player-dock.tsx` |
| Playback API | `src/lib/playback/scraper.ts` |
| HLS proxy | `src/lib/hls-proxy.ts`, `src/lib/hls-session.ts` |
| Stream resolver | `mini-services/stream-scraper/index.ts`, `providers/` |

## Scraper env (kill switches + logging)

Applied to the **stream-scraper process** (same container; restart required). Documented also in `.env.example`.

| Env | Effect |
|-----|--------|
| `PROVIDER_LORDFLIX=0` | Skip Lordflix (enc-dec) |
| `PROVIDER_VIDEASY=0` | Skip Videasy (enc-dec) |
| `PROVIDER_PLAYWRIGHT=0` | Never Playwright embed fallback |
| `PROVIDER_VIXSRC=0` | Skip Luna/Vixsrc (optional) |
| `PROVIDER_VIDLINK=0` | Skip VidLink API (optional) |
| `PROVIDER_NOTORRENT=0` | Skip NoTorrent (optional) |
| `SCRAPER_LOG_LEVEL` | `debug` \| `info` \| `warn` \| `error` (default `info`) |

Circuit breakers (in-memory, §8.3): window last 20 attempts / 10m; open when error rate ≥50% and ≥6 samples; open 15m then 1 half-open probe. Primarily protects Lordflix/Videasy; all providers report state on `/health`.

`/health` payload includes: `browsers`/`queued` (compat), `pool` (size/max/queued/warming), `circuits` (per-provider state/samples/errorRate/enabled), `timings` (lastMs/lastAt/lastOk), `lastScrape` wall time.

## Remux (MKV -> fMP4) — how 4K actually plays

MKV opens in **no browser**, Safari included, and that is where nearly all
real 4K lives. Those rows used to be surfaced, badged "unavailable" and
excluded from auto-play, which is why a 4K-rich title looked like it had none.

The media worker (`mini-services/transcoder`, port 3040, internal only) now
serves **two modes**, gated independently because their cost is not comparable:

| Mode | Default | What it does |
|------|---------|--------------|
| `remux` (`REMUX_ENABLED`) | **ON** | `-c:v copy` into fMP4 HLS. No decode, no encode, no downscale — a 4K MKV plays at its real 4K. Audio IS re-encoded (see below). |
| `transcode` (`TRANSCODER_ENABLED`) | OFF | Full re-encode to an H.264 ladder, capped at 1080p. A cold 4K HEVC job measured 17.4 GiB / 1378% CPU — opt-in only. |

`sourceDelivery()` in `src/lib/playback/source-quality.ts` decides which of
**direct / remux / unavailable** a source is. "unavailable" now means only what
it says: a codec with no route in this browser (HEVC in Chrome). Container
problems are remuxed.

**Audio is always re-encoded to stereo AAC.** MKV releases routinely carry
DTS-HD MA, TrueHD, E-AC3, FLAC or PCM; MSE rejects the whole append if the
audio track is undecodable, so copying it yields perfect video that will not
play. Audio encode is a few percent of one core against ~1% of the bitrate.

### Remux env

| Env | Default | Effect |
|-----|---------|--------|
| `REMUX_ENABLED` | `1` | `0` disables remuxing; MKV sources become unselectable again |
| `TRANSCODER_REMUX_MAX_CONCURRENT` | `2` | Enforced ceiling. Over capacity the worker refuses so the player fails over, rather than queueing behind another film |
| `TRANSCODER_REMUX_MIN_FREE_BYTES` | 25 GiB | Refuses to start a remux below this much free disk (after trying eviction first) |
| `TRANSCODER_REMUX_MAX_JOB_BYTES` | 30 GiB | Kills any single job that exceeds this |

Note `TRANSCODER_MAX_CONCURRENT` is reported on `/health` but has never been
enforced; the remux ceiling above is the one that applies.

### Disk

A stream copy writes its input back out roughly 1:1, so a 4K remux is tens of
GB. Four things bound it:

- ffmpeg reads at **4x realtime** after a 60s full-speed burst (startup stays
  instant, the lead stays bounded).
- A job with **no segment read for 2 minutes** is killed and its partial output
  discarded — otherwise an abandoned playback keeps writing the whole film.
- Entries **in use are never evicted** (in flight, or read in the last 30 min).
- **Incomplete entries are purged at boot**: a cache hit is decided by
  "master.m3u8 exists", which is also true after a crash or a killed job.
  A media playlist with no `#EXT-X-ENDLIST` was interrupted and is dropped.

### Duration caveat

A remux is produced live, so `video.duration` is **how much has been remuxed**,
not how long the title is (measured: 491.9s twenty seconds into a 24-minute
episode). The player marks duration `provisional` in that state and uses TMDB's
runtime for resume progress and the next-episode card. Anything new that
divides by duration must respect that flag.

### Verify a remux end to end
```bash
# Worker health includes free disk and the remux ceiling
docker exec cinehome curl -s http://127.0.0.1:3040/health

# Prove the OUTPUT is really 4K, not a downscale
docker exec cinehome sh -lc 'cd /app/transcode-cache/<key> \
  && cat init.mp4 seg_00000.m4s > /tmp/p.mp4 \
  && ffprobe -v error -select_streams v:0 \
     -show_entries stream=codec_name,width,height -of default=noprint_wrappers=1 /tmp/p.mp4'
```

## Verify
```bash
docker exec cinehome curl -s http://127.0.0.1:3030/health
docker exec cinehome curl -s --max-time 90 "http://127.0.0.1:3030/scrape?tmdbId=71912&mediaType=tv&season=1&episode=1"
```

### Playback smoke (PR-01 / M0)

Scraper-only harness (no browser TTFF). Fixture: Witcher S1E1 (`tmdbId=71912`). Writes JSON + table; exit 0 if health ok, ≥1 source, and `streamUrl` present.

```bash
# Inside container (scripts/ is in the image via Dockerfile COPY . .)
docker exec cinehome bun /app/scripts/smoke-playback.ts

# Pre-bake: script not yet in the image — pipe via stdin
docker exec -i cinehome bun - < scripts/smoke-playback.ts

# From laptop via SSH
ssh -o BatchMode=yes hussyserver \
  'docker exec cinehome bun /app/scripts/smoke-playback.ts'

# Cold / re-enrich (bypass result cache — use for latency deltas vs baseline A)
docker exec -e NOCACHE=1 cinehome bun /app/scripts/smoke-playback.ts

# Fast-only (skip full follow-up; full without NOCACHE is cache-hit after fast)
docker exec -e SKIP_FULL=1 cinehome bun /app/scripts/smoke-playback.ts

# Local
bun run smoke:playback
```

Env: `SCRAPER_URL` (default `http://127.0.0.1:3030`), `NOCACHE=1`, `SKIP_FULL=1`, `FORMAT=table|json|both`. Host `:4445` is the Next app — not the scraper.

Baseline log: [`docs/baseline-metrics.md`](docs/baseline-metrics.md).
