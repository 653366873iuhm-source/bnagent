# jager.live "Bind X" + "Border season" — spec, and how BNAGENT implements it

Source: jager.live HTML + JS bundle fetched 2026-10-30 (`/_next/static/immutable/chunks/3p23tnq0x9sck.js` app code,
`0pyaahj5ti35c.js` wallet + border table) and live probes of `/api/pass`, `/api/x-bind`, `/api/leaderboard`.
BNAGENT implementation: `server/index.mjs` (API) + `site/app.js` (UI). No database: chain data is recomputed from logs;
the only off-chain data (Bind X) lives in API memory and is persisted to the `data` branch by GitHub Actions.

## 1. Borders (levels)

Jager table (module 8576, export `a`), identical in BNAGENT (`BORDERS` in server and site):

| level | name | cn | min points | color |
|---|---|---|---|---|
| 0 | Bronze | 青铜 | 0 | #b87333 |
| 1 | Silver | 白银 | 7 | #c9d1d9 |
| 2 | Gold | 黄金 | 14 | #f0b90b |
| 3 | Platinum | 铂金 | 21 | #7fe0d0 |
| 4 | Diamond | 钻石 | 28 | #6ec8ff |
| 5 | Master | 大师 | 35 | #b57bff |
| 6 | King | 王者 | 42 | #ff5a5f |

level = highest index whose `min <= points`. Badge UI: a 10×10 px square rotated 45° (`rounded-[2px]`), background = color,
`box-shadow: 0 0 6px <color>88`, title "`<Name> border`"; the labelled variant adds the name in a small bordered chip.
Badges appear on every leaderboard row (before the .ai label), on the Mint Pass card (chip + "`N pts`" + "@x") and in the
Border season grid.

## 2. Season scoring

Jager copy (Invite dialog, "Border season"): "Each UTC day, landing in the Top 100 of the Invites, Mints or Holders day board
earns +1 point (up to 3 a day). Points never go down and borders only rise. Your border shows on your Mint Pass and on every board."
Mint Pass dialog: "`<n>` more to `<Next>`. Earn 1 point for each day board (Invites, Mints, Holders) where you finish in the Top 100."
/ at King: "Top border reached. This is the King card."

Rules as implemented (`computeSeason`):
- Day = UTC day. Only completed days score (today's live board does not).
- Boards (same as `/api/leaderboard` day boards, Agent IDs only, Top 100 after skipping non-Agent-ID wallets):
  Invites = sum of `QuotaGranted(reason INVITE)` per inviter that day; Mints = sum of `Minted.shares` per minter that day;
  Holders = BNAGENT balance at 23:59:59 UTC (replay of token `Transfer` logs), excluding pair, mint, token, dead, zero.
- +1 point per board per day where the wallet is in the Top 100 (max 3/day). Ties keep log order (stable sort).
- Points are recomputed from the full log history since the deploy block (130,514,568), so they are deterministic and can
  only grow; no storage needed. Recomputed when new blocks are indexed or the UTC day changes.
- Live probe of Jager: 600/600 leaderboard rows level 0; `voice.ai` has 1 point — consistent with day-close scoring.

## 3. Bind X

UI (Jager component `a4`, also in the header wallet chip "Add X" → dialog "X profile link"); BNAGENT puts it in the
Invite & tasks dialog, between Social tasks and Border season (same as Jager's dialog order `a3, a4, a6`):
- Title "Bind X" (X logo) + "@x" on the right when bound.
- Text: "Shows your @X next to your .ai on the leaderboards and your Mint Pass. One X per Agent ID. After unbinding, wait 7 days
  to bind again. No quota reward."
- Not connected: button "Connect to bind". Connected without Agent ID: nothing (dialog says the wallet holds no Agent ID).
- Bound: button "Unbind @x" → `confirm("Unbind @x? You can bind an X account again after 7 days.")`.
- Unbound: box "Post your Mint Pass from the X account you want to bind (the post must include `<handle>`.ai), then paste the
  post link." (+ " You can bind again in N day(s)." during cooldown), url input placeholder `https://x.com/…/status/…`,
  "Bind" button disabled while busy / empty / cooldown. Errors in red under the section.

Flow: `proveWallet(action, handle)` →
- Agentic Wallet (QR session): `{kind:"agent", clientId, sessionId}`; the server asks Binance (`mpc-wallet/list` through
  the same proxy) which BSC wallet the session controls and requires it to equal `address`.
- Browser wallet: `personal_sign` of
  `"<site>: <action> X for <handle>.ai\nWallet: <address lowercase>\nTime: <ISO time>"` → `{kind:"sig", time, signature}`.
  Jager uses `jager.live:`; BNAGENT uses `bnagent.onrender.com:`. Server accepts `time` within ±10 min.

API (same paths and shapes as Jager):
- `GET /api/x-bind?handle=<h>` → `{"x":null|"name","boundAt":null|ms,"cooldownMs":0|ms}`; bad/unknown handle → 400
  `{"error":"Unknown Agent ID."}`.
- `POST /api/x-bind {action:"bind"|"unbind", address, tweetUrl, proof}`. Errors (Jager wording where Jager has one):
  unknown action 400 "Unknown action."; no address 400 "Connect your wallet first."; proof fails 401 "Could not confirm this
  wallet. Reconnect it and try again."; plus: no Agent ID 403; already bound 409; X used by another Agent ID 409;
  cooldown 429 "You can bind again in N day(s)."; bad link 400; post not found / author ≠ link author 400;
  post lacks `<handle>.ai` 400 "The post must include `<handle>`.ai."; post unreadable 502.
- Post check: `https://publish.twitter.com/oembed?url=https://twitter.com/<user>/status/<id>` (author_url + html text),
  fallback `https://api.fxtwitter.com/<user>/status/<id>`. The bound X handle = the post author (case as returned).
- Rules: one X per Agent ID, one Agent ID per X, unbind starts a 7-day cooldown for that wallet. Rate limit 20 POST/10 min/IP.
- Leaderboard rows gain `"x"` (when bound) and `"level"`; `GET /api/pass?handle=<h>` → `{"handle","points","level","x"}`.

Storage (no DB): `Map(address → {x, boundAt})` + `Map(address → unboundAt)` in memory.
- `GET /api/x-bind/export` → `{"version":1,"note","updatedAt","bindings":[{"address","x","boundAt"}],"unbinds":[{"address","at"}]}`
  (public data only: wallet address, X handle, timestamps; `updatedAt` = newest timestamp so unchanged data gives an identical file).
  Auth: header `x-export-key` = Render env `BINDX_EXPORT_KEY` (≥32 chars, constant-time compare) **or**
  `Authorization: Bearer <GitHub Actions OIDC token>` with iss `https://token.actions.githubusercontent.com`, aud `bnagent-api`,
  repository `653366873iuhm-source/bnagent` (RS256 verified against GitHub's JWKS). 503 until the boot restore finished.
- `.github/workflows/keepalive.yml` job `export-bindx` (every 10 min): OIDC token → export → `jq` validate → commit
  `data/bindx.json` on branch `data` with GITHUB_TOKEN (only when changed).
- Boot: the API fetches `https://raw.githubusercontent.com/653366873iuhm-source/bnagent/data/data/bindx.json` (404 = empty;
  other failure = retry every 60 s, export stays 503 so an empty memory never overwrites the file).
- Known gap: a bind made less than ~10 min before an API restart (deploy) is lost if the export had not run yet; the user binds again.

## 4. Mint Pass dialog ("Preview your Mint Pass" / "Share your Mint Pass · `<Border>` border")

Jager `aR`: title "Your Mint Pass" (or "Mint successful" after a mint, with "You received N $JAGENT." / "Your $JAGENT is in your
wallet. See the exact amount on BscScan."), sub "Your Agent ID, X and border show here once you connect." (preview) / "Share it on X
with your invite link."; a 3D two-sided card (front: tier art per border; back: "`<BORDER>` BORDER" pill, logo, QR of the site,
"Scan · site", Agent / X / Minted / Border `0n / 07 Name` / Date UTC / Network, ©) that auto-rotates (0.03°/ms), drag/arrow keys,
Pause/Resume + Flip; border progress box; when connected: Post text 中文/EN, "Post on X" (x.com/intent/post), "Copy text",
"Save image" (PNG), hint "Attach the saved image to your post. Then paste the post link under Invite & tasks to bind your X and
claim the post task.", BscScan link after a mint. Post text template (EN): "My … Mint Pass\n\nAgent: h.ai\n[X: @x\n]Border: Name\n\n
No Binance .ai Agent ID, no mint.\nKeep minting: <site>/?ref=h.ai\n\nCA: <token>"; CN: "… Mint Pass\n\nAgent：h.ai\n[X：@x\n]
Border：青铜 Bronze\n\n只有币安 .ai Agent ID 可以铸造。\n继续铸造：…\n\nCA：…" (BNAGENT drops Jager's "Only Binance .ai Agent ID can
mint." English line inside the CN text and keeps the Chinese one). BNAGENT's card art is a CSS re-creation (no Jager images).
