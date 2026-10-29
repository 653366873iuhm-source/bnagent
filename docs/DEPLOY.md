# Deployment — tx 1 EXECUTED, minting still PAUSED

**Deployed on BSC mainnet 2026-10-30** (tx [0xb5783c0dff18c9f48cc2720b6c1d389a7298fdd52b5795dcaffe55012f16430b](https://bscscan.com/tx/0xb5783c0dff18c9f48cc2720b6c1d389a7298fdd52b5795dcaffe55012f16430b), block 130,514,568 (0x7c77e88), status success),
from the treasury Agentic Wallet **0x866396d4aee9467b67194431bdbDdE8E8044d8AE (`iuhm.ai`)**. Tx 2 (`setPaused(false)`) NOT sent yet.

| Contract | Address | Source |
|---|---|---|
| BnagentMint | [0xBd57F860B043924f4F37d35AC16c3aab37068e9a](https://bscscan.com/address/0xBd57F860B043924f4F37d35AC16c3aab37068e9a#code) | verified on BscScan + Sourcify |
| BnagentToken | [0xFfA0441EC4ce08F1afE3fdA5093d69ab30e5b97c](https://bscscan.com/address/0xFfA0441EC4ce08F1afE3fdA5093d69ab30e5b97c#code) | verified on BscScan + Sourcify |
| PancakeSwap BNAGENT/USDT pair (`mint.pair()`) | [0xb8E1f4a2B792BAc02599e183e1B8d6f2E54286Dc](https://bscscan.com/address/0xb8E1f4a2B792BAc02599e183e1B8d6f2E54286Dc) | PancakeSwap V2 pair |

Verified with solc 0.8.24, optimizer 200, evm cancun, bytecode_hash none, cbor_metadata false (standard-JSON input).
Token constructor args = (USDT, PancakeV2 factory, v4 PoolManager, v4 Vault) taken from the mint constructor params.
On-chain check after deploy: `paused()` = true, `totalMinted()` = 1100, `treasury()` = 0x8663…d8AE.

Plan file (as broadcast): `deploy/bsc-mainnet-plan.json` (tx input byte-identical to the plan's tx 1). Regenerate: `forge script script/BuildPlan.s.sol`;
social signer `BscConfig.SOCIAL_SIGNER` 0x66ECa9C28e4e4807e37C078b917e527DC85aC199.

## Launch (2 txs, both from the treasury Agentic Wallet 0x8663…d8AE, iuhm.ai)

| # | To | Data | Result |
|---|---|---|---|
| 1 | CREATE2 proxy 0x4e59b44847b379578588920cA78FbF26c0B4956C | `salt ‖ initCode` (salt = keccak256("BNAGENT.mint.v1")) | BnagentMint at the predicted address; its constructor deploys BnagentToken (CREATE, nonce 1), creates the official empty PancakeSwap BNAGENT/USDT pair, and records shares #1–#1,100 as burned (`SharesBurned(1,1100)`). Starts paused. |
| 2 | BnagentMint | `setPaused(false)` = `0x16c38b3c…00` | Minting opens at share #1,101. **Starts the 30-day clock** (`MintStarted(start, deadline)`). |

Originally predicted addresses (treasury 0x49E6…9BCE build) were superseded when the treasury changed to iuhm.ai (initCodeHash
0x3656d5afa1078591e2922c720da8488c3afdb20e771acff6090981a604442234). Actual: mint 0xBd57F860B043924f4F37d35AC16c3aab37068e9a, token 0xFfA0441EC4ce08F1afE3fdA5093d69ab30e5b97c, pair 0xb8E1f4a2B792BAc02599e183e1B8d6f2E54286Dc.

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
baw contract-call preview --binanceChainId 56 --from 0x866396d4aee9467b67194431bdbDdE8E8044d8AE --to <to> --value 0 --inputData <data> --json
baw contract-call execute --requestId <requestId> --json
```
After tx 1: put the mint/token/pair addresses into `site/config.js`, `site/llms.txt`, `site/agent.md`; verify source on BscScan/Sourcify
(solc 0.8.24, optimizer 200, evm cancun, bytecode_hash none, cbor_metadata false); then tx 2.
