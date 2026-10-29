(() => {
  "use strict";
  const C = window.BNAGENT_CONFIG;
  const $ = (id) => document.getElementById(id);
  const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || "");
  const deployed = isAddr(C.mint);
  const BSC = "0x38";
  const BSC_PARAMS = {
    chainId: BSC,
    chainName: "BNB Smart Chain",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: ["https://bsc-dataseed.bnbchain.org"],
    blockExplorerUrls: ["https://bscscan.com"],
  };
  const ZERO = "0x0000000000000000000000000000000000000000";
  const AGENTIC = "com.binance.agentic-wallet";
  let awReady = false; // set once the Agentic Wallet code below is initialised
  const qsLang = new URLSearchParams(location.search).get("lang");
  let lang = qsLang === "zh" || qsLang === "en" ? qsLang : localStorage.getItem("bnagent-lang") || "en";
  let pay = "usdt", state = null, referrer = null;
  // wallet session
  const W = { provider: null, name: "", icon: "", rdns: "", account: null, chainId: null, handle: null, agentOk: false, status: null, bnb: null, usdt: null, busy: false };
  const T = (en, zh) => (lang === "zh" ? zh : en);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function setLang(l) {
    lang = l; localStorage.setItem("bnagent-lang", l);
    document.body.className = "lang-" + l;
    document.documentElement.lang = l === "zh" ? "zh-CN" : "en";
    $("langBtn").textContent = l === "zh" ? "English" : "中文";
    render();
    if ($("walletModal").open) renderModal();
    if (typeof renderLb === "function" && LBV) renderLb();
    if ($("inviteModal").open) renderInvite();
    if ($("passModal").open) renderPassModal();
  }
  $("langBtn").onclick = () => setLang(lang === "en" ? "zh" : "en");

  // ---------------------------------------------------------------- price table (mirrors priceCents in the contract)
  const priceCents = (n) => (n <= 10000 ? 100 : n <= 20000 ? 110 + 10 * Math.floor((n - 10001) / 1000) : n <= 100000 ? 210 + 2 * Math.floor((n - 20001) / 1000) : n <= 1000000 ? 370 + 2 * Math.floor((n - 100001) / 10000) : Math.floor((5500 + 15 * Math.floor((n - 1000001) / 20000) + 5) / 10));
  // tiers like jager.live's "Tiered pricing", continued to 100,000,000 shares (5,131 tiers, 1U -> 79.74U; 8.07U at 4,440,000): tier 1 = shares 1-10,000 (1,101-10,000 sold), then
  // 10 x 1,000 (+0.10U), 80 x 1,000 (+0.02U), 90 x 10,000 (+0.02U), 4,950 x 20,000 (+0.015U, rounded to the cent)
  const TIERS = (() => {
    const t = [[1, 10000]];
    for (let k = 0; k < 90; k++) t.push([10001 + k * 1000, 11000 + k * 1000]);
    for (let k = 0; k < 90; k++) t.push([100001 + k * 10000, 110000 + k * 10000]);
    for (let k = 0; k < 4950; k++) t.push([1000001 + k * 20000, 1020000 + k * 20000]);
    return t;
  })();
  const tierOf = (n) => (n <= 10000 ? 1 : n <= 100000 ? 2 + Math.floor((n - 10001) / 1000) : n <= 1000000 ? 92 + Math.floor((n - 100001) / 10000) : 182 + Math.floor((n - 1000001) / 20000));
  const tierEnd = (n) => TIERS[tierOf(n) - 1][1];
  const uFmt = (cents) => String(+(cents / 100).toFixed(2));

  // ---------------------------------------------------------------- minimal JSON-RPC / ABI (public BSC RPC for reads)
  const pad = (hex) => hex.replace(/^0x/, "").padStart(64, "0");
  const encU = (n) => pad(BigInt(n).toString(16));
  const encA = (a) => pad(a.toLowerCase());
  function encString(s) {
    const b = new TextEncoder().encode(s);
    let hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    hex = hex.padEnd(Math.ceil(hex.length / 64) * 64 || 64, "0");
    return encU(32) + encU(b.length) + hex;
  }
  const words = (hex) => (String(hex || "").replace(/^0x/, "").match(/.{64}/g) || []).map((w) => BigInt("0x" + w));
  function decString(hex) {
    const w = words(hex);
    if (w.length < 2 || w[1] === 0n) return "";
    const raw = hex.replace(/^0x/, "").slice(128, 128 + Number(w[1]) * 2);
    return new TextDecoder().decode(new Uint8Array(raw.match(/.{2}/g).map((x) => parseInt(x, 16))));
  }
  async function rpc(method, params) {
    let last;
    for (const url of C.rpc) {
      try {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        const j = await r.json();
        if (j.error) { const e = new Error(j.error.message || "rpc error"); e.data = j.error.data; throw e; }
        if (j.result !== undefined) return j.result;
      } catch (e) { last = e; if (e.data) throw e; }
    }
    throw last || new Error("rpc");
  }
  const call = (to, data, from) => rpc("eth_call", [from ? { from, to, data } : { to, data }, "latest"]);
  const fmt = (wei, dp = 2) => (Number(wei) / 1e18).toLocaleString(undefined, { maximumFractionDigits: dp });
  const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);

  // selectors (BnagentMint keeps the Jager/$JAGENT ABI)
  const SEL = {
    overview: "0x3a2056f1", valve: "0x3a81955f", walletStatus: "0x4d6d0af8", costOf: "0xfd326592", bnbQuote: "0x68bce8cd",
    mint: "0x836a1040", mintWithBnb: "0xe38fd349", allowance: "0xdd62ed3e", approve: "0x095ea7b3",
    balanceOf: "0x70a08231", handleOf: "0xc50a1514", ownerOfHandle: "0x1da94fb4",
    socialDone: "0x6edd0f2e", claimSocial: "0x2e3c4860",
  };
  const ERRORS = {
    "0x9e87fac8": ["Minting is paused.", "铸造已暂停。"],
    "0x7eb01706": ["Choose 1 to 10 shares.", "请选择 1–10 份。"],
    "0x52df9fe5": ["Not enough shares left.", "剩余份数不足。"],
    "0x2611416a": ["This wallet holds no .ai Agent ID. Connect the Agentic Wallet that owns it.", "该钱包没有 .ai Agent ID，请连接持有它的 Agentic Wallet。"],
    "0xb7920101": ["This Agent ID has no quota left. Invite or do tasks to earn more.", "该 Agent ID 额度已用完，可通过邀请或社交任务增加。"],
    "0xb6ba0f43": ["The price moved above your limit. Nothing was charged; try again.", "价格超过了你的上限，未扣款，请重试。"],
    "0xbdbbb533": ["Not enough BNB was sent. The price moved; try again.", "发送的 BNB 不足（价格变动），请重试。"],
    "0x19abf40e": ["The BNB price feed is out of date. Pay with USDT or try later.", "BNB 喂价过期，请改用 USDT 或稍后再试。"],
    "0x79858a71": ["The BNB swap returned too little USDT. Nothing was charged; try again.", "BNB 兑换得到的 USDT 不足，未扣款，请重试。"],
    "0xf0c49d44": ["This wallet cannot receive BNB change. Pay with USDT instead.", "该钱包无法接收找零 BNB，请改用 USDT。"],
    "0xddafad98": ["The pool is not open yet.", "资金池尚未开启。"],
    "0xe450d38c": ["Not enough USDT in this wallet.", "钱包 USDT 余额不足。"],
    "0xfb8f41b2": ["USDT approval is too low. Approve again.", "USDT 授权额度不足，请重新授权。"],
    "0x5cd5d233": ["The task voucher expired. Claim again.", "任务凭证已过期，请重新领取。"],
    "0x87b38f77": ["This task, or this X account, has already been used.", "该任务或该 X 账号已被使用。"],
    "0x6921e3b4": ["Unknown task.", "未知任务。"],
  };
  function errText(e) {
    const datas = [e && e.data, e && e.data && e.data.data, e && e.error && e.error.data, e && e.info && e.info.error && e.info.error.data];
    for (const d of datas) {
      if (typeof d === "string" && d.length >= 10) { const m = ERRORS[d.slice(0, 10).toLowerCase()]; if (m) return T(m[0], m[1]); }
    }
    const msg = (e && (e.shortMessage || e.message)) || "";
    if (e && (e.code === 4001 || /reject|denied|cancel/i.test(msg))) return T("Request rejected in the wallet.", "已在钱包中拒绝。");
    if (/insufficient funds/i.test(msg)) return T("Not enough BNB for gas.", "BNB 不足以支付 Gas。");
    return msg ? msg.slice(0, 180) : T("Something went wrong.", "出错了。");
  }

  // ---------------------------------------------------------------- contract state
  async function load() {
    if (deployed) {
      try {
        const w = words(await call(C.mint, SEL.overview));
        state = { minted: Number(w[0]), paid: w[1], paused: w[2] === 1n, open: w[3] === 1n, nextCents: Number(w[4]), u: w[5], t: w[6], supply: w[7], circ: w[8], line: w[9], mintable: Number(w[10] || 0n) };
        try { const v = words(await call(C.mint, SEL.valve)); Object.assign(state, { start: Number(v[0]), deadline: Number(v[1]), withdrawals: Number(v[2]), held: v[3], withdrawable: v[4] === 1n, withdrawn: v[5] || 0n, parkedU: v[6] }); state.closed = false; } catch (e) {}
      } catch (e) { state = null; }
    }
    render();
    if (W.account) refreshWallet();
  }

  const tierName = (n) => T(`Tier ${tierOf(n)} · ${uFmt(priceCents(n))}U`, `第 ${tierOf(n)} 档 · ${uFmt(priceCents(n))}U`);
  // shares radio 1..10 like jager.live: max = min(10, remaining quota); defaults to the max available
  let selQty = null;
  const avail = () => (W.status ? Math.min(Math.max(W.status.quota - W.status.minted, 0), 10) : 0);
  const qty = () => { const q = avail(); return Math.min(Math.max(selQty ?? q, 1), Math.max(q, 1)); };
  function renderQty() {
    const box = $("mintCtrl"); if (!box) return;
    box.style.display = W.account && W.handle ? "" : "none";
    const q = avail(), r = qty();
    $("qtyGroup").innerHTML = Array.from({ length: 10 }, (_, i) => i + 1).map((n) => `<button type="button" role="radio" aria-checked="${n === r}" class="${n === r ? "on" : ""}" data-q="${n}"${n > q ? " disabled" : ""}>${n}</button>`).join("");
    $("qtyGroup").querySelectorAll("button").forEach((b) => (b.onclick = () => { selQty = +b.dataset.q; renderQty(); updateCost(); }));
  }

  function render() {
    const s = state;
    const BURNED = 1100, TOTAL = 100000000;
    const progress = (m) => {
      $("sMinted").textContent = m.toLocaleString();
      $("hMinted").textContent = m.toLocaleString();
      document.querySelectorAll("#sTotal .tv").forEach((e) => (e.textContent = m.toLocaleString()));
      // Staged bar (user, 2026-10-30): stage 1 fills to 10,000 (pool opens), then switches to the next stage target.
      // Stages follow the price-table segments: 10,000 / 20,000 / 100,000 / 1,000,000 / 100,000,000.
      const STAGES = [10000, 20000, 100000, 1000000, TOTAL];
      let si = STAGES.findIndex((e) => m < e); if (si < 0) si = STAGES.length - 1;
      const goal = STAGES[si];
      $("sGoal").textContent = " / " + goal.toLocaleString();
      $("sBar").style.width = Math.min(100, (m / goal) * 100).toFixed(3) + "%"; // burned + minted, one gold bar
      $("sLegend").textContent = `Burned + Minted ${m.toLocaleString()} / ${goal.toLocaleString()}`;
      $("sStage").innerHTML = `<span class="en">Stage ${si + 1} / ${STAGES.length}</span><span class="zh">第 ${si + 1} 阶段 / 共 ${STAGES.length} 阶段</span>`;
    };
    const dl = (d) => new Date(d * 1000).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    if (s) {
      const next = Math.min(s.minted + 1, TOTAL);
      progress(s.minted);
      $("sTier").textContent = s.minted >= TOTAL ? T("Sold out", "已售罄") : tierName(next);
      $("sNext").textContent = s.minted >= TOTAL ? "–" : "#" + next.toLocaleString();
      $("hPrice").textContent = uFmt(s.nextCents || priceCents(next));
      renderReceive();
      const nt = tierEnd(next) < TOTAL ? priceCents(tierEnd(next) + 1) : 0;
      $("sTotal").innerHTML = `<span class="en">Total shares <span class="tv">${s.minted.toLocaleString()}</span> / 100,000,000${nt ? ` · Rises to ${uFmt(nt)}U at ${tierEnd(next).toLocaleString()}` : ""}</span><span class="zh">总份数 <span class="tv">${s.minted.toLocaleString()}</span> / 100,000,000${nt ? ` · 第 ${tierEnd(next).toLocaleString()} 份后涨至 ${uFmt(nt)}U` : ""}</span>`;
      $("sPool").textContent = s.open ? `${fmt(s.u)} USDT / ${fmt(s.t, 0)} BNAGENT` : T(`Opens automatically at share 10,000 (${(10000 - s.minted).toLocaleString()} to go)`, `第 10,000 份时自动开池（还差 ${(10000 - s.minted).toLocaleString()} 份）`);
      $("sPaused").textContent = s.paused ? T("Paused", "暂停中") : s.minted >= TOTAL ? T("Sold out", "已售罄") : T("Open", "开放中");
      markTier(next);
    } else {
      // no live read yet: keep the honest static placeholders (— for supply), never claim a state we have not read
      $("sTier").textContent = tierName(1101);
      $("sPool").textContent = T("Opens automatically at share 10,000", "第 10,000 份时自动开池");
    }
    updateCost();
    const sx = C.social || {};
    $("socialInfo").textContent = sx.x ? "X: @" + sx.x : "";
    renderWallet();
    renderPassId();
    renderQty();
    if ($("inviteModal").open) renderInvite();
  }
  function buildTiers() {
    const body = $("tierBody"); if (!body || body.dataset.built) return;
    const rows = ['<tr data-from="1" data-to="1100" class="burned"><td>—</td><td>1 - 1,100</td><td><span class="en">Burned at deploy (never sold)</span><span class="zh">部署时销毁（不出售）</span></td></tr>'];
    TIERS.forEach(([a, b], i) => {
      const from = i === 0 ? 1101 : a;
      rows.push(`<tr data-from="${from}" data-to="${b}" data-tier="${i + 1}"><td>${i + 1}</td><td>${from.toLocaleString("en-US")} - ${b.toLocaleString("en-US")}</td><td>= ${uFmt(priceCents(a))}U<span class="cur"></span></td></tr>`);
    });
    body.innerHTML = rows.join("");
    body.dataset.built = "1";
  }
  buildTiers();
  function markTier(next) {
    document.querySelectorAll("#tierBody tr[data-from]").forEach((tr) => {
      const on = next >= +tr.dataset.from && next <= +tr.dataset.to;
      tr.classList.toggle("now", on); if (on) tr.setAttribute("aria-current", "step"); else tr.removeAttribute("aria-current");
      const c = tr.querySelector(".cur"); if (c) c.textContent = on ? T(" · Current", " · 当前") : "";
      if (on && !markTier.done) { markTier.done = 1; const w = tr.closest(".tierwrap"); if (w) w.scrollTop = Math.max(0, tr.offsetTop - 80); }
    });
  }
  // "You receive (est.)" like jager.live: shares × 50,000,000 before the pool, else cost / (pool price × 0.99)
  function renderReceive() {
    const s = state; if (!s) return;
    const n = W.handle ? qty() : 1;
    let v = null;
    if (s.minted + n <= 10000) v = 50000000 * n;
    else if (s.u > 0n) { let cents = 0; for (let i = 1; i <= n; i++) cents += priceCents(s.minted + i); v = (cents / 100) / (0.99 * (Number(s.u) / Number(s.t))); }
    $("sGet").textContent = v == null ? "—" : "≈ " + Math.floor(v).toLocaleString("en-US");
  }

  async function updateCost() {
    const q = qty();
    let cents = 0; const start = state ? state.minted : 1100;
    for (let i = 1; i <= q; i++) cents += priceCents(start + i);
    let txt = (cents / 100).toFixed(2) + " USDT";
    if (pay === "bnb" && deployed) {
      try { const w = words(await call(C.mint, SEL.bnbQuote + encU(q))); txt = fmt(w[0], 6) + " BNB"; } catch (e) { txt += " (BNB)"; }
    }
    $("costOut").textContent = "≈ " + txt;
    $("costOut").dataset.u = (cents / 100).toFixed(2).replace(/\.?0+$/, "");
    renderReceive();
    renderMintButton();
  }
  const setPay = (v) => { pay = v; [["payUsdt", "usdt"], ["payBnb", "bnb"]].forEach(([id, k]) => { $(id).classList.toggle("on", k === v); $(id).setAttribute("aria-checked", String(k === v)); }); updateCost(); };
  $("payUsdt").onclick = () => setPay("usdt");
  $("payBnb").onclick = () => setPay("bnb");

  // ---------------------------------------------------------------- referral ?ref=<handle>.ai
  async function loadRef() {
    const raw = (new URLSearchParams(location.search).get("ref") || "").toLowerCase().trim();
    if (!raw) return;
    const label = raw.replace(/\.ai$/, "");
    if (!/^[a-z0-9-]{1,63}$/.test(label)) return;
    try {
      const w = words(await call(C.agentRegistry, SEL.ownerOfHandle + encString(label)));
      if (w[0] !== 0n) { referrer = "0x" + w[0].toString(16).padStart(40, "0"); $("refInfo").textContent = T(`Invited by ${label}.ai`, `邀请人：${label}.ai`); }
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- wallet discovery (EIP-6963 + legacy injected)
  const discovered = []; // {info:{uuid,name,icon,rdns}, provider}
  let listenersOn = null, autoTried = false;
  window.addEventListener("eip6963:announceProvider", (ev) => {
    const d = ev.detail;
    if (!d || !d.provider || !d.info) return;
    if (discovered.some((x) => x.info.uuid === d.info.uuid || x.provider === d.provider)) return;
    discovered.push({ info: d.info, provider: d.provider });
    if ($("walletModal").open) renderModal();
    tryAutoReconnect();
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  function legacyName(p) {
    if (p.isBinance || p === window.BinanceChain) return ["Binance Wallet", "com.binance.wallet"];
    if (p.isOkxWallet || p.isOKExWallet || p === window.okxwallet) return ["OKX Wallet", "com.okex.wallet"];
    if (p.isTrust || p.isTrustWallet || p === window.trustwallet) return ["Trust Wallet", "com.trustwallet.app"];
    if (p.isTokenPocket) return ["TokenPocket", "pro.tokenpocket"];
    if (p.isBitKeep || p.isBitget) return ["Bitget Wallet", "com.bitget.web3"];
    if (p.isCoinbaseWallet) return ["Coinbase Wallet", "com.coinbase.wallet"];
    if (p.isMetaMask) return ["MetaMask", "io.metamask"];
    return [T("Browser wallet", "浏览器钱包"), "injected"];
  }
  function walletList() {
    const list = discovered.map((d) => ({ name: d.info.name, icon: d.info.icon, rdns: d.info.rdns || d.info.name, provider: d.provider }));
    const cands = [];
    const eth = window.ethereum;
    if (eth) { if (Array.isArray(eth.providers)) cands.push(...eth.providers); cands.push(eth); }
    for (const k of ["BinanceChain", "okxwallet", "trustwallet", "trustWallet"]) if (window[k] && typeof window[k].request === "function") cands.push(window[k]);
    for (const p of cands) {
      if (!p || typeof p.request !== "function" || list.some((x) => x.provider === p)) continue;
      const [name, rdns] = legacyName(p);
      if (list.some((x) => x.rdns === rdns)) continue; // already announced via EIP-6963
      list.push({ name, icon: "", rdns, provider: p });
    }
    const rank = (w) => (/binance/i.test(w.rdns + w.name) ? 0 : /metamask/i.test(w.rdns) ? 1 : /okx|okex/i.test(w.rdns + w.name) ? 2 : /trust/i.test(w.rdns + w.name) ? 3 : 4);
    return list.sort((a, b) => rank(a) - rank(b));
  }
  const isMobile = () => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  // ---------------------------------------------------------------- connect / chain
  function attachListeners(p) {
    if (listenersOn === p || typeof p.on !== "function") return;
    detachListeners();
    listenersOn = p;
    p.on("accountsChanged", onAccounts);
    p.on("chainChanged", onChain);
    p.on("disconnect", onDisconnect);
  }
  function detachListeners() {
    const p = listenersOn; listenersOn = null;
    if (!p || typeof p.removeListener !== "function") return;
    p.removeListener("accountsChanged", onAccounts); p.removeListener("chainChanged", onChain); p.removeListener("disconnect", onDisconnect);
  }
  function onAccounts(a) { if (!a || !a.length) return disconnect(); W.account = a[0]; resetWalletData(); refreshWallet(); render(); }
  function onChain(c) { W.chainId = typeof c === "number" ? "0x" + c.toString(16) : String(c).toLowerCase(); refreshWallet(); render(); }
  function onDisconnect() { disconnect(); }
  function resetWalletData() { W.handle = null; W.agentOk = false; W.status = null; W.bnb = null; W.usdt = null; selQty = null; }

  async function connectWith(w) {
    status("");
    W.busy = true; renderModal();
    try {
      const accs = await w.provider.request({ method: "eth_requestAccounts" });
      if (!accs || !accs.length) throw new Error(T("No account returned.", "钱包没有返回账户。"));
      Object.assign(W, { provider: w.provider, name: w.name, icon: w.icon, rdns: w.rdns, account: accs[0] });
      resetWalletData();
      W.chainId = String(await w.provider.request({ method: "eth_chainId" })).toLowerCase();
      localStorage.setItem("bnagent-wallet", w.rdns);
      attachListeners(w.provider);
      closeModal();
      render();
      if (W.chainId !== BSC) await switchToBsc();
      refreshWallet();
    } catch (e) {
      $("modalStatus").textContent = errText(e);
    } finally { W.busy = false; if ($("walletModal").open) renderModal(); }
  }
  async function switchToBsc() {
    if (!W.provider) return;
    try {
      await W.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BSC }] });
    } catch (e) {
      const code = e && (e.code ?? (e.data && e.data.originalError && e.data.originalError.code));
      if (code === 4902 || /unrecognized|not added|unknown chain/i.test((e && e.message) || "")) {
        try { await W.provider.request({ method: "wallet_addEthereumChain", params: [BSC_PARAMS] }); }
        catch (e2) { status(errText(e2), "bad"); return; }
      } else { status(T("Please switch your wallet to BNB Smart Chain (chainId 56).", "请将钱包切换到 BNB Smart Chain（chainId 56）。"), "bad"); return; }
    }
    try { W.chainId = String(await W.provider.request({ method: "eth_chainId" })).toLowerCase(); } catch (e) { /* keep */ }
    status(""); render();
  }
  function disconnect() {
    const p = W.provider;
    detachListeners();
    if (p) { try { p.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }).catch(() => {}); } catch (e) { /* optional */ } }
    Object.assign(W, { provider: null, name: "", icon: "", rdns: "", account: null, chainId: null });
    resetWalletData();
    localStorage.removeItem("bnagent-wallet");
    status(""); render();
  }
  async function tryAutoReconnect() {
    const want = localStorage.getItem("bnagent-wallet");
    if (!want || W.account || autoTried) return;
    if (want === AGENTIC && !awReady) return;
    const w = want === AGENTIC ? (sessionStorage.getItem("bnagent-aw-addr") ? agenticWallet() : null) : walletList().find((x) => x.rdns === want);
    if (!w) return;
    autoTried = true;
    try {
      const accs = await w.provider.request({ method: "eth_accounts" });
      if (accs && accs.length) {
        Object.assign(W, { provider: w.provider, name: w.name, icon: w.icon, rdns: w.rdns, account: accs[0] });
        W.chainId = String(await w.provider.request({ method: "eth_chainId" })).toLowerCase();
        attachListeners(w.provider);
        render(); refreshWallet();
      }
    } catch (e) { /* silent */ }
  }

  async function lookupAgent(addr) {
    const h = await call(C.agentRegistry, SEL.handleOf + encA(addr));
    return decString(h);
  }
  async function refreshWallet() {
    const a = W.account; if (!a) return;
    try { W.handle = await lookupAgent(a); } catch (e) { W.handle = W.handle ?? null; }
    try { W.bnb = BigInt(await rpc("eth_getBalance", [a, "latest"])); } catch (e) { /* ignore */ }
    try { W.usdt = words(await call(C.usdt, SEL.balanceOf + encA(a)))[0]; } catch (e) { /* ignore */ }
    if (deployed) {
      try {
        const s = words(await call(C.mint, SEL.walletStatus + encA(a))); W.agentOk = s[0] === 1n;
        const social = {};
        if (W.agentOk) for (const t of TASKS) { try { social[t.id] = words(await call(C.mint, SEL.socialDone + encU(s[1]) + pad(t.hash)))[0] === 1n; } catch (e) { social[t.id] = false; } }
        W.status = { id: s[1], minted: Number(s[2]), quota: Number(s[3]), social };
      } catch (e) { W.status = null; }
    } else W.agentOk = !!W.handle;
    if (a !== W.account) return;
    render();
    loadPass();
  }

  function renderWallet() {
    const box = $("walletBox");
    if (!W.account) {
      box.innerHTML = `<div class="small">${T("Not connected. Connect the wallet that holds your .ai Agent ID.", "未连接。请连接持有 .ai Agent ID 的钱包。")}</div>`;
      box.classList.add("off");
      $("connectBtn").style.display = "";
      $("disconnectBtn").style.display = "none";
      return;
    }
    $("connectBtn").style.display = "none";
    $("disconnectBtn").style.display = "";
    box.classList.remove("off");
    const onBsc = W.chainId === BSC;
    const chainTxt = onBsc ? `<span class="okc">BNB Smart Chain (56) ✓</span>` : `<span class="badc">${T("Wrong network", "网络错误")} (chainId ${W.chainId ? parseInt(W.chainId, 16) : "?"})</span> <button class="mini" id="switchBtn">${T("Switch to BSC", "切换到 BSC")}</button>`;
    const agent = W.handle === null ? "…" : W.handle ? `<span class="okc">${esc(W.handle)}.ai ✓</span>` : `<span class="badc">${T("no .ai Agent ID", "无 .ai Agent ID")}</span>`;
    const contract = !deployed ? `<span class="warnc">${T("Contracts not deployed yet", "合约未部署")}</span>` : W.status ? T(`minted ${W.status.minted} / quota ${W.status.quota}`, `已铸 ${W.status.minted} / 额度 ${W.status.quota}`) : "–";
    const icon = W.icon && /^data:image\//.test(W.icon) ? `<img class="wicon" src="${esc(W.icon)}" alt="">` : "";
    box.innerHTML =
      `<div class="row"><span>${T("Wallet", "钱包")}</span><span>${icon}${esc(W.name)} · <span class="mono" title="${esc(W.account)}">${short(W.account)}</span> <button class="mini" id="copyAddr">${T("Copy", "复制")}</button></span></div>` +
      `<div class="row"><span>${T("Network", "网络")}</span><span>${chainTxt}</span></div>` +
      `<div class="row"><span>Agent ID</span><span>${agent}</span></div>` +
      `<div class="row"><span>${T("Balance", "余额")}</span><span class="mono">${W.bnb != null ? fmt(W.bnb, 4) + " BNB" : "–"} · ${W.usdt != null ? fmt(W.usdt, 2) + " USDT" : "–"}</span></div>` +
      `<div class="row"><span>${T("Mint status", "铸造状态")}</span><span>${contract}</span></div>`;
    if ($("switchBtn")) $("switchBtn").onclick = switchToBsc;
    $("copyAddr").onclick = () => copy(W.account, $("copyAddr"));
  }

  function renderMintButton() {
    const b = $("mintBtn");
    let label, ok = false;
    const s = state;
    if (!deployed) label = T("Contracts not deployed yet", "合约未部署");
    else if (!W.account) label = T("Connect a wallet to mint", "连接钱包后铸造");
    else if (W.chainId !== BSC) label = T("Switch to BNB Smart Chain", "请切换到 BNB Smart Chain");
    else if (W.handle === "" ) label = T("This wallet has no .ai Agent ID", "该钱包没有 .ai Agent ID");
    else if (!s) label = T("Loading…", "加载中…");
    else if (s.paused) label = T("Minting is paused", "铸造已暂停");
    else if (s.minted >= 100000000) label = T("Sold out", "已售罄");
    else if (s.mintable === 0) label = T("Minting ended", "铸造已结束");
    else if (W.status && W.status.quota - W.status.minted <= 0) label = T("Quota used · Invite or do tasks to earn more", "额度已用完 · 邀请或做任务获得更多");
    else { const u = $("costOut").dataset.u || "—", bnb = pay === "bnb"; label = T(`Mint ${qty()} share${qty() > 1 ? "s" : ""} · ${u}U${bnb ? " in BNB" : ""}`, `铸造 ${qty()} 份 · ${u}U${bnb ? "（BNB 支付）" : ""}`); ok = true; }
    b.textContent = label;
    b.disabled = !ok;
    b.style.display = W.account ? "" : "none"; // like jager.live: only the connect button until a wallet is connected
  }

  // ---------------------------------------------------------------- wallet chooser modal
  const dappUrl = () => location.href.split("#")[0];
  function deepLinks() {
    const u = dappUrl();
    const noProto = u.replace(/^https?:\/\//, "");
    return [
      { name: "MetaMask", href: `https://metamask.app.link/dapp/${noProto}` },
      { name: "OKX Wallet", href: `okx://wallet/dapp/url?dappUrl=${encodeURIComponent(u)}` },
      { name: "Trust Wallet", href: `https://link.trustwallet.com/open_url?coin_id=20000714&url=${encodeURIComponent(u)}` },
    ];
  }
  function agentPrompt() {
    const base = dappUrl().replace(/[?].*$/, "").replace(/index\.html$/, "");
    return T(
      `Read ${base}llms.txt and follow it to mint BNAGENT on BNB Smart Chain (chainId 56) with my Binance Agentic Wallet. Mint <N> shares, paying with <BNB or USDT>, referrer <handle.ai or none>. Use only the mint contract address published in that file; if it says the contracts are not deployed, stop and tell me. Show me the preview before you execute.`,
      `请阅读 ${base}llms.txt 并按其中步骤，用我的币安 Agentic Wallet 在 BNB Smart Chain（chainId 56）上铸造 BNAGENT：铸造 <N> 份，用 <BNB 或 USDT> 支付，邀请人 <handle.ai 或无>。只使用该文件公布的铸造合约地址；如果文件写着合约未部署，就停止并告诉我。执行前先给我看预览（preview）。`
    );
  }

  // ---------------------------------------------------------------- Binance Agentic Wallet (.ai Agent ID) QR connect
  // Same flow as jager.live: our proxy (server/index.mjs, C.agentApi) forwards to Binance's Agentic Wallet API.
  // login -> QR (desktop) / app link (mobile) -> confirm until CONNECTED -> query until wallet CREATED -> wallets (chain 56).
  // Transactions: preview {binanceChainId 56, from, to, value, inputData, gasLimit} -> requestId -> poll execute until txHash;
  // the user approves each one in the Binance App. Exposed as an EIP-1193-style provider so the mint flow is unchanged.
  const AW = { abort: null, qr: null, phase: "idle", err: "" };
  const awStore = {
    cid() { let c = sessionStorage.getItem("bnagent-aw-cid"); if (!c) { c = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()); sessionStorage.setItem("bnagent-aw-cid", c); } return c; },
    sid: () => sessionStorage.getItem("bnagent-aw-sid"),
    setSid: (v) => v && sessionStorage.setItem("bnagent-aw-sid", v),
    clear: () => { sessionStorage.removeItem("bnagent-aw-sid"); sessionStorage.removeItem("bnagent-aw-addr"); },
  };
  const deep = (o, k) => { if (!o || typeof o !== "object") return null; if (Array.isArray(o)) { for (const x of o) { const r = deep(x, k); if (r) return r; } return null; } if (typeof o[k] === "string" && o[k]) return o[k]; for (const v of Object.values(o)) { const r = deep(v, k); if (r) return r; } return null; };
  const sleep = (ms, sig) => new Promise((res, rej) => { const t = setTimeout(res, ms); if (sig) sig.addEventListener("abort", () => { clearTimeout(t); rej(new Error(T("Connection cancelled.", "已取消连接。"))); }, { once: true }); });
  async function aw(action, body) {
    if (!C.agentApi) throw new Error(T("Agent ID QR login is not configured on this site.", "本站未配置 Agent ID 扫码登录。"));
    const r = await fetch(C.agentApi, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, clientId: awStore.cid(), sessionId: awStore.sid(), body: body || {} }) });
    const j = await r.json().catch(() => ({}));
    if (j.error) throw new Error(j.error);
    awStore.setSid(j.sessionId);
    const d = j.data || {};
    const code = d.code;
    if (code != null && code !== "000000" && code !== 0 && code !== "0") { const e = new Error(d.message || d.msg || `Agent Wallet error ${code}`); e.code = code; throw e; }
    if (!r.ok) throw new Error(d.message || "Agent Wallet request failed");
    const out = d.data ?? d; if (d.extra && out && typeof out === "object") out.extra = d.extra; return out;
  }
  async function awWallet() {
    const res = await aw("wallets");
    const found = [];
    const walk = (o, chain) => { if (!o || typeof o !== "object") return; if (Array.isArray(o)) return o.forEach((x) => walk(x, chain)); const c = String(o.binanceChainId ?? o.chainId ?? chain); const a = o.address ?? o.walletAddress; if (typeof a === "string" && isAddr(a) && (c === "56" || c === "0x38")) found.push(a); Object.values(o).forEach((x) => walk(x, c)); };
    walk(res, "");
    return found[0] || null;
  }
  const agenticProvider = {
    isBinanceAgentic: true,
    async request({ method, params }) {
      const a = sessionStorage.getItem("bnagent-aw-addr");
      if (method === "eth_requestAccounts" || method === "eth_accounts") return a ? [a] : [];
      if (method === "eth_chainId") return BSC;
      if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
      if (method === "wallet_revokePermissions") { aw("logout").catch(() => {}); awStore.clear(); return null; }
      if (method === "eth_sendTransaction") {
        const tx = params[0];
        const pv = await aw("preview", { binanceChainId: "56", from: tx.from, to: tx.to, value: tx.value ? BigInt(tx.value).toString() : "0", inputData: tx.data, gasLimit: tx.gas ? Number(BigInt(tx.gas)) : undefined });
        const requestId = deep(pv, "requestId");
        if (!requestId) throw new Error(T("The Agentic Wallet did not accept the transaction preview.", "Agentic Wallet 未接受交易预览。"));
        status(T("Confirm the transaction in your Binance App…", "请在币安 App 中确认交易…"));
        const until = Date.now() + 180000;
        for (;;) {
          const ex = await aw("execute", { requestId });
          const h = deep(ex, "txHash") || deep(ex, "transactionHash") || deep(ex, "hash");
          if (h && /^0x[0-9a-fA-F]{64}$/.test(h)) return h;
          if (Date.now() > until) throw new Error(T("The Binance App did not confirm the transaction.", "币安 App 未确认该交易。"));
          await sleep(3000);
        }
      }
      throw Object.assign(new Error("unsupported " + method), { code: 4200 });
    },
    on() {}, removeListener() {},
  };
  const agenticWallet = () => ({ name: T("Binance Agentic Wallet (Agent ID)", "币安 Agentic Wallet（Agent ID）"), icon: "", rdns: AGENTIC, provider: agenticProvider });
  awReady = true;
  function stopQr() { if (AW.abort) AW.abort.abort(); AW.abort = null; AW.qr = null; AW.phase = "idle"; AW.err = ""; }
  async function startQr() {
    stopQr();
    const ctl = new AbortController(); AW.abort = ctl; AW.phase = "preparing"; renderQr();
    try {
      awStore.clear();
      const res = await aw("login");
      const qi = (res && res.qrInfo) || res || {};
      const url = String(qi.qrCodeUrl || qi.urlForWeb || "");
      const id = String(qi.qrCodeId || "");
      let exp = Number(qi.expireAt || 0); if (exp > 0 && exp < 1e12) exp *= 1000;
      if (!url || !id) throw new Error(T("Could not get a sign-in code. Try again.", "未能获取登录二维码，请重试。"));
      AW.qr = { url, id, exp: exp || Date.now() + 300000, code: (res.extra && res.extra.pairingCode) || "" };
      AW.phase = "pending"; renderQr();
      for (;;) { // phase 1: scanned + approved in the app
        if (ctl.signal.aborted) return;
        if (Date.now() > AW.qr.exp) { AW.phase = "expired"; renderQr(); return; }
        const c = await aw("confirm", { qrCodeId: id }).catch((e) => { if (/expire/i.test(e.message)) throw e; return null; });
        const st = c && String(c.connectionStatus || "");
        if (st === "CONNECTING" && AW.phase !== "scanned") { AW.phase = "scanned"; renderQr(); }
        if (st === "CONNECTED") break;
        await sleep(2000, ctl.signal);
      }
      AW.phase = "linking"; renderQr();
      const until = Date.now() + 90000;
      let addr = null;
      while (!addr && Date.now() < until) { // phase 2: wallet ready
        const q = await aw("query").catch(() => null);
        if (q && String(q.walletCreateStatus || "") === "CREATED") addr = await awWallet().catch(() => null);
        if (!addr) await sleep(2000, ctl.signal);
      }
      if (!addr) throw new Error(T("The Agentic Wallet did not finish connecting. Get a new code.", "Agentic Wallet 未完成连接，请获取新二维码。"));
      sessionStorage.setItem("bnagent-aw-addr", addr);
      AW.phase = "idle"; AW.abort = null;
      await connectWith(agenticWallet());
    } catch (e) {
      if (ctl.signal.aborted) return;
      AW.phase = /expire/i.test(e.message || "") ? "expired" : "failed"; AW.err = e.message || String(e); renderQr();
    }
  }
  function qrSvg(text) {
    if (typeof window.qrcode !== "function") return "";
    const q = window.qrcode(0, "M"); q.addData(text); q.make();
    return q.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
  }
  function renderQr() {
    const box = $("qrBox"); if (!box) return;
    const ph = AW.phase;
    if (ph === "idle") { box.innerHTML = ""; return; }
    let h = "";
    if (ph === "preparing") h = `<p class="small">${T("Getting a sign-in code from Binance…", "正在从币安获取登录二维码…")}</p>`;
    else if (AW.qr && (ph === "pending" || ph === "scanned")) {
      const mobile = isMobile();
      h += mobile ? `<a class="btn" id="bnOpenApp" href="${esc(AW.qr.url)}" rel="noopener">${T("Open in Binance App", "在币安 App 中打开")}</a>` : "";
      h += `<div class="qrwrap${mobile ? " sm" : ""}">${qrSvg(AW.qr.url)}</div>`;
      h += `<p class="small" style="text-align:center">${mobile ? T("The Binance App opens and asks you to approve. Come back here afterwards.", "将打开币安 App 请求授权，授权后回到本页。") : T("Scan with the Binance App (Wallet → scan), then approve the Agentic Wallet sign-in.", "用币安 App 扫码（钱包 → 扫一扫），然后批准 Agentic Wallet 登录。")}${AW.qr.code ? `<br>${T("Pairing code", "配对码")}: <b class="mono">${esc(AW.qr.code)}</b>` : ""}</p>`;
      h += `<p class="small" id="qrState" style="text-align:center">${ph === "scanned" ? T("Scanned. Approve in the app…", "已扫码，请在 App 中批准…") : T("Waiting for scan…", "等待扫码…")}</p>`;
    } else if (ph === "linking") h = `<p class="small">${T("Approved. Linking your Agentic Wallet…", "已批准，正在连接 Agentic Wallet…")}</p>`;
    else if (ph === "expired") h = `<p class="small">${T("This sign-in code expired.", "二维码已过期。")}</p><button class="mini" id="qrRetry">${T("Get a new code", "获取新二维码")}</button>`;
    else if (ph === "failed") h = `<p class="small badc">${esc(AW.err)}</p><button class="mini" id="qrRetry">${T("Try again", "重试")}</button>`;
    box.innerHTML = h;
    if ($("qrRetry")) $("qrRetry").onclick = startQr;
  }
  function renderModal() {
    // Only the Binance QR connect is shown (user, 2026-10-30: other options confuse visitors).
    let h = `<h3>${T("Binance Wallet / Agent ID", "币安钱包 / Agent ID")}</h3>` +
      `<div class="wlist"><button class="wbtn bnqr" id="bnQrBtn" ${W.busy ? "disabled" : ""}><img class="wicon" src="assets/mark.svg" alt=""><span>${T("Binance Agentic Wallet (.ai Agent ID)", "币安 Agentic Wallet（.ai Agent ID）")}</span><em>${isMobile() ? T("open app", "打开 App") : T("scan QR", "扫码")}</em></button></div><div id="qrBox"></div>`;
    $("modalBody").innerHTML = h;
    $("bnQrBtn").onclick = startQr;
    renderQr();
  }
  // Test hook only (headless tests drive a mock injected wallet); not shown anywhere in the UI.
  window.__bnTestConnect = (i) => connectWith(walletList()[i || 0]);
  async function watchCheck() {
    const a = $("watchAddr").value.trim();
    if (!isAddr(a)) { $("watchOut").textContent = T("Enter a valid 0x address.", "请输入有效的 0x 地址。"); return; }
    $("watchOut").textContent = T("Looking up Agent ID on-chain…", "正在链上查询 Agent ID…");
    try {
      const h = await lookupAgent(a);
      let t = h ? T(`${h}.ai ✓ — eligible to mint`, `${h}.ai ✓ — 可以铸造`) : T("No .ai Agent ID — cannot mint", "无 .ai Agent ID — 不能铸造");
      if (deployed && h) { const s = words(await call(C.mint, SEL.walletStatus + encA(a))); t += T(` · minted ${s[2]} / quota ${s[3]}`, ` · 已铸 ${s[2]} / 额度 ${s[3]}`); }
      else if (!deployed) t += T(" · contracts not deployed yet", " · 合约未部署");
      $("watchOut").textContent = t;
    } catch (e) { $("watchOut").textContent = T("Lookup failed, try again.", "查询失败，请重试。"); }
  }
  function openModal() {
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    $("modalStatus").textContent = "";
    renderModal();
    const d = $("walletModal");
    if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
  }
  function closeModal() { if (AW.phase !== "linking") stopQr(); const d = $("walletModal"); if (d.open) { if (typeof d.close === "function") d.close(); else d.removeAttribute("open"); } }
  $("modalClose").onclick = closeModal;
  $("walletModal").addEventListener("click", (e) => { if (e.target === $("walletModal")) closeModal(); });
  $("connectBtn").onclick = () => {
    const list = walletList();
    // Inside a wallet's in-app browser there is exactly one provider: connect directly, like Jager does with the Binance provider.
    if (list.length === 1 && isMobile()) return connectWith(list[0]);
    openModal();
  };
  $("disconnectBtn").onclick = disconnect;
  $("agentBtn").onclick = openModal;

  async function copy(text, el) {
    try { await navigator.clipboard.writeText(text); }
    catch (e) { const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch (e2) { /* ignore */ } ta.remove(); }
    if (el) { const old = el.innerHTML; el.textContent = T("Copied", "已复制"); setTimeout(() => (el.innerHTML = old), 1200); }
  }

  // ---------------------------------------------------------------- mint
  const status = (msg, cls = "") => { $("status").textContent = msg; $("status").className = "status " + cls; };
  async function waitTx(hash) {
    const until = Date.now() + 180000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 2500));
      const rc = await rpc("eth_getTransactionReceipt", [hash]).catch(() => null);
      if (rc) return rc.status === "0x1";
    }
    throw new Error(T(`Still pending after 3 minutes. Check ${hash} on BscScan.`, `3 分钟后仍未确认，请在 BscScan 查看 ${hash}。`));
  }
  async function send(tx) {
    // simulate first (decodes contract errors before the wallet pops up), then estimate gas +20% like the reference site
    await rpc("eth_call", [tx, "latest"]);
    try { const g = BigInt(await rpc("eth_estimateGas", [tx])); tx.gas = "0x" + ((g * 12n) / 10n).toString(16); } catch (e) { /* let the wallet estimate */ }
    return W.provider.request({ method: "eth_sendTransaction", params: [tx] });
  }
  // after a mint, like jager.live: "Minted N shares from #X · BscScan · Share Mint Pass" + the Mint successful dialog
  function minted(hash, n) {
    const first = state ? state.minted + 1 : null;
    $("status").innerHTML = `${T(`Minted ${n} share${n > 1 ? "s" : ""}`, `已铸造 ${n} 份`)}${first ? T(` from #${first.toLocaleString()}`, `（自 #${first.toLocaleString()}）`) : ""} · <a href="${C.explorer}/tx/${esc(hash)}" target="_blank" rel="noreferrer">BscScan</a> · <button type="button" class="linkbtn" id="shareAfter">${T("Share Mint Pass", "分享 Mint Pass")}</button>`;
    $("status").className = "status ok";
    $("shareAfter").onclick = () => openPass({ txHash: hash });
    refreshWallet().then(() => openPass({ txHash: hash }));
  }
  $("mintBtn").onclick = async () => {
    if (!deployed || !W.account) return;
    if (W.chainId !== BSC) { await switchToBsc(); if (W.chainId !== BSC) return; }
    const q = qty();
    const ref = referrer && referrer.toLowerCase() !== W.account.toLowerCase() ? referrer : ZERO;
    $("mintBtn").disabled = true;
    try {
      if (pay === "usdt") {
        const cost = words(await call(C.mint, SEL.costOf + encU(q)))[0];
        const max = (cost * 102n) / 100n;
        const allow = words(await call(C.usdt, SEL.allowance + encA(W.account) + encA(C.mint)))[0];
        if (allow < max) {
          status(T("Approve USDT in your wallet…", "请在钱包中授权 USDT…"));
          const h = await send({ from: W.account, to: C.usdt, data: SEL.approve + encA(C.mint) + encU(max) });
          if (!(await waitTx(h))) return status(T("Approval failed.", "授权失败。"), "bad");
        }
        status(T("Confirm the mint in your wallet…", "请在钱包中确认铸造…"));
        const h = await send({ from: W.account, to: C.mint, data: SEL.mint + encU(q) + encA(ref) + encU(max) });
        status(T("Waiting for confirmation…", "等待确认…"));
        const ok = await waitTx(h);
        status(ok ? T("Minted!", "铸造成功！") : T("Transaction reverted on-chain.", "交易在链上失败。"), ok ? "ok" : "bad");
        if (ok) minted(h, q);
      } else {
        const need = words(await call(C.mint, SEL.bnbQuote + encU(q)))[0];
        const sendV = (need * 102n) / 100n;
        status(T("Confirm the mint in your wallet…", "请在钱包中确认铸造…"));
        const h = await send({ from: W.account, to: C.mint, value: "0x" + sendV.toString(16), data: SEL.mintWithBnb + encU(q) + encA(ref) + encU(sendV) });
        status(T("Waiting for confirmation…", "等待确认…"));
        const ok = await waitTx(h);
        status(ok ? T("Minted! Extra BNB was refunded.", "铸造成功！多余 BNB 已退回。") : T("Transaction reverted on-chain.", "交易在链上失败。"), ok ? "ok" : "bad");
        if (ok) minted(h, q);
      }
      load();
    } catch (e) { status(errText(e), "bad"); }
    finally { renderMintButton(); }
  };

  // ---------------------------------------------------------------- Invite & tasks · +1 mint (same dialog as jager.live)
  const API = C.api || "https://bnagent-api.onrender.com";
  const XH = (C.social && C.social.x) || "bnAgent_";
  const SITE_HOST = "bnagent.onrender.com";
  const TASKS = [
    { id: "FOLLOW", hash: "0xd0da9b1693253fae9e3642967a8d27bb318f84f49ff0596c1d11ecec5bd752f3", title: () => T(`Follow @${XH} on X`, `在 X 关注 @${XH}`), action: () => T("Follow", "关注"), href: `https://x.com/intent/follow?screen_name=${XH}` },
    { id: "TWEET", hash: "0x93e97387cbdd54fcd2e94ca587c3745ec0fd3255bec4a5a576b02fcd5dcd413e", title: () => T("Post your mint or BNAGENT content", "发布你的铸造或 BNAGENT 相关内容"), action: () => T("Post", "发帖"), href: `https://x.com/intent/post?text=${encodeURIComponent(`Minting BNAGENT with @${XH} on BNB Chain. ${SITE_HOST}`)}` },
  ];
  const IV = { opened: {}, busy: null, err: {}, url: "", copied: null };
  const ICON_X = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>';
  const ICON_USERS = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>';
  const ICON_LIST = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/></svg>';
  const ICON_CHECK = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
  function renderInvite() {
    const st = W.status, handle = W.handle || null;
    const link = handle ? `https://${SITE_HOST}/?ref=${handle}.ai` : "", code = handle ? `${handle}.ai` : "";
    let top;
    if (!W.account) top = `<button type="button" class="pbtn big" id="ivConnect">${T("Connect Binance Wallet to claim", "连接币安钱包后领取")}</button>`;
    else if (!st && W.handle !== "") top = `<p class="ivp">${T("Loading…", "加载中…")}</p>`;
    else if (!handle || !W.agentOk) top = `<p class="ivp" style="font-size:14px">${T("This wallet holds no .ai Agent ID. Connect the Agentic Wallet that owns it.", "该钱包没有 .ai Agent ID，请连接持有它的 Agentic Wallet。")}</p>`;
    else top = `<dl class="qgrid" id="ivQuota"><div><dt>${T("Quota", "额度")}</dt><dd>${st.quota}</dd></div><div><dt>${T("Minted", "已铸")}</dt><dd>${st.minted}</dd></div><div><dt>${T("Remaining", "剩余")}</dt><dd class="hl">${Math.max(st.quota - st.minted, 0)}</dd></div></dl>`;
    const socialDoneN = st && st.social ? Object.values(st.social).filter(Boolean).length : 0;
    const counted = handle && st ? `<span class="cnt" id="ivCounted">${Math.max(st.quota - 10 - socialDoneN, 0)} ${T("counted", "已计入")}</span>` : "";
    const inv = handle
      ? `<div class="ivbox"><span class="lnk" id="ivLink">${esc(link)}</span><button type="button" class="cbtn" id="ivCopyLink">${IV.copied === "link" ? T("Copied", "已复制") : T("Copy link", "复制链接")}</button></div>
         <div class="ivbox"><span class="small">${T("Code", "邀请码")} <span class="code">${esc(code)}</span></span><button type="button" class="cbtn" id="ivCopyCode">${IV.copied === "code" ? T("Copied", "已复制") : T("Copy code", "复制邀请码")}</button></div>`
      : `<p class="ivdash">${T(`Your invite link (${SITE_HOST}/?ref=yourname.ai) appears after you connect an Agent ID.`, `连接 Agent ID 后会显示你的邀请链接（${SITE_HOST}/?ref=yourname.ai）。`)}</p>`;
    const doneN = TASKS.filter((t) => st && st.social && st.social[t.id]).length;
    const canClaim = !!(handle && W.agentOk);
    const tasks = TASKS.map((t) => {
      const done = !!(st && st.social && st.social[t.id]);
      const ready = IV.opened[t.id] && (t.id !== "TWEET" || IV.url.trim().length > 0);
      const act = done ? `<span class="tdone">${ICON_CHECK} +1</span>`
        : `<div class="tact"><a class="obtn" href="${esc(t.href)}" target="_blank" rel="noreferrer" data-open="${t.id}">${t.action()} ${ICON_X}</a>` +
          (W.account ? `<button type="button" class="pbtn" data-claim="${t.id}"${!canClaim || !ready || IV.busy ? " disabled" : ""}>${IV.busy === t.id ? "… " : ""}${T("Claim +1", "领取 +1")}</button>` : `<button type="button" class="pbtn" data-connect="1">${T("Connect to claim", "连接后领取")}</button>`) + `</div>`;
      const extra = t.id === "TWEET" && !done
        ? `<p class="ivp">${T("Post your mint (or any post about BNAGENT) and paste its link. Reposted one from", "发布你的铸造（或任何关于 BNAGENT 的帖子）并粘贴帖子链接。转发了")} <a href="https://x.com/${XH}" target="_blank" rel="noreferrer" data-open="TWEET">@${XH}</a>${T("? Paste that post's link.", " 的帖子？粘贴那条帖子的链接。")}</p>
           <input type="url" inputmode="url" id="ivUrl" value="${esc(IV.url)}" placeholder="https://x.com/…/status/…" aria-label="Post link">` : "";
      return `<li data-task="${t.id}"><div class="trow"><span class="tt${done ? " done" : ""}">${t.title()}</span>${act}</div>${extra}${IV.err[t.id] ? `<span class="terr">${esc(IV.err[t.id])}</span>` : ""}</li>`;
    }).join("");
    $("inviteBody").innerHTML = `<div class="iv">
      <div class="ivtop"><div><h2 id="invite-title">${T("Earn extra mints", "赚取额外铸造额度")}</h2><p>${T("Every Agent ID starts with 10 shares. Each invitee's first mint adds +1, and each social task adds +1. Extra shares are still paid at the current price.", "每个 Agent ID 初始 10 份额度。每位被邀请人首次铸造 +1，每完成一项社交任务 +1。额外份额仍按当前价格付费。")}</p></div><button type="button" class="ivx" id="ivClose" aria-label="Close">✕</button></div>
      ${top}
      <section class="ivsec" aria-labelledby="invite-heading"><div class="ivh"><h3 id="invite-heading">${ICON_USERS}${T("Invite friends · +1 each", "邀请好友 · 每人 +1")}</h3>${counted}</div>
        <p class="ivp">${T("You get +1 share of quota when a new .ai opens your link and completes their first paid mint. Inviting yourself does not count.", "新的 .ai 通过你的链接完成首次付费铸造后，你获得 +1 份额度。邀请自己无效。")}</p>${inv}</section>
      <section class="ivsec" aria-labelledby="tasks-heading"><div class="ivh"><h3 id="tasks-heading">${ICON_LIST}${T("Social tasks", "社交任务")} <span class="mut">${T("· +1 each, once", "· 每项 +1，仅一次")}</span></h3><span class="cnt" id="ivTasksDone">${doneN} / ${TASKS.length} ${T("done", "完成")}</span></div>
        <p class="ivp">${T("Each task adds +1 share of quota, once per Agent ID.", "每项任务为每个 Agent ID 增加 +1 份额度，仅一次。")}</p>
        <ul class="tasks" id="ivTasks">${tasks}</ul></section>
      ${bindXHtml()}
      ${seasonHtml()}
    </div>`;
    $("ivClose").onclick = closeInvite;
    wireXb();
    if ($("ivConnect")) $("ivConnect").onclick = () => { closeInvite(); openModal(); };
    $("inviteBody").querySelectorAll("[data-connect]").forEach((b) => (b.onclick = () => { closeInvite(); openModal(); }));
    $("inviteBody").querySelectorAll("[data-open]").forEach((a) => a.addEventListener("click", () => { IV.opened[a.dataset.open] = true; setTimeout(renderInvite, 50); }));
    $("inviteBody").querySelectorAll("[data-claim]").forEach((b) => (b.onclick = () => claimTask(b.dataset.claim)));
    if ($("ivUrl")) $("ivUrl").oninput = (e) => { IV.url = e.target.value; const b = $("inviteBody").querySelector('[data-claim="TWEET"]'); if (b) b.disabled = !canClaim || !IV.opened.TWEET || !IV.url.trim() || !!IV.busy; };
    const cp = async (k) => { await copy(k === "link" ? link : code); IV.copied = k; renderInvite(); setTimeout(() => { IV.copied = null; if ($("inviteModal").open) renderInvite(); }, 1500); };
    if ($("ivCopyLink")) $("ivCopyLink").onclick = () => cp("link");
    if ($("ivCopyCode")) $("ivCopyCode").onclick = () => cp("code");
  }
  async function claimTask(id) {
    IV.busy = id; IV.err[id] = undefined; renderInvite();
    let err = null;
    try {
      if (!W.account) throw new Error(T("Connect your wallet first.", "请先连接钱包。"));
      if (W.chainId !== BSC) { await switchToBsc(); if (W.chainId !== BSC) throw new Error(T("Switch to BNB Smart Chain", "请切换到 BNB Smart Chain")); }
      const r = await fetch(API + "/api/social", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address: W.account, task: id, tweetUrl: id === "TWEET" ? IV.url.trim() : undefined }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || T("Claim failed", "领取失败"));
      const sig = String(j.signature || "").replace(/^0x/, "");
      if (sig.length !== 130 || !/^0x[0-9a-f]{64}$/i.test(j.taskId) || !/^0x[0-9a-f]{64}$/i.test(j.account)) throw new Error(T("Claim failed", "领取失败"));
      const data = SEL.claimSocial + pad(j.taskId) + pad(j.account) + encU(j.deadline) + encU(128) + encU(65) + sig + "0".repeat(62);
      status(T("Confirm the task claim in your wallet…", "请在钱包中确认领取任务…"));
      const h = await send({ from: W.account, to: C.mint, data });
      status(T("Waiting for confirmation…", "等待确认…"));
      const ok = await waitTx(h);
      if (!ok) throw new Error(T("Transaction reverted on-chain.", "交易在链上失败。"));
      status(T("Task claimed: +1 share of quota.", "任务已领取：额度 +1。"), "ok");
      if (id === "TWEET") IV.url = "";
      await refreshWallet();
    } catch (e) { err = errText(e); status(""); }
    IV.busy = null; IV.err[id] = err || undefined;
    if ($("inviteModal").open) renderInvite();
  }
  function openInvite() { renderInvite(); const d = $("inviteModal"); if (!d.open) { if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", ""); } }
  function closeInvite() { const d = $("inviteModal"); if (d.open) { if (typeof d.close === "function") d.close(); else d.removeAttribute("open"); } }
  $("inviteBtn").onclick = openInvite;
  $("inviteModal").addEventListener("click", (e) => { if (e.target === $("inviteModal")) closeInvite(); });

  // ---------------------------------------------------------------- Leaderboard (same as jager.live: Invites / Mints / Holders, Day / Week, Top 100)
  const LBS = [{ key: "invites", title: () => T("Invites", "邀请"), unit: () => T("Invites", "邀请") }, { key: "mints", title: () => T("Mints", "铸造"), unit: () => T("Shares", "份数") }, { key: "holders", title: () => T("Holders", "持有"), unit: () => "BNAGENT" }];
  const LBV = { board: "invites", period: "day", data: null, err: false, timer: null };
  const big = (v) => { const r = Number(BigInt(v) / 10n ** 18n); return r >= 1e12 ? (r / 1e12).toFixed(2) + "T" : r >= 1e9 ? (r / 1e9).toFixed(2) + "B" : r >= 1e6 ? (r / 1e6).toFixed(2) + "M" : r.toLocaleString(); };
  function renderLb() {
    const d = LBV.data, b = LBS.find((x) => x.key === LBV.board);
    $("lbBoards").innerHTML = LBS.map((x) => `<button type="button" role="tab" aria-selected="${x.key === LBV.board}" class="${x.key === LBV.board ? "on" : ""}" data-b="${x.key}">${x.title()}</button>`).join("");
    $("lbPeriod").innerHTML = ["day", "week"].map((p) => `<button type="button" role="tab" aria-selected="${p === LBV.period}" class="${p === LBV.period ? "on" : ""}" data-p="${p}">${p === "day" ? T("Day", "日") : T("Week", "周")}</button>`).join("");
    $("lbBoards").querySelectorAll("button").forEach((x) => (x.onclick = () => { LBV.board = x.dataset.b; renderLb(); }));
    $("lbPeriod").querySelectorAll("button").forEach((x) => (x.onclick = () => { LBV.period = x.dataset.p; renderLb(); }));
    const sub = !d ? "" : LBV.board === "holders" ? (LBV.period === "day" ? T("Snapshot at 23:59 UTC · live until then", "UTC 23:59 快照 · 之前实时") : T("Snapshot Sunday 23:59 UTC · live until then", "周日 UTC 23:59 快照 · 之前实时")) : LBV.period === "day" ? T(`UTC day ${d.day}`, `UTC 日 ${d.day}`) : T(`UTC week from Monday ${d.week}`, `UTC 周（周一 ${d.week} 起）`);
    $("lbSub").textContent = "Top 100 · " + sub + (d && d.syncing ? T(" · catching up with BSC", " · 正在同步 BSC") : "");
    $("lbUnit").textContent = b.unit();
    const me = W.handle ? `${W.handle}.ai` : null;
    const rows = d ? (d.boards[LBV.board] || {})[LBV.period] || [] : [];
    let h = "";
    if (!d && !LBV.err) h = `<li class="lbmsg">${T("Loading…", "加载中…")}</li>`;
    else if (!d && LBV.err) h = `<li class="lbmsg">${T("Leaderboard unavailable right now.", "排行榜暂时不可用。")}</li>`;
    else if (!rows.length) h = `<li class="lbmsg">${T("Nobody on this board yet.", "榜单暂无人上榜。")}</li>`;
    else h = rows.map((r) => `<li class="lbrow${r.label === me ? " me" : ""}"><span class="rk${r.rank <= 3 ? " top" : ""}">${r.rank}</span><span class="nm">${diamond(r.level || 0)}${r.x ? `<a href="https://x.com/${esc(r.x)}" target="_blank" rel="noreferrer" title="@${esc(r.x)} on X"><span class="tr">${esc(r.label)}</span>${ICON_X2}</a>` : `<span class="tr">${esc(r.label)}</span>`}${r.label === me ? ` <span class="small">${T("· You", "· 你")}</span>` : ""}</span><span class="val">${LBV.board === "holders" ? big(r.value) : Number(r.value).toLocaleString()}</span></li>`).join("");
    $("lbList").innerHTML = h;
    $("lbList").setAttribute("aria-label", `Top ${b.key} this ${LBV.period}`);
  }
  async function loadLb() {
    try { const r = await fetch(API + "/api/leaderboard", { cache: "no-store" }); const j = await r.json(); if (!r.ok) throw new Error(j.error); LBV.data = j; LBV.err = false; }
    catch (e) { if (!LBV.data) LBV.err = true; }
    renderLb();
    clearTimeout(LBV.timer); LBV.timer = setTimeout(loadLb, LBV.data && !LBV.data.syncing ? 300000 : 60000);
  }

  // ---------------------------------------------------------------- Mint Pass (jager.live): Agent ID status, border badge, preview / share dialog
  const BORDERS = [
    { name: "Bronze", cn: "青铜", min: 0, color: "#b87333", metal: "linear-gradient(135deg,#5a2e12,#e3a272 22%,#ffd3ad 32%,#a8592a 50%,#f0b48a 66%,#6e3a17 84%,#d08a5c)" },
    { name: "Silver", cn: "白银", min: 7, color: "#c9d1d9", metal: "linear-gradient(135deg,#4b5563,#e5e7eb 20%,#ffffff 30%,#9ca3af 48%,#f3f4f6 64%,#6b7280 82%,#e5e7eb)" },
    { name: "Gold", cn: "黄金", min: 14, color: "#f0b90b", metal: "linear-gradient(135deg,#7a5300,#f5d36b 18%,#fff1b8 28%,#c98d00 45%,#ffe08a 62%,#a86f00 80%,#f5d36b)" },
    { name: "Platinum", cn: "铂金", min: 21, color: "#7fe0d0", metal: "linear-gradient(135deg,#1f5f58,#bff5ec 22%,#ffffff 32%,#5cc9b8 50%,#d8fff8 66%,#2f7f74 84%,#9fe9dc)" },
    { name: "Diamond", cn: "钻石", min: 28, color: "#6ec8ff", metal: "linear-gradient(135deg,#0d3d66,#b5e3ff 22%,#ffffff 32%,#3fa9f5 50%,#d6f0ff 66%,#145a8f 84%,#8fd3ff)" },
    { name: "Master", cn: "大师", min: 35, color: "#b57bff", metal: "linear-gradient(135deg,#3b1a66,#dcc2ff 22%,#ffffff 32%,#8d4dff 50%,#ecdcff 66%,#4e2490 84%,#c49cff)" },
    { name: "King", cn: "王者", min: 42, color: "#ff5a5f", metal: "linear-gradient(135deg,#6b0f12,#ffb3b5 22%,#ffffff 32%,#e0282e 50%,#ffd6d7 66%,#8f1418 84%,#ff8a8d)" },
  ];
  const PASS = { data: null, handle: null, xb: null, result: null, lang: lang === "zh" ? "cn" : "en", copied: false, xbBusy: false, xbErr: "", xbUrl: "" };
  const diamond = (lv) => { const b = BORDERS[lv] || BORDERS[0]; return `<span class="dia" title="${b.name} border" style="background:${b.color};box-shadow:0 0 6px ${b.color}88"><span class="sr">${b.name} border</span></span>`; };
  const badge = (lv) => `<span class="bdg">${diamond(lv)}${(BORDERS[lv] || BORDERS[0]).name}</span>`;
  async function loadPass() {
    const h = W.handle || null;
    if (!h) { PASS.data = null; PASS.xb = null; PASS.handle = null; return; }
    if (PASS.handle !== h) { PASS.data = null; PASS.xb = null; PASS.handle = h; }
    try { const r = await fetch(`${API}/api/pass?handle=${encodeURIComponent(h)}`, { cache: "no-store" }); if (r.ok) PASS.data = await r.json(); } catch (e) { /* API asleep: keep defaults */ }
    try { const r = await fetch(`${API}/api/x-bind?handle=${encodeURIComponent(h)}`, { cache: "no-store" }); if (r.ok) PASS.xb = await r.json(); } catch (e) { /* ignore */ }
    if (W.handle === h) { renderPassId(); if ($("inviteModal").open) renderInvite(); if ($("passModal").open) renderPassModal(); }
  }
  function renderPassId() {
    const name = $("pName"), line = $("pLine"), bd = $("pBadges"); if (!name) return;
    let n, l, dim = true;
    if (!W.account) { n = T("Wallet not connected", "钱包未连接"); l = T("Connect the Binance Agentic Wallet that holds your .ai Agent ID", "连接持有 .ai Agent ID 的币安 Agentic Wallet"); }
    else if (W.handle === null || (W.handle && !W.status && deployed)) { n = `<span class="spin" aria-hidden="true"></span>${T("Verifying", "验证中")}`; l = T("Looking up Agent ID on-chain…", "正在链上查询 Agent ID…"); }
    else if (!W.handle) { n = T("No Agent ID", "没有 Agent ID"); l = T("This address holds no .ai Agent ID and cannot mint", "该地址没有 .ai Agent ID，无法铸造"); }
    else { const st = W.status, left = Math.max(st.quota - st.minted, 0); n = esc(W.handle) + ".ai"; dim = false; l = T(`Agent ID verified · ${st.minted} of ${st.quota} shares used · ${left} left`, `Agent ID 已验证 · 已用 ${st.minted} / ${st.quota} 份 · 剩余 ${left}`); }
    name.innerHTML = n; name.classList.toggle("dim", dim); name.classList.toggle("big", !dim);
    line.textContent = l;
    const pd = PASS.data;
    bd.innerHTML = W.handle ? `${badge(pd ? pd.level : 0)}${pd ? `<span class="o7">${pd.points} pts</span>` : ""}${pd && pd.x ? `<span class="o8">@${esc(pd.x)}</span>` : ""}` : "";
    bd.style.display = W.handle ? "" : "none";
    const lv = BORDERS[(pd && pd.level) || 0];
    $("passBtn").textContent = W.handle && W.status && W.status.minted > 0 ? T(`Share your Mint Pass · ${lv.name} border`, `分享你的 Mint Pass · ${lv.cn}边框`) : T("Preview your Mint Pass", "预览你的 Mint Pass");
  }
  function passCard() {
    const pd = PASS.data, lv = Math.min(Math.max((pd && pd.level) || 0, 0), 6), b = BORDERS[lv];
    return { handle: W.handle || "yourname", x: (pd && pd.x) || null, minted: (W.status && W.status.minted) || 0, level: lv, points: (pd && pd.points) || 0, date: new Date().toISOString().slice(0, 10), b };
  }
  function postText(cn, c) {
    const id = `${c.handle}.ai`, link = `https://${SITE_HOST}/?ref=${id}`, x = c.x ? (cn ? `X：@${c.x}\n` : `X: @${c.x}\n`) : "";
    return cn
      ? `BNAGENT Mint Pass\n\nAgent：${id}\n${x}Border：${c.b.cn} ${c.b.name}\n\n只有币安 .ai Agent ID 可以铸造。\n继续铸造：${link}\n\nCA：${C.token}`
      : `My BNAGENT Mint Pass\n\nAgent: ${id}\n${x}Border: ${c.b.name}\n\nNo Binance .ai Agent ID, no mint.\nKeep minting: ${link}\n\nCA: ${C.token}`;
  }
  function cardHtml(c) {
    const rows = [["Agent", `${esc(c.handle)}.ai`], ["X", c.x ? "@" + esc(c.x) : "—"], ["Minted", `${c.minted} shares`], ["Border", `0${c.level + 1} / 07 ${c.b.name}`], ["Date", `${c.date} UTC`], ["Network", "BNB Chain"]];
    return `<div class="mp3d" id="mp3d" tabindex="0" role="img" aria-label="${c.b.name} BNAGENT card. Drag or use the arrow keys to rotate."><div class="mpglow" style="background:${c.b.color}"></div>
      <div class="mpcard" id="mpCard">
        <div class="mpface front" style="--metal:${c.b.metal}"><div class="mptop"><span>BNAGENT<br>GENESIS 2026</span><span class="mpcoin"></span><span class="r">TIER 0${c.level + 1}<br>${c.b.name.toUpperCase()}</span></div>
          <div class="mpwell"><div class="mpart"><div class="mpseal"><b>BNAGENT</b><i>2026</i></div><div class="mpplate"><b>BNAGENT</b><img src="assets/bnagent-mark-v3.svg" alt=""></div><div class="mptag">THE AI AGENT MINT<br>OF BNB CHAIN · ${esc(c.handle)}.ai</div><div class="mpholo"><b>BNAGENT</b><i>2026</i><em>${c.b.name.toUpperCase()}</em><small>COLLECTOR'S<br>EDITION</small></div></div></div>
          <div class="mpfoot"><span>BUILT FOR AGENTIC WALLETS · AGENT ID ONLY</span><span class="mono">${esc(c.handle)}.ai</span></div></div>
        <div class="mpface back" aria-hidden="true"><div class="mpback"><span class="mppill">${c.b.name.toUpperCase()} BORDER</span><img class="mplogo" src="assets/bnagent-lockup-v3.png" alt=""><span class="mpqr">${qrSvg("https://" + SITE_HOST)}</span><span class="mpscan">SCAN · ${SITE_HOST}</span>
          <dl>${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl><p>© 2026 BNAGENT · AI Agent mint on BNB Chain</p></div></div>
      </div></div>
      <div class="mpctl"><button type="button" class="chip" id="mpPause">${T("Pause", "暂停")}</button><button type="button" class="chip" id="mpFlip">${T("Flip", "翻面")}</button></div>`;
  }
  const SPIN = { angle: -20, vel: 0.03, auto: 0.03, paused: false, drag: false, lastX: 0, lastT: 0, tilt: 0, tTilt: 0, startY: 0, raf: 0 };
  function spinStart() {
    cancelAnimationFrame(SPIN.raf);
    if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) { SPIN.auto = 0; SPIN.angle = 0; }
    let t = performance.now();
    const f = (now) => {
      const dt = Math.min(now - t, 48); t = now;
      if (!SPIN.drag) { const g = SPIN.paused ? 0 : SPIN.auto; SPIN.vel += (g - SPIN.vel) * Math.min(1, 0.0025 * dt); SPIN.angle += SPIN.vel * dt; }
      SPIN.tilt += (SPIN.tTilt - SPIN.tilt) * Math.min(1, 0.008 * dt);
      const el = $("mpCard"); if (!el) return;
      el.style.transform = `rotateX(${SPIN.tilt}deg) rotateY(${SPIN.angle}deg)`;
      SPIN.raf = requestAnimationFrame(f);
    };
    SPIN.raf = requestAnimationFrame(f);
    const box = $("mp3d");
    box.onpointerdown = (e) => { Object.assign(SPIN, { drag: true, lastX: e.clientX, startY: e.clientY, lastT: performance.now(), vel: 0 }); box.setPointerCapture(e.pointerId); };
    box.onpointermove = (e) => { if (!SPIN.drag) return; const now = performance.now(), dx = e.clientX - SPIN.lastX; SPIN.angle += 0.5 * dx; SPIN.vel = (0.5 * dx) / Math.max(now - SPIN.lastT, 1); SPIN.tTilt = Math.max(-14, Math.min(14, (SPIN.startY - e.clientY) * 0.12)); SPIN.lastX = e.clientX; SPIN.lastT = now; };
    box.onpointerup = box.onpointercancel = () => { SPIN.drag = false; SPIN.tTilt = 0; };
    box.onkeydown = (e) => { if (e.key === "ArrowLeft") SPIN.angle -= 30; if (e.key === "ArrowRight") SPIN.angle += 30; };
    $("mpPause").onclick = () => { SPIN.paused = !SPIN.paused; $("mpPause").textContent = SPIN.paused ? T("Resume", "继续") : T("Pause", "暂停"); };
    $("mpFlip").onclick = () => (SPIN.angle += 180);
  }
  function renderPassModal() {
    const c = passCard(), preview = !W.handle, res = PASS.result, txt = postText(PASS.lang === "cn", c);
    const nx = BORDERS[c.level + 1], cur = BORDERS[c.level];
    const span = nx ? nx.min - cur.min : 1, prog = nx ? c.points - cur.min : 1;
    const title = res ? T("Mint successful", "铸造成功") : T("Your Mint Pass", "你的 Mint Pass");
    const sub = res ? T("Your BNAGENT is in your wallet. See the exact amount on BscScan.", "你的 BNAGENT 已到账，准确数量见 BscScan。") : preview ? T("Your Agent ID, X and border show here once you connect.", "连接后这里会显示你的 Agent ID、X 和边框。") : T("Share it on X with your invite link.", "带上你的邀请链接分享到 X。");
    $("passBody").innerHTML = `<button type="button" class="ivx pclose" id="passClose" aria-label="Close">✕</button>
      <div class="phd"><h2 id="pass-dialog-title">${title}</h2><p>${sub}</p></div>
      ${cardHtml(c)}
      <div class="bprog"><div class="bph"><span>${T(`${cur.name} border`, `${cur.cn}边框`)}</span><span class="mono">${c.points} ${c.points === 1 ? "point" : "points"}</span></div>
        <div class="bpbar" role="progressbar" aria-label="Progress to next border" aria-valuemin="0" aria-valuemax="${span}" aria-valuenow="${Math.min(prog, span)}"><i style="width:${Math.min(100, (prog / span) * 100)}%"></i></div>
        <p>${nx ? T(`${nx.min - c.points} more to ${nx.name}. Earn 1 point for each day board (Invites, Mints, Holders) where you finish in the Top 100.`, `再得 ${nx.min - c.points} 分升到${nx.cn}。每个 UTC 日在邀请、铸造、持有日榜进入前 100，各得 1 分。`) : T("Top border reached. This is the King card.", "已达最高边框，这是王者卡。")}</p></div>
      ${preview ? "" : `<div class="pshare"><div class="psh"><span>${T("Post text", "帖子文案")}</span><div class="tabs boxed" role="radiogroup" aria-label="Language"><button type="button" role="radio" aria-checked="${PASS.lang === "cn"}" class="${PASS.lang === "cn" ? "on" : ""}" data-pl="cn">中文</button><button type="button" role="radio" aria-checked="${PASS.lang === "en"}" class="${PASS.lang === "en" ? "on" : ""}" data-pl="en">EN</button></div></div>
        <pre class="ptext" id="passText">${esc(txt)}</pre>
        <div class="pgrid"><button type="button" class="pbtn" id="passPost">${T("Post on X", "发到 X")}</button><button type="button" class="cbtn" id="passCopy">${PASS.copied ? T("Copied", "已复制") : T("Copy text", "复制文案")}</button><button type="button" class="cbtn" id="passSave">${T("Save image", "保存图片")}</button></div>
        <p class="ivp">${T("Attach the saved image to your post. Then paste the post link under Invite & tasks to bind your X and claim the post task.", "把保存的图片附在帖子里，然后到「邀请与任务」粘贴帖子链接，绑定你的 X 并领取发帖任务。")}</p>
        ${res ? `<a class="ivp mono ctr" href="${C.explorer}/tx/${esc(res.txHash)}" target="_blank" rel="noreferrer">${T("View transaction on BscScan", "在 BscScan 查看交易")}</a>` : ""}</div>`}`;
    $("passClose").onclick = closePass;
    $("passBody").querySelectorAll("[data-pl]").forEach((b) => (b.onclick = () => { PASS.lang = b.dataset.pl; renderPassModal(); }));
    if ($("passPost")) $("passPost").onclick = () => window.open(`https://x.com/intent/post?text=${encodeURIComponent(txt)}`, "_blank", "noopener,noreferrer");
    if ($("passCopy")) $("passCopy").onclick = async () => { await copy(txt); PASS.copied = true; renderPassModal(); setTimeout(() => { PASS.copied = false; if ($("passModal").open) renderPassModal(); }, 1500); };
    if ($("passSave")) $("passSave").onclick = () => savePassImage(c);
    spinStart();
  }
  // Save image: draws the back of the card (border pill, logo, QR, details) on a canvas, 3× scale, PNG download
  async function savePassImage(c) {
    const W0 = 600, H0 = 1000, k = 3, cv = document.createElement("canvas"); cv.width = W0 * k; cv.height = H0 * k;
    const g = cv.getContext("2d"); g.scale(k, k);
    const rr = (x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
    g.fillStyle = "#0b0b0b"; rr(0, 0, W0, H0, 36); g.fill();
    g.strokeStyle = c.b.color; g.globalAlpha = 0.5; g.lineWidth = 3; rr(18, 18, W0 - 36, H0 - 36, 24); g.stroke(); g.globalAlpha = 1;
    g.font = "900 22px Arial"; const pill = `${c.b.name.toUpperCase()} BORDER`, pw = g.measureText(pill).width + 44;
    g.fillStyle = c.b.color; rr((W0 - pw) / 2, 56, pw, 42, 21); g.fill(); g.fillStyle = "#0b0b0b"; g.textAlign = "center"; g.fillText(pill, W0 / 2, 85);
    const img = new Image(); img.src = "assets/bnagent-lockup-v3.png";
    await new Promise((r) => { img.onload = r; img.onerror = r; });
    if (img.naturalWidth) { const w = 420, h = (img.naturalHeight / img.naturalWidth) * w; g.drawImage(img, (W0 - w) / 2, 140, w, h); }
    if (typeof window.qrcode === "function") { const q = window.qrcode(0, "M"); q.addData("https://" + SITE_HOST); q.make(); const n = q.getModuleCount(), size = 200, cell = size / n, x0 = (W0 - size) / 2, y0 = 300; g.fillStyle = "#fff"; rr(x0 - 14, y0 - 14, size + 28, size + 28, 14); g.fill(); g.fillStyle = "#0b0b0b"; for (let r = 0; r < n; r++) for (let cc = 0; cc < n; cc++) if (q.isDark(r, cc)) g.fillRect(x0 + cc * cell, y0 + r * cell, cell + 0.5, cell + 0.5); }
    g.fillStyle = c.b.color; g.font = "700 20px Arial"; g.fillText(`SCAN · ${SITE_HOST.toUpperCase()}`, W0 / 2, 560);
    const rows = [["AGENT", `${c.handle}.ai`], ["X", c.x ? "@" + c.x : "—"], ["MINTED", `${c.minted} shares`], ["BORDER", `0${c.level + 1} / 07 ${c.b.name}`], ["DATE", `${c.date} UTC`], ["NETWORK", "BNB Chain"]];
    g.textAlign = "left";
    rows.forEach(([kk, v], i) => { const x = i % 2 ? 320 : 60, y = 620 + Math.floor(i / 2) * 92; g.strokeStyle = "#ffffff26"; g.lineWidth = 2; g.beginPath(); g.moveTo(x, y); g.lineTo(x + 220, y); g.stroke(); g.fillStyle = "#ffffff80"; g.font = "600 15px Arial"; g.fillText(kk, x, y + 26); g.fillStyle = "#fff"; g.font = "700 24px Arial"; g.fillText(v.length > 16 ? v.slice(0, 15) + "…" : v, x, y + 58); });
    g.textAlign = "center"; g.fillStyle = "#ffffff73"; g.font = "600 14px Arial"; g.fillText("© 2026 BNAGENT · AI AGENT MINT ON BNB CHAIN", W0 / 2, 950);
    const a = document.createElement("a"); a.href = cv.toDataURL("image/png"); a.download = `BNAGENT-MintPass-${c.handle}.png`; a.click();
  }
  function openPass(result) { PASS.result = result || null; renderPassModal(); const d = $("passModal"); if (!d.open) { if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", ""); } }
  function closePass() { cancelAnimationFrame(SPIN.raf); const d = $("passModal"); if (d.open) { if (typeof d.close === "function") d.close(); else d.removeAttribute("open"); } }
  $("passBtn").onclick = () => openPass(null);
  $("passModal").addEventListener("click", (e) => { if (e.target === $("passModal")) closePass(); });
  $("passModal").addEventListener("close", () => cancelAnimationFrame(SPIN.raf));

  // ---------------------------------------------------------------- Bind X + Border season (sections of the Invite & tasks dialog, as on jager.live)
  // Wallet proof: Agentic Wallet (QR) sessions send {kind:"agent", clientId, sessionId}; browser wallets personal_sign the message below.
  async function proveWallet(action, handle) {
    if (W.rdns === AGENTIC && awStore.sid()) return { kind: "agent", clientId: awStore.cid(), sessionId: awStore.sid() };
    const time = new Date().toISOString();
    const msg = `${SITE_HOST}: ${action} X for ${handle}.ai\nWallet: ${W.account.toLowerCase()}\nTime: ${time}`;
    const hx = "0x" + [...new TextEncoder().encode(msg)].map((b) => b.toString(16).padStart(2, "0")).join("");
    return { kind: "sig", time, signature: await W.provider.request({ method: "personal_sign", params: [hx, W.account] }) };
  }
  async function xbind(action) {
    const h = W.handle; if (!h || !W.account) return;
    if (action === "unbind" && !window.confirm(T(`Unbind @${PASS.xb && PASS.xb.x}? You can bind an X account again after 7 days.`, `解绑 @${PASS.xb && PASS.xb.x}？7 天后才能再次绑定 X 账号。`))) return;
    PASS.xbBusy = true; PASS.xbErr = ""; renderInvite();
    try {
      const proof = await proveWallet(action, h);
      const r = await fetch(API + "/api/x-bind", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, address: W.account, tweetUrl: PASS.xbUrl, proof }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || T("Request failed", "请求失败"));
      PASS.xbUrl = ""; await loadPass();
    } catch (e) { PASS.xbErr = errText(e); }
    PASS.xbBusy = false; if ($("inviteModal").open) renderInvite();
  }
  const ICON_X2 = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';
  const ICON_MEDAL = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M7.21 15 2.66 7.14a2 2 0 0 1 .13-2.2L4.4 2.8A2 2 0 0 1 6 2h12a2 2 0 0 1 1.6.8l1.6 2.14a2 2 0 0 1 .14 2.2L16.79 15"/><path d="M11 12 5.12 2.2"/><path d="m13 12 5.88-9.8"/><path d="M8 7h8"/><circle cx="12" cy="17" r="5"/><path d="M12 18v-2h-.5"/></svg>';
  function bindXHtml() {
    const xb = PASS.xb, h = W.handle;
    let body;
    if (!W.account) body = `<button type="button" class="pbtn" id="xbConnect">${T("Connect to bind", "连接后绑定")}</button>`;
    else if (!h) body = "";
    else if (xb && xb.x) body = `<button type="button" class="cbtn" id="xbUnbind"${PASS.xbBusy ? " disabled" : ""}>${PASS.xbBusy ? "… " : ""}${T("Unbind", "解绑")} @${esc(xb.x)}</button>`;
    else body = `<div class="xbbox"><p class="ivp">${T(`Post your Mint Pass from the X account you want to bind (the post must include ${esc(h)}.ai), then paste the post link.`, `用你要绑定的 X 账号发布你的 Mint Pass（帖子须包含 ${esc(h)}.ai），然后粘贴帖子链接。`)}${xb && xb.cooldownMs ? T(` You can bind again in ${Math.ceil(xb.cooldownMs / 864e5)} day(s).`, ` ${Math.ceil(xb.cooldownMs / 864e5)} 天后可再次绑定。`) : ""}</p>
        <div class="xbrow"><input type="url" inputmode="url" id="xbUrl" value="${esc(PASS.xbUrl)}" placeholder="https://x.com/…/status/…" aria-label="Mint Pass post link"><button type="button" class="pbtn" id="xbBind"${PASS.xbBusy || !PASS.xbUrl.trim() || (xb && xb.cooldownMs) ? " disabled" : ""}>${PASS.xbBusy ? "… " : ""}${T("Bind", "绑定")}</button></div></div>`;
    return `<section class="ivsec" aria-labelledby="xbind-heading"><div class="ivh"><h3 id="xbind-heading">${ICON_X2}${T("Bind X", "绑定 X")}</h3>${xb && xb.x ? `<span class="cnt hl">@${esc(xb.x)}</span>` : ""}</div>
      <p class="ivp">${T("Shows your @X next to your .ai on the leaderboards and your Mint Pass. One X per Agent ID. After unbinding, wait 7 days to bind again. No quota reward.", "在排行榜和 Mint Pass 上，于你的 .ai 旁显示 @X。每个 Agent ID 只能绑定一个 X。解绑后需等待 7 天才能再次绑定。不奖励额度。")}</p>
      ${body}${PASS.xbErr ? `<span class="terr">${esc(PASS.xbErr)}</span>` : ""}</section>`;
  }
  function seasonHtml() {
    const pd = PASS.data, nx = pd ? BORDERS[pd.level + 1] : null;
    return `<section class="ivsec" aria-labelledby="border-heading"><div class="ivh"><h3 id="border-heading">${ICON_MEDAL}${T("Border season", "边框赛季")}</h3>${pd ? `<span class="cnt">${pd.points} pts${nx ? T(` · ${nx.min - pd.points} to ${nx.name}`, ` · 距${nx.cn}还差 ${nx.min - pd.points}`) : ""}</span>` : ""}</div>
      <p class="ivp">${T("Each UTC day, landing in the Top 100 of the Invites, Mints or Holders day board earns +1 point (up to 3 a day). Points never go down and borders only rise. Your border shows on your Mint Pass and on every board.", "每个 UTC 日，进入邀请、铸造或持有日榜前 100 各得 +1 分（每天最多 3 分）。积分只增不减，边框只升不降。你的边框会显示在 Mint Pass 和所有榜单上。")}</p>
      <ul class="borders">${BORDERS.map((b, i) => `<li class="${pd && pd.level === i ? "on" : ""}">${diamond(i)}<span>${lang === "zh" ? b.cn : b.name}</span><span class="mut">${b.min}</span></li>`).join("")}</ul></section>`;
  }
  function wireXb() {
    if ($("xbConnect")) $("xbConnect").onclick = () => { closeInvite(); openModal(); };
    if ($("xbUnbind")) $("xbUnbind").onclick = () => xbind("unbind");
    if ($("xbBind")) $("xbBind").onclick = () => xbind("bind");
    if ($("xbUrl")) $("xbUrl").oninput = (e) => { PASS.xbUrl = e.target.value; const b = $("xbBind"); if (b) b.disabled = PASS.xbBusy || !PASS.xbUrl.trim() || !!(PASS.xb && PASS.xb.cooldownMs); };
  }

  // wake the API (Render free instance sleeps after ~15 min idle) as early as possible; fire-and-forget
  try { fetch(API + "/", { mode: "no-cors", cache: "no-store" }).catch(() => {}); } catch (e) { /* ignore */ }

  setLang(lang);
  loadRef();
  loadLb();
  load();
  setTimeout(tryAutoReconnect, 400);
  setInterval(load, 15000);
  window.__bnagent = { W, walletList, AW, agenticProvider };
})();
