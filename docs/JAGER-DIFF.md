# BNAGENT vs Jager ($JAGENT) — function-by-function self-audit

Reference (verified source, `ref/`): mint `JagentMintV2` 0x3643A907f875fA9B740e1C0747E91b5aA5222aB8, token `JagentTokenV2`
0x8e6442663A4F8C50b6132c68d42A30E7DFE4Ae15 (BSC). Audit date 2026-10-30 CST.

Allowed differences (user, 2026-10-29 23:52 CST):
**(a)** 100% of mint payments to treasury 0x49E6…9BCE; team adds LP manually (400B minted to treasury at share 10,000; one-time
`openTrading()` after LP). **(b)** 30,000 shares, Jager price table truncated. **(c)** 4.44T cap + scaled constants. **(d)** name BNAGENT.
Floor line kept.

Legend: **SAME** · **INTENDED (a/b/c/d)** · **N/A** = Jager-only migration of its earlier deployment (snapshot/quota import, seed) —
BNAGENT is a fresh launch · **FIXED** = an unintended difference found in the previous BNAGENT build (commit 30ba97e) and removed in this one.

ABI check (compiled both): of Jager's 127 mint ABI items, 95 now match BNAGENT exactly (name + inputs + outputs); the 32 others are all
migration (N/A) or 20%-split items. Of 48 token items, 44 match; the 4 others are `deployer/initialize` (see #44). Before this audit only
30/127 and 22/48 matched. Comparison output: `/workspace/work/jager_abi/abi-compare.json` (scratch).

## Unintended differences found and fixed

| # | Item | Previous BNAGENT | Jager | Now |
|---|---|---|---|---|
| F1 | BNB payment | BNB forwarded to treasury as BNB, no swap | Chainlink +1% quote, BNB wrapped and swapped to USDT on PancakeSwap WBNB/USDT V2, `SwapShort` if output < table cost, surplus to treasury | Same swap + `SwapShort` check; **all** USDT output (cost + surplus) to the treasury (a) |
| F2 | Shares 10,001+ before trading | Allowed at table price, 50M tokens each (an invented phase) | No such state: the pool opens inside share 10,000, every later share is pool-priced | Minting past 10,000 reverts `NotOpen()` until `openTrading()`; a tx that would cross 10,000 reverts; `mintableNow()` view |
| F3 | `renounce()` precondition | Only after trading opened | Only `seeded && importLocked` (migration), otherwise any time | No precondition (migration N/A). `openTrading()` is not an admin power, so it still works after renounce (tested) |
| F4 | Function / event / error names, EIP-712 type | Own names (`quote`, `claimTask`, `SocialClaim(...)`, `SharesMinted`, `MintPaused`, …) | `costOf`, `claimSocial`, `Social(address user,bytes32 task,bytes32 account,uint256 deadline)`, `Minted`, `QuotaGranted`, `Paused`, … | All renamed to Jager's: same selectors, same event topics, same error selectors, same EIP-712 struct; storage getters `mintedCount/extraQuota/paidOnce/socialDone/accountAgent/unblockable`, `opened()`, `reserves()`, `circulating()`, `floorValue()`, `ceilValue()`, `openedTime`, `swapTax()/swapTaxSelf()`, token `tradingEnabled/blocksDisabled/blockedPool/rejects/MAX_SUPPLY/enableTrading/burnFromPair/disableBlocks/setPoolBlocked` |
| F5 | Token tax constants type | `uint16` (`BUY_FEE_BPS`, `SELL_FEE_BPS`) | `uint256 BUY_TAX_BPS/SELL_BURN_BPS/SELL_KEEP_BPS` | Jager's names and types |
| F6 | Extra `Payment` event | Emitted per mint | none | Removed (payment visible in the USDT Transfer to the treasury) |
| F7 | Mint-side supply constant | read `token.HARD_CAP()` | `MAX_SUPPLY` constant in the mint | `MAX_SUPPLY` constant in both (4.44T) |

## Full comparison

| # | Area | Jager | BNAGENT | Verdict |
|---|---|---|---|---|
| 1 | Name / symbol | JAGENT / JAGENT; EIP-712 domain name "JagentMint" | BNAGENT / BNAGENT; domain "BnagentMint", version "1" | INTENDED (d) |
| 2 | Decimals | 18 | 18 | SAME |
| 3 | TOTAL_SHARES | 4,440,000 | 30,000 | INTENDED (b) |
| 4 | Token MAX_SUPPLY (incl. dead) | 444T | 4.44T | INTENDED (c) |
| 5 | `priceCents(n)` | 100 ≤10k; 110+10·⌊(n−10,001)/1,000⌋ ≤20k; 210+2·⌊(n−20,001)/1,000⌋ ≤100k; 2 more tiers | first three formulas, identical; 30,000 → 228 | INTENDED (b) (identical where defined; sum 47,400 USDT) |
| 6 | Crossing tiers within one tx | per-share loop `priceCents(n+1+i)` in `costOf` and `_mintShares` | identical loop | SAME |
| 7 | `costOf(shares)` | sum of table prices × 1e16 | identical | SAME |
| 8 | Agent ID gate `_agent` | `handleOf(msg.sender)` → id = keccak(handle) → `ownerOf(id) == sender`, try/catch | identical, same registry 0x60B9…022F | SAME |
| 9 | Base quota | 10 per Agent ID (`BASE_PER_ID`) | 10 | SAME |
| 10 | Invite credit | +1 to referrer's Agent ID on the buyer's first paid mint (`paidOnce`), set before shares are issued; ignored if referrer = 0, = sender, has no Agent ID, or same Agent ID; event `QuotaGranted(referrer, rid, 1, INVITE)` | identical (same order: quota check → payment → `paidOnce` → credit → issue) | SAME |
| 11 | Social tasks `claimSocial` | FOLLOW / TWEET / TELEGRAM; EIP-712 `Social(user,task,account,deadline)` signed by immutable `quotaSigner`; `deadline` check; `tryRecover`; Agent ID required; once per task per ID; an account hash binds to the first ID; +1 quota | identical | SAME (signer value differs: Jager uses a dedicated backend key 0xF6f3…2342; BNAGENT plan defaults to the treasury — decision open) |
| 12 | Per-tx limit | 1–10 (`MAX_PER_TX`), `BadShares` | identical | SAME |
| 13 | Sold-out check | `totalMinted + shares > TOTAL_SHARES` → `SoldOut`; supply > MAX_SUPPLY → `SoldOut` | identical | SAME |
| 14 | Pause | starts paused; treasury `setPaused`; unpause needs `seeded && importLocked` | starts paused; treasury `setPaused` | SAME (precondition N/A) |
| 15 | Tokens per share ≤ 10,000 | 50M to buyer (`USER_SHARE`) + 40M parked per share for the pool | 50M to buyer; nothing parked | SAME for the buyer; parking INTENDED (a) |
| 16 | Share 10,000 | pending 8,000 USDT + 400B tokens → `pair.mint(dead)`, `enableTrading`, `Opened` | 400B (`OPEN_TOKENS`) minted to treasury (`OpenTokensMinted`); treasury adds LP itself, then `openTrading()` → `enableTrading`, `openedTime`, `Opened(usdt, tokens, lp)` | INTENDED (a) |
| 17 | `opened()` | `totalMinted >= OPEN_AT` | `token.tradingEnabled()` | INTENDED (a) |
| 18 | Shares 10,001+ | pool-priced from the next share on | allowed only after `openTrading()` (F2) | INTENDED (a) consequence; FIXED |
| 19 | Post-open tokens per share | `pay·t·10,000 / (u·9,900)` (99% of pool price, i.e. 1% discount), on the running pool | identical formula; running pool changes only by burns | SAME formula; LP-add part INTENDED (a) |
| 20 | Payment split | 20% treasury, 80% paired into the pool at pool price (LP to dead) | 100% treasury, no LP add | INTENDED (a) |
| 21 | USDT payment path | `transferFrom(buyer → mint)` then split | `transferFrom(buyer → treasury)` | INTENDED (a) |
| 22 | BNB pricing | Chainlink BNB/USD 0x0567…2aeE, heartbeat 3,600 s, bounds $50–$50,000, +1% (`BNB_EXTRA_BPS` 100), round up | identical (same feed and bounds) | SAME |
| 23 | BNB swap + refund | swap `need` on WBNB/USDT V2 (fee 25 bps), `SwapShort`, refund `msg.value − need`, `RefundFailed` | identical; whole swap output → treasury | SAME (+ (a)); FIXED (F1) |
| 24 | Slippage params | `mint(shares, referrer, maxCost)` maxCost in USDT wei; `mintWithBnb(...)` maxCost in BNB wei; `OverMaxCost`; `BadPayment` if value < need | identical | SAME |
| 25 | Plain BNB to mint | `receive()` only from WBNB | identical | SAME |
| 26 | Floor line | `totalPaid × 50,000,000 / 27,727,060` (≈1.8033×) | `totalPaid × 85,477 / 47,400` (≈1.8033×) | INTENDED (c) |
| 27 | Floor burn rule | if circ·u/t < line: target t = ⌈u·circ/line⌉, limited by +0.8%/tx vs tx start (`RISE 1008/1000`), never below `POOL_TOKEN_FLOOR`, burn pair inventory to dead + sync, `PoolBurned` | identical code | SAME |
| 28 | Pool minimum | 11,666,666,667 | 116,666,667 (÷100 with cap) | INTENDED (c) |
| 29 | Ceiling line | view only, 60,000,000 / 27,727,060 | view only, 102,572 / 47,400 | INTENDED (c) |
| 30 | `circulating()` | supply − pair − dead − mint | identical | SAME |
| 31 | Buy tax | 1% of buys from the official pair to the mint contract | identical | SAME |
| 32 | Sell tax | 1% to dead + 1% to the mint contract | identical | SAME |
| 33 | Wallet transfers | 0% | 0% | SAME |
| 34 | Tax exemptions | transfers from/to the mint contract | identical (treasury NOT exempt, same as Jager's treasury) | SAME |
| 35 | Pre-open transfers | only from the mint contract | from the mint contract, plus treasury → official pair | INTENDED (a) (needed to add LP while locked) |
| 36 | Tax → BNB | `swapTax()` anyone, once per block, ≤ 0.10% of pool token reserve, token→USDT→WBNB, BNB to treasury; auto-attempt inside mints via `swapTaxSelf` try/catch | identical | SAME |
| 37 | Pool rejection | official pair allowed; V4 PoolManager 0x28e2…e9dF and Infinity Vault 0x238a…e6c4 rejected; blocked pools (until `disableBlocks`); any contract whose token0/token1 includes the token (20k-gas probes); EOAs and EIP-7702 accounts never | identical, same addresses | SAME |
| 38 | `setPoolBlocked` | treasury; not pair/mint/treasury/token/dead/unblockable/EOA/7702 | identical; unblockable = Pancake V2 router, Smart Router, Binance DEX router (same three as Jager on-chain) | SAME |
| 39 | `renounce()` | sets `renounced`, unpauses, `disableBlocks`; precondition seed/import | identical, no precondition | SAME (F3 fixed) |
| 40 | Events | `Minted`, `QuotaGranted`, `Opened`, `PoolBurned`, `TaxSwapped`, `TaxSwapFailed`, `PausedSet`, `Renounced`; token `TradingEnabled`, `PoolBlocked`, `BlocksDisabled` | identical signatures; + `OpenTokensMinted` | SAME (+ (a)) |
| 41 | Errors | Jager set | Jager set minus migration errors; + `AlreadyOpen`, `NoLiquidity` (openTrading) | SAME (+ (a)) |
| 42 | Selectors used by site/agents | `mint` 0x836a1040, `mintWithBnb` 0xe38fd349, `bnbQuote` 0x68bce8cd, `costOf`, `quotaOf`, `mintedCount`, `socialDone`, `claimSocial`, `totalMinted`, `paused` | identical (test `test_JagerSelectors`) | SAME |
| 43 | Extra views | — | `overview()`, `walletStatus(address)`, `agentOf(address)`, `canOpenTrading()`, `mintableNow()`, `domainSeparator()` (read-only) | additive, no state effect (Jager's site uses its own backend `/api/stats` and `/api/verify`) |
| 44 | Token deployment | separate deploy, `initialize(minter)` by deployer | created in the mint constructor (minter = mint) | structural only (single CREATE2 tx from the Agentic Wallet; no behaviour difference) |
| 45 | Migration | `START_MINTED` 9,515, `START_PAID` 8,475, snapshot/quota/social/account import, `seed()`, `lockImport()` | none; starts at 0 | N/A |
| 46 | Reentrancy | `nonReentrant` on mint, mintWithBnb, swapTax | identical | SAME |
| 47 | Compiler | 0.8.24, cancun | 0.8.24, cancun, optimizer 200 | SAME |

## Effects of (a) worth knowing (not bugs, consequences of the allowed change)
- Minting stops at 10,000 until the treasury adds LP and calls `openTrading()`; nothing can be minted in between.
- Mints never add pool USDT, so after opening the pool's USDT side stays at what the team deposited; floor burns only shrink the token
  side. Fork run: pool 8,025 USDT / 114.2B BNAGENT at sell-out (price ≈3.5× opening), circulating "value" on the line 85,476 USDT vs 8k real depth.
- LP tokens sit in the treasury (withdrawable). Jager sends them to dead.

## Tests
`test/BnagentFork.t.sol`, BSC mainnet fork (block 130,495,086): **16/16 pass** (docs/test-results.txt). New: `test_NoMintPastOpenAtBeforeTrading`,
`test_RenounceBeforeOpen`, `test_JagerSelectors`; BNB tests now check the swap and that the treasury receives ≥ cost in USDT.
