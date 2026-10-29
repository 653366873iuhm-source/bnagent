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

async function handle(payload) {
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
const MINT = (process.env.MINT || "0xBd57F860B043924f4F37d35AC16c3aab37068e9a").toLowerCase();
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
async function ethCall(data) {
  let last;
  for (const url of RPCS) {
    try {
      const r = await fetch(url.trim(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: MINT, data }, "latest"] }), signal: AbortSignal.timeout(8000) });
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
const TOKEN = (process.env.TOKEN || "0xFfA0441EC4ce08F1afE3fdA5093d69ab30e5b97c").toLowerCase();
const REGISTRAR = "0x60b9262456de011f7d15a54cdd8c48baaa8b022f";
const PAIR = (process.env.PAIR || "0xb8E1f4a2B792BAc02599e183e1B8d6f2E54286Dc").toLowerCase();
const DEPLOY_BLOCK = Number(process.env.DEPLOY_BLOCK || 130514568);
const LOG_RPCS = (process.env.LOG_RPC || "https://rpc-bsc.48.club,https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3,https://bsc.rpc.blxrbdn.com").split(",").map((s) => s.trim());
const T_MINTED = hex(kec("Minted(address,uint256,uint256,uint256,uint256)"));
const T_QUOTA = hex(kec("QuotaGranted(address,uint256,uint256,bytes32)"));
const T_TRANSFER = hex(kec("Transfer(address,address,uint256)"));
const R_INVITE = hex(keccak_256(enc.encode("INVITE")));
const SEL_HANDLE = sel("handleOf(address)");
const LB = { next: DEPLOY_BLOCK, head: 0, syncing: true, invites: [], mints: [], bal: new Map(), handles: new Map(), cache: null, cacheAt: 0, busy: false };
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
    out.push({ rank: out.length + 1, label: `${h}.ai`, value: e.v.toString() });
  }
  return out;
}
async function leaderboard() {
  if (LB.cache && Date.now() - LB.cacheAt < 60000) return LB.cache;
  const now = new Date();
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const weekStart = dayStart - ((now.getUTCDay() + 6) % 7) * 86400000;
  const skip = new Set([PAIR, MINT, TOKEN, "0x000000000000000000000000000000000000dead", "0x0000000000000000000000000000000000000000"]);
  const holders = await rank([...LB.bal].filter(([a, v]) => v > 0n && !skip.has(a)).map(([who, v]) => ({ who, v })));
  const out = {
    day: utcDay(dayStart), week: utcDay(weekStart), syncing: LB.syncing, block: LB.next - 1,
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
setTimeout(scanLoop, 500);

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";
  const allowed = ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const cors = allowed ? { "Access-Control-Allow-Origin": origin, Vary: "Origin", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600" } : {};
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...cors }); res.end(JSON.stringify(obj)); };
  const url = req.url.split("?")[0];
  if ((req.method === "GET" || req.method === "HEAD") && (url === "/" || url === "/health")) return send(200, { ok: true, service: "bnagent agent-wallet proxy + social signer", allowTo: [...ALLOW_TO], social: SIGNER_ADDR });
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
    try { const [code, obj] = await handle(JSON.parse(raw || "{}")); send(code, obj); }
    catch (e) { send(502, { error: "Agent Wallet request failed" }); }
  });
});
server.listen(PORT, () => console.log(`agent-wallet proxy on :${PORT}; origins ${ORIGINS.join(" ")}`));
