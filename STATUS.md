# BNAGENT — STATUS (2026-10-29 23:xx CST)

## Done
- Contracts (own code, same rules as the reference mechanism; see docs/PARAMETERS.md):
  `src/BnagentMint.sol` (runtime 17.7 KB, initcode 25.8 KB), `src/BnagentToken.sol`, `src/interfaces/IExternal.sol`.
- BSC mainnet fork tests `test/BnagentFork.t.sol`: **11 / 11 PASS** (publicnode RPC, fork block = latest−20 ≈ 130,493,1xx).
  Full log: docs/test-results.txt. Covered: CREATE2 deploy from the treasury through 0x4e59…956C with address prediction,
  real Agent ID holders (htetwai.ai, chmon.ai, gm1117.ai; treasury = allin168.ai), price table (sum 47,400), paused start + admin,
  0/11 shares, maxCost, quota, no-Agent-ID, plain BNB revert, invites (+1 on first paid mint only, self/non-agent ignored),
  social tasks (EIP-712, duplicate task, account reuse, wrong user, expired, unknown task), pre-open transfer lock,
  BNB mint via Chainlink + Pancake swap with refund, full flow 1 → 30,000 (USDT + BNB mints, opening tx at 10,000 with 8,000 USDT + 400B,
  LP at dead, phase-2 99% pricing, floor burn ≤ 0.8%/tx and pool ≥ min every tx, wallet transfer 0 tax, other pair / V4 PoolManager /
  Infinity Vault rejected, buy 1%, sell 1% burn + 1% fee, tax → BNB to treasury capped at 0.1% of pool and once per block,
  block/unblock rules, renounce, sold-out revert, supply ≤ 4.44T), token cap + only-minter.
- Unsigned deployment plan `deploy/bsc-mainnet-plan.json` + docs/DEPLOY.md (2 txs; nothing broadcast).
- Website `site/` (gold on black, script-made SVG logo, EN default / 中文, live mint card via JSON-RPC, price table with current-tier highlight,
  leaderboard placeholders, quota/social section, whitepaper EN+ZH, contract list from config, agent section, risk disclosure,
  llms.txt, agent.md). Contract addresses empty in site/config.js.
- Local git repo (branch main + gh-pages = site/ subtree) ready to push.

## Blocked
- GitHub: the Hark GitHub App cannot create repositories (POST /user/repos → 403 "Resource not accessible by integration";
  installation has contents/workflows/actions write but no Administration or Pages permission). Repo + Pages not created.
  Needed from the user: create an empty public repo `653366873iuhm-source/bnagent` (no README) at https://github.com/new.
  Then Hark can push main + a gh-pages branch (contents write is granted). Enabling Pages: Settings → Pages → Deploy from branch
  `gh-pages` / root (the App has no Pages permission, so the user may need to click this once).

## Open issues / decisions for the user
1. Social-task signer (immutable constructor arg). Plan defaults to the treasury wallet (Agentic Wallet can sign EIP-712 via
   `baw sign-message`, but signing each claim by hand is slow; recovery from its signatures not yet verified on-chain). A dedicated backend
   signer key + verification service is the practical option. Changing it changes the predicted addresses.
2. X / Telegram handles: placeholders in site/config.js (`social.x`, `social.telegram`); the tasks themselves are on-chain constants FOLLOW/TWEET/TELEGRAM.
3. Floor-line numerator judgment call: kept the reference ≈1.80× ratio (85,477 / 47,400). Using the literal 50,000,000 numerator with a 47,400
   denominator would make the line ≈1,055× paid in (permanent maximal burning).
4. Pool minimum reserve scaled by the supply-cap ratio (1/100 → 116,666,667). Scaling by the share ratio (1/148) would give ≈78,828,829.
5. Not audited. Site not visually checked in a browser (no Chromium available in the sandbox); JS syntax checked, logo rendered and checked.
6. Leaderboards need an indexer (placeholder only).
