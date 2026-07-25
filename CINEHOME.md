# CINEHOME.md — CineHome Streaming App

**NOT a Godot project.** Ignore workspace `CLAUDE.md` Godot rules for this repo.

## Source of truth (SoT)
- **Current authoritative Git tree**: `/home/hussy/cinehome` on `hussyserver`,
  branch `main`. The exact pre-ownership running state is commit `11847dd` and
  tag `production-baseline-20260725`.
- The deployed tree had no Git history and the previously documented canonical
  repository was on an unavailable machine. We deliberately initialized Git on
  the verified deploy copy so every production build now has one recoverable
  authority. Developer-machine copies are mirrors until the old repository is
  reconciled; never push a stale local tree over the server authority.
- **Canonical App Router**: `src/app` only. There is no root `app/` router.

## Stack
- Next.js 16 + Bun + Prisma (SQLite)
- `mini-services/stream-scraper` on port **3030 inside the container only** (never publish 3030)
- HLS proxy: local `/api/hls/[sessionId]` by default (residential uplink — works with embed CDNs)
- Optional Cloudflare Worker only when **`WORKER_PROXY_ENABLED=1`** (many CDNs 403 CF IPs — verify before enabling)
- **CinePro OMSS** (Lordflix-class): when `CINEPRO_URL` is set, scraper races multi-provider + CinePro stream proxy
- Watch page: **CineHome** (custom hls.js) + **Embed** mode (iframe servers like Cineby)
- Host publish: **4445 → 3000** (`docker-compose.yml`)
- **Sign-in required** for playback

### Lordflix-class setup (recommended on hussyserver)

You already run `cinepro-core` + `embedin` on Docker network `embedin_default`.

```bash
# .env
CINEPRO_URL=http://cinepro-core:3000
WORKER_PROXY_ENABLED=0
NEXT_PUBLIC_EMBEDIN_URL=http://192.168.1.107:4444   # or Tailscale IP :4444

# compose joins embedin_default so cinehome can resolve cinepro-core
docker compose up -d --build
```

CinePro providers (example): Icefy, VidApi, VixSrc, VidNest, VidZee, Peachify, Tulnex, …

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

Secrets: copy `.env.example` → `.env` on the server. **Never commit `.env`.** `deploy.sh` rsync includes `.env.example` but never pushes `.env` / other `.env.*`.

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
| Player UI | `src/components/video-player.tsx`, `player-settings-dock.tsx` |
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
