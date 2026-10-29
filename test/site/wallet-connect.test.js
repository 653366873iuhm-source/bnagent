// Headless wallet-connect test for site/ (playwright-core 1.49 + chromium headless shell).
// Usage: node wallet-connect.test.js [siteDir] [liveUrl]. Expects a ./libs dir with missing chromium deps when run in the Hark sandbox.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const exe = require('child_process').execSync("find ~/.cache/ms-playwright/chromium_headless_shell-1148 -name headless_shell -type f").toString().trim();
const ROOT = process.argv[2] || '/workspace/work/bnagent/site';
const BASE = process.argv[3]; // optional: test a live URL instead of a local server
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain', '.md': 'text/markdown' };
const srv = http.createServer((q, r) => { let f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); }); });
const ADDR = '0x49E6fb3812fdfD67eDfE17259f03CcbE59f39BCE'; // test fixture: a wallet holding allin168.ai on BSC (not the treasury; treasury = 0x8663…d8AE iuhm.ai)
const TREASURY = '0x866396d4aee9467b67194431bdbDdE8E8044d8AE'; // iuhm.ai Agentic Wallet
const MINT = '0xD6aFC30810B001CfA5306A2C54b5E6559DfC9Cf0';
const mock = (addr) => `(() => {
  const calls = []; window.__calls = calls; let chain = '0x1'; let added = false; const ls = {};
  const p = { isMetaMask: true, request: async ({ method, params }) => { calls.push(method);
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return ['${addr}'];
      if (method === 'eth_chainId') return chain;
      if (method === 'wallet_switchEthereumChain') { if (!added) { const e = new Error('Unrecognized chain'); e.code = 4902; throw e; } chain = params[0].chainId; (ls.chainChanged||[]).forEach(f => f(chain)); return null; }
      if (method === 'wallet_addEthereumChain') { added = true; chain = params[0].chainId; (ls.chainChanged||[]).forEach(f => f(chain)); return null; }
      if (method === 'wallet_revokePermissions') return null;
      throw Object.assign(new Error('unsupported ' + method), { code: 4200 }); },
    on: (ev, f) => { (ls[ev] = ls[ev] || []).push(f); }, removeListener: (ev, f) => { ls[ev] = (ls[ev]||[]).filter(x => x !== f); } };
  window.ethereum = p;
  const info = { uuid: 'mock-uuid-1', name: 'Mock Wallet', icon: 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22/>', rdns: 'test.mock.wallet' };
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider: p }) }));
  window.addEventListener('eip6963:requestProvider', announce); announce();
})();`;
const results = []; const ok = (name, cond, extra = '') => { results.push([cond ? 'PASS' : 'FAIL', name, extra]); };
(async () => {
  let base = BASE;
  const LOCAL = !base; if (!base) base = 'https://bnagent.local.test/';
  const px = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  let proxy; if (px) { const u = new URL(px); proxy = { server: `${u.protocol}//${u.host}`, }; if (u.username) { proxy.username = decodeURIComponent(u.username); proxy.password = decodeURIComponent(u.password); } }
  console.log('browser proxy:', proxy ? 'from env' : 'none');
  const b0 = await chromium.launch({ executablePath: exe, proxy, env: { ...process.env, LD_LIBRARY_PATH: __dirname + '/libs' } });
  // serve the local site under a fake https origin (the sandbox proxy cannot reach 127.0.0.1)
  const b = { close: () => b0.close(), newContext: async (o) => { const c = await b0.newContext(o); if (LOCAL) await c.route('https://bnagent.local.test/**', (route) => {
      let f = path.join(ROOT, decodeURIComponent(new URL(route.request().url()).pathname)); if (f.endsWith('/')) f += 'index.html';
      if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
      route.fulfill({ status: 200, contentType: types[path.extname(f)] || 'application/octet-stream', body: fs.readFileSync(f) }); }); return c; } };
  // --- 1: no wallet installed
  {
    const ctx = await b.newContext(); const pg = await ctx.newPage(); const errs = [];
    pg.on('console', m => { if (m.type() === 'error') errs.push(m.text()); }); pg.on('pageerror', e => errs.push(String(e)));
    await pg.goto(base + '?lang=zh', { waitUntil: 'networkidle' });
    ok('no-wallet: page loads without console errors', errs.length === 0, errs.join(' | '));
    ok('no-wallet: mint button asks to connect (contracts deployed)', (await pg.textContent('#mintBtn')).includes('连接钱包后铸造'));
    ok('no-wallet: addresses card shows mint + treasury', (await pg.textContent('#addrBox')).includes(MINT) && (await pg.textContent('#addrBox')).includes(TREASURY));
    await pg.waitForFunction(() => /\d/.test(document.getElementById('sMinted').textContent) && document.getElementById('sPaused').textContent !== '–', null, { timeout: 20000 }).catch(() => {});
    ok('no-wallet: live supply >= 1,100 / 100,000,000 and mint state', +(await pg.textContent('#sMinted')).trim().replace(/,/g, '') >= 1100 && /暂停|开放|售罄/.test(await pg.textContent('#sPaused')), (await pg.textContent('#sMinted')) + ' ' + (await pg.textContent('#sPaused')));
    await pg.click('#connectBtn');
    const body = await pg.textContent('#modalBody');
    ok('no-wallet: chooser opens and says no wallet detected', body.includes('未检测到浏览器钱包'));
    ok('no-wallet: chooser has mobile deep links', (await pg.$$('#modalBody a.wbtn')).length === 3);
    ok('no-wallet: chooser has agent prompt with llms.txt', (await pg.inputValue('#agentPrompt')).includes('llms.txt'));
    await pg.fill('#watchAddr', ADDR); await pg.click('#watchBtn');
    await pg.waitForFunction(() => /allin168|无 \.ai|失败/.test(document.getElementById('watchOut').textContent), null, { timeout: 20000 }).catch(() => {});
    const w = await pg.textContent('#watchOut');
    ok('no-wallet: read-only Agent ID check works', w.includes('allin168.ai') && w.includes('已铸'), w);
    await pg.screenshot({ path: __dirname + '/shot-nowallet-modal.png', fullPage: false });
    await ctx.close();
  }
  // --- 2: injected mock wallet via EIP-6963, starts on Ethereum (0x1), BSC not added -> add + switch
  {
    const ctx = await b.newContext(); await ctx.addInitScript(mock(ADDR)); const pg = await ctx.newPage(); const errs = [];
    pg.on('console', m => { if (m.type() === 'error') errs.push(m.text()); }); pg.on('pageerror', e => errs.push(String(e)));
    await pg.goto(base + '?lang=en', { waitUntil: 'networkidle' });
    await pg.click('#connectBtn');
    const names = await pg.$$eval('#modalBody .wbtn[data-i]', els => els.map(e => e.textContent));
    ok('mock: chooser lists the EIP-6963 wallet once (deduped with window.ethereum)', names.length === 1 && names[0].includes('Mock Wallet'), JSON.stringify(names));
    await pg.click('#modalBody .wbtn[data-i="0"]');
    await pg.waitForFunction(() => /allin168\.ai/.test(document.getElementById('walletBox').textContent), null, { timeout: 20000 }).catch(() => {});
    const wb = await pg.textContent('#walletBox');
    const calls = await pg.evaluate(() => window.__calls);
    ok('mock: modal closed after connect', !(await pg.evaluate(() => document.getElementById('walletModal').open)));
    ok('mock: shows address', wb.includes('0x49E6…9BCE'), wb);
    ok('mock: switched to BSC via wallet_addEthereumChain after 4902', calls.includes('wallet_switchEthereumChain') && calls.includes('wallet_addEthereumChain') && wb.includes('BNB Smart Chain (56)'), calls.join(','));
    ok('mock: shows Agent ID from registry', wb.includes('allin168.ai'), wb);
    await pg.waitForFunction(() => /minted \d+ \/ quota/.test(document.getElementById('walletBox').textContent), null, { timeout: 20000 }).catch(() => {});
    ok('mock: shows live mint status from walletStatus', /minted \d+ \/ quota \d+/.test(await pg.textContent('#walletBox')));
    await pg.waitForFunction(() => /paused|Mint \d/.test(document.getElementById('mintBtn').textContent), null, { timeout: 20000 }).catch(() => {});
    ok('mock: mint button reflects paused state', (await pg.textContent('#mintBtn')).includes('Minting is paused') ? await pg.isDisabled('#mintBtn') : /Mint \d/.test(await pg.textContent('#mintBtn')), await pg.textContent('#mintBtn'));
    await pg.screenshot({ path: __dirname + '/shot-connected.png', fullPage: false });
    // reload: silent auto-reconnect via eth_accounts
    await pg.reload({ waitUntil: 'networkidle' });
    await pg.waitForFunction(() => /0x49E6/.test(document.getElementById('walletBox').textContent), null, { timeout: 10000 }).catch(() => {});
    ok('mock: auto-reconnects after reload without prompting', (await pg.textContent('#walletBox')).includes('0x49E6…9BCE') && !(await pg.evaluate(() => window.__calls)).includes('eth_requestAccounts'));
    await pg.click('#disconnectBtn');
    ok('mock: disconnect clears the session', (await pg.textContent('#walletBox')).includes('Not connected'));
    ok('mock: no console errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  // --- 3: Binance Agentic Wallet (.ai Agent ID) QR connect, desktop. The proxy is mocked: login -> QR, confirm CONNECTING then CONNECTED,
  //        query CREATED, wallets -> chain 56 address. Then a mocked eth_sendTransaction goes through preview/execute.
  const awMock = async (ctx, seen) => {
    let confirms = 0, executes = 0;
    await ctx.route('**/api/agent-wallet', async (route) => {
      const req = route.request();
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' } });
      const { action, body } = JSON.parse(req.postData() || '{}'); seen.push(action);
      const R = (data, sessionId = null) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ sessionId, data: { code: '000000', data, ...(action === 'login' ? { extra: { pairingCode: 'ab1cd2' } } : {}) } }) });
      if (action === 'login') return R({ connectionStatus: 'UNCONNECTED', qrInfo: { qrCodeUrl: 'https://app.binance.com/uni-qr/TESTqr01', qrCodeId: 'qr-1', expireAt: String(Date.now() + 300000) } });
      if (action === 'confirm') return R({ connectionStatus: ++confirms < 2 ? 'CONNECTING' : 'CONNECTED' }, confirms >= 2 ? 'agentSessionId=test-session' : null);
      if (action === 'query') return R({ connectionStatus: 'CONNECTED', walletCreateStatus: 'CREATED' });
      if (action === 'wallets') return R([{ subWalletList: [{ curve: 'secp256k1', addresses: [{ binanceChainId: '56', address: ADDR }] }] }]);
      if (action === 'preview') { seen.push('preview:' + body.binanceChainId + ':' + body.to); return R({ requestId: 'req-1' }); }
      if (action === 'execute') return R(++executes < 2 ? { status: 'PENDING' } : { txHash: '0x' + 'ab'.repeat(32) });
      if (action === 'logout') return R({});
      return route.fulfill({ status: 400, body: '{}' });
    });
  };
  {
    const ctx = await b.newContext(); const seen = []; await awMock(ctx, seen); const pg = await ctx.newPage(); const errs = [];
    pg.on('console', m => { if (m.type() === 'error') errs.push(m.text()); }); pg.on('pageerror', e => errs.push(String(e)));
    await pg.goto(base + '?lang=en', { waitUntil: 'networkidle' });
    await pg.click('#connectBtn');
    ok('qr: chooser shows the Binance Agentic Wallet (.ai Agent ID) option first', (await pg.textContent('#modalBody h3')).includes('Binance Wallet / Agent ID') && (await pg.isVisible('#bnQrBtn')));
    await pg.click('#bnQrBtn');
    await pg.waitForSelector('#qrBox .qrwrap svg', { timeout: 10000 }).catch(() => {});
    const qrHtml = await pg.innerHTML('#qrBox').catch(() => '');
    ok('qr: desktop shows a QR code + pairing code', /<svg/.test(qrHtml) && qrHtml.includes('ab1cd2') && !qrHtml.includes('bnOpenApp'), qrHtml.slice(0, 200));
    await pg.screenshot({ path: __dirname + '/shot-qr.png', fullPage: false });
    await pg.waitForFunction(() => /0x49E6/.test(document.getElementById('walletBox').textContent), null, { timeout: 25000 }).catch(() => {});
    const wb = await pg.textContent('#walletBox');
    ok('qr: connects the Agentic Wallet on BSC (chainId 56) after confirm/query/wallets', wb.includes('Agentic Wallet') && wb.includes('0x49E6…9BCE') && wb.includes('BNB Smart Chain (56)'), wb + ' | ' + seen.join(','));
    ok('qr: Agent ID resolved for the Agentic Wallet', /allin168\.ai/.test(await pg.textContent('#walletBox')) || await pg.waitForFunction(() => /allin168\.ai/.test(document.getElementById('walletBox').textContent), null, { timeout: 15000 }).then(() => true).catch(() => false));
    ok('qr: session id stored for later calls', (await pg.evaluate(() => sessionStorage.getItem('bnagent-aw-sid'))) === 'agentSessionId=test-session');
    const tx = await pg.evaluate(async (a) => window.__bnagent.agenticProvider.request({ method: 'eth_sendTransaction', params: [{ from: a, to: '0x55d398326f99059fF775485246999027B3197955', data: '0x095ea7b3', gas: '0x30d40' }] }), ADDR).catch(e => 'ERR ' + e.message);
    ok('qr: eth_sendTransaction -> preview (chain 56) -> execute polled until txHash', tx === '0x' + 'ab'.repeat(32) && seen.includes('preview:56:0x55d398326f99059fF775485246999027B3197955'), String(tx));
    await pg.reload({ waitUntil: 'networkidle' });
    await pg.waitForFunction(() => /0x49E6/.test(document.getElementById('walletBox').textContent), null, { timeout: 10000 }).catch(() => {});
    ok('qr: Agentic Wallet session restored after reload', (await pg.textContent('#walletBox')).includes('0x49E6…9BCE'));
    await pg.click('#disconnectBtn');
    ok('qr: disconnect clears the Agentic session', (await pg.textContent('#walletBox')).includes('Not connected') && !(await pg.evaluate(() => sessionStorage.getItem('bnagent-aw-addr'))));
    ok('qr: no console errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  // --- 4: same option on a phone: deep link into the Binance App (the QR URL is a Binance universal link)
  {
    const ctx = await b.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const seen = []; await awMock(ctx, seen); const pg = await ctx.newPage();
    await pg.goto(base + '?lang=en', { waitUntil: 'networkidle' });
    await pg.click('#connectBtn');
    await pg.click('#bnQrBtn');
    await pg.waitForSelector('#bnOpenApp', { timeout: 10000 }).catch(() => {});
    const href = await pg.getAttribute('#bnOpenApp', 'href').catch(() => null);
    ok('qr-mobile: shows "Open in Binance App" deep link to the sign-in URL', href === 'https://app.binance.com/uni-qr/TESTqr01', String(href));
    await pg.screenshot({ path: __dirname + '/shot-qr-mobile.png', fullPage: false });
    await ctx.close();
  }
  // --- 5: branding + supply bar
  {
    const ctx = await b.newContext(); const pg = await ctx.newPage();
    await pg.goto(base + '?lang=en', { waitUntil: 'networkidle' });
    const logoOk = await pg.evaluate(async () => { const img = document.querySelector('header img'); return !!img && img.complete && img.naturalWidth > 0 && /assets\/bnagent-lockup-v3\.png/.test(img.src); });
    ok('brand: header logo loads and is the v3 lockup (woven chevron A mark + BNAGENT)', logoOk);
    const og = await pg.getAttribute('meta[property="og:image"]', 'content');
    ok('brand: og:image on bnagent.onrender.com', og === 'https://bnagent.onrender.com/assets/og-v3.png', og);
    const sup = await pg.evaluate(() => ({ label: document.querySelector('.slabel').textContent, big: document.querySelector('.sbig').textContent.replace(/\s+/g, ' ').trim(), bars: document.querySelectorAll('.supply .bar i').length, legend: document.getElementById('sLegend').textContent, legends: document.querySelectorAll('.slegend').length }));
    ok('supply: SUPPLY, staged N / 10,000 in stage 1 (N >= 1,100), one gold bar, one legend', sup.label === 'SUPPLY' && /^(\d{1,3}(,\d{3})*) \/ (10,000|20,000|100,000|1,000,000|100,000,000)$/.test(sup.big) && +sup.big.split(' ')[0].replace(/,/g, '') >= 1100 && sup.bars === 1 && sup.legends === 1 && sup.legend === 'Burned + Minted ' + sup.big, JSON.stringify(sup));
    const wp = await pg.textContent('#whitepaper');
    ok('docs: whitepaper has no admin section and no long 30-day section', !/Admin controls/.test(wp) && !/The 30-day rule/.test(wp));
    const page = await pg.textContent('body'); const foot = await pg.textContent('footer');
    ok('slim: no GitHub link, no burned-at-deploy lead sentence, no risk box, footer 30-day + not-affiliated line', !/GitHub/.test(page) && !(await pg.$('#repoLink')) && !(await pg.$('#risk')) && !/Shares #1–#1,100 are burned at deploy and never sold/.test(page) && /team may withdraw the parked 80%\. Independent project, not affiliated with Binance\./.test(foot), foot);
    ok('slim: no 30-day status rows or 30-day lead sentence (zh+en)', !(await pg.$('#sDeadline')) && !(await pg.$('#sWithdrawn')) && !/30 天期限|团队已提取|若开放铸造后 30 天内|backed only by/.test(page + await pg.content()), '');
    const xl = await pg.$$eval('a[href="https://x.com/bnAgent_"]', l => l.map(e => e.id));
    ok('social: X link https://x.com/bnAgent_ in header and footer, no Telegram on the page', xl.includes('xLinkHead') && xl.includes('xLinkFoot') && !/telegram|t\.me\//i.test(await pg.content()), JSON.stringify(xl));
    await ctx.close();
  }
  await b.close();
  for (const r of results) console.log(r[0], '-', r[1], r[0] === 'FAIL' ? '  >> ' + r[2] : '');
  const failed = results.filter(r => r[0] === 'FAIL').length;
  console.log(`${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
