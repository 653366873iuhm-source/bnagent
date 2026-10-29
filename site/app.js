(() => {
  const C = window.BNAGENT_CONFIG;
  const $ = (id) => document.getElementById(id);
  const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || "");
  const deployed = isAddr(C.mint);
  let lang = new URLSearchParams(location.search).get("lang") === "zh" ? "zh" : (localStorage.getItem("bnagent-lang") || "en");
  let pay = "usdt", account = null, state = null, referrer = null;
  const T = (en, zh) => (lang === "zh" ? zh : en);

  function setLang(l) {
    lang = l; localStorage.setItem("bnagent-lang", l);
    document.body.className = "lang-" + l;
    document.documentElement.lang = l === "zh" ? "zh-CN" : "en";
    $("langBtn").textContent = l === "zh" ? "English" : "中文";
    render();
  }
  $("langBtn").onclick = () => setLang(lang === "en" ? "zh" : "en");

  // ---------------------------------------------------------------- price table (mirrors the contract)
  const priceCents = (n) => (n <= 10000 ? 100 : n <= 20000 ? 110 + 10 * Math.floor((n - 10001) / 1000) : 210 + 2 * Math.floor((n - 20001) / 1000));
  function stepTable() {
    let h = `<table><thead><tr><th>${T("Shares", "份数")}</th><th>${T("Price (USDT)", "价格 (USDT)")}</th></tr></thead><tbody>`;
    h += `<tr data-from="1" data-to="10000"><td>1 – 10,000</td><td>1.00</td></tr>`;
    for (let s = 10001; s <= 30000; s += 1000) h += `<tr data-from="${s}" data-to="${s + 999}"><td>${s.toLocaleString()} – ${(s + 999).toLocaleString()}</td><td>${(priceCents(s) / 100).toFixed(2)}</td></tr>`;
    $("stepTable").innerHTML = h + "</tbody></table>";
  }

  // ---------------------------------------------------------------- minimal JSON-RPC / ABI
  const pad = (hex) => hex.replace(/^0x/, "").padStart(64, "0");
  const encU = (n) => pad(BigInt(n).toString(16));
  const encA = (a) => pad(a.toLowerCase());
  function encString(s) {
    const b = new TextEncoder().encode(s);
    let hex = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    hex = hex.padEnd(Math.ceil(hex.length / 64) * 64 || 64, "0");
    return encU(32) + encU(b.length) + hex;
  }
  const words = (hex) => (hex.replace(/^0x/, "").match(/.{64}/g) || []).map((w) => BigInt("0x" + w));
  async function rpc(method, params) {
    for (const url of C.rpc) {
      try {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        const j = await r.json();
        if (j.result !== undefined) return j.result;
      } catch (e) { /* next */ }
    }
    throw new Error("rpc");
  }
  const call = (to, data) => rpc("eth_call", [{ to, data }, "latest"]);
  const fmt = (wei, dp = 2) => (Number(wei) / 1e18).toLocaleString(undefined, { maximumFractionDigits: dp });
  const short = (a) => a.slice(0, 6) + "…" + a.slice(-4);

  // ---------------------------------------------------------------- state
  async function load() {
    if (!deployed) { render(); return; }
    try {
      const w = words(await call(C.mint, "0x3a2056f1"));
      state = { minted: Number(w[0]), paid: w[1], paused: w[2] === 1n, open: w[3] === 1n, nextCents: Number(w[4]), u: w[5], t: w[6], supply: w[7], circ: w[8], line: w[9] };
    } catch (e) { state = null; }
    render();
    if (account) loadWallet();
  }

  function tierName(n) {
    if (n <= 10000) return T("Tier 1 · 1.00 USDT", "第一档 · 1.00 USDT");
    if (n <= 20000) return T("Tier 2 · 1.10 → 2.00", "第二档 · 1.10 → 2.00");
    return T("Tier 3 · 2.10 → 2.28", "第三档 · 2.10 → 2.28");
  }

  function render() {
    stepTable();
    $("notDeployed").style.display = deployed ? "none" : "block";
    const s = state;
    if (s) {
      const next = Math.min(s.minted + 1, 30000);
      $("sMinted").textContent = `${s.minted.toLocaleString()} / 30,000`;
      $("sBar").style.width = (s.minted / 300).toFixed(2) + "%";
      $("sTier").textContent = s.minted >= 30000 ? T("Sold out", "已售罄") : tierName(next);
      $("sNext").textContent = s.minted >= 30000 ? "–" : "#" + next.toLocaleString();
      $("sPrice").textContent = s.nextCents ? (s.nextCents / 100).toFixed(2) + " USDT" : "–";
      if (!s.open) $("sGet").textContent = "50,000,000 BNAGENT";
      else if (s.u > 0n) $("sGet").textContent = "≈ " + fmt((BigInt(s.nextCents) * 10n ** 16n * s.t * 10000n) / (s.u * 9900n), 0) + " BNAGENT";
      $("sPool").textContent = s.open ? `${fmt(s.u)} USDT / ${fmt(s.t, 0)} BNAGENT` : T(`Opens at share 10,000 (${(10000 - s.minted).toLocaleString()} to go)`, `第 10,000 份时开池（还差 ${(10000 - s.minted).toLocaleString()} 份）`);
      $("sPaused").textContent = s.paused ? T("Paused", "暂停中") : T("Open", "开放中");
      document.querySelectorAll("#tierBody tr, #stepTable tr[data-from]").forEach((tr) => tr.classList.toggle("now", next >= +tr.dataset.from && next <= +tr.dataset.to));
    } else {
      $("sTier").textContent = tierName(1); $("sNext").textContent = "#1"; $("sPrice").textContent = "1.00 USDT"; $("sGet").textContent = "50,000,000 BNAGENT";
      $("sPool").textContent = T("Opens at share 10,000", "第 10,000 份时开池"); $("sPaused").textContent = deployed ? "–" : T("Not deployed", "未部署");
      document.querySelectorAll("#tierBody tr, #stepTable tr[data-from]").forEach((tr) => tr.classList.toggle("now", +tr.dataset.from === 1));
    }
    updateCost();
    // addresses
    const row = (k, v) => `<div class="row"><span>${k}</span><span class="mono addr">${isAddr(v) ? `<a href="${C.explorer}/address/${v}" target="_blank" rel="noopener">${v}</a>` : T("not deployed yet", "尚未部署")}</span></div>`;
    $("addrBox").innerHTML = row(T("Mint contract", "铸造合约"), C.mint) + row(T("BNAGENT token", "BNAGENT 代币"), C.token) + row(T("BNAGENT/USDT pair", "BNAGENT/USDT 交易对"), C.pair) + row("USDT", C.usdt) + row(T("Agent ID registry", "Agent ID 注册表"), C.agentRegistry) + row(T("Treasury (Agentic Wallet)", "金库（Agentic Wallet）"), C.treasury);
    const sx = C.social || {};
    $("socialInfo").textContent = sx.x || sx.telegram ? [sx.x ? "X: @" + sx.x : "", sx.telegram ? "Telegram: " + sx.telegram : ""].filter(Boolean).join(" · ") : T("Official X / Telegram accounts will be announced.", "官方 X / Telegram 账号待公布。");
    $("mintBtn").disabled = !(deployed && account && state && !state.paused && state.minted < 30000);
  }

  async function updateCost() {
    const q = Math.max(1, Math.min(10, parseInt($("qty").value || "1", 10)));
    let cents = 0; const start = state ? state.minted : 0;
    for (let i = 1; i <= q; i++) cents += priceCents(start + i);
    let txt = (cents / 100).toFixed(2) + " USDT";
    if (pay === "bnb" && deployed) {
      try { const w = words(await call(C.mint, "0x68bce8cd" + encU(q))); txt = fmt(w[0], 6) + " BNB"; } catch (e) { txt += " (BNB)"; }
    }
    $("costOut").textContent = "≈ " + txt;
  }
  $("qty").oninput = updateCost;
  $("payUsdt").onclick = () => { pay = "usdt"; $("payUsdt").classList.add("on"); $("payBnb").classList.remove("on"); updateCost(); };
  $("payBnb").onclick = () => { pay = "bnb"; $("payBnb").classList.add("on"); $("payUsdt").classList.remove("on"); updateCost(); };

  // ---------------------------------------------------------------- referral ?ref=<handle>.ai
  async function loadRef() {
    const raw = (new URLSearchParams(location.search).get("ref") || "").toLowerCase().trim();
    if (!raw) return;
    const label = raw.replace(/\.ai$/, "");
    if (!/^[a-z0-9]{3,20}$/.test(label)) return;
    try {
      const w = words(await call(C.agentRegistry, "0x1da94fb4" + encString(label)));
      const a = "0x" + w[0].toString(16).padStart(40, "0");
      if (w[0] !== 0n) { referrer = a; $("refInfo").textContent = T(`Invited by ${label}.ai`, `邀请人：${label}.ai`); }
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------- wallet
  const status = (msg, cls = "") => { $("status").textContent = msg; $("status").className = "status " + cls; };
  async function loadWallet() {
    try {
      const h = await call(C.agentRegistry, "0xc50a1514" + encA(account));
      const w = words(h); let handle = "";
      if (w.length >= 2 && w[1] > 0n) { const hex = h.replace(/^0x/, "").slice(128, 128 + Number(w[1]) * 2); handle = new TextDecoder().decode(new Uint8Array(hex.match(/.{2}/g).map((x) => parseInt(x, 16)))); }
      let txt = `${short(account)} · ${handle ? handle + ".ai" : T("no .ai Agent ID", "无 .ai Agent ID")}`;
      if (deployed) {
        const s = words(await call(C.mint, "0x4d6d0af8" + encA(account)));
        if (s[0] === 1n) txt += T(` · minted ${s[2]} / ${s[3]}`, ` · 已铸 ${s[2]} / ${s[3]}`);
      }
      $("walletInfo").textContent = txt;
      if (handle) { const link = `${location.origin}${location.pathname}?ref=${handle}.ai`; $("refBox").style.display = "block"; $("refBox").innerHTML = T("Your invite link: ", "你的邀请链接：") + `<code>${link}</code>`; }
    } catch (e) { $("walletInfo").textContent = short(account); }
  }
  $("connectBtn").onclick = async () => {
    if (!window.ethereum) return status(T("Open this page in the Binance Agentic Wallet / a Web3 wallet browser.", "请在币安 Agentic Wallet 或 Web3 钱包浏览器中打开本页。"), "bad");
    try {
      [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
      const cid = await window.ethereum.request({ method: "eth_chainId" });
      if (parseInt(cid, 16) !== 56) { try { await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x38" }] }); } catch (e) { return status(T("Switch to BNB Smart Chain.", "请切换到 BNB Smart Chain。"), "bad"); } }
      status(""); loadWallet(); render();
    } catch (e) { status(T("Connection rejected.", "已拒绝连接。"), "bad"); }
  };
  async function waitTx(hash) {
    for (let i = 0; i < 90; i++) { await new Promise((r) => setTimeout(r, 2000)); const rc = await rpc("eth_getTransactionReceipt", [hash]).catch(() => null); if (rc) return rc.status === "0x1"; }
    return false;
  }
  $("mintBtn").onclick = async () => {
    const q = Math.max(1, Math.min(10, parseInt($("qty").value || "1", 10)));
    const ref = referrer && referrer.toLowerCase() !== account.toLowerCase() ? referrer : "0x0000000000000000000000000000000000000000";
    try {
      if (pay === "usdt") {
        const cost = words(await call(C.mint, "0xed1bd76c" + encU(q)))[0];
        const max = (cost * 102n) / 100n;
        const allow = words(await call(C.usdt, "0xdd62ed3e" + encA(account) + encA(C.mint)))[0];
        if (allow < max) {
          status(T("Approve USDT in your wallet…", "请在钱包中授权 USDT…"));
          const h = await window.ethereum.request({ method: "eth_sendTransaction", params: [{ from: account, to: C.usdt, data: "0x095ea7b3" + encA(C.mint) + encU(max) }] });
          if (!(await waitTx(h))) return status(T("Approval failed.", "授权失败。"), "bad");
        }
        status(T("Confirm the mint in your wallet…", "请在钱包中确认铸造…"));
        const h = await window.ethereum.request({ method: "eth_sendTransaction", params: [{ from: account, to: C.mint, data: "0x836a1040" + encU(q) + encA(ref) + encU(max) }] });
        status(T("Waiting for confirmation…", "等待确认…"));
        const ok = await waitTx(h);
        status(ok ? T("Minted!", "铸造成功！") : T("Transaction failed.", "交易失败。"), ok ? "ok" : "bad");
      } else {
        const need = words(await call(C.mint, "0x68bce8cd" + encU(q)))[0];
        const send = (need * 102n) / 100n;
        status(T("Confirm the mint in your wallet…", "请在钱包中确认铸造…"));
        const h = await window.ethereum.request({ method: "eth_sendTransaction", params: [{ from: account, to: C.mint, value: "0x" + send.toString(16), data: "0xe38fd349" + encU(q) + encA(ref) + encU(send) }] });
        status(T("Waiting for confirmation…", "等待确认…"));
        const ok = await waitTx(h);
        status(ok ? T("Minted! Extra BNB was refunded.", "铸造成功！多余 BNB 已退回。") : T("Transaction failed.", "交易失败。"), ok ? "ok" : "bad");
      }
      load();
    } catch (e) { status((e && e.message) || T("Cancelled.", "已取消。"), "bad"); }
  };

  if (C.repo) $("repoLink").href = C.repo;
  setLang(lang);
  loadRef();
  load();
  setInterval(load, 15000);
})();
