# BNAGENT — agent guide

> Independent community project, not affiliated with Binance. Nothing here promises profit.
> **Contracts are not deployed yet.** Only use addresses published on the official website / llms.txt.
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
totalMinted() · paused() · opened() · reserves() · floorValue() · mintableNow() 0x8af51955
```
Minting needs `paused == false` and `mintableNow() > 0` (it is 0 after share 10,000 until `openTrading()`).

## 3. Mint

| Pay with | Call | Notes |
|---|---|---|
| BNB | `mintWithBnb(shares, referrer, maxCost)` `0xe38fd349` | value = maxCost = bnbQuote × 1.02; swapped to USDT in-contract, change refunded |
| USDT | `approve(mint, cost × 1.02)` on USDT, then `mint(shares, referrer, maxCost)` `0x836a1040` | maxCost = cost × 1.02 |

- 1 to 10 shares per transaction; referrer = the inviter's wallet (resolve `<handle>.ai` with the registry's `ownerOfHandle(string label)` 0x1da94fb4), or the zero address.
- Inviting yourself does nothing. The inviter gets +1 quota on your first paid mint.
- Add 20% to the gas estimate. Simulate with eth_call first; revert reasons: `Paused`, `BadShares`, `SoldOut`, `NoAgent`, `Quota`, `OverMaxCost`, `BadPayment`, `StalePrice`, `SwapShort`, `NotOpen`.

## 4. Social tasks (+1 share each)

Tasks: FOLLOW (X), TWEET (post about BNAGENT), TELEGRAM (join group). Official handles: to be announced.
After verification the project signer issues an EIP-712 `Social(address user,bytes32 task,bytes32 account,uint256 deadline)`
signature (domain name `BnagentMint`, version `1`, chainId 56, verifyingContract = mint); the wallet then calls
`claimSocial(bytes32 task, bytes32 account, uint256 deadline, bytes signature)` (`0x2e3c4860`). Each X/TG account counts for one Agent ID only.

## 5. Safety rules

- Never send BNB or USDT by plain transfer to the mint or token contract.
- BNAGENT cannot be transferred until the treasury calls `openTrading()` (only after share 10,000 and once the team has added liquidity to the official BNAGENT/USDT pair).
- Shares 1–10,000 give 50,000,000 BNAGENT each; after trading opens, pool price −1%.
- Taxes: buy 1%, sell 1% burn + 1% treasury, wallet transfers 0%.

## 6. Funds and liquidity

- 100% of each mint payment goes to the project treasury `0x49E6fb3812fdfD67eDfE17259f03CcbE59f39BCE` in the same transaction, in USDT (BNB is swapped first). The mint contract keeps nothing.
- With share 10,000 the mint contract mints 400,000,000,000 BNAGENT to the treasury. The team adds the PancakeSwap liquidity manually; the LP tokens stay with the treasury (not locked, not burned).
