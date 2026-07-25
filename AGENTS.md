# AGENTS.md — CineHome (Absolute Cinema)

**NOT a Godot project.** Ignore any home-level Godot / GDScript rules for this repo.

## Identity
- Product: household Netflix-style streamer (TMDB browse → multi-provider resolve → hls.js player)
- Brand in UI: Absolute Cinema · Code name: CineHome
- **Local SoT**: `/Users/husnainali/cinehome-sot` (this git repo)
- **Server path**: `/home/hussy/cinehome` on `hussyserver` (`100.89.184.84:58222`, user `hussy`)
- **Live URL**: `http://100.89.184.84:4445` (Docker `cinehome`, host 4445 → app 3000)
- **Scraper**: container-internal only on `:3030` — never publish

## Stack
- Next.js 16 + Bun + Prisma SQLite + Tailwind + shadcn
- Player: hls.js + dash.js · `src/components/video-player.tsx`
- Scraper: `mini-services/stream-scraper/` (Playwright pool + API providers)
- HLS: session proxy `src/lib/hls-proxy.ts` · optional CF Worker off by default
- Auth: NextAuth name + PIN (no email)

## Canonical paths
| Area | Path |
|------|------|
| App Router | `src/app/**` only |
| Views | `src/views/*` |
| Player | `src/components/video-player.tsx`, `player-dock.tsx`, `player/*` |
| Playback API client | `src/lib/playback/scraper.ts` |
| Scraper | `mini-services/stream-scraper/index.ts` + `providers/` |
| Docs | `CINEHOME.md`, `docs/CINEHOME-OVERHAUL-DESIGN.md` |

## Agent workflow (this project)
1. Work in **this repo** (`cinehome-sot`). Never invent a second tree without rsync intent.
2. Prefer **specialized subagents** with non-overlapping file scopes:
   - `cinehome-player` — player / dock / resume
   - `cinehome-scraper` — stream-scraper only
   - `cinehome-ui` — views / chrome / tokens
   - `cinehome-qa` — browser screenshots + smoke (read/execute)
3. After code changes: `bunx tsc --noEmit` (or rely on Docker build) → `./scripts/deploy.sh` → browser QA.
4. Handoffs: `.claude/handoffs/*.md` for multi-step audits (optional).
5. **Do not** launch Godot boss/coder agents here.

## Coding rules
- Full TypeScript types on new/changed code
- Named constants for magic numbers (especially player/scraper timeouts)
- No `console.log` in production app paths (scraper may use `logAt`)
- Minimal diffs — no drive-by refactors
- Never commit `.env`, `.env.browser`, or `~/.grok/secrets/*`
- Never publish scraper port 3030
- Functions: prefer short helpers over 100+ line blobs when editing

## Deploy & ops
```bash
# From SoT
./scripts/deploy.sh

# Smoke (scraper only, inside container)
ssh hussyserver 'docker exec cinehome bun /app/scripts/smoke-playback.ts'

# Browser QA (see + interact with live UI)
source ~/.grok/secrets/cinehome.env
bun scripts/browser/qa.ts screenshot home
bun scripts/browser/qa.ts flow smoke
bun scripts/browser/qa.ts open /watch/movie/550   # headed optional: HEADED=1
```

Secrets file (local only): `~/.grok/secrets/cinehome.env`  
→ `CINEHOME_BASE_URL`, `CINEHOME_TEST_USER`, `CINEHOME_TEST_PIN`, `CINEHOME_SSH`, `CINEHOME_SOT`

## Visual / interactive testing (mandatory for UI work)
1. Run `scripts/browser/qa.ts` against **live** `:4445` (or local `http://127.0.0.1:3000` if dev).
2. Screenshots land in `.browser-qa/` — **read image files with the Read tool** to see the UI.
3. Prefer interactive flows (`login`, `browse`, `watch`, `click`, `flow smoke`) over guessing CSS.
4. HEADED=1 opens a visible Chromium window on the Mac when the human wants to watch.

## Quality bar before “done”
- [ ] No secrets in git
- [ ] `tsc` / Docker build clean for touched areas
- [ ] Deploy + health: app `:4445` + `docker exec cinehome curl -sf http://127.0.0.1:3030/health`
- [ ] UI changes: at least one browser screenshot reviewed
- [ ] Playback changes: smoke-playback or live watch check

## Design tokens (short)
- Hero/detail primary Play = **white/light pill**
- Secondary actions = crimson accent
- Nav: Home · Movies · Shows · My List (Continue not primary)
- Motion: `src/lib/motion.ts` · tokens: `docs/design-tokens.md`
