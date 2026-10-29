# BNAGENT — STATUS (2026-10-30 ~05:00 CST)

## DEPLOYED on BSC mainnet — MINTING LIVE (setPaused(false) sent; totalMinted 1,101 at 03:30 CST)
- Deploy tx 0xb5783c0dff18c9f48cc2720b6c1d389a7298fdd52b5795dcaffe55012f16430b (block 130,514,568, success), sent from the treasury Agentic Wallet **0x866396d4aee9467b67194431bdbDdE8E8044d8AE (`iuhm.ai`)**.
- Mint **0xBd57F860B043924f4F37d35AC16c3aab37068e9a** · token **0xFfA0441EC4ce08F1afE3fdA5093d69ab30e5b97c** · pair **0xb8E1f4a2B792BAc02599e183e1B8d6f2E54286Dc** (from `mint.pair()`).
- Source **verified on BscScan** (Etherscan v2 API, standard-JSON) and **Sourcify** (full match) for mint and token.
- On-chain: `paused()` = false (minting open), `totalMinted()` = 1,101 at last check, `treasury()` = iuhm.ai wallet.
- Render `bnagent-api`: `ALLOW_TO=0xBd57F860B043924f4F37d35AC16c3aab37068e9a` set and redeployed. Site config/llms.txt/agent.md/docs carry the live addresses; site reads paused/supply live.
- Note: the NatSpec comment in src/BnagentMint.sol still says "treasury 0x49E6…9BCE" — left unchanged on purpose (verified source must match
  what was deployed; the treasury is a constructor argument, so the comment has no effect).


## Done
- Contracts on **Jager's money model** + allowed differences (docs/JAGER-DIFF.md): 20% of each payment → treasury 0x8663…d8AE (iuhm.ai), 80% parked;
  the tx reaching share 10,000 auto-opens the PancakeSwap BNAGENT/USDT pool (LP to dead, transfer lock lifted); afterwards 80% of each mint → pool.
- **1,100 burned shares**: sale starts at #1,101; 28,900 sellable (46,300 USDT).
- **30-day rule, REPEATABLE (user 2026-10-30 00:54 CST):** clock starts at the first unpause. After 30 days, while share 10,000 has not been reached,
  only the treasury can call `withdrawUnfilled()` **as many times as it wants, and minting continues**. Each call: all USDT held (the parked 80%) →
  treasury, parked pool tokens (40M/share) → dead, parked counters reset. **A pool that opens later is backed only by what was parked after the last
  withdraw** (e.g. withdraw at 8,000, open at 10,000 → 1,600 USDT + 80B). Never before day 30, never after the pool opens, works after renounce.
  `MintClosed` removed. Dead tokens stay in totalSupply (cap math conservative).
- Fork tests: **26/26 PASS** (docs/test-results.txt).
- Deploy plan `deploy/bsc-mainnet-plan.json` (tx 1 broadcast byte-identical), docs/DEPLOY.md (deployed addresses + verification).
- Site: **https://bnagent.onrender.com/** (Render static site `bnagent`, publish dir `site/`; auto-deploy does NOT fire, trigger a manual deploy via API) + GitHub Pages mirror
  https://653366873iuhm-source.github.io/bnagent/ (gh-pages = copy of site/). **Logo v3** (2026-10-30; tools/make_logo_v3.py, concept r3-4 "Woven chevron A"):
  clean vector mark: gold #E8B84A upward chevron woven with an amber #B07823 V forming an A (bnagent-mark-v3.svg/.png) + Space Grotesk Bold
  cream "BNAGENT" lockup (bnagent-lockup-v3.png); favicon-v3.svg + favicon-v3-32/180/512.png, og-v3.png; preview logo-v3-preview.png.
  New filenames per version (Render CDN caches old ones). Concept sheets logo-r3-1..6.png; v2 helmet files kept but unused. og/twitter tags, canonical = onrender.
- **Binance Agentic Wallet (.ai Agent ID) QR connect** like jager.live: `server/index.mjs` proxy (Render web service `bnagent-api`,
  https://bnagent-api.onrender.com, free plan, Singapore) → Binance agent-wallet login/confirm/query/mpc-wallet list/contract-call preview/execute.
  Desktop: QR + pairing code; mobile: "Open in Binance App" link (the QR URL is a Binance universal link). Connected session acts as an EIP-1193
  provider, so the mint flow is unchanged (preview → user approves in the app → txHash). Headless tests 32/32 (deployed-state checks: live supply 1,100/30,000, paused label, addresses).

## Social tasks, invite dialog, leaderboard, keep-alive (2026-10-30 ~03:30 CST)
- API `bnagent-api` now also serves `POST /api/social` (alias `/social/sign`): click-based vouchers like jager.live (FOLLOW: no input;
  TWEET: pasted post link or xHandle), EIP-712 Social(...) signed by 0x66EC…C199 (key in Render env `SOCIAL_SIGNER_KEY`, never committed;
  keystore stays in secrets/), Agent ID + socialDone + accountAgent checked on-chain, rate limits 30/10min per IP, 8/10min per wallet.
  `GET /api/leaderboard` (alias `/stats/leaderboard`): Invites / Mints / Holders × UTC day / week, top 100, Agent IDs only, from mint+token
  logs since block 130,514,568 (eth_getLogs via rpc-bsc.48.club / nodereal public, 5,000-block chunks; in-memory, rebuilt on restart).
  noble.mjs = vendored @noble/curves+hashes bundle (service stays dependency-free, build `echo no-deps`).
- Site copies jager.live: header "Invite & tasks · +1 mint" (mobile "Earn") dialog (quota grid, invite link + code copy, social tasks
  Follow/Post → Claim +1 → claimSocial via the connected wallet), shares radio 1–10 + USDT/BNB radios in the mint card, Leaderboard card.
- `.github/workflows/keepalive.yml` pings https://bnagent-api.onrender.com/ every 10 min; the site also pings it on load.

## Not done / next
- Render auto-deploy: both services show autoDeploy=yes / trigger=commit / repo linked, but Render gets no push events (the Render
  GitHub App is not installed on 653366873iuhm-source; cannot be fixed via the Render API). `.github/workflows/deploy.yml` triggers
  deploys on push **if** repo secrets RENDER_DEPLOY_HOOK_SITE / RENDER_DEPLOY_HOOK_API (hook URLs from each service's Settings page;
  the API does not expose them) or RENDER_API_KEY exist — Hark's GitHub token cannot write repo secrets (403), so a human must add
  one. Until then: `POST https://api.render.com/v1/services/<id>/deploys` (static `srv-dbhnqqqjnfac73afudj0`, api `srv-dbhnrnnlk1mc73d80lm0`).
  gh-pages is now mirrored from site/ by the same workflow on every push to main.
- Real scan-and-approve of the QR flow not exercised (needs a user with the Binance App); Render free web service sleeps after ~15 min idle,
  so the first QR request can take ~30-60 s.

## Open decisions
1. X / Telegram handles still placeholders in site/config.js.
2. Not audited. Leaderboards need an indexer.

## Jager parity round (2026-10-30 ~05:00 CST)
- Site: pre-JS HTML shows the live state (supply "—" until read, minting Open, addresses; meta/og "Minting is live"); Jager side rails
  (≥1280px, vertical "BNB SMART CHAIN · AGENT ID ONLY" / "BUILT FOR BINANCE AGENTIC WALLET · ONE AND ONLY" — Jager has no top
  scrolling strip); header counter "N / 30,000 · Shares · Now 1U"; mint card = Jager "Mint Pass" (Agent ID status lines, border badge
  + pts + @x, Current tier "Tier n · xU", Next serial, You receive (est.) + Jager note, "Total shares … · Rises to 1.1U at 10,000",
  figcaption, "Preview your Mint Pass" → 3D rotating pass dialog with border progress, post text 中文/EN, Post on X / Copy / Save
  image, "Mint successful" after a mint); price table lists all 21 tiers + burned row (no collapse); whitepaper moved to
  site/whitepaper/index.html (content identical, Jager page header), nav Whitepaper → whitepaper/ (+ mobile icon link); bottom
  safety notes (pay only to mint, token address only for wallets, never send USDT directly, "Minted before?", "AI agents: read llms.txt").
  Invite dialog gains Bind X + Border season sections; leaderboard rows show border diamonds and X links.
- API: GET /api/stats + /api/verify (Jager shapes), GET /api/pass, GET/POST /api/x-bind, GET /api/x-bind/export (OIDC or
  BINDX_EXPORT_KEY, set on Render; local copy secrets/bindx-export-key). Season points derived from chain logs (no DB).
  Bind X persisted via keepalive.yml job export-bindx → branch `data`, file data/bindx.json; restored on boot. Spec: docs/JAGER-BINDX-SEASON.md.
- Tests: `node test/server/api.test.mjs` (39) and `NODE_PATH=/workspace/work/webtest/node_modules PW_LIBS=/workspace/work/webtest/libs
  node test/site/site.test.js [siteDir] [liveUrl]` (79; was the 52-test /workspace/work/webtest/bn-site.test.js, now in the repo).
- Shipped: commits e2c67d9 + 26c9534 on main; Render deploys dep-dbhq7eifngtc73caj9og (site) / dep-dbhq7eui0phs73f1i3n0 (api) for e2c67d9,
  dep-dbhqai67bikc73f9k0f0 (site) for 26c9534; gh-pages mirrored by the deploy workflow (44d27a4, 94cf4f3); data branch created by the
  first export run. Live tests: Render 78/78, GitHub Pages 78/78 (live mode skips 1 local-only Bind X POST check).
- Render CDN caches index.html ~5 min (s-maxage=300, ignores query strings): right after a deploy an old index can meet new JS; css/js
  now carry ?v=<tag> — bump the tag when changing app.js/style.css.
