---
name: cinehome-dev
description: >
  CineHome / Absolute Cinema development workflow on hussyserver :4445.
  Use for any CineHome feature, bugfix, player, scraper, UI, deploy, or
  when the user mentions cinehome, absolute cinema, port 4445, stream scraper,
  hls player, or hussyserver streaming site. Also /cinehome-dev.
---

# CineHome development skill

## Always
1. **Cwd SoT**: `/Users/husnainali/cinehome` — GitHub `nsfwhusnain-coder/cinehome` is canonical. `cinehome-sot` is stale. Not Godot, not meatflicks.
2. Read `AGENTS.md` + `CINEHOME.md` if unclear.
3. **Ignore Godot rules** from home Claude.md.

## Env
```bash
source ~/.grok/secrets/cinehome.env
# CINEHOME_BASE_URL, CINEHOME_TEST_USER, CINEHOME_TEST_PIN, CINEHOME_SSH, CINEHOME_SOT
```

## Parallel subagents (preferred)
Spawn with **non-overlapping file scopes** + `cwd=/Users/husnainali/cinehome`:

| Agent type | Scope |
|------------|--------|
| `cinehome-player` | `src/components/video-player.tsx`, player-*, `src/stores/player-store.ts`, `src/lib/playback/*` (client only) |
| `cinehome-scraper` | `mini-services/stream-scraper/**` only |
| `cinehome-ui` | `src/views/**`, navbar, mobile-dock, hero, cards, tokens |
| `cinehome-qa` | run browser QA + smoke; report; no product code unless asked |

Parent merges, runs `bunx tsc --noEmit`, deploys, re-runs QA.

## Implement → verify loop
1. Code in SoT
2. `bunx tsc --noEmit`
3. `./scripts/deploy.sh` (or `SKIP_RSYNC=1` on server)
4. Scraper: `ssh hussyserver 'docker exec cinehome bun /app/scripts/smoke-playback.ts'`
5. UI: `bun scripts/browser/qa.ts flow smoke` then **Read** `.browser-qa/*.png`
6. Summarize with screenshot paths

## Hard constraints
- Never publish port 3030
- Never commit secrets / `.env` / `.browser-qa` session state if it has cookies… (folder gitignored)
- Minimal diffs; no unrelated refactors
