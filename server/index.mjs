// BNAGENT Agentic Wallet QR proxy (same approach as jager.live's /api/agent-wallet route).
// Node >= 18, no dependencies. Run: node server/index.mjs   (PORT, ALLOW_ORIGINS, ALLOW_TO env vars)
//
// The browser cannot talk to Binance's Agentic Wallet API directly: the session is an `agentSessionId` cookie that a
// page on another origin can neither read nor send. This proxy forwards a fixed set of actions and hands the session id
// back to the page (kept in sessionStorage there). It stores nothing, holds no keys and cannot move funds: every
// transaction still needs the user's confirmation in the Binance App.
//
// Social tasks: POST /social/sign {user, task, xHandle} returns an EIP-712 Social(...) grant signed by the dedicated social signer
// (SOCIAL_SIGNER_KEY env var, never logged) that the user's wallet then passes to BnagentMint.claimSocial(). See signSocial().
//
// Actions: login, confirm, query, wallets, preview, execute, logout. `preview` only accepts `to` addresses in ALLOW_TO
// (the BNAGENT mint contract + USDT), so this endpoint cannot be used to request approvals for other contracts.
import http from "node:http";
import crypto from "node:crypto";
import { secp256k1, keccak_256 } from "./noble.mjs";
import { startSweeper } from "./sweeper.mjs";

const PORT = Number(process.env.PORT || 10000);
const BASE = "https://www.binance.com/bapi/defi/v1/public/wallet-direct/agent-wallet";
const ORIGINS = (process.env.ALLOW_ORIGINS ||
  "https://bnagent.onrender.com,https://bnagent-ai.onrender.com,https://bnagentai.onrender.com,https://653366873iuhm-source.github.io")
  .split(",").map((s) => s.trim()).filter(Boolean);
const USDT = "0x55d398326f99059ff775485246999027b3197955";
const ALLOW_TO = new Set([USDT, ...(process.env.ALLOW_TO || "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^0x[0-9a-f]{40}$/.test(s))]);
const ROUTES = {
  login: ["POST", "/login"],
  confirm: ["POST", "/login/confirm"],
  query: ["GET", "/login/query"],
  logout: ["POST", "/login/logout"],
  wallets: ["POST", "/mpc-wallet/list"],
  preview: ["POST", "/contract-call/preview"],
  execute: ["POST", "/contract-call/execute"],
};
const VERSION = "1.11.0";
const isHex = (s, n) => typeof s === "string" && new RegExp(`^0x[0-9a-fA-F]{${n ?? "0,"}}$`).test(s);
const okId = (s) => typeof s === "string" && /^[A-Za-z0-9._:=-]{1,200}$/.test(s);

function headersFor(clientId, sessionId) {
  const cid = okId(clientId) ? clientId : crypto.randomUUID();
  const h = {
    "Content-Type": "application/json",
    agentClientId: cid, "bnc-uuid": cid, agentClientSystem: "Web", agentClientType: "AGENT_CLI",
    agentClientVersion: VERSION, clientVersion: VERSION, version_code: VERSION,
    "x-trace-id": crypto.randomBytes(16).toString("hex"), device_name: "BNAGENT web",
  };
  const sid = typeof sessionId === "string" ? sessionId.replace(/^agentSessionId=/, "") : "";
  if (okId(sid)) h.Cookie = `agentSessionId=${sid}`;
  return h;
}

function sanitize(action, body) {
  const b = body && typeof body === "object" ? body : {};
  switch (action) {
    case "login": {
      // throw-away secp256k1 key; Binance only uses the public key to pair this session (pairing code = 3+3 chars)
      const ecdh = crypto.createECDH("secp256k1");
      ecdh.generateKeys();
      const pub = ecdh.getPublicKey("hex", "compressed").substring(2);
      return { body: { isFirstLogin: true, os: "Web", publicKeyHex: pub }, extra: { pairingCode: pub.slice(0, 3) + pub.slice(-3) } };
    }
    case "confirm":
      if (!okId(b.qrCodeId)) throw new Error("bad qrCodeId");
      return { body: { qrCodeId: b.qrCodeId } };
    case "preview": {
      const to = String(b.to || "").toLowerCase();
      if (!ALLOW_TO.has(to)) throw new Error("This contract is not allowed here.");
      if (!isHex(b.from, 40) || !isHex(b.inputData)) throw new Error("bad preview");
      const value = /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(String(b.value ?? "0")) ? String(b.value ?? "0") : "0";
      const out = { binanceChainId: "56", from: b.from, to: b.to, value, inputData: b.inputData };
      if (Number.isInteger(b.gasLimit) && b.gasLimit > 21000 && b.gasLimit < 30000000) out.gasLimit = b.gasLimit;
      return { body: out };
    }
    case "execute":
      if (!okId(b.requestId)) throw new Error("bad requestId");
      return { body: { requestId: b.requestId } };
    default:
      return { body: undefined };
  }
}

async function proxy(payload) {
  const { action, clientId, sessionId, body } = payload || {};
  const route = ROUTES[action];
  if (!route) return [400, { error: "unknown action" }];
  let s;
  try { s = sanitize(action, body); } catch (e) { return [400, { error: e.message }]; }
  const [method, path] = route;
  const r = await fetch(BASE + path, { method, headers: headersFor(clientId, sessionId), body: method === "GET" ? undefined : JSON.stringify(s.body ?? {}) });
  const cookies = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : [r.headers.get("set-cookie") || ""];
  let sid = null;
  for (const c of cookies) { const m = /agentSessionId=([^;]+)/.exec(c || ""); if (m) sid = m[1]; }
  const data = await r.json().catch(() => ({ message: `HTTP ${r.status}` }));
  const bodySid = data && data.data && typeof data.data.agentSessionId === "string" ? data.data.agentSessionId.replace(/^agentSessionId=/, "") : "";
  if (!sid && okId(bodySid)) sid = bodySid;
  if (data && data.data && "agentSessionId" in data.data) delete data.data.agentSessionId; // only travels as sessionId
  if (s.extra && data && typeof data === "object") data.extra = s.extra;
  return [r.ok ? 200 : 502, { sessionId: sid ? `agentSessionId=${sid}` : null, data }];
}


// ---------------------------------------------------------------- social tasks (+1 share each)
// Click-based like jager.live: the site opens the X follow / post link first, then the user claims. No X API.
// account = keccak256(lowercased X handle without @); deadline = now + 30 min. The contract binds each X account to the first
// Agent ID that uses it and allows each task once per Agent ID.
const MINT = (process.env.MINT || "0xD6aFC30810B001CfA5306A2C54b5E6559DfC9Cf0").toLowerCase();
const CHAIN_ID = 56n;
const RPCS = (process.env.RPC || "https://bsc-dataseed.bnbchain.org,https://bsc-rpc.publicnode.com,https://bsc-dataseed1.binance.org").split(",");
const TASKS = { FOLLOW: "FOLLOW", TWEET: "TWEET", POST: "TWEET" }; // TELEGRAM exists on-chain but is not offered
const enc = new TextEncoder();
const hex = (b) => "0x" + Buffer.from(b).toString("hex");
const unhex = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ""), "hex"));
const kec = (x) => keccak_256(typeof x === "string" ? (x.startsWith("0x") ? unhex(x) : enc.encode(x)) : x);
const sel = (sig) => hex(kec(sig)).slice(0, 10);
const w32 = (h) => h.replace(/^0x/, "").padStart(64, "0");
const SEL = { agentOf: sel("agentOf(address)"), socialDone: sel("socialDone(uint256,bytes32)"), accountAgent: sel("accountAgent(bytes32)"), domainSeparator: sel("domainSeparator()"), claimSocial: sel("claimSocial(bytes32,bytes32,uint256,bytes)") };
const SOCIAL_TYPEHASH = kec("Social(address user,bytes32 task,bytes32 account,uint256 deadline)");
const DOMAIN = kec(Buffer.concat([
  kec("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), kec("BnagentMint"), kec("1"),
  unhex(w32(CHAIN_ID.toString(16))), unhex(w32(MINT)),
].map((b) => Buffer.from(b))));
let SIGNER = null, SIGNER_ADDR = null;
try {
  const k = (process.env.SOCIAL_SIGNER_KEY || "").trim().replace(/^0x/, "");
  if (/^[0-9a-fA-F]{64}$/.test(k)) {
    SIGNER = unhex(k);
    SIGNER_ADDR = "0x" + Buffer.from(kec(secp256k1.getPublicKey(SIGNER, false).slice(1))).subarray(12).toString("hex");
  }
} catch (e) { SIGNER = null; }
async function ethCall(data, to = MINT) {
  let last;
  for (const url of RPCS) {
    try {
      const r = await fetch(url.trim(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }), signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      if (typeof j.result === "string") return j.result;
      last = new Error((j.error && j.error.message) || "rpc");
    } catch (e) { last = e; }
  }
  throw last || new Error("rpc");
}
let domainChecked = false;
async function checkDomain() {
  if (domainChecked) return;
  const onchain = (await ethCall(SEL.domainSeparator)).toLowerCase();
  if (onchain !== hex(DOMAIN)) throw new Error("domain separator mismatch");
  domainChecked = true;
}
const hits = new Map(); // key -> [timestamps]
function limited(key, max, windowMs) {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now); hits.set(key, arr);
  if (hits.size > 50000) for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > windowMs) hits.delete(k);
  return arr.length > max;
}
async function signSocial(b, ip) {
  if (!SIGNER) return [503, { error: "Social tasks are not configured on this server." }];
  const user = String((b && (b.user ?? b.address)) || "");
  if (!isHex(user, 40)) return [400, { error: "user must be a 0x wallet address" }];
  const taskName = TASKS[String((b && b.task) || "").trim().toUpperCase()];
  if (!taskName) return [400, { error: "Unknown task." }];
  // X account: from the pasted post link (as on jager.live), or an explicit xHandle (agents). FOLLOW needs neither: then the
  // voucher is bound to the wallet itself.
  let handle = "";
  const tweetUrl = String((b && b.tweetUrl) || "").trim();
  if (tweetUrl) {
    const m = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{5,25})/i.exec(tweetUrl);
    if (!m || m[1].toLowerCase() === "i") return [400, { error: "Paste the full post link, like https://x.com/yourname/status/123…" }];
    handle = m[1].toLowerCase();
  } else if (b && (b.xHandle ?? b.handle)) {
    handle = String(b.xHandle ?? b.handle).trim().replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "").replace(/^@/, "").replace(/[/?#].*$/, "").toLowerCase();
    if (!/^[a-z0-9_]{1,15}$/.test(handle)) return [400, { error: "xHandle must be an X username (1-15 letters, digits or _)" }];
  }
  if (taskName === "TWEET" && !handle) return [400, { error: "Paste the link of your post." }];
  if (limited("ip:" + ip, 30, 10 * 60 * 1000)) return [429, { error: "Too many requests from this IP. Try again in a few minutes." }];
  if (limited("u:" + user.toLowerCase(), 8, 10 * 60 * 1000)) return [429, { error: "Too many requests for this wallet. Try again in a few minutes." }];
  await checkDomain();
  const ag = (await ethCall(SEL.agentOf + w32(user))).replace(/^0x/, "");
  const id = ag.slice(0, 64), ok = BigInt("0x" + (ag.slice(64, 128) || "0")) === 1n;
  if (!ok) return [403, { error: "This wallet holds no .ai Agent ID." }];
  const task = hex(keccak_256(enc.encode(taskName)));
  const account = hex(keccak_256(enc.encode(handle || "wallet:" + user.toLowerCase())));
  if (BigInt(await ethCall(SEL.socialDone + id + w32(task))) === 1n) return [409, { error: "This task, or this X account, has already been used.", done: true }];
  const bound = BigInt(await ethCall(SEL.accountAgent + w32(account)));
  if (bound !== 0n && bound !== BigInt("0x" + id)) return [409, { error: "This task, or this X account, has already been used." }];
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 30 * 60);
  const struct = kec(Buffer.concat([SOCIAL_TYPEHASH, unhex(w32(user)), unhex(task), unhex(account), unhex(w32(deadline.toString(16)))].map((x) => Buffer.from(x))));
  const digest = kec(Buffer.concat([Buffer.from([0x19, 0x01]), Buffer.from(DOMAIN), Buffer.from(struct)]));
  const sig = secp256k1.sign(digest, SIGNER, { lowS: true });
  const signature = "0x" + w32(sig.r.toString(16)) + w32(sig.s.toString(16)) + (27 + sig.recovery).toString(16);
  const data = SEL.claimSocial + w32(task) + w32(account) + w32(deadline.toString(16)) + w32("80") + w32("41") + signature.slice(2) + "0".repeat(62);
  return [200, { user, task: taskName, taskId: task, xHandle: handle || null, account, deadline: Number(deadline), signature, signer: SIGNER_ADDR, to: MINT, data, value: "0", chainId: 56 }];
}

// ---------------------------------------------------------------- leaderboard (same shape as jager.live /api/leaderboard)
// Boards: invites (QuotaGranted with reason INVITE, by inviter), mints (Minted shares, by minter), holders (live BNAGENT balance).
// Day = current UTC day, week = UTC week from Monday. Scans mint + token logs from the deploy block in 5,000-block chunks on
// public RPCs that allow eth_getLogs, keeps everything in memory (rebuilt after a restart; `syncing` is true while catching up).
const TOKEN = (process.env.TOKEN || "0xC7F95A3bff008053A4e2f235bAf2f6d784e6C5FB").toLowerCase();
const REGISTRAR = "0x60b9262456de011f7d15a54cdd8c48baaa8b022f";
const PAIR = (process.env.PAIR || "0x7d4Fde617a4f5D83fD8A354672558d9B9Cd5aA6f").toLowerCase();
const DEPLOY_BLOCK = Number(process.env.DEPLOY_BLOCK || 130542132);
const TAXSWEEP = startSweeper({ mint: MINT, token: TOKEN, pair: PAIR, name: "bnagent" });
const LOG_RPCS = (process.env.LOG_RPC || "https://rpc-bsc.48.club,https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3,https://bsc.rpc.blxrbdn.com").split(",").map((s) => s.trim());
const T_MINTED = hex(kec("Minted(address,uint256,uint256,uint256,uint256)"));
const T_QUOTA = hex(kec("QuotaGranted(address,uint256,uint256,bytes32)"));
const T_TRANSFER = hex(kec("Transfer(address,address,uint256)"));
const R_INVITE = hex(keccak_256(enc.encode("INVITE")));
const SEL_HANDLE = sel("handleOf(address)");
const LB = { next: DEPLOY_BLOCK, head: 0, syncing: true, invites: [], mints: [], transfers: [], bal: new Map(), handles: new Map(), cache: null, cacheAt: 0, busy: false };
async function rpcAny(urls, method, params) {
  let last;
  for (const url of urls) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      if (j.result !== undefined) return j.result;
      last = new Error((j.error && j.error.message) || "rpc");
    } catch (e) { last = e; }
  }
  throw last || new Error("rpc");
}
const blockTs = new Map();
async function tsOf(log) {
  if (log.blockTimestamp) return Number(BigInt(log.blockTimestamp));
  const n = Number(BigInt(log.blockNumber));
  if (!blockTs.has(n)) { const b = await rpcAny(LOG_RPCS.concat(RPCS), "eth_getBlockByNumber", ["0x" + n.toString(16), false]); blockTs.set(n, Number(BigInt(b.timestamp))); }
  return blockTs.get(n);
}
const addrOf = (topic) => "0x" + topic.slice(26).toLowerCase();
async function scanOnce() {
  if (LB.busy) return; LB.busy = true;
  try {
    LB.head = Number(BigInt(await rpcAny(LOG_RPCS.concat(RPCS), "eth_blockNumber", [])));
    let step = 5000, rounds = 0;
    while (LB.next <= LB.head && rounds++ < 60) {
      const to = Math.min(LB.next + step - 1, LB.head);
      let logs;
      try {
        logs = await rpcAny(LOG_RPCS, "eth_getLogs", [{ address: [MINT, TOKEN], fromBlock: "0x" + LB.next.toString(16), toBlock: "0x" + to.toString(16), topics: [[T_MINTED, T_QUOTA, T_TRANSFER]] }]);
      } catch (e) { if (step > 500) { step = Math.floor(step / 2); continue; } throw e; }
      for (const l of logs) {
        const a = l.address.toLowerCase(), t0 = l.topics[0];
        if (a === MINT && t0 === T_MINTED) {
          const d = l.data.slice(2); LB.mints.push({ who: addrOf(l.topics[1]), n: Number(BigInt("0x" + d.slice(64, 128))), ts: await tsOf(l) });
        } else if (a === MINT && t0 === T_QUOTA) {
          if ("0x" + l.data.slice(66, 130) === R_INVITE) LB.invites.push({ who: addrOf(l.topics[1]), n: Number(BigInt(l.data.slice(0, 66))), ts: await tsOf(l) });
        } else if (a === TOKEN && t0 === T_TRANSFER) {
          const from = addrOf(l.topics[1]), to2 = addrOf(l.topics[2]), v = BigInt(l.data);
          LB.bal.set(from, (LB.bal.get(from) || 0n) - v); LB.bal.set(to2, (LB.bal.get(to2) || 0n) + v);
          LB.transfers.push({ from, to: to2, v, ts: await tsOf(l) });
        }
      }
      LB.next = to + 1;
    }
    LB.syncing = LB.head - LB.next > 200;
    LB.cache = null;
  } finally { LB.busy = false; }
}
async function handleOf(a) {
  if (LB.handles.has(a)) return LB.handles.get(a);
  let h = "";
  try {
    const r = (await rpcAny(RPCS, "eth_call", [{ to: REGISTRAR, data: SEL_HANDLE + w32(a) }, "latest"])).replace(/^0x/, "");
    const len = Number(BigInt("0x" + (r.slice(64, 128) || "0")));
    h = Buffer.from(r.slice(128, 128 + len * 2), "hex").toString("utf8");
  } catch (e) { return null; }
  LB.handles.set(a, h);
  return h;
}
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);
async function board(rows, since) {
  const m = new Map();
  for (const r of rows) if (r.ts >= since) m.set(r.who, (m.get(r.who) || 0) + r.n);
  return rank([...m].map(([who, v]) => ({ who, v: BigInt(v) })));
}
async function rank(list) {
  list.sort((x, y) => (y.v > x.v ? 1 : y.v < x.v ? -1 : 0));
  const out = [];
  for (const e of list) {
    if (out.length >= 100) break;
    const h = await handleOf(e.who);
    if (!h) continue; // only Agent IDs are listed
    const row = { rank: out.length + 1, label: `${h}.ai`, value: e.v.toString(), level: 0 };
    const xb = XB.byAddr.get(e.who); if (xb) row.x = xb.x;
    if (SEASON.levels) row.level = SEASON.levels.get(e.who) || 0;
    out.push(row);
  }
  return out;
}
async function leaderboard() {
  if (LB.cache && Date.now() - LB.cacheAt < 60000) return LB.cache;
  await season().catch(() => null);
  const now = new Date();
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const weekStart = dayStart - ((now.getUTCDay() + 6) % 7) * 86400000;
  const skip = new Set([PAIR, MINT, TOKEN, "0x000000000000000000000000000000000000dead", "0x0000000000000000000000000000000000000000"]);
  const holders = await rank([...LB.bal].filter(([a, v]) => v > 0n && !skip.has(a)).map(([who, v]) => ({ who, v })));
  const out = {
    block: LB.next - 1, updatedAt: Date.now(), syncing: LB.syncing, day: utcDay(dayStart), week: utcDay(weekStart),
    boards: {
      invites: { day: await board(LB.invites, dayStart / 1000), week: await board(LB.invites, weekStart / 1000) },
      mints: { day: await board(LB.mints, dayStart / 1000), week: await board(LB.mints, weekStart / 1000) },
      holders: { day: holders, week: holders },
    },
  };
  LB.cache = out; LB.cacheAt = Date.now();
  return out;
}
const scanLoop = async () => { try { await scanOnce(); } catch (e) { console.log("leaderboard scan:", e.message); } setTimeout(scanLoop, LB.syncing ? 2000 : 30000); };
if (process.env.NO_LISTEN !== "1") setTimeout(scanLoop, 500);

// ---------------------------------------------------------------- public read API (same shape as jager.live /api/stats and /api/verify)
const USDT_ADDR = "0x55d398326f99059fF775485246999027B3197955";
const MINT_CS = process.env.MINT_CHECKSUM || "0xD6aFC30810B001CfA5306A2C54b5E6559DfC9Cf0";
const TOKEN_CS = process.env.TOKEN_CHECKSUM || "0xC7F95A3bff008053A4e2f235bAf2f6d784e6C5FB";
const PAIR_CS = process.env.PAIR_CHECKSUM || "0x7d4Fde617a4f5D83fD8A354672558d9B9Cd5aA6f";
const SEL2 = { overview: sel("overview()"), costOf: sel("costOf(uint256)"), bnbQuote: sel("bnbQuote(uint256)"), handleOf: sel("handleOf(address)"), ownerOfHandle: sel("ownerOfHandle(string)") };
const words = (h) => (String(h || "").replace(/^0x/, "").match(/.{64}/g) || []).map((x) => BigInt("0x" + x));
export function units(v, dec = 18) { // bigint -> decimal string without trailing zeros
  const neg = v < 0n; if (neg) v = -v;
  const b = 10n ** BigInt(dec), i = v / b, f = (v % b).toString().padStart(dec, "0").replace(/0+$/, "");
  return (neg ? "-" : "") + i.toString() + (f ? "." + f : "");
}
const STATS = { at: 0, data: null, busy: null };
async function stats() {
  if (STATS.data && Date.now() - STATS.at < 10000) return STATS.data;
  if (STATS.busy) return STATS.busy;
  STATS.busy = (async () => {
    const w = words(await ethCall(SEL2.overview));
    const minted = Number(w[0]), paused = w[2] === 1n, open = w[3] === 1n, nextCents = Number(w[4]), u = w[5], t = w[6], mintable = Number(w[10] ?? 1n);
    const price = nextCents / 100;
    let tokensPerShare = 50000000;
    if (open && u > 0n && t > 0n) tokensPerShare = Math.floor(price / (0.99 * (Number(u) / Number(t))));
    const left = Math.max(0, 100000000 - minted), maxN = Math.min(10, left);
    const bnb = [];
    for (let n = 1; n <= maxN; n++) {
      const [c, q] = await Promise.all([ethCall(SEL2.costOf + w32(n.toString(16))), ethCall(SEL2.bnbQuote + w32(n.toString(16))).catch(() => null)]);
      const cost = words(c)[0], quote = q ? words(q)[0] : null;
      bnb.push({ shares: n, costUsdt: units(cost), quoteBnb: quote == null ? null : units(quote), sendBnb: quote == null ? null : units((quote * 102n) / 100n) });
    }
    const data = {
      token: { symbol: "BNAGENT", address: TOKEN_CS, decimals: 18 }, mintContract: MINT_CS, pair: PAIR_CS, usdt: USDT_ADDR, chainId: 56,
      totalMinted: minted, priceUsdtPerShare: price, tokensPerShare,
      tokensPerShareNote: open
        ? "Estimate at the current pool price. After share 10,000 each share pays its USDT price at the pool price with a 1% discount, so the amount changes with the pool."
        : "Fixed at 50,000,000 BNAGENT per share up to share 10,000. After share 10,000 each share pays its USDT price at the pool price with a 1% discount, so the amount changes with the pool.",
      mintingOpen: !paused && minted < 100000000 && mintable !== 0, paused, poolOpensAt: 10000, maxPerTransaction: 10,
      burnedAtDeploy: 1100, totalShares: 100000000, bnb,
    };
    STATS.data = data; STATS.at = Date.now();
    return data;
  })().finally(() => { STATS.busy = null; });
  return STATS.busy;
}
const HANDLES = new Map(); // address -> {h, at}
const TEST_HANDLES = process.env.TEST_HANDLES ? JSON.parse(process.env.TEST_HANDLES) : null; // test-only: {address: handle}
async function handleOfAddr(a) {
  a = a.toLowerCase();
  if (TEST_HANDLES && a in TEST_HANDLES) return TEST_HANDLES[a];
  const c = HANDLES.get(a); if (c && Date.now() - c.at < 300000) return c.h;
  const r = (await ethCall(SEL2.handleOf + w32(a), REGISTRAR)).replace(/^0x/, "");
  const len = Number(BigInt("0x" + (r.slice(64, 128) || "0")));
  const h = Buffer.from(r.slice(128, 128 + len * 2), "hex").toString("utf8");
  HANDLES.set(a, { h, at: Date.now() });
  return h;
}
function encString(s) {
  const b = Buffer.from(s, "utf8");
  let hx = b.toString("hex"); hx = hx.padEnd(Math.ceil(hx.length / 64) * 64 || 64, "0");
  return w32("20") + w32(b.length.toString(16)) + hx;
}
const OWNERS = new Map(); // handle -> {a, at}
async function ownerOfHandle(h) {
  if (TEST_HANDLES) { const e = Object.entries(TEST_HANDLES).find(([, v]) => v === h); if (e) return e[0]; }
  const c = OWNERS.get(h); if (c && Date.now() - c.at < 300000) return c.a;
  const w = words(await ethCall(SEL2.ownerOfHandle + encString(h), REGISTRAR));
  const a = w[0] ? "0x" + w[0].toString(16).padStart(40, "0") : null;
  OWNERS.set(h, { a, at: Date.now() });
  return a;
}
async function verify(address) {
  if (!isHex(address, 40)) return [400, { error: "Invalid address" }];
  const h = await handleOfAddr(address);
  return [200, { address, agentId: h ? `${h}.ai` : null, verified: !!h }];
}

// ---------------------------------------------------------------- Border season (derived from chain data only, like the leaderboard)
// Each completed UTC day, a Top 100 finish on the Invites, Mints or Holders day board = +1 point (max 3 a day). Holders = balance at
// 23:59:59 UTC. Points are recomputed from the full log history, so they never go down; level = highest border whose min <= points.
export const BORDERS = [
  { name: "Bronze", cn: "青铜", min: 0, color: "#b87333" }, { name: "Silver", cn: "白银", min: 7, color: "#c9d1d9" },
  { name: "Gold", cn: "黄金", min: 14, color: "#f0b90b" }, { name: "Platinum", cn: "铂金", min: 21, color: "#7fe0d0" },
  { name: "Diamond", cn: "钻石", min: 28, color: "#6ec8ff" }, { name: "Master", cn: "大师", min: 35, color: "#b57bff" },
  { name: "King", cn: "王者", min: 42, color: "#ff5a5f" },
];
export const levelOf = (p) => { let l = 0; BORDERS.forEach((b, i) => { if (p >= b.min) l = i; }); return l; };
const SEASON = { points: null, levels: null, key: "", busy: null, days: 0 };
const SKIP = () => new Set([PAIR, MINT, TOKEN, "0x000000000000000000000000000000000000dead", "0x0000000000000000000000000000000000000000"]);
async function top100(entries, isAgent) { // [[addr, bigint]] -> addrs (Agent IDs only), sorted desc
  entries.sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0));
  const out = [];
  for (const [a, v] of entries) { if (out.length >= 100) break; if (v <= 0n) continue; const h = await isAgent(a); if (h) out.push(a); }
  return out;
}
export async function computeSeason({ invites, mints, transfers }, deployTs, nowMs, skip, isAgent = handleOf) {
  const todayStart = Math.floor(nowMs / 86400000) * 86400;
  const first = Math.floor(deployTs / 86400) * 86400;
  const pts = new Map(); const add = (a) => pts.set(a, (pts.get(a) || 0) + 1);
  const tr = [...transfers].sort((a, b) => a.ts - b.ts); let ti = 0; const bal = new Map();
  let days = 0;
  for (let d = first; d < todayStart; d += 86400) {
    const end = d + 86400; days++;
    for (const kind of [invites, mints]) {
      const m = new Map(); for (const r of kind) if (r.ts >= d && r.ts < end) m.set(r.who, (m.get(r.who) || 0n) + BigInt(r.n));
      for (const a of await top100([...m], isAgent)) add(a);
    }
    while (ti < tr.length && tr[ti].ts < end) { const x = tr[ti++]; bal.set(x.from, (bal.get(x.from) || 0n) - x.v); bal.set(x.to, (bal.get(x.to) || 0n) + x.v); }
    for (const a of await top100([...bal].filter(([a]) => !skip.has(a)), isAgent)) add(a);
  }
  return { pts, days };
}
async function season() {
  const key = `${LB.next}:${Math.floor(Date.now() / 86400000)}`;
  if (SEASON.points && SEASON.key === key) return SEASON;
  if (LB.syncing && SEASON.points) return SEASON;
  if (SEASON.busy) return SEASON.busy;
  SEASON.busy = (async () => {
    const deployTs = LB.mints.length ? Math.min(...LB.mints.map((m) => m.ts)) : Math.floor(Date.now() / 1000);
    const { pts, days } = await computeSeason(LB, deployTs, Date.now(), SKIP());
    SEASON.points = pts; SEASON.levels = new Map([...pts].map(([a, p]) => [a, levelOf(p)])); SEASON.key = key; SEASON.days = days;
    return SEASON;
  })().finally(() => { SEASON.busy = null; });
  return SEASON.busy;
}
async function pass(handle) {
  const h = String(handle || "").toLowerCase().replace(/\.ai$/, "");
  if (!/^[a-z0-9-]{1,63}$/.test(h)) return [400, { error: "Unknown Agent ID." }];
  const a = await ownerOfHandle(h);
  if (!a) return [400, { error: "Unknown Agent ID." }];
  await season().catch(() => null);
  const points = (SEASON.points && SEASON.points.get(a.toLowerCase())) || 0;
  const xb = XB.byAddr.get(a.toLowerCase());
  return [200, { handle: h, points, level: levelOf(points), x: xb ? xb.x : null }];
}

// ---------------------------------------------------------------- Bind X (off-chain: Agent ID wallet <-> X handle, proven by the wallet)
// Kept in memory; GitHub Actions exports it every 10 min to data/bindx.json on the `data` branch; restored from there on boot.
const COOLDOWN = 7 * 86400000;
const XB = { byAddr: new Map(), unbound: new Map(), restored: false };
const RESTORE_URL = process.env.BINDX_RESTORE_URL || "https://raw.githubusercontent.com/653366873iuhm-source/bnagent/data/data/bindx.json";
export function xbLoad(j) {
  if (!j || !Array.isArray(j.bindings)) throw new Error("bad bindx file");
  for (const b of j.bindings) {
    const a = String(b.address || "").toLowerCase(), x = String(b.x || "");
    if (!/^0x[0-9a-f]{40}$/.test(a) || !/^[A-Za-z0-9_]{1,15}$/.test(x)) continue;
    const cur = XB.byAddr.get(a); if (!cur || (cur.boundAt || 0) < (b.boundAt || 0)) XB.byAddr.set(a, { x, boundAt: Number(b.boundAt) || 0 });
  }
  for (const u of j.unbinds || []) {
    const a = String(u.address || "").toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(a)) continue;
    const at = Number(u.at) || 0; if ((XB.unbound.get(a) || 0) < at) XB.unbound.set(a, at);
    const cur = XB.byAddr.get(a); if (cur && cur.boundAt < at) XB.byAddr.delete(a);
  }
}
export function xbExport() {
  const bindings = [...XB.byAddr].map(([address, v]) => ({ address, x: v.x, boundAt: v.boundAt })).sort((p, q) => (p.address < q.address ? -1 : 1));
  const unbinds = [...XB.unbound].map(([address, at]) => ({ address, at })).sort((p, q) => (p.address < q.address ? -1 : 1));
  const updatedAt = Math.max(0, ...bindings.map((b) => b.boundAt), ...unbinds.map((u) => u.at));
  return { version: 1, note: "BNAGENT Bind X: Agent ID wallet address <-> X handle (public data).", updatedAt, bindings, unbinds };
}
async function xbRestore() {
  if (process.env.BINDX_NO_RESTORE === "1") { XB.restored = true; return; }
  try {
    const r = await fetch(RESTORE_URL + "?t=" + Date.now(), { signal: AbortSignal.timeout(15000) });
    if (r.status === 404) { XB.restored = true; console.log("bindx: no saved file yet"); return; }
    if (!r.ok) throw new Error("HTTP " + r.status);
    xbLoad(await r.json()); XB.restored = true; console.log(`bindx: restored ${XB.byAddr.size} bindings`);
  } catch (e) { console.log("bindx restore failed, retrying:", e.message); setTimeout(xbRestore, 60000); }
}
const xOf = (x) => { for (const [a, v] of XB.byAddr) if (v.x.toLowerCase() === x.toLowerCase()) return a; return null; };
export const proofMessage = (action, handle, address, time) => `bnagent.onrender.com: ${action} X for ${handle}.ai\nWallet: ${address.toLowerCase()}\nTime: ${time}`;
export function recoverPersonal(message, signature) {
  const sig = String(signature || "").replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{130}$/.test(sig)) return null;
  const msg = Buffer.from(message, "utf8");
  const digest = kec(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${msg.length}`, "utf8"), msg]));
  let v = parseInt(sig.slice(128, 130), 16); if (v >= 27) v -= 27;
  if (v !== 0 && v !== 1) return null;
  try {
    const S = secp256k1.Signature.fromCompact(sig.slice(0, 128)).addRecoveryBit(v);
    const P = S.recoverPublicKey(digest);
    const raw = P.toRawBytes ? P.toRawBytes(false) : P.toBytes(false);
    return "0x" + Buffer.from(kec(raw.slice(1))).subarray(12).toString("hex");
  } catch (e) { return null; }
}
async function proveWallet(proof, action, handle, address) {
  if (!proof || typeof proof !== "object") return false;
  if (proof.kind === "sig") {
    const t = Date.parse(String(proof.time || ""));
    if (!Number.isFinite(t) || Math.abs(Date.now() - t) > 10 * 60000) return false;
    const rec = recoverPersonal(proofMessage(action, handle, address, String(proof.time)), proof.signature);
    return !!rec && rec === address.toLowerCase();
  }
  if (proof.kind === "agent") { // the Agentic Wallet session from our QR login: ask Binance which wallet it controls
    if (!okId(proof.clientId) || typeof proof.sessionId !== "string") return false;
    const [code, out] = await proxy({ action: "wallets", clientId: proof.clientId, sessionId: proof.sessionId });
    if (code !== 200) return false;
    const found = [];
    const walk = (o, chain) => { if (!o || typeof o !== "object") return; if (Array.isArray(o)) return o.forEach((x) => walk(x, chain)); const c = String(o.binanceChainId ?? o.chainId ?? chain); const a = o.address ?? o.walletAddress; if (typeof a === "string" && isHex(a, 40) && (c === "56" || c === "0x38")) found.push(a.toLowerCase()); Object.values(o).forEach((x) => walk(x, c)); };
    walk(out && out.data, "");
    return found.includes(address.toLowerCase());
  }
  return false;
}
export function parsePostUrl(u) {
  const m = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d{5,25})/i.exec(String(u || "").trim());
  if (!m || m[1].toLowerCase() === "i") return null;
  return { user: m[1], id: m[2] };
}
async function readPost(p) { // -> {author, text} from X oEmbed, fxtwitter as a fallback
  if (process.env.XBIND_FAKE_POSTS) { const f = JSON.parse(process.env.XBIND_FAKE_POSTS)[p.id]; if (f) return f; }
  try {
    const r = await fetch(`https://publish.twitter.com/oembed?omit_script=1&url=${encodeURIComponent(`https://twitter.com/${p.user}/status/${p.id}`)}`, { redirect: "follow", signal: AbortSignal.timeout(10000) });
    if (r.ok) { const j = await r.json(); const author = (/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})/i.exec(j.author_url || "") || [])[1]; if (author) return { author, text: String(j.html || "").replace(/<[^>]+>/g, " ") }; }
    if (r.status === 404) return null;
  } catch (e) { /* fall back */ }
  try {
    const r = await fetch(`https://api.fxtwitter.com/${p.user}/status/${p.id}`, { signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    if (j && j.tweet && j.tweet.author) return { author: j.tweet.author.screen_name, text: String(j.tweet.text || "") };
    if (j && j.code === 404) return null;
  } catch (e) { /* none */ }
  throw new Error("post unreadable");
}
async function xbindGet(handle) {
  const h = String(handle || "").toLowerCase().replace(/\.ai$/, "");
  if (!/^[a-z0-9-]{1,63}$/.test(h)) return [400, { error: "Unknown Agent ID." }];
  const a = await ownerOfHandle(h);
  if (!a) return [400, { error: "Unknown Agent ID." }];
  const v = XB.byAddr.get(a.toLowerCase());
  const un = XB.unbound.get(a.toLowerCase()) || 0;
  return [200, { x: v ? v.x : null, boundAt: v ? v.boundAt : null, cooldownMs: v ? 0 : Math.max(0, un + COOLDOWN - Date.now()) }];
}
async function xbindPost(b, ip) {
  const action = b && b.action;
  if (action !== "bind" && action !== "unbind") return [400, { error: "Unknown action." }];
  const address = String((b && b.address) || "");
  if (!isHex(address, 40)) return [400, { error: "Connect your wallet first." }];
  if (limited("xb:" + ip, 20, 10 * 60000)) return [429, { error: "Too many requests. Try again in a few minutes." }];
  const handle = await handleOfAddr(address);
  if (!handle) return [403, { error: "This wallet holds no .ai Agent ID. Connect the Agentic Wallet that owns it." }];
  if (!(await proveWallet(b.proof, action, handle, address).catch(() => false))) return [401, { error: "Could not confirm this wallet. Reconnect it and try again." }];
  const a = address.toLowerCase();
  if (action === "unbind") {
    if (!XB.byAddr.has(a)) return [400, { error: "No X account is bound to this Agent ID." }];
    XB.byAddr.delete(a); XB.unbound.set(a, Date.now()); LB.cache = null;
    return [200, { x: null, boundAt: null, cooldownMs: COOLDOWN }];
  }
  if (XB.byAddr.has(a)) return [409, { error: "This Agent ID already has an X account. Unbind it first." }];
  const left = (XB.unbound.get(a) || 0) + COOLDOWN - Date.now();
  if (left > 0) return [429, { error: `You can bind again in ${Math.ceil(left / 86400000)} day(s).`, cooldownMs: left }];
  const p = parsePostUrl(b.tweetUrl);
  if (!p) return [400, { error: "Paste the full post link, like https://x.com/yourname/status/123…" }];
  let post;
  try { post = await readPost(p); } catch (e) { return [502, { error: "Could not read that post right now. Try again." }]; }
  if (!post) return [400, { error: "Post not found. Check the link." }];
  if (post.author.toLowerCase() !== p.user.toLowerCase()) return [400, { error: "Post not found. Check the link." }];
  if (!new RegExp(`(^|[^a-z0-9-])${handle.replace(/-/g, "\\-")}\\.ai([^a-z0-9-]|$)`, "i").test(post.text)) return [400, { error: `The post must include ${handle}.ai.` }];
  const other = xOf(post.author);
  if (other && other !== a) return [409, { error: `@${post.author} is already bound to another Agent ID.` }];
  XB.byAddr.set(a, { x: post.author, boundAt: Date.now() }); LB.cache = null;
  return [200, { x: post.author, boundAt: XB.byAddr.get(a).boundAt, cooldownMs: 0 }];
}
// export auth: shared key (Render env BINDX_EXPORT_KEY) or a GitHub Actions OIDC token for this repo (audience "bnagent-api")
const OIDC = { keys: null, at: 0 };
const REPO = process.env.GITHUB_REPO || "653366873iuhm-source/bnagent";
const b64u = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
async function oidcOk(tok) {
  const [h, p, sg] = String(tok || "").split("."); if (!sg) return false;
  const head = JSON.parse(b64u(h).toString()), claims = JSON.parse(b64u(p).toString());
  if (head.alg !== "RS256") return false;
  if (!OIDC.keys || Date.now() - OIDC.at > 3600000 || !OIDC.keys.find((k) => k.kid === head.kid)) {
    const r = await fetch("https://token.actions.githubusercontent.com/.well-known/jwks", { signal: AbortSignal.timeout(10000) });
    OIDC.keys = (await r.json()).keys; OIDC.at = Date.now();
  }
  const jwk = OIDC.keys.find((k) => k.kid === head.kid); if (!jwk) return false;
  const good = crypto.verify("RSA-SHA256", Buffer.from(h + "." + p), crypto.createPublicKey({ key: jwk, format: "jwk" }), b64u(sg));
  const now = Date.now() / 1000;
  return good && claims.iss === "https://token.actions.githubusercontent.com" && claims.aud === "bnagent-api" && claims.repository === REPO && claims.exp > now && (claims.nbf || 0) <= now + 60;
}
async function exportAuthorized(req) {
  const key = process.env.BINDX_EXPORT_KEY || "";
  const given = String(req.headers["x-export-key"] || "");
  if (key.length >= 32 && given.length === key.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key))) return true;
  const m = /^Bearer (.+)$/.exec(String(req.headers.authorization || ""));
  if (m) { try { return await oidcOk(m[1]); } catch (e) { return false; } }
  return false;
}
if (process.env.NO_LISTEN !== "1") setTimeout(xbRestore, 200);

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";
  const allowed = ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const cors = allowed ? { "Access-Control-Allow-Origin": origin, Vary: "Origin", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600" } : {};
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...cors }); res.end(req.method === "HEAD" ? undefined : JSON.stringify(obj)); };
  const [url, qs] = req.url.split("?");
  const q = new URLSearchParams(qs || "");
  const isGet = req.method === "GET" || req.method === "HEAD";
  const body = (max, fn) => { let raw = ""; req.on("data", (c) => { raw += c; if (raw.length > max) req.destroy(); }); req.on("end", async () => { let j; try { j = JSON.parse(raw || "{}"); } catch (e) { return send(400, { error: "Bad JSON" }); } try { const [code, obj] = await fn(j); send(code, obj); } catch (e) { send(502, { error: "Could not check the chain right now. Try again." }); } }); };
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  if (req.method === "OPTIONS" && ["/api/stats", "/api/verify", "/api/pass", "/api/x-bind", "/api/leaderboard", "/stats/leaderboard"].includes(url)) { res.writeHead(allowed ? 204 : 403, cors); return res.end(); }
  if (isGet && (url === "/" || url === "/health")) return send(200, { ok: true, service: "bnagent agent-wallet proxy + social signer + public API", allowTo: [...ALLOW_TO], social: SIGNER_ADDR, features: { xbind: true, season: true, bindxRestored: XB.restored }, taxSweep: TAXSWEEP });
  if (isGet && url === "/api/stats") { try { return send(200, await stats()); } catch (e) { return send(502, { error: "Could not read the chain right now." }); } }
  if (isGet && url === "/api/verify") { try { const [c, o] = await verify(q.get("address") || ""); return send(c, o); } catch (e) { return send(502, { error: "Could not read the chain right now." }); } }
  if (isGet && url === "/api/pass") { try { const [c, o] = await pass(q.get("handle")); return send(c, o); } catch (e) { return send(502, { error: "Could not read the chain right now." }); } }
  if (isGet && url === "/api/x-bind") { try { const [c, o] = await xbindGet(q.get("handle")); return send(c, o); } catch (e) { return send(502, { error: "Could not read the chain right now." }); } }
  if (url === "/api/x-bind" && req.method === "POST") { if (origin && !allowed) return send(403, { error: "origin not allowed" }); return body(6000, (j) => xbindPost(j, ip)); }
  if (isGet && url === "/api/x-bind/export") {
    if (!(await exportAuthorized(req))) return send(401, { error: "unauthorized" });
    if (!XB.restored) return send(503, { error: "still restoring" });
    return send(200, xbExport());
  }
  if ((req.method === "GET" || req.method === "HEAD") && (url === "/api/leaderboard" || url === "/stats/leaderboard")) {
    try { return send(200, await leaderboard()); } catch (e) { return send(502, { error: "Leaderboard unavailable right now." }); }
  }
  if (url === "/social/sign" || url === "/api/social") {
    // open to agents too (no Origin header); browsers only from the allowed origins
    if (req.method === "OPTIONS") { res.writeHead(allowed ? 204 : 403, cors); return res.end(); }
    if (req.method !== "POST") return send(405, { error: "POST only" });
    if (origin && !allowed) return send(403, { error: "origin not allowed" });
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 4000) req.destroy(); });
    req.on("end", async () => {
      try { const [code, obj] = await signSocial(JSON.parse(raw || "{}"), ip); send(code, obj); }
      catch (e) { send(502, { error: "Could not check the chain right now. Try again." }); }
    });
    return;
  }
  if (url !== "/api/agent-wallet") return send(404, { error: "not found" });
  if (req.method === "OPTIONS") { res.writeHead(allowed ? 204 : 403, cors); return res.end(); }
  if (req.method !== "POST") return send(405, { error: "POST only" });
  if (!allowed) return send(403, { error: "origin not allowed" });
  let raw = "";
  req.on("data", (c) => { raw += c; if (raw.length > 20000) req.destroy(); });
  req.on("end", async () => {
    try { const [code, obj] = await proxy(JSON.parse(raw || "{}")); send(code, obj); }
    catch (e) { send(502, { error: "Agent Wallet request failed" }); }
  });
});
if (process.env.NO_LISTEN !== "1") server.listen(PORT, () => console.log(`agent-wallet proxy on :${PORT}; origins ${ORIGINS.join(" ")}`));
