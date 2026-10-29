# BNAGENT parameters and scaling math

**Deployed** on BSC mainnet 2026-10-30 (tx 0xb5783c0dff18c9f48cc2720b6c1d389a7298fdd52b5795dcaffe55012f16430b): mint 0xBd57F860B043924f4F37d35AC16c3aab37068e9a, token 0xFfA0441EC4ce08F1afE3fdA5093d69ab30e5b97c, pair 0xb8E1f4a2B792BAc02599e183e1B8d6f2E54286Dc; treasury 0x866396d4aee9467b67194431bdbDdE8E8044d8AE (iuhm.ai). Minting starts paused.

Reference mechanism: the $JAGENT mint/token (BSC 0x3643…2aB8 / 0x8e64…5aE15, verified source read from Sourcify).
BNAGENT re-implements the mechanism in its own code with Jager's money model (user decision 2026-10-30 00:25 CST). These values differ (user-decided); audit: docs/JAGER-DIFF.md.

| Parameter | Reference | BNAGENT | How |
|---|---|---|---|
| Name / ticker | JAGENT | BNAGENT | user |
| Total shares | 4,440,000 | 30,000 | user |
| Burned shares | — (migration start 9,515) | **#1–#1,100 burned at deploy** (no tokens, no USDT); sale starts at #1,101; 28,900 sellable | user 2026-10-30 00:34 |
| Price table | 5 tiers to 8.07 | first 3 tiers, truncated at 30,000 (max 2.28) | user |
| Total USDT | 27,728,100 (table) / 27,727,060 (constant) | 47,400 for all 30,000; **46,300 for the 28,900 sellable** | sum of table |
| Hard cap | 444T | 4.44T (4,440,000,000,000 × 1e18) | user |
| Treasury / tax receiver / admin | multisig | 0x866396d4aee9467b67194431bdbDdE8E8044d8AE (Agentic Wallet, `iuhm.ai`) | user |
| Floor line | paid × 50,000,000 / 27,727,060 (≈1.803293×) | paid × **83,492 / 46,300** (≈1.803283×) | denominator = price of the sellable shares (user); numerator = 46,300 × 50,000,000 / 27,727,060 = 83,492.4 → 83,492 |
| Ceiling line (view only, unused in logic) | 60,000,000 / 27,727,060 | 100,191 / 46,300 | same scaling |
| Opening pool | 8,000 USDT + 400B (hard-coded) | **parked amounts**: 8,900 × 0.80 = 7,120 USDT + 8,900 × 40M = 356B (50M per USDT) | user 00:34 |
| Payment split | 20% treasury / 80% pool | same | Jager |
| LP tokens | dead | dead | Jager |
| Unfilled deadline | — | 30 days from the first unpause; then treasury-only `withdrawUnfilled()`, **repeatable, minting continues**; parked USDT → treasury, parked pool tokens → dead; a later pool uses only what was parked after the last withdraw | user 00:25, changed 00:54 |
| Social signer | dedicated key | dedicated key 0x66ECa9C28e4e4807e37C078b917e527DC85aC199 | user 00:25 |
| Pool minimum token reserve | 11,666,666,667 | **116,666,667** | × cap ratio 4.44T / 444T = 1/100 |
| Tax swap cap | 10 bps of pool token reserve | **10 bps** (unchanged) | already relative to the pool, so it scales by itself; absolute size shrinks with the pool |

## Fork-test outcome at sell-out (`test_FullFlow`, 28,900 sold shares, synthetic 10-share mints)

Pool opened at share 10,000 with 7,120 USDT / 356B BNAGENT (LP to dead). At share 30,000: pool ≈ 37,065 USDT / 507.6B BNAGENT,
total supply ≈ 2.050T (cap 4.44T), dead ≈ 399.3B, circulating ≈ 1.143T whose pool value (83,491 USDT) sits on the floor line (83,492).
Floor burns in 999 of 1,000 mint txs in 10,001–20,000 and all 1,000 in 20,001–30,000. Treasury: 9,260 USDT (20% of 46,300) + BNB-swap surplus + tax BNB.
