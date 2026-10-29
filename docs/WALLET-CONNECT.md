# Wallet connection — what jager.live does and what BNAGENT does

## jager.live (read from its production bundle `/_next/static/immutable/chunks/0pyaahj5ti35c.js`, 2026-10-30)
- No WalletConnect, no wagmi/RainbowKit/Reown, no mobile deep links. A custom React `WalletProvider`.
- **Injected path (Binance only):** listens for `eip6963:announceProvider`, dispatches `eip6963:requestProvider`, and picks the provider whose
  `info.rdns` contains "binance"; fallback `window.ethereum.isBinance` or `window.BinanceChain`. Other wallets are not offered
  ("Binance Wallet extension not detected. Scan the QR code with the Binance App."). Connect = `eth_requestAccounts` + `eth_chainId`;
  if not `0x38` → `wallet_switchEthereumChain`, on error 4902 → `wallet_addEthereumChain` {BNB Smart Chain, bsc-dataseed.bnbchain.org, bscscan}.
  Listens to `accountsChanged` / `chainChanged` / `disconnect`.
- **Agentic Wallet QR path (desktop):** a server route `POST /api/agent-wallet` proxies Binance's Agentic Wallet login API. The browser generates
  a throw-away secp256k1 key, calls `login {publicKeyHex, os, location}` → gets `qrCodeUrl`, `qrCodeId`, `expireAt` (+ a 6-char pairing code),
  polls `query`/`confirm` until `connectionStatus = CONNECTED`, then `walletCreateStatus = CREATED`, then `wallets` → the chain-56 address.
  Transactions: `preview {binanceChainId:56, from, to, value, inputData, gasLimit = 1.3 × estimate}` → `requestId` → poll `execute` until a tx hash
  (the user confirms in the Binance App). Session ids live in sessionStorage. Reads go to bsc-dataseed.bnbchain.org.
- Before sending: `eth_call` simulation, gas = estimate × 1.2, receipts polled every 2.5 s for 3 min; custom errors mapped to plain messages.
- Agent guide: `/llms.txt` (= `/skill.md`), linked in the page footer; backend JSON `/api/stats`, `/api/verify?address=`.

## BNAGENT (site/app.js, static, GitHub Pages)
- EIP-6963 discovery of **all** injected wallets with a chooser (Binance first, then MetaMask, OKX, Trust, others), plus legacy fallbacks
  (`window.ethereum`, `ethereum.providers[]`, `BinanceChain`, `okxwallet`, `trustwallet`), de-duplicated.
- Same chain logic as Jager (switch → 4902 → add BSC), same listeners, silent auto-reconnect via `eth_accounts`, disconnect
  (+ `wallet_revokePermissions` where supported).
- Mobile: inside a wallet's in-app browser with a single provider it connects directly; otherwise deep links "open in MetaMask / OKX / Trust",
  and "copy link → Binance App → Wallet → Discover".
- Agentic Wallet: copyable agent prompt pointing to our `llms.txt` / `agent.md`, `baw contract-call` template, and a read-only
  "check an Agentic Wallet address" box (Agent ID + quota from chain).
- After connect: address, network (with Switch button), `.ai` Agent ID from the SPACE ID registry, BNB/USDT balances, and
  "合约未部署 / Contracts not deployed yet" while `config.js` has no mint address. Mint: eth_call simulation, gas × 1.2, Jager-style error messages.
- **Agentic Wallet QR login (added 2026-10-30):** same design as Jager. `server/index.mjs` (Render web service `bnagent-api`) proxies
  `POST /api/agent-wallet {action, clientId, sessionId, body}` to `https://www.binance.com/bapi/defi/v1/public/wallet-direct/agent-wallet/*`
  (endpoints and headers taken from Binance's own `@binance/agentic-wallet` CLI 1.11.0): `login` (throw-away secp256k1 public key → `qrCodeUrl`,
  `qrCodeId`, `expireAt`, pairing code), `confirm` (until `CONNECTED`; the `agentSessionId` comes back and is returned to the page as `sessionId`,
  stored in sessionStorage), `query` (until `walletCreateStatus = CREATED`), `wallets` (mpc-wallet/list → chain-56 address), `preview`
  (contract-call/preview, binanceChainId 56; `to` restricted to USDT + env `ALLOW_TO`), `execute` (polled every 3 s until a tx hash), `logout`.
  CORS limited to bnagent.onrender.com and the GitHub Pages origin. The proxy stores nothing and cannot sign: every tx is approved in the Binance App.
  Client: "Binance Wallet / Agent ID" button at the top of the chooser; QR (vendored qrcode-generator, MIT) on desktop, "Open in Binance App" link on
  mobile; the session is wrapped as an EIP-1193 provider (`eth_requestAccounts`, `eth_chainId` = 0x38, `eth_sendTransaction` → preview/execute).
- No WalletConnect projectId is needed: this is Binance's own Agentic Wallet login, not WalletConnect.
- WalletConnect: Jager does not use it. Not added; it would need a WalletConnect Cloud projectId (none available).

Test: `test/site/wallet-connect.test.js` (headless Chromium, mock EIP-6963 provider) — 16/16 pass locally and against the live site.
