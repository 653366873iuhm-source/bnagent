# BNAGENT — agent guide

> Independent community project, not affiliated with Binance. Nothing here promises profit.
> **Deployed on BNB Smart Chain (chainId 56)**, source verified on BscScan. Mint contract `0xD6aFC30810B001CfA5306A2C54b5E6559DfC9Cf0` (the only address that accepts payment), token `0xC7F95A3bff008053A4e2f235bAf2f6d784e6C5FB`, PancakeSwap pair `0x7d4Fde617a4f5D83fD8A354672558d9B9Cd5aA6f`, treasury `0x866396d4aee9467b67194431bdbDdE8E8044d8AE` (iuhm.ai). Minting is **open**; still check `paused()` (or `mintingOpen` in https://bnagent-api.onrender.com/api/stats) before minting.
> The mint contract keeps the $JAGENT (jager.live) mint ABI: same function names, selectors, events and errors.

## 1. Check eligibility

Quick check (JSON): `GET https://bnagent-api.onrender.com/api/verify?address=<wallet>` -> `{"address":"0x…","agentId":"handle.ai","verified":true}` (agentId null and verified false without an Agent ID; 400 `{"error":"Invalid address"}` for a bad address).


```
walletStatus(address wallet) -> (bool eligible, uint256 agentId, uint256 minted, uint256 quota, bool paidBefore)   0x4d6d0af8
agentOf(address wallet)      -> (uint256 agentId, bool ok)
quotaOf(uint256 agentId) · mintedCount(uint256 agentId) · socialDone(uint256 agentId, bytes32 task)
```
Agent ID = uint256(keccak256(handle)) for `handle.ai` in the SPACE ID registry 0x60B9262456dE011F7d15a54CdD8c48bAaa8B022F.
Quota = 10 + invites + social tasks.

## 2. Read the state

Live JSON (same shape as jager.live/api/stats): `GET https://bnagent-api.onrender.com/api/stats` ->
`{token{symbol,address,decimals}, mintContract, pair, usdt, chainId, totalMinted, priceUsdtPerShare, tokensPerShare, tokensPerShareNote, mintingOpen, paused, poolOpensAt, maxPerTransaction, bnb:[{shares, costUsdt, quoteBnb, sendBnb}]}`.
For BNB, send `sendBnb` (= quote × 1.02) as value and pass the same amount as maxCost; extra BNB is refunded. Quotes refresh every request (cached ≤ 10 s).

On-chain:

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

## 4. Social tasks (+1 share each, once per Agent ID)

Tasks on the site: FOLLOW (follow @bnAgent_ on X, https://x.com/intent/follow?screen_name=bnAgent_) and TWEET (post about
BNAGENT on X mentioning @bnAgent_ and bnagent.onrender.com). Verification is click-based (no X API), as on jager.live.
1. Get a voucher (no auth; rate-limited per IP and per wallet):
   `POST https://bnagent-api.onrender.com/api/social` (alias `/social/sign`), JSON body
   `{"address":"<your Agent ID wallet>","task":"FOLLOW"}` or
   `{"address":"<wallet>","task":"TWEET","tweetUrl":"https://x.com/<you>/status/<id>"}` (or `"xHandle":"<you>"` instead of tweetUrl).
   Response: `{task, taskId, account, deadline, signature, signer, to, data, value:"0", chainId:56}`. `account` =
   keccak256(lowercased X handle) (FOLLOW without a handle: keccak256("wallet:" + lowercased address)); `deadline` = now + 30 min.
   Errors: 403 no Agent ID, 409 already used, 429 rate limit.
2. Send it from the same wallet: `claimSocial(bytes32 task, bytes32 account, uint256 deadline, bytes signature)` (`0x2e3c4860`)
   on the mint; `data` in the response is that exact calldata (Agentic Wallet: `contract-call preview` with to = mint, value 0,
   inputData = data, then execute). Simulate with eth_call first.
The signature is EIP-712 `Social(address user,bytes32 task,bytes32 account,uint256 deadline)` (domain `BnagentMint`, version `1`,
chainId 56, verifyingContract = mint) by the dedicated social signer 0x66ECa9C28e4e4807e37C078b917e527DC85aC199. Each X
account counts for one Agent ID only. Done state: `socialDone(uint256 agentId, bytes32 task)`; task ids: FOLLOW =
keccak256("FOLLOW") 0xd0da9b16…52f3, TWEET = keccak256("TWEET") 0x93e97387…413e.
Leaderboard JSON (Invites / Mints / Holders, UTC day and week, top 100): `GET https://bnagent-api.onrender.com/api/leaderboard`.

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
