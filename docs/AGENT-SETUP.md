# CineHome agent environment (for humans + Grok)

Configured so Grok can develop, deploy, and **see** the live site.

## Paths
| Item | Path |
|------|------|
| Local SoT | `/Users/husnainali/cinehome` |
| Canonical remote | GitHub `nsfwhusnain-coder/cinehome` (`cinehome-sot` is STALE — do not edit or deploy from it) |
| Server | `hussyserver:/home/hussy/cinehome` |
| Live | http://100.89.184.84:4445 |
| Secrets | `~/.grok/secrets/cinehome.env` (mode 600, never commit) |
| Screenshots | `cinehome/.browser-qa/` |

## Skills (slash / auto)
- `/cinehome-dev` — full workflow
- `/cinehome-browser` — Playwright see + interact
- `/cinehome-deploy` — ship + health
- `/cinehome` — global pointer (user skill)

## Subagent types
- `cinehome-player`
- `cinehome-scraper`
- `cinehome-ui`
- `cinehome-qa`

Spawn with `cwd=/Users/husnainali/cinehome` and non-overlapping file scopes.

## Browser QA
```bash
source ~/.grok/secrets/cinehome.env
cd /Users/husnainali/cinehome
bun scripts/browser/qa.ts flow smoke
HEADED=1 bun scripts/browser/qa.ts flow home   # you watch Chromium
```

Agent reads PNGs under `.browser-qa/` via the Read tool.

## QA account
- User: `grokqa` (non-admin)
- PIN: only in `~/.grok/secrets/cinehome.env`

## Grok config
- Memory enabled (`~/.grok/config.toml`)
- Subagents enabled
- Project `AGENTS.md` overrides Godot home rules when cwd is this repo

## Recommended session start
```bash
cd /Users/husnainali/cinehome
# start grok from this directory so AGENTS.md + project skills load
```
