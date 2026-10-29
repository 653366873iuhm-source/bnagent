# BNAGENT — STATUS (2026-10-30 CST)

## Done
- Contracts (own code, **Jager-identical mechanism and ABI** except the allowed differences; audit docs/JAGER-DIFF.md):
  `src/BnagentMint.sol` (runtime 16.9 KB, initcode 25.3 KB), `src/BnagentToken.sol`, `src/interfaces/IExternal.sol`.
- Allowed differences only: (a) 100% of mint payments to treasury 0x49E6…9BCE in USDT (BNB swapped to USDT like Jager, whole output to treasury);
  share 10,000 mints 400B to the treasury; team adds LP; one-time treasury `openTrading()`; shares 10,001+ only after openTrading (`NotOpen`);
  pre-open the treasury may move tokens into the official pair. (b) 30,000 shares, Jager table truncated (47,400 USDT). (c) 4.44T cap,
  floor 85,477/47,400, pool floor 116,666,667. (d) name BNAGENT. renounce() any time (as Jager).
- 2026-10-30 self-audit fixed 7 unintended differences (BNB forwarding instead of swap, invented 10,001+ pre-open phase, renounce precondition,
  all names/selectors/events/errors/EIP-712 struct, token constant types, extra Payment event, mint MAX_SUPPLY).
- BSC mainnet fork tests `test/BnagentFork.t.sol`: **16 / 16 PASS** (publicnode, fork block 130,495,086). Log: docs/test-results.txt.
- Unsigned deployment plan `deploy/bsc-mainnet-plan.json` + docs/DEPLOY.md. Predicted (socialSigner = treasury):
  mint 0x7cd80FF28A70CBC28AeFeaCF6C3695Fe0fcDE836, token 0x8641Dd2857504f963F40446196BFF9091C288425,
  pair 0xD3d0c6F1c8102d33fb9cf836e82aC8C228789e6c. Deploy gas: eth_estimateGas 8,389,782 (≈0.00042 BNB at 0.05 gwei).
- Website `site/` (EN/中文): new wallet connect (EIP-6963 chooser + legacy injected, auto switch/add BSC, deep links, Agentic Wallet prompt,
  read-only address check, "合约未部署" state) — docs/WALLET-CONNECT.md; headless test test/site/wallet-connect.test.js 16/16.
  llms.txt / agent.md updated to the Jager ABI. Contract addresses still empty in site/config.js.
- GitHub: https://github.com/653366873iuhm-source/bnagent (main + gh-pages = site/), live https://653366873iuhm-source.github.io/bnagent/.

## Blocked
- Agentic Wallet QR login on the site (like jager.live) needs a backend proxy to Binance's Agentic Wallet API; GitHub Pages is static.
- Mainnet deployment: needs the user's explicit go-ahead and the social-signer decision (changes the addresses).

## Open issues / decisions for the user
1. Social-task signer (immutable constructor arg). Plan defaults to the treasury wallet (Agentic Wallet can sign EIP-712 via
   `baw sign-message`, but signing each claim by hand is slow; recovery from its signatures not yet verified on-chain). A dedicated backend
   signer key + verification service is the practical option. Changing it changes the predicted addresses. (Jager uses a dedicated signer key 0xF6f3…2342, not its treasury.)
2. X / Telegram handles: placeholders in site/config.js (`social.x`, `social.telegram`); the tasks themselves are on-chain constants FOLLOW/TWEET/TELEGRAM.
7. Team-held LP: the treasury can withdraw liquidity (disclosed on the site). Without LP adds, pool USDT stays at the team's deposit, so floor burns
   shrink the pool's BNAGENT side every mint (fork: 400B → 114.2B, price ×3.5) and the "circulating value" on the floor line is far above real pool depth.
3. Floor-line numerator judgment call: kept the reference ≈1.80× ratio (85,477 / 47,400). Using the literal 50,000,000 numerator with a 47,400
   denominator would make the line ≈1,055× paid in (permanent maximal burning).
4. Pool minimum reserve scaled by the supply-cap ratio (1/100 → 116,666,667). Scaling by the share ratio (1/148) would give ≈78,828,829.
5. Not audited. Site checked in headless Chromium (playwright) with a mock wallet.
6. Leaderboards need an indexer (placeholder only).
