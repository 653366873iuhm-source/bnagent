# Deployment plan (NOT executed)

Nothing has been broadcast. Mainnet deployment needs the user's explicit approval.

Plan file: `deploy/bsc-mainnet-plan.json` (regenerate: `forge script script/BuildPlan.s.sol`; optional env `SOCIAL_SIGNER=0x…`,
default = the dedicated signer `BscConfig.SOCIAL_SIGNER` 0x66ECa9C28e4e4807e37C078b917e527DC85aC199).

## Launch (2 txs, both from the treasury Agentic Wallet 0x49E6…9BCE)

| # | To | Data | Result |
|---|---|---|---|
| 1 | CREATE2 proxy 0x4e59b44847b379578588920cA78FbF26c0B4956C | `salt ‖ initCode` (salt = keccak256("BNAGENT.mint.v1")) | BnagentMint at the predicted address; its constructor deploys BnagentToken (CREATE, nonce 1), creates the official empty PancakeSwap BNAGENT/USDT pair, and records shares #1–#1,100 as burned (`SharesBurned(1,1100)`). Starts paused. |
| 2 | BnagentMint | `setPaused(false)` = `0x16c38b3c…00` | Minting opens at share #1,101. **Starts the 30-day clock** (`MintStarted(start, deadline)`). |

Predicted (social signer 0x66EC…aC199, initCodeHash 0xfae87a43eba57acdf7a6fb26b94bb928de8f286bad7ce571e0d9bdcd5e0885c2; build of 2026-10-30 00:4x CST):
- mint  0x2B1Ec8a99BDd66ba6192b5b1755e8B346CcE9705
- token 0x76aE68D5cdD675dC81593923BFb13d6967E4fbdc
- pair  0x2fD791295f5F53F095Cb2102B0496e63E7e0514d (USDT is token0)
(all three confirmed by deploying the exact plan initcode on a BSC mainnet fork: `test_PlannedDeploymentAddress`)

These change if the signer or the code changes. Initcode 27,709 bytes (limit 49,152); mint runtime 18.9 KB (limit 24 KB).
`eth_estimateGas` for tx 1 on BSC mainnet (2026-10-30 ~00:40 CST, from the treasury): **8,800,504 gas** ≈ 0.00044 BNB at the current 0.05 gwei.

## After launch — nothing manual
Money model = Jager: each payment 20% → treasury, 80% parked in the mint contract (+40M BNAGENT per share). The tx that reaches share
10,000 opens the pool automatically (7,120 USDT + 356B BNAGENT, LP to 0x…dEaD) and lifts the transfer lock. No team LP step, no `openTrading()`.

## 30-day safety valve (treasury only, needs explicit user approval when the time comes)
If `canWithdrawUnfilled()` (0x2df719e3) is true — more than 30 days after tx 2 and share 10,000 not reached — the treasury may call
`withdrawUnfilled()` = `0xa65c6326`: all USDT in the mint contract → treasury, minting closed for good (`MintClosed`), tokens stay
non-transferable. Works after `renounce()`. Never before the deadline, never after the pool opened.

Optional: `renounce()` (0xb15be2f5) removes pause + pool blocking forever (no precondition; also starts the clock if minting was never unpaused).

## Execution (later, after approval), per tx
```
baw contract-call preview --binanceChainId 56 --from 0x49E6fb3812fdfD67eDfE17259f03CcbE59f39BCE --to <to> --value 0 --inputData <data> --json
baw contract-call execute --requestId <requestId> --json
```
After tx 1: put the mint/token/pair addresses into `site/config.js`, `site/llms.txt`, `site/agent.md`; verify source on BscScan/Sourcify
(solc 0.8.24, optimizer 200, evm cancun, bytecode_hash none, cbor_metadata false); then tx 2.
