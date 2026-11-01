// Tax sweeper: the mint contract's swapTax() sells at most 0.1% of the pool per call and at most once per block,
// so a keeper calls it every TAX_SWEEP_SEC seconds until no tax tokens are parked; proceeds go to the treasury.
// Dependency-free: signs legacy EIP-155 transactions with the bundled noble secp256k1 / keccak.
import { secp256k1, keccak_256 } from "./noble.mjs";

const env = process.env;
const RPCS = (env.SWEEP_RPC || "https://bsc-rpc.publicnode.com,https://1rpc.io/bnb,https://bsc.drpc.org,https://bsc-dataseed.bnbchain.org").split(",").map((s) => s.trim()).filter(Boolean);
const hexb = (b) => Buffer.from(b).toString("hex");
const kec = (b) => keccak_256(b);
const sel = (sig) => "0x" + hexb(kec(Buffer.from(sig))).slice(0, 8);
const SEL = { swapTax: sel("swapTax()"), balanceOf: sel("balanceOf(address)"), getReserves: sel("getReserves()"), token0: sel("token0()") };

let rr = 0;
async function rpc(method, params) {
  let last;
  for (let i = 0; i < RPCS.length; i++) {
    const url = RPCS[(rr + i) % RPCS.length];
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      if (j.error) { const e = new Error(j.error.message || "rpc error"); e.rpc = true; throw e; }
      if (j.result !== undefined) { rr = (rr + i) % RPCS.length; return j.result; }
    } catch (e) { last = e; if (e.rpc && /revert|execution|nonce|underpriced|known|insufficient/i.test(e.message)) throw e; }
  }
  throw last || new Error("rpc");
}

function rlpBytes(b) {
  if (b.length === 1 && b[0] < 0x80) return b;
  return Buffer.concat([rlpLen(b.length, 0x80), b]);
}
function rlpLen(n, off) {
  if (n < 56) return Buffer.from([off + n]);
  let h = n.toString(16); if (h.length % 2) h = "0" + h;
  const lb = Buffer.from(h, "hex");
  return Buffer.concat([Buffer.from([off + 55 + lb.length]), lb]);
}
function rlpList(items) { const p = Buffer.concat(items.map(rlpBytes)); return Buffer.concat([rlpLen(p.length, 0xc0), p]); }
function big(n) { n = BigInt(n); if (n === 0n) return Buffer.alloc(0); let h = n.toString(16); if (h.length % 2) h = "0" + h; return Buffer.from(h, "hex"); }
const addrBuf = (a) => Buffer.from(a.replace(/^0x/, ""), "hex");

export function signLegacy(priv, nonce, gp, gas, to, data) {
  const fields = [big(nonce), big(gp), big(gas), addrBuf(to), big(0), Buffer.from(data.slice(2), "hex")];
  const digest = kec(rlpList([...fields, big(56), Buffer.alloc(0), Buffer.alloc(0)]));
  const sig = secp256k1.sign(digest, priv, { lowS: true });
  return "0x" + hexb(rlpList([...fields, big(BigInt(sig.recovery) + 56n * 2n + 35n), big(sig.r), big(sig.s)]));
}

export function startSweeper({ mint, token, pair, name }) {
  const state = { enabled: false, note: "off", at: 0, swaps: 0, keeper: null, keeperBnb: null, parked: "0" };
  const k = (env.KEEPER_KEY || "").trim().replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(k)) { state.note = "no KEEPER_KEY"; return state; }
  const priv = Buffer.from(k, "hex");
  const from = "0x" + hexb(kec(secp256k1.getPublicKey(priv, false).slice(1))).slice(24);
  Object.assign(state, { enabled: true, keeper: from, note: "starting" });
  const MIN_QUOTE = BigInt(Math.round(Number(env.TAX_SWEEP_MIN || "0.2") * 1e6)) * 10n ** 12n; // quote token has 18 decimals (USDT/WBNB on BSC)
  const minGas = BigInt(Math.round(Number(env.SWEEP_MIN_GWEI || "0.1") * 1e9));
  const pad = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  let busy = false, busyAt = 0;
  async function once() {
    if (busy && Date.now() - busyAt < 90000) return;
    busy = true; busyAt = Date.now();
    try {
      const parked = BigInt(await rpc("eth_call", [{ to: token, data: SEL.balanceOf + pad(mint) }, "latest"]));
      state.parked = parked.toString();
      if (parked === 0n) { state.note = "nothing parked"; state.at = Date.now(); return; }
      const res = await rpc("eth_call", [{ to: pair, data: SEL.getReserves }, "latest"]);
      const t0 = "0x" + (await rpc("eth_call", [{ to: pair, data: SEL.token0 }, "latest"])).slice(26);
      const r0 = BigInt("0x" + res.slice(2, 66)), r1 = BigInt("0x" + res.slice(66, 130));
      const [rt, rq] = t0.toLowerCase() === token.toLowerCase() ? [r0, r1] : [r1, r0];
      const value = rt > 0n ? (parked * rq) / rt : 0n;
      state.parkedQuote = (Number(value / 10n ** 12n) / 1e6).toFixed(4);
      if (value < MIN_QUOTE) { state.note = "below min " + (env.TAX_SWEEP_MIN || "0.2"); state.at = Date.now(); return; }
      const bal = BigInt(await rpc("eth_getBalance", [from, "latest"]));
      state.keeperBnb = (Number(bal / 10n ** 12n) / 1e6).toFixed(6);
      if (bal < 50_000_000_000_000n) { state.note = "keeper gas low"; state.at = Date.now(); return; }
      await rpc("eth_call", [{ from, to: mint, data: SEL.swapTax }, "latest"]); // reverts (same block / not open) -> skip
      const gasEst = BigInt(await rpc("eth_estimateGas", [{ from, to: mint, data: SEL.swapTax }]));
      let gp = BigInt(await rpc("eth_gasPrice", [])); if (gp < minGas) gp = minGas;
      const nonce = BigInt(await rpc("eth_getTransactionCount", [from, "pending"]));
      const gas = gasEst * 13n / 10n + 20000n;
      const raw = signLegacy(priv, nonce, gp, gas, mint, SEL.swapTax);
      const hash = await rpc("eth_sendRawTransaction", [raw]);
      for (let i = 0; i < 15; i++) { await new Promise((r) => setTimeout(r, 2000)); const rc = await rpc("eth_getTransactionReceipt", [hash]).catch(() => null); if (rc) break; }
      state.swaps++; state.note = "swapped " + hash; state.at = Date.now();
    } catch (e) {
      state.note = "skip: " + String(e.message || e).slice(0, 120); state.at = Date.now();
    } finally { busy = false; }
  }
  setInterval(once, Number(env.TAX_SWEEP_SEC || 10) * 1000);
  setTimeout(once, 5000);
  console.log(`[${name}] tax sweeper on, keeper ${from}`);
  return state;
}
