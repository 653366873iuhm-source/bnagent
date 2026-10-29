# BNAGENT parameters and scaling math

Reference mechanism: the $JAGENT mint/token (BSC 0x3643…2aB8 / 0x8e64…5aE15, verified source read from Sourcify).
BNAGENT re-implements the mechanism in its own code. These values differ (user-decided), and the funds/liquidity model differs as described in the next section:

| Parameter | Reference | BNAGENT | How |
|---|---|---|---|
| Name / ticker | JAGENT | BNAGENT | user |
| Total shares | 4,440,000 | 30,000 | user |
| Price table | 5 tiers to 8.07 | first 3 tiers, truncated at 30,000 (max 2.28) | user |
| Total USDT for all shares | 27,728,100 (table) / 27,727,060 (constant) | 47,400 | sum of table |
| Hard cap | 444T | 4.44T (4,440,000,000,000 × 1e18) | user |
| Treasury / tax receiver / admin | multisig | 0x49E6fb3812fdfD67eDfE17259f03CcbE59f39BCE (Agentic Wallet, `allin168.ai`) | user |
| Floor line | paid × 50,000,000 / 27,727,060 (≈1.80330×) | paid × **85,477 / 47,400** (≈1.80331×) | denominator = total price of all shares (user); numerator = 47,400 × 50,000,000 / 27,727,060 = 85,476.6 → 85,477, so the line keeps the same ≈1.80× ratio |
| Ceiling line (view only, unused in logic) | 60,000,000 / 27,727,060 | 102,572 / 47,400 | same scaling |
| Pool minimum token reserve | 11,666,666,667 | **116,666,667** | × cap ratio 4.44T / 444T = 1/100 |
| Tax swap cap | 10 bps of pool token reserve | **10 bps** (unchanged) | already relative to the pool, so it scales by itself; absolute size shrinks with the pool |

## Funds and liquidity (user decision 2026-10-29 23:08 CST — replaces the reference's auto-LP)

| Item | Reference / earlier BNAGENT | BNAGENT now |
|---|---|---|
| Mint payment split | 80% to pool (LP to dead), 20% treasury | **100% to the treasury** (0x49E6…9BCE) in the same tx; the mint contract never holds proceeds |
| USDT payment | transferFrom buyer → mint | `transferFrom(buyer → treasury)` directly |
| BNB payment | Chainlink quote (+1%), swapped to USDT on WBNB/USDT V2, `SwapShort` check, surplus USDT to treasury | identical swap and checks; **the whole USDT output** goes to the treasury (changed 2026-10-30 to match Jager; the earlier BNB-forwarding variant was an unintended difference) |
| Pool tokens | 40M per share parked in the mint contract, 400B paired with 8,000 USDT at share 10,000 | no parking; the tx that mints share 10,000 mints **LP_TOKENS = 400,000,000,000 BNAGENT to the treasury** |
| Pool creation | auto `pair.mint(dead)` at share 10,000 | none. The official BNAGENT/USDT V2 pair is still created (empty) by the token constructor and is the only pool accepted. The treasury adds LP itself (router `addLiquidity`, or direct transfer + `pair.mint`) |
| LP tokens | sent to 0x…dEaD | held by the treasury (not locked, not burned) |
| Trading start | same tx as share 10,000 | treasury calls **`openTrading()`** (one-time, irreversible): reverts unless `totalMinted ≥ 10,000` AND the official pair has both reserves > 0 AND LP totalSupply > 0. View: `canOpenTrading()` |
| Transfers before trading | only from the mint contract | only from the mint contract, **plus treasury → official pair** (needed so the treasury can add LP while transfers are locked) |
| Tokens per share | 50M through share 10,000, then pool price / 0.99 | 50M through share 10,000; **share 10,001+ can only be minted after `openTrading()`** (`NotOpen`), then pool price / 0.99 |
| Phase-2 LP adds | 80% of each payment paired at pool price | none (mints never add liquidity) |
| Floor line | burns pool inventory + sync | unchanged formula, burns pool inventory + `sync()`, **only after `openTrading()`**; needs no contract USDT |
| renounce() | any time (after its migration) | any time; `openTrading()` is not an admin power and still works after renounce |

Unchanged: Agent ID gate (handleOf + ownerOf on SPACE ID registry 0x60B9…022F), base 10 / +1 invite (first paid mint) / +1 per social task
(FOLLOW, TWEET, TELEGRAM via EIP-712 signer), max 10 per tx, self-invite ignored, 30,000 shares, price table (47,400 USDT), hard cap 4.44T,
post-open buyer price = pool price / 0.99, BNB priced via Chainlink BNB/USD (+1%, heartbeat 3600 s, bounds $50–$50,000),
buy 1% / sell 1% burn + 1% fee / wallet 0%, other pairs + V4 PoolManager + Infinity Vault rejected,
routers (Pancake V2, Pancake Smart Router, Binance DEX router) never blockable, max +0.8% price per tx from floor burns, pool min reserve,
tax → BNB once per block (still uses the WBNB/USDT V2 pair), admin pause + pool block until `renounce()`.

Differences in structure (not in rules):
- No migration/snapshot/seed logic (skipped by instruction).
- The token is deployed by the mint contract's constructor, so the mint is its minter without an `initialize()` call
  (the CREATE2 proxy cannot make follow-up calls; the Agentic Wallet cannot create contracts directly).
- Minting starts **paused**; the treasury opens it with `setPaused(false)` (tx 2 of the plan). `renounce()` also unpauses.
- Public interface = Jager's (names, selectors, events, errors, EIP-712 `Social` struct); extra read-only views: `overview()`, `walletStatus(address)`, `agentOf(address)`, `canOpenTrading()`, `mintableNow()`, `domainSeparator()`. Full audit: docs/JAGER-DIFF.md.
- Function selectors for `mint`, `mintWithBnb`, `bnbQuote` match the reference, so existing agent tooling works.

Fork-test outcome at sell-out (30,000 shares; treasury simulated adding 8,000 USDT + 400B at share 10,000 then opening; all other mints synthetic
10-share mints): total supply ≈ 1.616T (cap 4.44T), pool ≈ 8,025 USDT / 114.24B BNAGENT (pool price ≈ 3.5× the opening price), dead ≈ 284.5B,
circulating ≈ 1.217T whose pool value (85,476 USDT) sits on the floor line (85,477 USDT). Floor burns hit 999 of 1,000 mint txs in 10,001–20,000
and all 1,000 in 20,001–30,000. Treasury received every payment in USDT (BNB-paid shares as their swap output, ≥ the table price).
Note: without LP adds, the pool USDT stays at what the team deposits, so the floor-line "value" of circulating supply is a paper number far above
real pool depth (here 85k vs 8k USDT).
