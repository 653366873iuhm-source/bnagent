# BNAGENT — STATUS (2026-10-30 ~02:00 CST)

## DEPLOYED on BSC mainnet (minting still PAUSED)
- Deploy tx 0xb5783c0dff18c9f48cc2720b6c1d389a7298fdd52b5795dcaffe55012f16430b (block 130,514,568, success), sent from the treasury Agentic Wallet **0x866396d4aee9467b67194431bdbDdE8E8044d8AE (`iuhm.ai`)**.
- Mint **0xBd57F860B043924f4F37d35AC16c3aab37068e9a** · token **0xFfA0441EC4ce08F1afE3fdA5093d69ab30e5b97c** · pair **0xb8E1f4a2B792BAc02599e183e1B8d6f2E54286Dc** (from `mint.pair()`).
- Source **verified on BscScan** (Etherscan v2 API, standard-JSON) and **Sourcify** (full match) for mint and token.
- On-chain: `paused()` = true, `totalMinted()` = 1100, `treasury()` = iuhm.ai wallet. **Tx 2 `setPaused(false)` NOT sent** (needs user confirmation).
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

## Not done / next
- Render auto-deploy on push did NOT fire for either service (GitHub webhook apparently not wired for this repo): after each push trigger
  `POST https://api.render.com/v1/services/<id>/deploys` (static `srv-dbhnqqqjnfac73afudj0`, api `srv-dbhnrnnlk1mc73d80lm0`) or fix the Render GitHub app access.
- **Open minting**: tx 2 `setPaused(false)` from the treasury — only after the user confirms (starts the 30-day clock).
- Social-task verification backend (signs `Social(...)` with the dedicated key) — not built.
- Real scan-and-approve of the QR flow not exercised (needs a user with the Binance App); Render free web service sleeps after ~15 min idle,
  so the first QR request can take ~30-60 s.

## Open decisions
1. X / Telegram handles still placeholders in site/config.js.
2. Not audited. Leaderboards need an indexer.
