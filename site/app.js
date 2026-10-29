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
  let lang = qsLang === "zh" || qsLang === "en" ? qsLang : localStorage.getItem("bnagent-lang") || ((navigator.language || "").toLowerCase().startsWith("zh") ? "zh" : "en");
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
  }
  $("langBtn").onclick = () => setLang(lang === "en" ? "zh" : "en");

  // ---------------------------------------------------------------- price table (mirrors priceCents in the contract)
  const priceCents = (n) => (n <= 10000 ? 100 : n <= 20000 ? 110 + 10 * Math.floor((n - 10001) / 1000) : 210 + 2 * Math.floor((n - 20001) / 1000));
  function stepTable() {
    let h = `<table><thead><tr><th>${T("Shares", "份数")}</th><th>${T("Price (USDT)", "价格 (USDT)")}</th></tr></thead><tbody>`;
    h += `<tr data-from="1" data-to="1100" class="burned"><td>1 – 1,100</td><td>${T("burned at deploy (never sold)", "部署时销毁（不出售）")}</td></tr>`;
    h += `<tr data-from="1101" data-to="10000"><td>1,101 – 10,000</td><td>1.00</td></tr>`;
    for (let s = 10001; s <= 30000; s += 1000) h += `<tr data-from="${s}" data-to="${s + 999}"><td>${s.toLocaleString()} – ${(s + 999).toLocaleString()}</td><td>${(priceCents(s) / 100).toFixed(2)}</td></tr>`;
    $("stepTable").innerHTML = h + "</tbody></table>";
  }

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

  function tierName(n) {
    if (n <= 10000) return T("Tier 1 · 1.00 USDT", "第一档 · 1.00 USDT");
    if (n <= 20000) return T("Tier 2 · 1.10 → 2.00", "第二档 · 1.10 → 2.00");
    return T("Tier 3 · 2.10 → 2.28", "第三档 · 2.10 → 2.28");
  }
  const qty = () => Math.max(1, Math.min(10, parseInt($("qty").value || "1", 10) || 1));

  function render() {
    stepTable();
    $("notDeployed").style.display = deployed ? "none" : "block";
    const s = state;
    const BURNED = 1100, TOTAL = 30000;
    const progress = (m) => {
      $("sMinted").textContent = m.toLocaleString();
      $("sBar").style.width = (m / TOTAL * 100).toFixed(3) + "%"; // burned + minted, one gold bar
      $("sLegend").textContent = `Burned + Minted ${m.toLocaleString()} / ${TOTAL.toLocaleString()}`;
    };
    const dl = (d) => new Date(d * 1000).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    if (s) {
      const next = Math.min(s.minted + 1, TOTAL);
      progress(s.minted);
      $("sTier").textContent = s.minted >= TOTAL ? T("Sold out", "已售罄") : tierName(next);
      $("sNext").textContent = s.minted >= TOTAL ? "–" : "#" + next.toLocaleString();
      $("sPrice").textContent = s.nextCents ? (s.nextCents / 100).toFixed(2) + " USDT" : "–";
      if (!s.open) $("sGet").textContent = "50,000,000 BNAGENT";
      else if (s.u > 0n) $("sGet").textContent = "≈ " + fmt((BigInt(s.nextCents) * 10n ** 16n * s.t * 10000n) / (s.u * 9900n), 0) + " BNAGENT";
      $("sPool").textContent = s.open ? `${fmt(s.u)} USDT / ${fmt(s.t, 0)} BNAGENT` : T(`Opens automatically at share 10,000 (${(10000 - s.minted).toLocaleString()} to go)`, `第 10,000 份时自动开池（还差 ${(10000 - s.minted).toLocaleString()} 份）`);
      $("sPaused").textContent = s.paused ? T("Paused", "暂停中") : s.minted >= TOTAL ? T("Sold out", "已售罄") : T("Open", "开放中");
      document.querySelectorAll("#tierBody tr, #stepTable tr[data-from]").forEach((tr) => tr.classList.toggle("now", next >= +tr.dataset.from && next <= +tr.dataset.to));
    } else {
      progress(BURNED);
      if (deployed) { $("sMinted").textContent = "–"; $("sLegend").textContent = `Burned + Minted – / ${TOTAL.toLocaleString()}`; }
      $("sTier").textContent = tierName(1101); $("sNext").textContent = "#1,101"; $("sPrice").textContent = "1.00 USDT"; $("sGet").textContent = "50,000,000 BNAGENT";
      $("sPool").textContent = T("Opens automatically at share 10,000", "第 10,000 份时自动开池");
      $("sPaused").textContent = deployed ? "–" : T("Contracts not deployed", "合约未部署");
      document.querySelectorAll("#tierBody tr, #stepTable tr[data-from]").forEach((tr) => tr.classList.toggle("now", +tr.dataset.from === 1101));
    }
    updateCost();
    const row = (k, v) => `<div class="row"><span>${k}</span><span class="mono addr">${isAddr(v) ? `<a href="${C.explorer}/address/${v}" target="_blank" rel="noopener">${v}</a>` : T("not deployed yet", "尚未部署")}</span></div>`;
    $("addrBox").innerHTML = row(T("Mint contract", "铸造合约"), C.mint) + row(T("BNAGENT token", "BNAGENT 代币"), C.token) + row(T("BNAGENT/USDT pair", "BNAGENT/USDT 交易对"), C.pair) + row("USDT", C.usdt) + row(T("Agent ID registry", "Agent ID 注册表"), C.agentRegistry) + row(T("Treasury (Agentic Wallet)", "金库（Agentic Wallet）"), C.treasury);
    const sx = C.social || {};
    $("socialInfo").textContent = sx.x ? "X: @" + sx.x : "";
    renderWallet();
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
    renderMintButton();
  }
  $("qty").oninput = updateCost;
  $("payUsdt").onclick = () => { pay = "usdt"; $("payUsdt").classList.add("on"); $("payBnb").classList.remove("on"); updateCost(); };
  $("payBnb").onclick = () => { pay = "bnb"; $("payBnb").classList.add("on"); $("payUsdt").classList.remove("on"); updateCost(); };

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
  function resetWalletData() { W.handle = null; W.agentOk = false; W.status = null; W.bnb = null; W.usdt = null; }

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
    $("refBox").style.display = "none";
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
      try { const s = words(await call(C.mint, SEL.walletStatus + encA(a))); W.agentOk = s[0] === 1n; W.status = { minted: Number(s[2]), quota: Number(s[3]) }; } catch (e) { W.status = null; }
    } else W.agentOk = !!W.handle;
    if (a !== W.account) return;
    if (W.handle) { const link = `${location.origin}${location.pathname}?ref=${W.handle}.ai`; $("refBox").style.display = "block"; $("refBox").innerHTML = T("Your invite link: ", "你的邀请链接：") + `<code>${esc(link)}</code>`; }
    render();
  }

  function renderWallet() {
    const box = $("walletBox");
    if (!W.account) {
      box.innerHTML = `<div class="small">${T("Not connected. Connect the wallet that holds your .ai Agent ID.", "未连接。请连接持有 .ai Agent ID 的钱包。")}</div>`;
      $("connectBtn").style.display = "";
      $("disconnectBtn").style.display = "none";
      return;
    }
    $("connectBtn").style.display = "none";
    $("disconnectBtn").style.display = "";
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
    else if (s.minted >= 30000) label = T("Sold out", "已售罄");
    else if (s.mintable === 0) label = T("Minting ended", "铸造已结束");
    else if (W.status && W.status.quota - W.status.minted <= 0) label = T("Quota used · invite or do tasks", "额度已用完 · 邀请或做任务");
    else { label = T(`Mint ${qty()} share${qty() > 1 ? "s" : ""} · ${$("costOut").textContent.replace("≈ ", "")}`, `铸造 ${qty()} 份 · ${$("costOut").textContent.replace("≈ ", "")}`); ok = true; }
    b.textContent = label;
    b.disabled = !ok;
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
    const list = walletList();
    let h = `<h3>${T("Binance Wallet / Agent ID", "币安钱包 / Agent ID")}</h3>` +
      `<div class="wlist"><button class="wbtn bnqr" id="bnQrBtn" ${W.busy ? "disabled" : ""}><img class="wicon" src="assets/mark.svg" alt=""><span>${T("Binance Agentic Wallet (.ai Agent ID)", "币安 Agentic Wallet（.ai Agent ID）")}</span><em>${isMobile() ? T("open app", "打开 App") : T("scan QR", "扫码")}</em></button></div><div id="qrBox"></div>`;
    h += `<h3>${T("Browser wallets", "浏览器钱包")}</h3>`;
    if (list.length) {
      h += `<div class="wlist">` + list.map((w, i) => `<button class="wbtn" data-i="${i}" ${W.busy ? "disabled" : ""}>${w.icon && /^data:image\//.test(w.icon) ? `<img class="wicon" src="${esc(w.icon)}" alt="">` : `<span class="wicon ph">${esc(w.name[0] || "W")}</span>`}<span>${esc(w.name)}</span>${/binance/i.test(w.rdns + w.name) ? `<em>${T("recommended", "推荐")}</em>` : ""}</button>`).join("") + `</div>`;
    } else {
      h += `<p class="small">${T("No browser wallet detected. Install one, or open this page inside a wallet app:", "未检测到浏览器钱包。请安装钱包插件，或在钱包 App 内打开本页：")} <a href="https://www.binance.com/en/web3wallet" target="_blank" rel="noopener">Binance Wallet</a> · <a href="https://metamask.io/download/" target="_blank" rel="noopener">MetaMask</a> · <a href="https://www.okx.com/web3" target="_blank" rel="noopener">OKX Wallet</a></p>`;
    }
    h += `<h3>${T("On your phone", "手机钱包")}</h3><div class="wlist">` +
      deepLinks().map((d) => `<a class="wbtn" href="${esc(d.href)}" rel="noopener"><span class="wicon ph">${d.name[0]}</span><span>${T("Open in", "在")} ${d.name}${T("", " 中打开")}</span></a>`).join("") +
      `<button class="wbtn" id="copyUrl"><span class="wicon ph">B</span><span>${T("Binance App: copy link, then Wallet → Discover → paste", "币安 App：复制链接，到 钱包 → 发现 粘贴打开")}</span></button></div>`;
    h += `<h3>${T("Binance Agentic Wallet (AI agent)", "币安 Agentic Wallet（AI Agent）")}</h3>` +
      `<p class="small">${T("The Agentic Wallet is driven by your AI agent, not by a browser extension. Give your agent this prompt (it points to our llms.txt / agent.md):", "Agentic Wallet 由你的 AI Agent 操作，而不是浏览器插件。把下面这段提示词发给你的 Agent（指向本站 llms.txt / agent.md）：")}</p>` +
      `<textarea id="agentPrompt" readonly rows="5">${esc(agentPrompt())}</textarea>` +
      `<div class="btnrow"><button class="mini" id="copyPrompt">${T("Copy prompt", "复制提示词")}</button><a class="mini" href="llms.txt" target="_blank">llms.txt</a><a class="mini" href="agent.md" target="_blank">agent.md</a></div>` +
      `<pre class="cmd">baw contract-call preview --binanceChainId 56 --from &lt;wallet&gt; --to ${deployed ? C.mint : "&lt;mint, not deployed yet&gt;"} --value &lt;wei&gt; --inputData &lt;calldata&gt; --json
baw contract-call execute --requestId &lt;id&gt; --json</pre>` +
      `<p class="small">${T("Check an Agentic Wallet address (read-only):", "查询 Agentic Wallet 地址（只读）：")}</p>` +
      `<div class="ctrl"><input id="watchAddr" placeholder="0x…" spellcheck="false" style="width:100%;text-align:left"><button class="mini" id="watchBtn">${T("Check", "查询")}</button></div><div class="small" id="watchOut"></div>`;
    $("modalBody").innerHTML = h;
    $("bnQrBtn").onclick = startQr;
    renderQr();
    document.querySelectorAll("#modalBody .wbtn[data-i]").forEach((el) => (el.onclick = () => connectWith(list[+el.dataset.i])));
    $("copyUrl").onclick = () => copy(dappUrl(), $("copyUrl"));
    $("copyPrompt").onclick = () => copy(agentPrompt(), $("copyPrompt"));
    $("watchBtn").onclick = watchCheck;
  }
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
      } else {
        const need = words(await call(C.mint, SEL.bnbQuote + encU(q)))[0];
        const sendV = (need * 102n) / 100n;
        status(T("Confirm the mint in your wallet…", "请在钱包中确认铸造…"));
        const h = await send({ from: W.account, to: C.mint, value: "0x" + sendV.toString(16), data: SEL.mintWithBnb + encU(q) + encA(ref) + encU(sendV) });
        status(T("Waiting for confirmation…", "等待确认…"));
        const ok = await waitTx(h);
        status(ok ? T("Minted! Extra BNB was refunded.", "铸造成功！多余 BNB 已退回。") : T("Transaction reverted on-chain.", "交易在链上失败。"), ok ? "ok" : "bad");
      }
      load();
    } catch (e) { status(errText(e), "bad"); }
    finally { renderMintButton(); }
  };

  setLang(lang);
  loadRef();
  load();
  setTimeout(tryAutoReconnect, 400);
  setInterval(load, 15000);
  window.__bnagent = { W, walletList, AW, agenticProvider };
})();
