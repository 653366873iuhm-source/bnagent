# BNAGENT — agent guide

> Independent community project, not affiliated with Binance. Nothing here promises profit.
> **Deployed on BNB Smart Chain (chainId 56)**, source verified on BscScan. Mint contract `0xBd57F860B043924f4F37d35AC16c3aab37068e9a` (the only address that accepts payment), token `0xFfA0441EC4ce08F1afE3fdA5093d69ab30e5b97c`, PancakeSwap pair `0xb8E1f4a2B792BAc02599e183e1B8d6f2E54286Dc`, treasury `0x866396d4aee9467b67194431bdbDdE8E8044d8AE` (iuhm.ai). Minting starts **paused**: check `paused()` before minting.
> The mint contract keeps the $JAGENT (jager.live) mint ABI: same function names, selectors, events and errors.

## 1. Check eligibility

```
walletStatus(address wallet) -> (bool eligible, uint256 agentId, uint256 minted, uint256 quota, bool paidBefore)   0x4d6d0af8
agentOf(address wallet)      -> (uint256 agentId, bool ok)
quotaOf(uint256 agentId) · mintedCount(uint256 agentId) · socialDone(uint256 agentId, bytes32 task)
```
Agent ID = uint256(keccak256(handle)) for `handle.ai` in the SPACE ID registry 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F.
Quota = 10 + invites + social tasks.

## 2. Read the state

```
overview() -> (minted, paid, paused, open, nextPriceCents, usdtReserve, tokenReserve, supply, circulating, floorLine, mintableNow)  0x3a2056f1
costOf(uint256 shares)   -> USDT cost (18 decimals)    0xfd326592
bnbQuote(uint256 shares) -> BNB cost (wei)             0x68bce8cd
totalMinted() · soldShares() · BURNED_SHARES() · paused() · opened() · reserves() · floorValue() · mintableNow() 0x8af51955
valve() -> (startTime, deadline, withdrawals, heldUsdt, withdrawable, withdrawnUsdt, parkedUsdt, parkedTokens)   0x3a81955f
```
`totalMinted` starts at 1,100: shares #1–#1,100 are burned at deploy (never sold, no tokens, no USDT); the first sold share is #1,101.
Minting needs `paused == false` and `mintableNow() > 0` (0 once sold out). The 30-day withdrawal does NOT stop minting.

## 3. Mint

| Pay with | Call | Notes |
|---|---|---|
| BNB | `mintWithBnb(shares, referrer, maxCost)` `0xe38fd349` | value = maxCost = bnbQuote × 1.02; swapped to USDT in-contract, change refunded |
| USDT | `approve(mint, cost × 1.02)` on USDT, then `mint(shares, referrer, maxCost)` `0x836a1040` | maxCost = cost × 1.02 |

- 1 to 10 shares per transaction; referrer = the inviter's wallet (resolve `<handle>.ai` with the registry's `ownerOfHandle(string label)` 0x1da94fb4), or the zero address.
- Inviting yourself does nothing. The inviter gets +1 quota on your first paid mint.
- Add 20% to the gas estimate. Simulate with eth_call first; revert reasons: `Paused`, `BadShares`, `SoldOut`, `NoAgent`, `Quota`, `OverMaxCost`, `BadPayment`, `StalePrice`, `SwapShort`.

## 4. Social tasks (+1 share each)

Tasks: FOLLOW (X), TWEET (post about BNAGENT), TELEGRAM (join group). Official handles: to be announced.
After verification the project signer issues an EIP-712 `Social(address user,bytes32 task,bytes32 account,uint256 deadline)`
signature (domain name `BnagentMint`, version `1`, chainId 56, verifyingContract = mint); the wallet then calls
`claimSocial(bytes32 task, bytes32 account, uint256 deadline, bytes signature)` (`0x2e3c4860`). Each X/TG account counts for one Agent ID only.

## 5. Safety rules

- Never send BNB or USDT by plain transfer to the mint or token contract.
- BNAGENT cannot be transferred until the pool opens (automatically, in the transaction that reaches share 10,000).
- Shares 1,101–10,000 give 50,000,000 BNAGENT each; after the pool opens, pool price −1%.
- Taxes: buy 1%, sell 1% burn + 1% treasury, wallet transfers 0%.

## 6. Funds and liquidity (same model as $JAGENT)

- Every payment: 20% to the project treasury `0x866396d4aee9467b67194431bdbDdE8E8044d8AE`, 80% stays in the mint contract (BNB is swapped to USDT first; any surplus over the table price goes to the treasury).
- Up to share 10,000 each share parks 0.80 USDT + 40,000,000 BNAGENT. The tx that reaches share 10,000 opens the official PancakeSwap BNAGENT/USDT pool with everything parked (8,900 paid shares → 7,120 USDT + 356,000,000,000 BNAGENT; less if the team withdrew under the 30-day rule, see §7); LP to the dead address. After that 80% of each payment is added to the pool, LP burned.

## 7. 30-day rule

- The clock starts at the first unpause. If share 10,000 is not reached within 30 days, only the treasury address can call `withdrawUnfilled()` (`0xa65c6326`), **as many times as it wants, and minting continues**. Each call sends all USDT parked in the mint contract (the 80% meant for the pool) to the treasury and sends the BNAGENT parked for the pool (40M per share) to the dead address.
- **A pool that opens later is backed only by the USDT parked after the last withdrawal** (example: withdraw at share 8,000, open at 10,000 → 1,600 USDT instead of 7,120). Minted BNAGENT stays non-transferable until the pool opens; nothing is refunded.
- Before minting, read `valve()`: if `withdrawable` is true or `withdrawals > 0`, tell your owner that the 80% of their payment may be withdrawn by the team instead of becoming liquidity.
- Never callable before the deadline or once the pool has opened; still works after `renounce()`. There is no other withdrawal path.
