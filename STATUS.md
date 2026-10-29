# BNAGENT — STATUS (2026-10-30 ~01:20 CST)

## Done
- Contracts on **Jager's money model** + allowed differences (docs/JAGER-DIFF.md): 20% of each payment → treasury 0x49E6…9BCE, 80% parked;
  the tx reaching share 10,000 auto-opens the PancakeSwap BNAGENT/USDT pool (LP to dead, transfer lock lifted); afterwards 80% of each mint → pool.
- **1,100 burned shares**: sale starts at #1,101; 28,900 sellable (46,300 USDT).
- **30-day rule, REPEATABLE (user 2026-10-30 00:54 CST):** clock starts at the first unpause. After 30 days, while share 10,000 has not been reached,
  only the treasury can call `withdrawUnfilled()` **as many times as it wants, and minting continues**. Each call: all USDT held (the parked 80%) →
  treasury, parked pool tokens (40M/share) → dead, parked counters reset. **A pool that opens later is backed only by what was parked after the last
  withdraw** (e.g. withdraw at 8,000, open at 10,000 → 1,600 USDT + 80B). Never before day 30, never after the pool opens, works after renounce.
  `MintClosed` removed. Dead tokens stay in totalSupply (cap math conservative).
- Fork tests: **26/26 PASS** (docs/test-results.txt).
- Deploy plan (unsigned) `deploy/bsc-mainnet-plan.json`, docs/DEPLOY.md: mint 0x4E826B92A676DEe5DE13E8Da7C2BD42b0172281b,
  token 0x568bf080000E07A017AF1C886158a5b6ad366591, pair 0x495369C007508D28a27Aaaeca18B3D8af8233037; deploy gas 8,798,720 (~0.00044 BNB).
- Site: **https://bnagent.onrender.com/** (Render static site `bnagent`, publish dir `site/`, auto-deploy from main) + GitHub Pages mirror
  https://653366873iuhm-source.github.io/bnagent/ (gh-pages = copy of site/). New logo (tools/make_logo.py → site/assets: mark.svg, logo.svg,
  bnagent-logo.svg (horizontal), favicon.svg + 32/180/512 png, og.svg/og.png, logo-preview.png), og/twitter tags, canonical = onrender.
- **Binance Agentic Wallet (.ai Agent ID) QR connect** like jager.live: `server/index.mjs` proxy (Render web service `bnagent-api`,
  https://bnagent-api.onrender.com, free plan, Singapore) → Binance agent-wallet login/confirm/query/mpc-wallet list/contract-call preview/execute.
  Desktop: QR + pairing code; mobile: "Open in Binance App" link (the QR URL is a Binance universal link). Connected session acts as an EIP-1193
  provider, so the mint flow is unchanged (preview → user approves in the app → txHash). Headless tests 30/30.

## Not done / next
- Render auto-deploy on push did NOT fire for either service (GitHub webhook apparently not wired for this repo): after each push trigger
  `POST https://api.render.com/v1/services/<id>/deploys` (static `srv-dbhnqqqjnfac73afudj0`, api `srv-dbhnrnnlk1mc73d80lm0`) or fix the Render GitHub app access.
- After deployment: set `ALLOW_TO=<mint address>` on the `bnagent-api` Render service (preview of mint calls is refused until then; USDT approve allowed),
  and fill site/config.js, llms.txt, agent.md.
- Mainnet deployment: needs the user's explicit go-ahead.
- Social-task verification backend (signs `Social(...)` with the dedicated key) — not built.
- Real scan-and-approve of the QR flow not exercised (needs a user with the Binance App); Render free web service sleeps after ~15 min idle,
  so the first QR request can take ~30-60 s.

## Open decisions
1. X / Telegram handles still placeholders in site/config.js.
2. Not audited. Leaderboards need an indexer.
