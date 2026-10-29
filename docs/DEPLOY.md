# Deployment plan (NOT executed)

Nothing has been broadcast. Mainnet deployment needs the user's explicit approval.

Plan file: `deploy/bsc-mainnet-plan.json` (regenerate: `forge script script/BuildPlan.s.sol`, optional env `SOCIAL_SIGNER=0x…`).

| # | From | To | Data | Result |
|---|---|---|---|---|
| 1 | Treasury Agentic Wallet 0x49E6…9BCE | CREATE2 proxy 0x4e59b44847b379578588920cA78FbF26c0B4956C | `salt ‖ initCode` (salt = keccak256("BNAGENT.mint.v1")) | BnagentMint at the predicted address; its constructor deploys BnagentToken (CREATE, nonce 1) and creates the PancakeSwap BNAGENT/USDT pair. Starts paused. |
| 2 | Treasury | BnagentMint | `setPaused(false)` = `0x16c38b3c…00` | Minting opens |

Predicted (with socialSigner = treasury): mint 0x77d712228E7Bc75c293C9C793b6751F6ce316d30, token 0x264391dC2A74a2BBd6eeb79A3f836BdadB8f218B.
These change if `SOCIAL_SIGNER` changes (it is a constructor argument). eth_estimateGas for tx 1 on mainnet: ≈ 8.52M gas
(≈ 0.00043 BNB at 0.05 gwei).

Execution (later, after approval), per tx:
```
baw contract-call preview --binanceChainId 56 --from 0x49E6fb3812fdfD67eDfE17259f03CcbE59f39BCE --to <to> --value 0 --inputData <data> --json
baw contract-call execute --requestId <requestId> --json
```
Requires Developer Mode in the Binance app. After tx 1: put the mint/token/pair addresses into `site/config.js`, `site/llms.txt`, `site/agent.md`;
verify source on BscScan/Sourcify (solc 0.8.24, optimizer 200, evm cancun, bytecode_hash none, cbor_metadata false); then tx 2.
