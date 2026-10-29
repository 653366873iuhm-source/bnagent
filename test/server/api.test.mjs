// Server tests (no dependencies): node test/server/api.test.mjs
// 1) pure: season scoring, borders, Bind X export/restore, personal_sign recovery, post-link parsing (module imported with NO_LISTEN=1)
// 2) HTTP: spawns server/index.mjs on a free port with test-only env (TEST_HANDLES, XBIND_FAKE_POSTS, BINDX_EXPORT_KEY, BINDX_NO_RESTORE)
//    and checks /api/stats, /api/verify (live BSC reads), /api/pass, /api/x-bind GET/POST bind/unbind/cooldown, export auth.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, "../../server/index.mjs");
process.env.NO_LISTEN = "1";
const M = await import(SERVER);
const { secp256k1, keccak_256 } = await import(path.join(here, "../../server/noble.mjs"));
const results = []; const ok = (n, c, x = "") => results.push([c ? "PASS" : "FAIL", n, x]);

// ---- pure
{
  const D = 86400, d0 = Date.UTC(2026, 9, 29) / 1000; // 2026-10-29 00:00 UTC
  const A = "0x" + "a".repeat(40), B = "0x" + "b".repeat(40), C = "0x" + "c".repeat(40), Z = "0x" + "0".repeat(40);
  const data = {
    invites: [{ who: A, n: 1, ts: d0 + 100 }, { who: A, n: 1, ts: d0 + D + 5 }],
    mints: [{ who: A, n: 10, ts: d0 + 50 }, { who: B, n: 3, ts: d0 + 60 }, { who: C, n: 5, ts: d0 + 70 }, { who: B, n: 1, ts: d0 + 2 * D + 10 }],
    transfers: [{ from: Z, to: A, v: 10n, ts: d0 + 50 }, { from: Z, to: B, v: 3n, ts: d0 + 60 }, { from: B, to: C, v: 3n, ts: d0 + D + 1 }],
  };
  const isAgent = async (a) => (a === C ? "" : "h"); // C holds no Agent ID
  const now = (d0 + 2 * D + 3600) * 1000; // day 3, 01:00 UTC -> days 1 and 2 are complete
  const { pts, days } = await M.computeSeason(data, d0 + 50, now, new Set([Z]), isAgent);
  // day1: invites A, mints A,B (C not agent), holders A,B ; day2: invites A, mints none, holders A (B gave all to C)
  ok("season: 2 completed UTC days counted, today excluded", days === 2, String(days));
  ok("season: +1 per day board Top 100 (A = 3 + 2 = 5, B = 2, non-Agent-ID C = 0)", pts.get(A) === 5 && pts.get(B) === 2 && !pts.get(C), JSON.stringify([...pts]));
  ok("season: borders Bronze 0 / Silver 7 / Gold 14 … King 42, 7 levels", M.BORDERS.length === 7 && M.levelOf(0) === 0 && M.levelOf(6) === 0 && M.levelOf(7) === 1 && M.levelOf(20) === 2 && M.levelOf(42) === 6 && M.levelOf(99) === 6);
  const many = { invites: [], mints: Array.from({ length: 150 }, (_, i) => ({ who: "0x" + i.toString(16).padStart(40, "0"), n: 150 - i, ts: d0 + 10 })), transfers: [] };
  const r2 = await M.computeSeason(many, d0, (d0 + D + 10) * 1000, new Set(), async () => "h");
  ok("season: only the Top 100 of a day board score", [...r2.pts.values()].filter((v) => v > 0).length === 100 && !r2.pts.get("0x" + (120).toString(16).padStart(40, "0")));
}
{
  M.xbLoad({ bindings: [{ address: "0x" + "1".repeat(40), x: "alice_x", boundAt: 1000 }, { address: "bad", x: "zz", boundAt: 1 }, { address: "0x" + "2".repeat(40), x: "has space", boundAt: 1 }], unbinds: [{ address: "0x" + "3".repeat(40), at: 500 }] });
  const ex = M.xbExport();
  ok("bindx: restore keeps only valid rows; export = address + X handle (+ times), sorted, stable updatedAt", ex.bindings.length === 1 && ex.bindings[0].x === "alice_x" && ex.unbinds.length === 1 && ex.updatedAt === 1000 && Object.keys(ex.bindings[0]).join() === "address,x,boundAt", JSON.stringify(ex));
  M.xbLoad({ bindings: [], unbinds: [{ address: "0x" + "1".repeat(40), at: 2000 }] });
  ok("bindx: a later unbind in the file removes an older binding", M.xbExport().bindings.length === 0);
  let threw = false; try { M.xbLoad({ nope: 1 }); } catch (e) { threw = true; }
  ok("bindx: malformed file rejected", threw);
}
{
  const priv = secp256k1.utils.randomSecretKey ? secp256k1.utils.randomSecretKey() : secp256k1.utils.randomPrivateKey();
  const addr = "0x" + Buffer.from(keccak_256(secp256k1.getPublicKey(priv, false).slice(1))).subarray(12).toString("hex");
  const msg = M.proofMessage("bind", "tester", addr, "2026-10-30T00:00:00.000Z");
  const sig = personalSign(priv, msg);
  ok("proof: personal_sign recovers the signer; message names site, action, Agent ID, wallet, time", M.recoverPersonal(msg, sig) === addr && msg === `bnagent.onrender.com: bind X for tester.ai\nWallet: ${addr}\nTime: 2026-10-30T00:00:00.000Z`);
  ok("proof: tampered message does not recover the signer", M.recoverPersonal(msg.replace("bind", "unbind"), sig) !== addr);
  ok("post links: x.com / twitter.com / mobile parsed; /i/ and junk rejected", M.parsePostUrl("https://x.com/Bob_1/status/1234567890").user === "Bob_1" && M.parsePostUrl("https://mobile.twitter.com/a/status/12345").id === "12345" && !M.parsePostUrl("https://x.com/i/status/12345") && !M.parsePostUrl("hello"));
  ok("units: 18-decimal formatting", M.units(1357111130196713n) === "0.001357111130196713" && M.units(10n ** 18n * 252n / 100n) === "2.52" && M.units(0n) === "0");
}
function personalSign(priv, message) {
  const m = Buffer.from(message, "utf8");
  const digest = keccak_256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${m.length}`), m]));
  const s = secp256k1.sign(digest, priv, { lowS: true });
  return "0x" + s.r.toString(16).padStart(64, "0") + s.s.toString(16).padStart(64, "0") + (27 + s.recovery).toString(16);
}

// ---- HTTP
const priv = secp256k1.utils.randomSecretKey ? secp256k1.utils.randomSecretKey() : secp256k1.utils.randomPrivateKey();
const ADDR = "0x" + Buffer.from(keccak_256(secp256k1.getPublicKey(priv, false).slice(1))).subarray(12).toString("hex");
const priv2 = secp256k1.utils.randomSecretKey ? secp256k1.utils.randomSecretKey() : secp256k1.utils.randomPrivateKey();
const ADDR2 = "0x" + Buffer.from(keccak_256(secp256k1.getPublicKey(priv2, false).slice(1))).subarray(12).toString("hex");
const PORT = 10900 + Math.floor(Math.random() * 90), KEY = "k".repeat(40), B = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, NO_LISTEN: "0", PORT: String(PORT), BINDX_NO_RESTORE: "1", BINDX_EXPORT_KEY: KEY, TEST_HANDLES: JSON.stringify({ [ADDR]: "tester", [ADDR2]: "other" }),
  XBIND_FAKE_POSTS: JSON.stringify({ "1111111111": { author: "Tester_X", text: "My BNAGENT Mint Pass Agent: tester.ai" }, "2222222222": { author: "Tester_X", text: "no handle here" }, "3333333333": { author: "Tester_X", text: "other.ai minting" } }) };
const child = spawn(process.execPath, [SERVER], { env, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; child.stdout.on("data", (d) => (log += d)); child.stderr.on("data", (d) => (log += d));
for (let i = 0; i < 50 && !log.includes("proxy on"); i++) await new Promise((r) => setTimeout(r, 100));
const get = async (p, h = {}) => { const r = await fetch(B + p, { headers: h }); return [r.status, await r.json().catch(() => null), r]; };
const post = async (p, j, h = {}) => { const r = await fetch(B + p, { method: "POST", headers: { "content-type": "application/json", ...h }, body: JSON.stringify(j) }); return [r.status, await r.json().catch(() => null)]; };
const proof = (action, handle = "tester", pk = priv, a = ADDR) => { const time = new Date().toISOString(); return { kind: "sig", time, signature: personalSign(pk, M.proofMessage(action, handle, a, time)) }; };
try {
  let [c, j] = await get("/api/stats");
  ok("GET /api/stats: Jager shape (token, mintContract, pair, usdt, chainId 56, totalMinted, price, tokensPerShare, mintingOpen, paused, poolOpensAt, maxPerTransaction, bnb[1..10])",
    c === 200 && j.token.symbol === "BNAGENT" && j.token.address === "0xC7F95A3bff008053A4e2f235bAf2f6d784e6C5FB" && j.mintContract === "0xD6aFC30810B001CfA5306A2C54b5E6559DfC9Cf0" && j.chainId === 56 && j.totalMinted >= 1100 && typeof j.priceUsdtPerShare === "number" && j.tokensPerShare > 0 && typeof j.mintingOpen === "boolean" && j.poolOpensAt === 10000 && j.maxPerTransaction === 10 && j.bnb.length === 10 && j.bnb[0].shares === 1 && /^\d/.test(j.bnb[0].quoteBnb) && Number(j.bnb[0].sendBnb) > Number(j.bnb[0].quoteBnb),
    JSON.stringify(j).slice(0, 300));
  ok("GET /api/stats: sendBnb = quote × 1.02, costUsdt follows the price table", j && Math.abs(Number(j.bnb[1].sendBnb) / Number(j.bnb[1].quoteBnb) - 1.02) < 1e-9 && (j.totalMinted >= 10000 || j.bnb[2].costUsdt === "3"));
  [c, j] = await get("/api/verify?address=0x866396d4aee9467b67194431bdbDdE8E8044d8AE");
  ok("GET /api/verify: Agent ID wallet -> {address, agentId: iuhm.ai, verified: true}", c === 200 && j.agentId === "iuhm.ai" && j.verified === true && j.address === "0x866396d4aee9467b67194431bdbDdE8E8044d8AE", JSON.stringify(j));
  [c, j] = await get("/api/verify?address=0x0000000000000000000000000000000000000001");
  ok("GET /api/verify: no Agent ID -> agentId null, verified false", c === 200 && j.agentId === null && j.verified === false);
  [c, j] = await get("/api/verify?address=bad");
  ok("GET /api/verify: bad address -> 400 Invalid address", c === 400 && j.error === "Invalid address");
  let r; [c, j, r] = await get("/api/verify?address=bad", { origin: "https://bnagent.onrender.com" });
  ok("CORS: allowed origin echoed on the public GET routes", r.headers.get("access-control-allow-origin") === "https://bnagent.onrender.com");
  [c, j] = await get("/api/pass?handle=tester");
  ok("GET /api/pass: {handle, points, level, x}", c === 200 && j.handle === "tester" && j.points === 0 && j.level === 0 && j.x === null, JSON.stringify(j));
  [c, j] = await get("/api/pass");
  ok("GET /api/pass without a handle -> 400 Unknown Agent ID.", c === 400 && j.error === "Unknown Agent ID.");
  [c, j] = await get("/api/x-bind?handle=tester");
  ok("GET /api/x-bind: unbound -> {x:null, boundAt:null, cooldownMs:0}", c === 200 && j.x === null && j.boundAt === null && j.cooldownMs === 0);
  [c, j] = await post("/api/x-bind", {});
  ok("POST /api/x-bind: unknown action", c === 400 && j.error === "Unknown action.");
  [c, j] = await post("/api/x-bind", { action: "bind" });
  ok("POST /api/x-bind: no wallet -> Connect your wallet first.", c === 400 && j.error === "Connect your wallet first.");
  [c, j] = await post("/api/x-bind", { action: "bind", address: ADDR, tweetUrl: "https://x.com/Tester_X/status/1111111111", proof: { kind: "sig", time: new Date().toISOString(), signature: "0x" + "11".repeat(65) } });
  ok("POST /api/x-bind: bad signature -> Could not confirm this wallet.", c === 401 && /Could not confirm this wallet/.test(j.error), JSON.stringify(j));
  [c, j] = await post("/api/x-bind", { action: "bind", address: ADDR, tweetUrl: "https://x.com/Tester_X/status/1111111111", proof: proof("bind", "tester", priv2, ADDR) });
  ok("POST /api/x-bind: signature from another wallet rejected", c === 401);
  [c, j] = await post("/api/x-bind", { action: "bind", address: ADDR, tweetUrl: "https://x.com/Tester_X/status/2222222222", proof: proof("bind") });
  ok("POST /api/x-bind: post must include <handle>.ai", c === 400 && j.error === "The post must include tester.ai.", JSON.stringify(j));
  [c, j] = await post("/api/x-bind", { action: "bind", address: ADDR, tweetUrl: "https://x.com/Someone/status/1111111111", proof: proof("bind") });
  ok("POST /api/x-bind: link author must match the post author", c === 400);
  [c, j] = await post("/api/x-bind", { action: "bind", address: ADDR, tweetUrl: "https://x.com/Tester_X/status/1111111111", proof: proof("bind") });
  ok("POST /api/x-bind: bind OK -> x from the post author", c === 200 && j.x === "Tester_X", JSON.stringify(j));
  [c, j] = await get("/api/x-bind?handle=tester");
  ok("GET /api/x-bind after bind: x + boundAt", j.x === "Tester_X" && j.boundAt > 0);
  [c, j] = await get("/api/pass?handle=tester.ai");
  ok("GET /api/pass shows the bound X", j.x === "Tester_X");
  [c, j] = await post("/api/x-bind", { action: "bind", address: ADDR2, tweetUrl: "https://x.com/Tester_X/status/3333333333", proof: proof("bind", "other", priv2, ADDR2) });
  ok("POST /api/x-bind: one X per Agent ID (X already bound elsewhere -> 409)", c === 409, JSON.stringify(j));
  [c, j] = await get("/api/x-bind/export");
  ok("export: no key -> 401", c === 401);
  [c, j] = await get("/api/x-bind/export", { "x-export-key": "k".repeat(39) + "x" });
  ok("export: wrong key -> 401", c === 401);
  [c, j] = await get("/api/x-bind/export", { authorization: "Bearer a.b.c" });
  ok("export: forged OIDC token -> 401", c === 401);
  [c, j] = await get("/api/x-bind/export", { "x-export-key": KEY });
  ok("export: key -> bindings (address + X handle), public-safe", c === 200 && j.bindings.length === 1 && j.bindings[0].address === ADDR && j.bindings[0].x === "Tester_X" && !JSON.stringify(j).includes("signature"), JSON.stringify(j));
  [c, j] = await post("/api/x-bind", { action: "unbind", address: ADDR, proof: proof("unbind") });
  ok("POST /api/x-bind: unbind -> 7-day cooldown", c === 200 && j.x === null && j.cooldownMs === 7 * 86400000);
  [c, j] = await get("/api/x-bind?handle=tester");
  ok("GET /api/x-bind after unbind: cooldownMs > 6 days", j.x === null && j.cooldownMs > 6 * 86400000);
  [c, j] = await post("/api/x-bind", { action: "bind", address: ADDR, tweetUrl: "https://x.com/Tester_X/status/1111111111", proof: proof("bind") });
  ok("POST /api/x-bind: re-bind inside the cooldown refused", c === 429 && /bind again in 7 day/.test(j.error), JSON.stringify(j));
  [c, j] = await get("/api/x-bind/export", { "x-export-key": KEY });
  ok("export after unbind: no bindings, one unbind entry", j.bindings.length === 0 && j.unbinds.length === 1 && j.unbinds[0].address === ADDR);
  [c, j] = await get("/health");
  ok("health: features xbind + season", j.features && j.features.xbind && j.features.season && j.features.bindxRestored);
} catch (e) { ok("http tests crashed", false, e.stack); }
child.kill();
for (const r of results) console.log(r[0], "-", r[1], r[0] === "FAIL" ? "  >> " + r[2] : "");
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
