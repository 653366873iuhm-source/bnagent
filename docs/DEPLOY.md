# Deployment plan (NOT executed)

Nothing has been broadcast. Mainnet deployment needs the user's explicit approval.

Plan file: `deploy/bsc-mainnet-plan.json` (regenerate: `forge script script/BuildPlan.s.sol`; optional env `SOCIAL_SIGNER=0x…`,
default = the dedicated signer `BscConfig.SOCIAL_SIGNER` 0x66ECa9C28e4e4807e37C078b917e527DC85aC199).

## Launch (2 txs, both from the treasury Agentic Wallet 0x49E6…9BCE)

| # | To | Data | Result |
|---|---|---|---|
| 1 | CREATE2 proxy 0x4e59b44847b379578588920cA78FbF26c0B4956C | `salt ‖ initCode` (salt = keccak256("BNAGENT.mint.v1")) | BnagentMint at the predicted address; its constructor deploys BnagentToken (CREATE, nonce 1), creates the official empty PancakeSwap BNAGENT/USDT pair, and records shares #1–#1,100 as burned (`SharesBurned(1,1100)`). Starts paused. |
| 2 | BnagentMint | `setPaused(false)` = `0x16c38b3c…00` | Minting opens at share #1,101. **Starts the 30-day clock** (`MintStarted(start, deadline)`). |

Predicted (social signer 0x66EC…aC199, initCodeHash 0x5079c63ebdd459ed3a9c29cd51db5ce41962b929d4bd31651400d64f5bdb646f; build of 2026-10-30 ~01:10 CST, repeatable-withdraw version):
- mint  0x4E826B92A676DEe5DE13E8Da7C2BD42b0172281b
- token 0x568bf080000E07A017AF1C886158a5b6ad366591
- pair  0x495369C007508D28a27Aaaeca18B3D8af8233037
(all three confirmed by deploying the exact plan initcode on a BSC mainnet fork: `test_PlannedDeploymentAddress`)

These change if the signer or the code changes. Initcode 27,709 bytes (limit 49,152); mint runtime 18,861 bytes (limit 24,576).
`eth_estimateGas` for tx 1 on BSC mainnet (2026-10-30 ~01:10 CST, from the treasury): **8,798,720 gas** ≈ 0.00044 BNB at the current 0.05 gwei.

## After launch — nothing manual
Money model = Jager: each payment 20% → treasury, 80% parked in the mint contract (+40M BNAGENT per share). The tx that reaches share
10,000 opens the pool automatically (7,120 USDT + 356B BNAGENT, LP to 0x…dEaD) and lifts the transfer lock. No team LP step, no `openTrading()`.

## 30-day safety valve (treasury only, needs explicit user approval each time)
If `canWithdrawUnfilled()` (0x2df719e3) is true — more than 30 days after tx 2 and share 10,000 not reached — the treasury may call
`withdrawUnfilled()` = `0xa65c6326`: all USDT in the mint contract (parked 80%) → treasury, parked pool tokens → dead, **minting continues**.
Repeatable any number of times until the pool opens; a later pool is seeded only with what was parked after the last call.
Works after `renounce()`. Never before the deadline, never after the pool opened.

Optional: `renounce()` (0xb15be2f5) removes pause + pool blocking forever (no precondition; also starts the clock if minting was never unpaused).

## Execution (later, after approval), per tx
```
baw contract-call preview --binanceChainId 56 --from 0x49E6fb3812fdfD67eDfE17259f03CcbE59f39BCE --to <to> --value 0 --inputData <data> --json
baw contract-call execute --requestId <requestId> --json
```
After tx 1: put the mint/token/pair addresses into `site/config.js`, `site/llms.txt`, `site/agent.md`; verify source on BscScan/Sourcify
(solc 0.8.24, optimizer 200, evm cancun, bytecode_hash none, cbor_metadata false); then tx 2.
