# BNAGENT parameters and scaling math

Reference mechanism: the $JAGENT mint/token (BSC 0x3643…2aB8 / 0x8e64…5aE15, verified source read from Sourcify).
BNAGENT re-implements the same mechanism in its own code. Only these values differ (user-decided):

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

Unchanged: Agent ID gate (handleOf + ownerOf on SPACE ID registry 0x60B9…022F), base 10 / +1 invite (first paid mint) / +1 per social task
(FOLLOW, TWEET, TELEGRAM via EIP-712 signer), max 10 per tx, self-invite ignored, 50M tokens per share pre-pool (40M parked for pool),
pool opens on share 10,000 with 8,000 USDT + 400B tokens and LP to 0x…dEaD, post-pool buyer price = pool price / 0.99,
80/20 split, BNB via Chainlink BNB/USD (+1%, heartbeat 3600 s, bounds $50–$50,000) swapped on the WBNB/USDT V2 pair with refund,
buy 1% / sell 1% burn + 1% fee / wallet 0%, no transfers before open, other pairs + V4 PoolManager + Infinity Vault rejected,
routers (Pancake V2, Pancake Smart Router, Binance DEX router) never blockable, max +0.8% price per tx from floor burns,
tax → BNB once per block, admin pause + pool block until `renounce()`.

Differences in structure (not in rules):
- No migration/snapshot/seed logic (skipped by instruction).
- The token is deployed by the mint contract's constructor, so the mint is its minter without an `initialize()` call
  (the CREATE2 proxy cannot make follow-up calls; the Agentic Wallet cannot create contracts directly).
- Minting starts **paused**; the treasury opens it with `setPaused(false)` (tx 2 of the plan). `renounce()` also unpauses.
- Extra read-only views for the site/agents: `overview()`, `walletStatus(address)`, `agentIdOf(address)`, `domainSeparator()`.
- Function selectors for `mint`, `mintWithBnb`, `bnbQuote` match the reference, so existing agent tooling works.

Fork-test outcome at sell-out (30,000 shares, all synthetic 10-share mints): total supply ≈ 2.18T (cap 4.44T), pool ≈ 37,945 USDT /
540.2B BNAGENT, dead ≈ 425.4B, circulating ≈ 1.217T whose pool value (85,476 USDT) sits on the floor line (85,477 USDT);
every phase-2 mint triggered a floor burn (capped at +0.8%/tx). Treasury received 9,480 USDT (20%).
