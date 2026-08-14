# Critic reviewer — 10/10 loop

**VERDICT: REJECT**

## MUST-FIX
1. `src/lib/playback/debrid/torrentio.ts` `buildKindPath` still maps season 0 → 1. Use `tvQueryIndex`. Test that S0 builds `stream/series/{imdb}:0:1.json`.
2. `docs/AGENT-SETUP.md` still says cinehome-sot is SoT. Match AGENTS.md.

## SCORES
| Segment | /10 |
|---|---:|
| Player / 4K / TV decode | 8 |
| Scraper / providers | 8 |
| Browse / TV / login | 8 |
| Person / settings / household | 8 |
| Ops / deploy / docs | 6 |

See parent conversation for full reviewer text.
