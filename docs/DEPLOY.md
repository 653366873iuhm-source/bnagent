# Deployment plan (NOT executed)

Nothing has been broadcast. Mainnet deployment needs the user's explicit approval.

Plan file: `deploy/bsc-mainnet-plan.json` (regenerate: `forge script script/BuildPlan.s.sol`, optional env `SOCIAL_SIGNER=0x…`).

## Launch (2 txs)

| # | From | To | Data | Result |
|---|---|---|---|---|
| 1 | Treasury Agentic Wallet 0x49E6…9BCE | CREATE2 proxy 0x4e59b44847b379578588920cA78FbF26c0B4956C | `salt ‖ initCode` (salt = keccak256("BNAGENT.mint.v1")) | BnagentMint at the predicted address; its constructor deploys BnagentToken (CREATE, nonce 1) and creates the official, empty PancakeSwap BNAGENT/USDT pair. Starts paused. |
| 2 | Treasury | BnagentMint | `setPaused(false)` = `0x16c38b3c…00` | Minting opens |

Predicted (socialSigner = treasury, initCodeHash 0xb7327642db54b16708224fb71ccc72dcf10f7b472fa484ab65f424ae874f5d1a; Jager-identical ABI build, 2026-10-30):
- mint  0x7cd80FF28A70CBC28AeFeaCF6C3695Fe0fcDE836
- token 0x8641Dd2857504f963F40446196BFF9091C288425
- pair  0xD3d0c6F1c8102d33fb9cf836e82aC8C228789e6c (PancakeSwap V2 CREATE2: factory 0xcA14…0c73, init hash 0x00fb7f63…9bd5; USDT is token0)
(all three confirmed by deploying on a BSC mainnet fork)

These change if `SOCIAL_SIGNER` changes (constructor argument) or the code changes. Initcode 25,882 bytes (limit 49,152).
eth_estimateGas for tx 1 on BSC mainnet (2026-10-30 00:1x CST, from the treasury): 8,389,782 gas (fork execution 7,995,635) ≈ 0.00042 BNB at 0.05 gwei.

From tx 1 on, every mint payment goes straight to the treasury in USDT (BNB payments are swapped to USDT on PancakeSwap WBNB/USDT exactly as in the Jager mint; the whole output goes to the treasury). The mint contract never holds funds. Minting stops at share 10,000 (`mintableNow()` = 0) until step 6.

## After share 10,000 (treasury, manual — needs explicit user approval for each tx)

The tx that mints share 10,000 mints 400,000,000,000 BNAGENT to the treasury. Transfers stay locked; the treasury may move BNAGENT only
into the official pair. Then:

| # | To | Call | Note |
|---|---|---|---|
| 3 | BNAGENT token | `approve(PancakeV2Router 0x10ED43C718714eb63d5aA57B78B54704E256024E, 400e9 × 1e18)` (0x095ea7b3) | |
| 4 | USDT | `approve(router, X)` | X = USDT the team pairs (decides the opening price; 8,000 USDT = minters' phase-1 price) |
| 5 | Router | `addLiquidity(token, USDT, 400e9e18, X, 400e9e18, X, treasury, deadline)` (0xe8e33700) | LP tokens go to the treasury (not locked, not burned) |
| 6 | BnagentMint | `openTrading()` = `0xc9567bf9` | one-time, irreversible; reverts unless share 10,000 is sold and the pair holds liquidity. Check `canOpenTrading()` (0x976bfa66) first |

If someone donates USDT to the empty pair and calls `sync()` (reserves USDT > 0, BNAGENT = 0), the router's `addLiquidity` reverts
(INSUFFICIENT_LIQUIDITY). Fallback (fork-tested): treasury transfers the 400B BNAGENT and the USDT directly to the pair, then calls
`pair.mint(treasury)` (0x6a627842), then `openTrading()`. The donated dust simply belongs to the LP (the treasury).

Optional: `renounce()` (0xb15be2f5) removes pause + pool blocking forever (as in Jager, no opening precondition; `openTrading()` keeps working after it).

Note: after trading opens the treasury is NOT tax-exempt; a later `addLiquidity` from the treasury pays the 1% burn + 1% sell fee on the
BNAGENT side (same as before this change).

## Execution (later, after approval), per tx
```
baw contract-call preview --binanceChainId 56 --from 0x49E6fb3812fdfD67eDfE17259f03CcbE59f39BCE --to <to> --value 0 --inputData <data> --json
baw contract-call execute --requestId <requestId> --json
```
Requires Developer Mode in the Binance app. After tx 1: put the mint/token/pair addresses into `site/config.js`, `site/llms.txt`, `site/agent.md`;
verify source on BscScan/Sourcify (solc 0.8.24, optimizer 200, evm cancun, bytecode_hash none, cbor_metadata false); then tx 2.
