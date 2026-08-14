# Ops critic MUST-FIX — SoT path + CinePro rank

**Repo:** `/Users/husnainali/cinehome` (GitHub `nsfwhusnain-coder/cinehome`). Did not touch `cinehome-sot`.
**Date:** 2026-08-14
**Scope:** two surgical edits only. No deploy, no env, no extra files.

## 1. `docs/AGENT-SETUP.md` SoT honesty

Every Local SoT path and `cd` now points at `/Users/husnainali/cinehome`.

| Was | Now |
|-----|-----|
| Local SoT `/Users/husnainali/cinehome-sot` | `/Users/husnainali/cinehome` |
| Screenshots `cinehome-sot/.browser-qa/` | `cinehome/.browser-qa/` |
| Spawn `cwd=/Users/husnainali/cinehome-sot` | `cwd=/Users/husnainali/cinehome` |
| Browser QA `cd …/cinehome-sot` | `cd /Users/husnainali/cinehome` |
| Session start `cd …/cinehome-sot` | `cd /Users/husnainali/cinehome` |

Added a Paths row: canonical remote is GitHub `nsfwhusnain-coder/cinehome`. `cinehome-sot` is STALE — do not edit or deploy from it.

File body otherwise unchanged (skills, subagents, QA account, grok config).

## 2. Ranker does not assume HLS from `/v1/proxy`

`mini-services/stream-scraper/index.ts` `providerPriority` (~L525) used to boost every CinePro `/v1/proxy` URL to 10 (HLS tier). Probe already sniffs body / Content-Type (`looksLikeHlsUrl` / `classifyProbeKind`); Fshare/Share MP4s ride the same path.

```
// Probe sniffs HLS vs progressive; /v1/proxy wraps both (Fshare MP4 ≠ HLS).
if (url.includes(".m3u8") || url.includes("playlist")) return 10;
return 8;
```

CinePro `/v1/proxy` of a progressive MP4 now scores **8**, not **10**. Real HLS still ranks 10 only when the URL itself has `.m3u8` or `playlist`. `.php` stays 4; Luna/vixsrc label stays 7.

## Not done (by contract)

- No other docs (`CINEHOME.md`, research notes still mention historic `cinehome-sot`)
- No new tests (probe already covers URL-only HLS; ranker change is one predicate)
- No deploy / env / port 3030
- No player / UI / other scraper edits
