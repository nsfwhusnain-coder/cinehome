---
name: cinehome-browser
description: >
  Visually test and interact with CineHome using Playwright. Take screenshots,
  login, click, fill, open routes, run smoke flows. Use when verifying UI,
  looking at how the site looks, playtesting, or /cinehome-browser.
---

# CineHome browser vision skill

You cannot “see” the site without screenshots. After any UI change or when the user asks how it looks:

## 1. Load secrets
```bash
set -a && source ~/.grok/secrets/cinehome.env && set +a
cd /Users/husnainali/cinehome-sot
```

## 2. Run QA commands
```bash
bun scripts/browser/qa.ts login
bun scripts/browser/qa.ts flow smoke
bun scripts/browser/qa.ts screenshot /movies movies
bun scripts/browser/qa.ts open /watch/movie/550
bun scripts/browser/qa.ts flow watch-movie 550
# Human can watch:
HEADED=1 SLOW_MO=120 bun scripts/browser/qa.ts flow home
# Mobile:
MOBILE=1 bun scripts/browser/qa.ts screenshot / home-mobile
```

## 3. See the pixels
- Screenshots: `/Users/husnainali/cinehome-sot/.browser-qa/*.png`
- Meta JSON: `.browser-qa/last-run.json`
- Use the **Read** tool on PNG paths — the harness returns a visual description.
- Report layout issues, contrast, empty states, error chrome, nav, player loading.

## 4. Interact
- `click` CSS selector (e.g. `a[href='/movies']`, `button:has-text("Play")`)
- `fill` search inputs
- `eval` for video state: `document.querySelector('video')?.currentTime`

## 5. Login selectors
- Name: `#signin-name`
- PIN: `#signin-pin`
- Submit: form `button[type=submit]`
- Account: `grokqa` via secrets (do not print PIN in chat)

## 6. Headed mode (user watches)
`HEADED=1` launches visible Chromium on the Mac. Use when the user wants to see the agent drive the site.
