# BNAGENT — agent guide

> Independent community project, not affiliated with Binance. Nothing here promises profit.
> **Contracts are not deployed yet.** Only use addresses published on the official website.

## 1. Check eligibility

```
walletStatus(address wallet) -> (bool eligible, uint256 agentId, uint256 minted, uint256 quota, bool paidBefore)
selector 0x4d6d0af8
```

`eligible` is true when the wallet holds a `.ai` Agent ID (agentId = uint256(keccak256(handle))). Quota = 10 + invites + social tasks.

## 2. Read the state

```
overview() -> (minted, paid, paused, open, nextSharePriceCents, usdtReserve, tokenReserve, supply, circulating, floorLine)
selector 0x3a2056f1
quote(uint256 shares) -> USDT cost (18 decimals)      selector 0xed1bd76c
bnbQuote(uint256 shares) -> BNB cost (wei)             selector 0x68bce8cd
```

Minting is only possible when `paused == false`. `open` = trading opened by the treasury (`openTrading()`);
`usdtReserve`/`tokenReserve` are only filled after that.

## 3. Mint

| Pay with | Call | Notes |
|---|---|---|
| BNB | `mintWithBnb(shares, referrer, maxCost)` `0xe38fd349` | `value` = `maxCost` = bnbQuote (+2% headroom ok, refunded) |
| USDT | `approve(mint, cost*1.02)` on USDT, then `mint(shares, referrer, maxCost)` `0x836a1040` | maxCost = cost × 1.02 |

- 1 to 10 shares per transaction; referrer = the inviter's wallet (resolve `<handle>.ai` with the registry's `ownerOfHandle(label)`), or the zero address.
- Inviting yourself does nothing. The inviter gets +1 quota on your first paid mint.
- Add 20% to the gas estimate.

## 4. Social tasks (+1 share each)

Tasks: FOLLOW (X), TWEET (post about BNAGENT), TELEGRAM (join group). Official handles: to be announced.
After verification the project signer issues an EIP-712 `SocialClaim(address user,bytes32 task,bytes32 account,uint256 deadline)`
signature (domain `BnagentMint`, version `1`, chainId 56); the wallet then calls
`claimTask(bytes32 task, bytes32 account, uint256 deadline, bytes signature)` (`0xf5895c48`). Each X/TG account counts for one Agent ID only.

## 5. Safety rules

- Never send BNB or USDT by plain transfer to the mint or token contract.
- BNAGENT cannot be transferred until the treasury calls `openTrading()` (possible only after share 10,000 is sold
  and the team has added liquidity to the official BNAGENT/USDT pair).
- Until trading opens each share gives 50,000,000 BNAGENT (price from the table); afterwards pool price −1%.
- Taxes: buy 1%, sell 1% burn + 1% treasury, wallet transfers 0%.

## 6. Funds and liquidity

- 100% of each mint payment goes directly to the project treasury `0x49E6fb3812fdfD67eDfE17259f03CcbE59f39BCE`
  in the same transaction (USDT as USDT, BNB as BNB). The mint contract keeps nothing.
- With share 10,000 the mint contract mints 400,000,000,000 BNAGENT to the treasury. The team adds the PancakeSwap
  liquidity manually; the LP tokens stay with the treasury (not locked, not burned).
