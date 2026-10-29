> **v2 (current, 2026-10-30):** 100,000,000 shares (#1–#1,100 burned, sale from #1,101; 99,998,900 sellable, 4,223,766,600 USDT at table prices), 5,131 tiers 1U → 79.74U (Jager table continued by its last rule: 100,001–1,000,000 +0.02 per 10,000; then +0.015 per 20,000, rounded to cents), cap 10,000T, FLOOR_LINE 7,616,686,731 / LINE_DENOM 4,223,766,600, POOL_TOKEN_FLOOR 11,666,666,667. Every other rule unchanged.
> Mint 0xD6aFC30810B001CfA5306A2C54b5E6559DfC9Cf0 · Token 0xC7F95A3bff008053A4e2f235bAf2f6d784e6C5FB · Pair 0x7d4Fde617a4f5D83fD8A354672558d9B9Cd5aA6f · deploy tx 0x89fc3e2a…8ac6 · unpaused tx 0x3384c6d5…0943 (valve deadline 2026-11-29 05:19:06 CST).
> The figures below describe **v1** (30,000 shares, mint 0xBd57…9e68a, paused 2026-10-30 05:03 CST) and are kept for the record.

# BNAGENT vs Jager ($JAGENT) — function-by-function audit

Reference (verified source, `ref/`, gitignored): mint `JagentMintV2` 0x3643A907f875fA9B740e1C0747E91b5aA5222aB8, token `JagentTokenV2`
0x8e6442663A4F8C50b6132c68d42A30E7DFE4Ae15 (BSC). Updated 2026-10-30 CST for the user's decisions of 00:25 and 00:34 CST:
**back to Jager's money model** (20% treasury / 80% to the pool, automatic open at share 10,000, LP to dead), plus the
allowed differences below. The earlier manual-LP / `openTrading()` / 400B-to-treasury model is removed everywhere.

## Allowed differences (the only ones)

| Id | Difference | Where |
|---|---|---|
| A | **30,000 shares**, Jager price table truncated at 30,000 (first three tiers, identical formulas) | `TOTAL_SHARES`, `priceCents` |
| B | **1,100 burned shares**: shares #1–#1,100 are burned at deploy — never sold, no tokens, no USDT. `totalMinted` starts at 1,100 (as Jager's `START_MINTED` 9,515, but with `totalPaid` = 0); first sold share #1,101 at the table price (1 USDT); 28,900 sellable. `BURNED_SHARES` / `SELLABLE_SHARES` constants, `soldShares()` view, `SharesBurned(1, 1100)` event in the constructor | mint |
| C | **Opening amounts from what is parked**, not hard-coded 8,000 USDT / 400B: `_open()` pairs `pendingUsdt` with `pendingTokens` (8,900 paid shares → 7,120 USDT + 356B, same 50M/USDT pre-pool price). Jager's `pendingUsdt == OPEN_USDT` check becomes `pendingUsdt > 0 && pendingTokens > 0` (error `NotSeeded`). Uses the accounting counters, not `balanceOf`, so USDT donated to the mint contract cannot change the opening or push the token mint over the cap | `_open` |
| D | **4.44T cap + scaled constants**: `MAX_SUPPLY` 4.44T (both contracts); floor line `paid × 83,492 / 46,300` (46,300 = price of the 28,900 sellable shares; 83,492 = 46,300 × 50,000,000 / 27,727,060 → same ≈1.8033× as Jager); ceiling (view only) 100,191 / 46,300; `POOL_TOKEN_FLOOR` 116,666,667 (Jager ÷100, cap ratio) | constants |
| E | **Name** BNAGENT (token name/symbol, EIP-712 domain "BnagentMint") | |
| F | **Treasury** 0x866396d4aee9467b67194431bdbDdE8E8044d8AE (immutable) | constructor |
| G | **30-day `withdrawUnfilled()`, REPEATABLE, minting continues** (user 2026-10-30 00:54 CST; replaces the earlier one-shot close): `mintStartTime` is set on the first `setPaused(false)` (or `renounce()`, which also unpauses); `mintDeadline()` = start + 30 days. After the deadline (strictly `>`), while the pool is not open, **only `msg.sender == treasury`** (immutable; not gated by `renounced`, so it works after `renounce()`) can call it, **any number of times**: all USDT held by the mint contract (the parked 80% + any stray USDT) → treasury, `pendingUsdt = 0`; the parked pool tokens (`pendingTokens`, 40M/share) are sent to DEAD and `pendingTokens = 0`; counters `unfilledWithdrawals`, `totalUnfilledWithdrawn`; event `UnfilledWithdrawn(treasury, usdt, tokensToDead, totalMinted)`. **Minting is NOT paused or closed.** A pool that opens later (share 10,000) is seeded only with what was parked after the last withdraw, at the same pre-pool price 50M/USDT. Dead tokens stay in `totalSupply`, so the 4.44T cap check stays conservative (at most 8,900 × 40M = 356B can go to dead this way). Never callable before the deadline or once `opened()`. `MintClosed`/`mintClosed` removed. No other withdraw path exists. Views `canWithdrawUnfilled()`, `valve()` → (start, deadline, withdrawals, heldUsdt, withdrawable, withdrawnUsdt, parkedUsdt, parkedTokens) |
| H | **Own social signer**: dedicated EOA 0x66ECa9C28e4e4807e37C078b917e527DC85aC199 (Jager also uses a dedicated key, 0xF6f3…2342) | deploy config |

Structural (no behaviour change): the token is created by the mint constructor (`minter = msg.sender`, no `initialize()`), because the
CREATE2 deployer proxy cannot make follow-up calls. Migration (snapshot/quota import, `seed`, `lockImport`, `START_PAID`) is N/A for a fresh launch.

## Full comparison

| # | Area | Jager | BNAGENT | Verdict |
|---|---|---|---|---|
| 1 | Name / symbol / EIP-712 domain | JAGENT, "JagentMint" | BNAGENT, "BnagentMint" v1 | E |
| 2 | Decimals | 18 | 18 | SAME |
| 3 | TOTAL_SHARES | 4,440,000 | 30,000 | A |
| 4 | Start of sale | `totalMinted = START_MINTED` (9,515, migration), `totalPaid = START_PAID` | `totalMinted = BURNED_SHARES` (1,100), `totalPaid = 0`, nothing minted for them | B |
| 5 | MAX_SUPPLY | 444T | 4.44T | D |
| 6 | `priceCents(n)` | 5 tiers | first 3 tiers, identical; #30,000 = 2.28 | A |
| 7 | Per-share loop in `costOf` / `_mintShares` | yes | identical | SAME |
| 8 | Agent ID gate `_agent` (handleOf → keccak → ownerOf, try/catch) | registry 0x60B9…022F | identical | SAME |
| 9 | Quota: base 10, invite +1 on first paid mint, 3 social tasks +1 each | | identical (same order of checks/effects) | SAME |
| 10 | `claimSocial`, EIP-712 `Social(address user,bytes32 task,bytes32 account,uint256 deadline)` | `quotaSigner` dedicated key | identical code; signer 0x66EC…aC199 | SAME / H |
| 11 | Per-tx 1–10 (`BadShares`), `SoldOut` (shares and supply) | | identical | SAME |
| 12 | Pause | starts paused; treasury `setPaused`; unpause needs seed+import | starts paused; treasury `setPaused`; first unpause starts the 30-day clock | SAME (+G) |
| 13 | Shares ≤ 10,000 | 50M to buyer, 0.80 USDT + 40M tokens parked (`pendingUsdt/pendingTokens`), 20% to treasury | identical | SAME |
| 14 | Open at share 10,000 | `_open()`: 8,000 USDT + 400B (top-up mint) → `pair.mint(DEAD)`, `enableTrading`, `sync`, `Opened` | identical flow with parked amounts (7,120 + 356B) | C |
| 15 | `opened()` | `totalMinted >= OPEN_AT` | identical | SAME |
| 16 | A tx crossing 10,000 | opens inside the tx; later shares pool-priced | identical (`test_OpenInsideCrossingTx`) | SAME |
| 17 | Post-open tokens per share | `pay·t·10,000 / (u·9,900)` | identical | SAME |
| 18 | Post-open split | 20% treasury, 80% paired at pool price, LP to dead (`_curveShare` + `_settle`) | identical code | SAME |
| 19 | USDT path | `transferFrom(buyer → mint)` then split | identical | SAME |
| 20 | BNB pricing / swap / refund | Chainlink +1%, swap on WBNB/USDT V2, `SwapShort`, surplus to treasury, refund | identical | SAME |
| 21 | Floor-line burn (`RISE` 1008/1000, pool minimum, `PoolBurned`) | | identical code, scaled constants | SAME / D |
| 22 | `circulating()`, `floorValue()`, `ceilValue()` | | identical | SAME |
| 23 | Taxes (buy 1% to mint; sell 1% dead + 1% mint; wallets 0%; mint exempt) | | identical | SAME |
| 24 | Pre-open transfers | only from the mint contract | identical (the earlier treasury→pair exception is removed) | SAME |
| 25 | `swapTax` / `swapTaxSelf` (once per block, ≤0.10% of pool) | | identical | SAME |
| 26 | Pool rejection (other pairs, V4 PoolManager, Infinity Vault, blocked pools, 7702/EOA never) | | identical, same addresses | SAME |
| 27 | `setPoolBlocked` / unblockable routers | | identical | SAME |
| 28 | `renounce()` | precondition seed/import; unpauses, disables blocks | no precondition (migration N/A); also starts the clock if never started | SAME (+G) |
| 29 | Events | Jager set | Jager set + `SharesBurned`, `MintStarted`, `UnfilledWithdrawn` | SAME (+B, G) |
| 30 | Errors | Jager set | Jager set minus migration-only errors + `AlreadyOpen`, `DeadlineNotReached` | SAME (+G) |
| 31 | Selectors used by site/agents | `mint` 0x836a1040, `mintWithBnb` 0xe38fd349, `bnbQuote` 0x68bce8cd, … | identical (`test_JagerSelectors`) | SAME |
| 32 | Extra read-only views | — | `overview()`, `walletStatus()`, `agentOf()`, `mintableNow()`, `soldShares()`, `mintDeadline()`, `canWithdrawUnfilled()`, `valve()`, `domainSeparator()` | additive |
| 33 | Withdraw paths | none (all USDT ends in the pool or treasury) | only `withdrawUnfilled()` (G) | G |
| 34 | Reentrancy | `nonReentrant` on mint, mintWithBnb, swapTax | same + `withdrawUnfilled` | SAME |
| 35 | Compiler | 0.8.24 cancun | 0.8.24 cancun, optimizer 200 | SAME |

## Griefing on the empty pair (checked against Jager, matched)

The official pair is created empty by the token constructor. Before the open nobody but the mint contract can move BNAGENT, so:
- Nobody can put BNAGENT into the pair; a USDT-only `pair.mint()` reverts (sqrt(x·0) − 1000 underflows) → **LP supply is always 0 before the open**.
- USDT donated to the pair, with or without `sync()`, is absorbed: `pair.mint()` credits `balance − reserve` = exactly what `_open` sends, and the donation stays in the pool (LP to dead). Tested with 1 wei + 50,000 USDT + sync, and 7 USDT without sync.
- `skim()` reverts before the open (it transfers 0 BNAGENT out of the pair, which the lock refuses) — harmless, same as Jager.
- USDT donated to the mint contract does not change the opening (counters, not balances; C). It stays in the contract; it is swept to the treasury only if `withdrawUnfilled()` runs (after day 30, before the open).
Jager's `_open` behaves the same way; no fix was needed beyond C.

## Judgment calls to note
- Withdraw is allowed strictly **after** `start + 30 days`; minting is never stopped by the deadline or by a withdraw.
- **After day 30 (pool not open) the team can withdraw the parked 80% as many times as it wants and minting continues.** Anyone who mints
  in that period can have their 80% withdrawn too. A later pool is backed only by the USDT parked after the last withdraw (e.g. withdraw at
  8,000, open at 10,000 → 1,600 USDT + 80B instead of 7,120 USDT + 356B). Once the pool opens, no withdraw is possible ever again.
- Parked tokens on withdraw: sent to DEAD (not kept, not re-used) so the later pool opens at the same 50M-per-USDT price minters paid,
  instead of a huge token side against a small USDT side. They stay counted in totalSupply → cap math only gets more conservative.

## Tests
`test/BnagentFork.t.sol`, BSC mainnet fork: **26/26 pass** (docs/test-results.txt).
