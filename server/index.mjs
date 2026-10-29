// BNAGENT Agentic Wallet QR proxy (same approach as jager.live's /api/agent-wallet route).
// Node >= 18, no dependencies. Run: node server/index.mjs   (PORT, ALLOW_ORIGINS, ALLOW_TO env vars)
//
// The browser cannot talk to Binance's Agentic Wallet API directly: the session is an `agentSessionId` cookie that a
// page on another origin can neither read nor send. This proxy forwards a fixed set of actions and hands the session id
// back to the page (kept in sessionStorage there). It stores nothing, holds no keys and cannot move funds: every
// transaction still needs the user's confirmation in the Binance App.
//
// Actions: login, confirm, query, wallets, preview, execute, logout. `preview` only accepts `to` addresses in ALLOW_TO
// (the BNAGENT mint contract + USDT), so this endpoint cannot be used to request approvals for other contracts.
import http from "node:http";
import crypto from "node:crypto";

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

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";
  const allowed = ORIGINS.includes(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const cors = allowed ? { "Access-Control-Allow-Origin": origin, Vary: "Origin", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600" } : {};
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...cors }); res.end(JSON.stringify(obj)); };
  const url = req.url.split("?")[0];
  if (req.method === "GET" && (url === "/" || url === "/health")) return send(200, { ok: true, service: "bnagent agent-wallet proxy", allowTo: [...ALLOW_TO] });
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
