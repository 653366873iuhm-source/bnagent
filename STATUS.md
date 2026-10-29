# BNAGENT — STATUS (2026-10-30 ~00:50 CST)

## Done
- Contracts back on **Jager's money model** (user 2026-10-30 00:25 CST) + allowed differences (docs/JAGER-DIFF.md):
  20% of each payment → treasury 0x49E6…9BCE, 80% parked; the tx reaching share 10,000 auto-opens the PancakeSwap BNAGENT/USDT pool
  (LP to dead, transfer lock lifted); afterwards 80% of each mint → pool (LP burned). Manual LP / `openTrading()` / 400B-to-treasury removed.
- **1,100 burned shares** (user 00:34): #1–#1,100 never sold, no tokens/USDT; sale starts at #1,101; 28,900 sellable (46,300 USDT).
  Pool opens with what is parked: 7,120 USDT + 356B. Floor line paid × 83,492 / 46,300 (≈1.8033×).
- **30-day valve**: clock starts at the first unpause; after 30 days, if share 10,000 not reached, only the treasury address can call
  `withdrawUnfilled()` (all USDT → treasury, minting closed for good). Works after renounce; never after the pool opens.
- **Dedicated social signer** 0x66ECa9C28e4e4807e37C078b917e527DC85aC199 (encrypted keystore in `secrets/`, gitignored, chmod 600).
- Fork tests `test/BnagentFork.t.sol`: **25/25 PASS** (docs/test-results.txt), incl. griefing on the empty pair, valve before/after deadline,
  non-treasury, after renounce, after open, mint closed after withdraw, burned shares, full sell-out.
- Deploy plan (unsigned) `deploy/bsc-mainnet-plan.json`, docs/DEPLOY.md: mint 0x2B1Ec8a99BDd66ba6192b5b1755e8B346CcE9705,
  token 0x76aE68D5cdD675dC81593923BFb13d6967E4fbdc, pair 0x2fD791295f5F53F095Cb2102B0496e63E7e0514d; deploy gas 8,800,504.
- Site: whitepaper / risk / llms.txt / agent.md on the new model + plain 30-day rule; SUPPLY bar ("Burned + Minted X / 30,000", X starts
  at 1,100, one gold fill); 30-day deadline row. Wallet-connect headless test 16/16.

## Not done / next (user said: later, not now)
- Logo redesign; Render subdomain bnagent.onrender.com; Jager-style Binance Agent ID QR wallet connect (needs a backend).
- Mainnet deployment: needs the user's explicit go-ahead.
- Social-task verification backend (signs `Social(...)` with the dedicated key) — not built.

## Open decisions
1. Minting is not auto-stopped at the 30-day deadline: until the treasury calls `withdrawUnfilled()`, minting continues and reaching
   10,000 still opens the pool. (Alternative: hard stop at the deadline.)
2. X / Telegram handles still placeholders in site/config.js.
3. Not audited. Leaderboards need an indexer.
