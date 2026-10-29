# BNAGENT — STATUS (2026-10-29 23:5x CST)

## Done
- Contracts (own code; see docs/PARAMETERS.md): `src/BnagentMint.sol` (runtime 16.6 KB, initcode 24.9 KB), `src/BnagentToken.sol`, `src/interfaces/IExternal.sol`.
- **Funds/liquidity model changed (user decision 2026-10-29 23:08 CST):** 100% of every mint payment goes straight to the treasury
  0x49E6…9BCE (USDT via transferFrom buyer→treasury; BNB forwarded as BNB, no swap). No funds in the contract, no auto LP, no LP burn.
  Share 10,000 mints 400B BNAGENT to the treasury; the team adds LP itself; one-time treasury `openTrading()` (needs ≥10,000 shares
  and liquidity in the official pair) unlocks transfers. Before that: 50M tokens/share at table prices; transfers locked except
  treasury → official pair. Floor line only after openTrading. `renounce()` only after openTrading.
- BSC mainnet fork tests `test/BnagentFork.t.sol`: **13 / 13 PASS** (publicnode, fork block 130,495,086). Log: docs/test-results.txt.
  Covers: CREATE2 deploy + address prediction, real Agent IDs, price table, pause/admin, mint rules/quota/invites/social tasks,
  every payment in treasury (USDT exact, BNB exact, mint holds 0 USDT/BNB/LP), 400B to treasury at 10,000, transfers locked until
  openTrading (incl. treasury → wallet), openTrading reverts before 10,000 (even with a seeded pair), with empty pair, for non-treasury,
  twice; renounce before open reverts; table price + 50M/share between 10,000 and open; treasury adds LP via router then opens;
  donation-griefed empty pair → direct LP add + open; post-open 99% pricing, floor burn ≤0.8%/tx, pool ≥ min, taxes, tax→BNB,
  other pools rejected, block/unblock, renounce, sell-out at 30,000, supply 1.618T < 4.44T.
- Unsigned deployment plan `deploy/bsc-mainnet-plan.json` + docs/DEPLOY.md (2 launch txs + documented manual LP/openTrading txs; nothing broadcast).
  Predicted: mint 0xeCbF387Bc969eECeB0C0b04E595bB2F00938b027, token 0x5044dC1cD9b5F8a3242628D10c61536658dC5A23,
  pair 0x1E9E6BcF76b874E41A74ed74c866B455E256016e. Deploy gas ≈ 8.31M.
- Website `site/` + llms.txt + agent.md + whitepaper (EN/中文) updated: 100% of proceeds to treasury, LP added manually by the team,
  LP held by treasury (not locked/burned), openTrading step, risk disclosure. Contract addresses still empty in site/config.js.
- Local git repo (branch main + gh-pages = site/ subtree).

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
7. Team-held LP: the treasury can withdraw liquidity (disclosed on the site). Without LP adds, pool USDT stays at the team's deposit, so floor burns
   shrink the pool's BNAGENT side every mint (fork: 400B → 114B, price ×3.5) and the "circulating value" on the floor line is far above real pool depth.
3. Floor-line numerator judgment call: kept the reference ≈1.80× ratio (85,477 / 47,400). Using the literal 50,000,000 numerator with a 47,400
   denominator would make the line ≈1,055× paid in (permanent maximal burning).
4. Pool minimum reserve scaled by the supply-cap ratio (1/100 → 116,666,667). Scaling by the share ratio (1/148) would give ≈78,828,829.
5. Not audited. Site not visually checked in a browser (no Chromium available in the sandbox); JS syntax checked, logo rendered and checked.
6. Leaderboards need an indexer (placeholder only).
