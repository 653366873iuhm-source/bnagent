// Headless wallet-connect test for site/ (playwright-core 1.49 + chromium headless shell).
// Usage: NODE_PATH=<dir with playwright-core> PW_LIBS=<chromium deps dir> node test/site/site.test.js [siteDir] [liveUrl]
// (in the Hark sandbox: NODE_PATH=/workspace/work/webtest/node_modules PW_LIBS=/workspace/work/webtest/libs)
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const exe = require('child_process').execSync("find ~/.cache/ms-playwright/chromium_headless_shell-1148 -name headless_shell -type f").toString().trim();
const ROOT = process.argv[2] || path.join(__dirname, '../../site');
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
      if (method === 'personal_sign') { window.__signed = params; return '0x' + '11'.repeat(65); }
      if (method === 'eth_sendTransaction') { window.__sent = params[0]; const e = new Error('User rejected the request.'); e.code = 4001; throw e; }
      throw Object.assign(new Error('unsupported ' + method), { code: 4200 }); },
    on: (ev, f) => { (ls[ev] = ls[ev] || []).push(f); }, removeListener: (ev, f) => { ls[ev] = (ls[ev]||[]).filter(x => x !== f); } };
  window.ethereum = p;
  const info = { uuid: 'mock-uuid-1', name: 'Mock Wallet', icon: 'data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22/>', rdns: 'test.mock.wallet' };
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider: p }) }));
  window.addEventListener('eip6963:requestProvider', announce); announce();
})();`;
const LBMOCK = { day: '2026-10-29', week: '2026-10-26', syncing: false, boards: { invites: { day: [{ rank: 1, label: 'allin168.ai', value: '3', level: 2, x: 'allin_x' }, { rank: 2, label: 'iuhm.ai', value: '1', level: 0 }], week: [{ rank: 1, label: 'allin168.ai', value: '5' }] }, mints: { day: [{ rank: 1, label: 'iuhm.ai', value: '10' }], week: [] }, holders: { day: [{ rank: 1, label: 'iuhm.ai', value: '500000000000000000000000000' }], week: [] } } };
const SIGNER_URL = process.env.SIGNER_URL || 'http://127.0.0.1:10777'; // local server/index.mjs with SOCIAL_SIGNER_KEY (for the claim test)
const XB_STATE = { x: null, boundAt: null, cooldownMs: 0 };
const results = []; const ok = (name, cond, extra = '') => { results.push([cond ? 'PASS' : 'FAIL', name, extra]); };
(async () => {
  let base = BASE;
  const LOCAL = !base; if (!base) base = 'https://bnagent.local.test/';
  const px = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  let proxy; if (px) { const u = new URL(px); proxy = { server: `${u.protocol}//${u.host}`, }; if (u.username) { proxy.username = decodeURIComponent(u.username); proxy.password = decodeURIComponent(u.password); } }
  console.log('browser proxy:', proxy ? 'from env' : 'none');
  const b0 = await chromium.launch({ executablePath: exe, proxy, env: { ...process.env, LD_LIBRARY_PATH: process.env.PW_LIBS || __dirname + '/libs' } });
  // serve the local site under a fake https origin (the sandbox proxy cannot reach 127.0.0.1)
  const b = { close: () => b0.close(), newContext: async (o) => { const c = await b0.newContext(o); if (LOCAL) { await c.route(/\/api\/pass\?/, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ handle: new URL(route.request().url()).searchParams.get('handle'), points: 3, level: 0, x: null }) })); await c.route(/\/api\/x-bind\?/, (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(XB_STATE) })); } if (LOCAL) await c.route('**/api/leaderboard', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(LBMOCK) })); if (LOCAL) await c.route('https://bnagent.local.test/**', (route) => {
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
    ok('no-wallet: safety notes show the mint + token addresses', (await pg.textContent('#notes')).includes(MINT) && (await pg.textContent('#notes')).includes('0xC7F95A3bff008053A4e2f235bAf2f6d784e6C5FB'));
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
    const wpPg = await ctx.newPage(); await wpPg.goto(base + 'whitepaper/?lang=en', { waitUntil: 'networkidle' }); const wp = await wpPg.textContent('#whitepaper'); await wpPg.close();
    ok('docs: whitepaper has no admin section and no long 30-day section', !/Admin controls/.test(wp) && !/The 30-day rule/.test(wp));
    const page = await pg.textContent('body'); const foot = await pg.textContent('footer');
    ok('slim: no GitHub link, no burned-at-deploy lead sentence, no risk box, footer 30-day + not-affiliated line', !/GitHub/.test(page) && !(await pg.$('#repoLink')) && !(await pg.$('#risk')) && !/Shares #1–#1,100 are burned at deploy and never sold/.test(page) && /team may withdraw the parked 80%\. Independent project, not affiliated with Binance\./.test(foot), foot);
    ok('slim: no 30-day status rows or 30-day lead sentence (zh+en)', !(await pg.$('#sDeadline')) && !(await pg.$('#sWithdrawn')) && !/30 天期限|团队已提取|若开放铸造后 30 天内|backed only by/.test(page + await pg.content()), '');
    const xl = await pg.$$eval('a[href="https://x.com/bnAgent_"]', l => l.map(e => e.id));
    ok('social: X link https://x.com/bnAgent_ in header and footer, no Telegram on the page', xl.includes('xLinkHead') && xl.includes('xLinkFoot') && !/telegram|t\.me\//i.test(await pg.content()), JSON.stringify(xl));
    await ctx.close();
  }
  // --- 6: Invite & tasks · +1 mint dialog, shares radios and leaderboard (same structure as jager.live)
  {
    const ctx = await b.newContext(); await ctx.addInitScript(mock(ADDR)); const pg = await ctx.newPage(); const errs = [];
    pg.on('console', m => { if (m.type() === 'error' && !/ERR_|net::/.test(m.text())) errs.push(m.text()); }); pg.on('pageerror', e => errs.push(String(e)));
    const social = [];
    await ctx.route('**/api/social', async (route) => {
      const req = route.request(); social.push(req.postData());
      const r = await fetch(SIGNER_URL + '/api/social', { method: 'POST', body: req.postData() }).catch(() => null);
      const body = r ? await r.text() : '{"error":"signer offline"}';
      route.fulfill({ status: r ? r.status : 502, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body });
    });
    await pg.goto(base + '?lang=en', { waitUntil: 'networkidle' });
    ok('invite: header button "Invite & tasks · +1 mint" (mobile label "Earn")', (await pg.textContent('#inviteBtn .hlg')).includes('Invite & tasks · +1 mint') && (await pg.textContent('#inviteBtn .hsm')).includes('Earn'));
    await pg.click('#inviteBtn');
    let iv = await pg.textContent('#inviteBody');
    ok('invite: dialog opens: Earn extra mints, connect-to-claim, invite placeholder, 2 social tasks (no Telegram)', (await pg.evaluate(() => document.getElementById('inviteModal').open)) && iv.includes('Earn extra mints') && iv.includes('Connect Binance Wallet to claim') && iv.includes('bnagent.onrender.com/?ref=yourname.ai') && (await pg.$$('#ivTasks li')).length === 2 && iv.includes('Follow @bnAgent_ on X') && iv.includes('Connect to claim') && !/telegram/i.test(iv), iv.slice(0, 300));
    const hrefs = await pg.$$eval('#ivTasks a.obtn', l => l.map(a => a.href));
    ok('invite: task links = X follow intent + X post intent mentioning @bnAgent_ and the site', hrefs[0] === 'https://x.com/intent/follow?screen_name=bnAgent_' && hrefs[1].startsWith('https://x.com/intent/post?text=') && decodeURIComponent(hrefs[1]).includes('@bnAgent_') && decodeURIComponent(hrefs[1]).includes('bnagent.onrender.com'), JSON.stringify(hrefs));
    await pg.click('#ivClose');
    // leaderboard
    await pg.waitForFunction(() => document.querySelectorAll('#lbList li.lbrow').length > 0, null, { timeout: 10000 }).catch(() => {});
    const lb = await pg.evaluate(() => ({ tabs: [...document.querySelectorAll('#lbBoards button')].map(b => b.textContent), per: [...document.querySelectorAll('#lbPeriod button')].map(b => b.textContent), cols: document.querySelector('.lbcols').textContent, sub: document.getElementById('lbSub').textContent, rows: [...document.querySelectorAll('#lbList li.lbrow')].map(l => l.textContent) }));
    ok('leaderboard: tabs Invites/Mints/Holders, Day/Week, Top 100 · UTC day, Rank/Agent ID/Invites, rows from /api/leaderboard', lb.tabs.join() === 'Invites,Mints,Holders' && lb.per.join() === 'Day,Week' && /^Top 100 · UTC day \d{4}-\d{2}-\d{2}/.test(lb.sub) && lb.cols.includes('Rank') && lb.cols.includes('Agent ID') && lb.cols.includes('Invites') && (LOCAL ? lb.rows.length === 2 && lb.rows[0].includes('allin168.ai') && lb.rows[0].endsWith('3') : true), JSON.stringify(lb));
    ok('leaderboard: no "Opens after launch" placeholder', !/Opens after launch/.test(await pg.textContent('#boards')));
    await pg.click('#lbBoards button[data-b="holders"]');
    ok('leaderboard: Holders tab shows BNAGENT unit, snapshot note and M/B/T formatting', (await pg.textContent('#lbUnit')) === 'BNAGENT' && (await pg.textContent('#lbSub')).includes('Snapshot at 23:59 UTC') && (LOCAL ? (await pg.textContent('#lbList')).includes('500.00M') : /\.ai/.test(await pg.textContent('#lbList'))), await pg.textContent('#lbList'));
    await pg.click('#lbBoards button[data-b="mints"]'); await pg.click('#lbPeriod button[data-p="week"]');
    ok('leaderboard: Mints/Week shows Shares unit (empty message on the mock)', (await pg.textContent('#lbUnit')) === 'Shares' && (LOCAL ? (await pg.textContent('#lbList')).includes('Nobody on this board yet.') : true) && /UTC week from Monday \d{4}-/.test(await pg.textContent('#lbSub')));
    // connect
    await pg.click('#connectBtn'); await pg.click('#modalBody .wbtn[data-i="0"]');
    await pg.waitForFunction(() => /minted \d+ \/ quota/.test(document.getElementById('walletBox').textContent), null, { timeout: 25000 }).catch(() => {});
    await pg.waitForFunction(() => document.querySelectorAll('#qtyGroup button').length === 10, null, { timeout: 10000 }).catch(() => {});
    const q = await pg.evaluate(() => ({ vis: getComputedStyle(document.getElementById('mintCtrl')).display !== 'none', n: document.querySelectorAll('#qtyGroup button').length, checked: [...document.querySelectorAll('#qtyGroup button')].filter(b => b.getAttribute('aria-checked') === 'true').map(b => b.textContent), dis: [...document.querySelectorAll('#qtyGroup button')].filter(b => b.disabled).length, pay: [...document.querySelectorAll('#payUsdt,#payBnb')].map(b => b.getAttribute('role')) }));
    const wb = await pg.textContent('#walletBox'); const m = /minted (\d+) \/ quota (\d+)/.exec(wb); const rem = m ? Math.min(Math.max(+m[2] - +m[1], 0), 10) : -1;
    ok('mint: shares radio group 1..10 (max = min(10, remaining)), defaults to the max, USDT/BNB radios', q.vis && q.n === 10 && q.dis === 10 - rem && q.checked.join() === String(Math.max(rem, 1)) && q.pay.join() === 'radio,radio', JSON.stringify(q) + ' rem=' + rem);
    if (rem >= 3) { await pg.click('#qtyGroup button[data-q="3"]'); await pg.waitForTimeout(300); }
    ok('mint: picking 3 updates the cost (3 × 1 USDT)', rem < 3 || ((await pg.getAttribute('#costOut', 'data-u')) === '3' && (await pg.getAttribute('#qtyGroup button[data-q="3"]', 'aria-checked')) === 'true'), await pg.getAttribute('#costOut', 'data-u'));
    await pg.click('#inviteBtn');
    await pg.waitForSelector('#ivQuota', { timeout: 15000 }).catch(() => {});
    iv = await pg.textContent('#inviteBody');
    ok('invite: connected shows Quota / Minted / Remaining, invite link ?ref=allin168.ai with Copy link + Code allin168.ai', !!(await pg.$('#ivQuota')) && (await pg.textContent('#ivLink')) === 'https://bnagent.onrender.com/?ref=allin168.ai' && iv.includes('Copy link') && iv.includes('Copy code') && iv.includes('allin168.ai') && /\d+ counted/.test(iv) && /\d \/ 2 done/.test(iv), iv.slice(0, 400));
    const followClaim = '#ivTasks [data-claim="FOLLOW"]';
    const doneAlready = !(await pg.$(followClaim));
    ok('invite: Claim +1 disabled until the Follow link was opened', doneAlready || await pg.isDisabled(followClaim));
    if (!doneAlready) {
      const [popup] = await Promise.all([ctx.waitForEvent('page').catch(() => null), pg.click('#ivTasks a[data-open="FOLLOW"]')]);
      if (popup) await popup.close().catch(() => {});
      await pg.waitForTimeout(300);
      ok('invite: Claim +1 enabled after opening the Follow link', !(await pg.isDisabled(followClaim)));
      await pg.click(followClaim);
      await pg.waitForFunction(() => window.__sent || /terr/.test(document.getElementById('ivTasks').innerHTML), null, { timeout: 30000 }).catch(() => {});
      const sent = await pg.evaluate(() => window.__sent || null);
      const err = await pg.textContent('#ivTasks .terr').catch(() => '');
      ok('invite: Claim → POST /api/social {address, task} → claimSocial simulated OK on BSC → sent to the wallet (rejected by the mock)', social.length === 1 && JSON.parse(social[0]).task === 'FOLLOW' && sent && sent.to.toLowerCase() === MINT.toLowerCase() && sent.data.startsWith('0x2e3c4860') && /rejected/i.test(err), JSON.stringify({ social, sent: sent && sent.data && sent.data.slice(0, 20), err }));
    }
    // post task needs the link
    const tweetClaim = '#ivTasks [data-claim="TWEET"]';
    if (await pg.$(tweetClaim)) {
      const [popup] = await Promise.all([ctx.waitForEvent('page').catch(() => null), pg.click('#ivTasks a.obtn[data-open="TWEET"]')]);
      if (popup) await popup.close().catch(() => {});
      await pg.waitForTimeout(300);
      ok('invite: Post task stays disabled until a post link is pasted', await pg.isDisabled(tweetClaim));
      await pg.fill('#ivUrl', 'https://x.com/allin168/status/1983000000000000001');
      ok('invite: Post task enabled with a link', !(await pg.isDisabled(tweetClaim)));
    }
    await pg.screenshot({ path: __dirname + '/shot-invite.png', fullPage: false });
    await pg.click('#ivClose');
    await pg.evaluate(() => window.scrollTo(0, document.getElementById('boards').offsetTop - 70)); await pg.waitForTimeout(300);
    await pg.screenshot({ path: __dirname + '/shot-leaderboard.png', fullPage: false });
    ok('invite/leaderboard: no console errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  // --- 7: mobile header label
  {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true }); const pg = await ctx.newPage();
    await pg.goto(base + '?lang=en', { waitUntil: 'networkidle' });
    ok('invite: mobile header shows "Earn"', (await pg.isVisible('#inviteBtn .hsm')) && !(await pg.isVisible('#inviteBtn .hlg')));
    await ctx.close();
  }
  // --- 7: jager.live parity (2026-10-30): pre-JS HTML, rails, header counter, Mint Pass card + dialog, tier list, whitepaper page,
  //        safety notes, Bind X + Border season, leaderboard badges, 375px mobile
  {
    const raw = LOCAL ? fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8') : await (await fetch(base)).text();
    const metaD = (/<meta name="description" content="([^"]+)"/.exec(raw) || [])[1] || '', ogD = (/<meta property="og:description" content="([^"]+)"/.exec(raw) || [])[1] || '';
    ok('pre-JS HTML: deployed + live state (no "not deployed", mint address, supply placeholder —, minting Open), meta/og say minting is live',
      !/not deployed|合约未部署|notDeployed/.test(raw) && raw.includes(MINT) && /id="sMinted">—</.test(raw) && /id="hMinted">—</.test(raw) && /id="sPaused"><span class="en">Open</.test(raw) && /minting is live/i.test(metaD) && metaD.includes(MINT) && /minting is live/i.test(ogD) && !/1,100<\/b>/.test(raw), metaD);
    const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } }); await ctx.addInitScript(mock(ADDR)); const pg = await ctx.newPage(); const errs = [];
    pg.on('console', m => { if (m.type() === 'error') errs.push(m.text()); }); pg.on('pageerror', e => errs.push(String(e)));
    let xbPosts = [];
    if (LOCAL) await ctx.route('**/api/x-bind', async (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' } });
      const j = JSON.parse(route.request().postData() || '{}'); xbPosts.push(j);
      if (j.action === 'bind') Object.assign(XB_STATE, { x: 'allin_x', boundAt: Date.now(), cooldownMs: 0 });
      route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(XB_STATE) });
    });
    await pg.goto(base + '?lang=en', { waitUntil: 'networkidle' });
    await pg.waitForFunction(() => /\d/.test(document.getElementById('hMinted').textContent), null, { timeout: 20000 }).catch(() => {});
    const rails = await pg.evaluate(() => ({ vis: getComputedStyle(document.querySelector('.rails')).display, l: document.querySelector('.rail.l .rt .en').textContent, r: document.querySelector('.rail.r .rt .en').textContent, mode: getComputedStyle(document.querySelector('.rail .rt')).writingMode }));
    ok('rails: Jager side rails at ≥1280px ("BNB SMART CHAIN · AGENT ID ONLY" / "BUILT FOR BINANCE AGENTIC WALLET · ONE AND ONLY", vertical), no "BUILD ON BINANCE"', rails.vis === 'block' && rails.l === 'BNB SMART CHAIN · AGENT ID ONLY' && rails.r === 'BUILT FOR BINANCE AGENTIC WALLET · ONE AND ONLY' && rails.mode === 'vertical-rl' && !/BUILD ON BINANCE/.test(raw), JSON.stringify(rails));
    const hc = await pg.evaluate(() => document.querySelector('.hcount').innerText.replace(/\s+/g, ' ').trim());
    const minted = +(await pg.textContent('#hMinted')).replace(/,/g, '');
    ok('header counter: "N / 100,000,000 · Shares · Now 1U" live', minted >= 1100 && new RegExp(`^${minted.toLocaleString('en-US')} / 100,000,000 Shares · Now (1|1\\.\\d+|2(\\.\\d+)?)U$`).test(hc), hc);
    const pc = await pg.evaluate(() => ({ top: document.querySelector('.ptop').innerText.replace(/\s+/g, ' '), name: document.getElementById('pName').textContent, line: document.getElementById('pLine').textContent, btn: document.getElementById('passBtn').textContent, conn: document.getElementById('connectBtn').innerText, mintHidden: getComputedStyle(document.getElementById('mintBtn')).display === 'none' }));
    ok('Mint Pass card: "BNAGENT · MINT PASS / BSC", Agent ID "Wallet not connected", Jager status line, connect button, "Preview your Mint Pass"', pc.top === 'BNAGENT · MINT PASS BSC' && pc.name === 'Wallet not connected' && pc.line === 'Connect the Binance Agentic Wallet that holds your .ai Agent ID' && pc.btn === 'Preview your Mint Pass' && pc.conn === 'Connect Binance Wallet to mint' && pc.mintHidden, JSON.stringify(pc));
    const dl = await pg.evaluate(() => ({ tier: document.getElementById('sTier').textContent, next: document.getElementById('sNext').textContent, get: document.getElementById('sGet').textContent, note: document.querySelector('.pnote .en').textContent, total: document.querySelector('#sTotal .en').textContent, cap: document.querySelector('.pcap .en').textContent }));
    ok('Mint Pass: Current tier "Tier 1 · 1U", Next serial "#N+1", You receive (est.) ≈ 50,000,000 + Jager explanation', dl.tier === 'Tier 1 · 1U' && dl.next === '#' + (minted + 1).toLocaleString('en-US') && dl.get === '≈ 50,000,000' && dl.note === 'Set by the pool price at mint time, 1% below market. The exact amount shows after the mint.', JSON.stringify(dl));
    ok('Mint Pass: "Total shares N / 100,000,000 · Rises to 1.1U at 10,000" + Jager figcaption', dl.total === `Total shares ${minted.toLocaleString('en-US')} / 100,000,000 · Rises to 1.1U at 10,000` && dl.cap.startsWith('Each Agent ID mints 10 shares, plus one for every invitee') && dl.cap.endsWith('20% goes to the treasury.'), dl.total);
    const keep = await pg.evaluate(() => ({ facts: document.querySelectorAll('.facts .fact').length, pool: !!document.getElementById('sPool'), paused: document.getElementById('sPaused').textContent, agentBtn: !!document.getElementById('agentBtn'), quota: !!document.getElementById('quota'), agents: !!document.querySelector('#agents pre'), lang: !!document.getElementById('langBtn'), nav: [...document.querySelectorAll('nav a')].map(a => a.innerText).join(''), wp: document.getElementById('wpLink').getAttribute('href') }));
    ok('KEEP: 6 stat boxes, pool + minting rows, AI agent link, Quota, For AI agents block, CN/EN toggle, nav (Whitepaper → whitepaper/)', keep.facts === 6 && keep.pool && /Open|Paused|Sold out/.test(keep.paused) && keep.agentBtn && keep.quota && keep.agents && keep.lang && keep.nav === 'MintPrice tableLeaderboardsWhitepaperFor agentsX' && keep.wp === 'whitepaper/', JSON.stringify(keep));
    const tb = await pg.evaluate(() => ({ rows: [...document.querySelectorAll('#tierBody tr')].map(r => r.innerText.replace(/\s+/g, ' ').trim()), cur: [...document.querySelectorAll('#tierBody tr[aria-current="step"]')].map(r => r.innerText.replace(/\s+/g, ' ').trim()), sum: document.querySelector('.tiersum .en').textContent, details: !!document.querySelector('#prices details') }));
    ok('price table: every row listed (burned row + 5,131 tiers, 1U → 79.74U), current tier marked "· Current", no expand/collapse', tb.rows.length === 5132 && tb.rows[0] === '— 1 - 1,100 Burned at deploy (never sold)' && tb.rows[1].startsWith('1 1,101 - 10,000 = 1U') && tb.rows[2] === '2 10,001 - 11,000 = 1.1U' && tb.rows[21] === '21 29,001 - 30,000 = 2.28U' && tb.rows[92] === '92 100,001 - 110,000 = 3.7U' && tb.rows[353] === '353 4,420,001 - 4,440,000 = 8.07U' && tb.rows[5131] === '5131 99,980,001 - 100,000,000 = 79.74U' && tb.cur.length === 1 && tb.cur[0].endsWith('· Current') && tb.sum === '1U to 10,000 · then rises in steps · 5,131 tiers · Max 79.74U' && !tb.details, JSON.stringify(tb.rows.slice(0, 3)) + JSON.stringify(tb.cur));
    const notes = await pg.textContent('#notes .en:nth-of-type(1)').catch(() => '') + (await pg.$$eval('#notes p.en', l => l.map(p => p.textContent).join(' ')));
    ok('safety notes: pay only to the mint contract, token contract never receives BNB/USDT, never transfer USDT directly (approve + mint / mintWithBnb), "Minted before?" token address, "AI agents: read llms.txt"', /Pay only to the mint contract 0xD6aFC30810B001CfA5306A2C54b5E6559DfC9Cf0/.test(notes) && /is for adding the token to a wallet; never send BNB or USDT to it/.test(notes) && /Never transfer USDT directly to the mint contract; approve USDT and call mint\(shares, referrer, maxCost\), or send BNB with mintWithBnb/.test(notes) && /Minted before\? Your BNAGENT is already in your wallet\. To see it, add this token address in your wallet/.test(notes) && /AI agents: read bnagent\.onrender\.com\/llms\.txt before minting/.test(notes), notes.slice(0, 200));
    ok('no risk / investment-advice disclaimer, no Telegram', !/investment advice|highly volatile|投资建议/i.test(await pg.content()) && !/telegram|t\.me\//i.test(await pg.content()));
    // Mint Pass preview (not connected)
    await pg.click('#passBtn');
    await pg.waitForSelector('#mpCard', { timeout: 5000 }).catch(() => {});
    let pv = await pg.evaluate(() => ({ open: document.getElementById('passModal').open, h: document.getElementById('pass-dialog-title').textContent, p: document.querySelector('.phd p').textContent, faces: document.querySelectorAll('#mpCard .mpface').length, prog: document.querySelector('.bprog').innerText.replace(/\s+/g, ' '), share: !!document.getElementById('passText'), qr: !!document.querySelector('.mpqr svg') }));
    ok('Preview your Mint Pass: dialog "Your Mint Pass", preview text, rotating 2-sided card with QR, Bronze border progress, no share block before connecting', pv.open && pv.h === 'Your Mint Pass' && pv.p === 'Your Agent ID, X and border show here once you connect.' && pv.faces === 2 && pv.qr && /^Bronze border 0 points .*7 more to Silver\. Earn 1 point for each day board/.test(pv.prog) && !pv.share, JSON.stringify(pv));
    const t0 = await pg.evaluate(() => document.getElementById('mpCard').style.transform); await pg.waitForTimeout(400); const t1 = await pg.evaluate(() => document.getElementById('mpCard').style.transform);
    ok('Mint Pass card auto-rotates', t0 !== t1 && /rotateY/.test(t1), t0 + ' -> ' + t1);
    await pg.click('#passClose');
    // invite dialog sections, disconnected
    await pg.click('#inviteBtn');
    let iv = await pg.textContent('#inviteBody');
    const bl = await pg.$$eval('.borders li', l => l.map(x => [...x.querySelectorAll(':scope > span:not(.dia)')].map(e => e.textContent).join(' ')));
    ok('Invite dialog: Bind X (Jager text, "Connect to bind") and Border season (7 borders Bronze 0 … King 42)', iv.includes('Bind X') && iv.includes('Shows your @X next to your .ai on the leaderboards and your Mint Pass. One X per Agent ID. After unbinding, wait 7 days to bind again. No quota reward.') && !!(await pg.$('#xbConnect')) && iv.includes('Border season') && iv.includes('Each UTC day, landing in the Top 100 of the Invites, Mints or Holders day board earns +1 point (up to 3 a day).') && bl.join('|') === 'Bronze 0|Silver 7|Gold 14|Platinum 21|Diamond 28|Master 35|King 42', JSON.stringify(bl));
    await pg.click('#ivClose');
    // leaderboard badge + X link
    if (LOCAL) { await pg.click('#lbBoards button[data-b="invites"]'); await pg.click('#lbPeriod button[data-p="day"]'); } else { await pg.click('#lbBoards button[data-b="holders"]'); await pg.waitForFunction(() => document.querySelector('#lbList li.lbrow'), null, { timeout: 15000 }).catch(() => {}); }
    const lb1 = await pg.evaluate(() => { const li = document.querySelector('#lbList li.lbrow'); return li ? { dia: !!li.querySelector('.dia'), x: (li.querySelector('.nm a') || {}).href || null, color: (li.querySelector('.dia') || {}).style ? li.querySelector('.dia').style.background : '' } : null; });
    ok('leaderboard: colored border diamond per row, bound X links to x.com', !!lb1 && lb1.dia && (!LOCAL || (lb1.x === 'https://x.com/allin_x' && /240, 185, 11|f0b90b/i.test(lb1.color))), JSON.stringify(lb1));
    // connect -> Agent ID verified, pass share block, Bind X flow
    await pg.click('#connectBtn'); await pg.click('#modalBody .wbtn[data-i="0"]');
    await pg.waitForFunction(() => /Agent ID verified/.test(document.getElementById('pLine').textContent), null, { timeout: 25000 }).catch(() => {});
    if (LOCAL) await pg.waitForFunction(() => /pts/.test(document.getElementById('pBadges').textContent), null, { timeout: 10000 }).catch(() => {});
    const pid = await pg.evaluate(() => ({ name: document.getElementById('pName').textContent, line: document.getElementById('pLine').textContent, badges: [...document.getElementById('pBadges').childNodes].map(e => e.className === 'bdg' ? e.lastChild.textContent : e.textContent).join(' ') }));
    ok('connected: Agent ID allin168.ai, "Agent ID verified · X of Y shares used · Z left", Bronze badge + points', pid.name === 'allin168.ai' && /^Agent ID verified · \d+ of \d+ shares used · \d+ left$/.test(pid.line) && /^Bronze/.test(pid.badges) && (!LOCAL || pid.badges.includes('3 pts')), JSON.stringify(pid));
    await pg.click('#passBtn');
    await pg.waitForSelector('#passText', { timeout: 5000 }).catch(() => {});
    const txt = await pg.textContent('#passText').catch(() => '');
    const btns = await pg.$$eval('.pgrid button', l => l.map(b => b.textContent));
    ok('connected Mint Pass: post text (cn default per page language) with Agent, Border, invite link, CA; Post on X / Copy text / Save image', /^My BNAGENT Mint Pass\n\nAgent: allin168\.ai\nBorder: Bronze\n\nNo Binance \.ai Agent ID, no mint\.\nKeep minting: https:\/\/bnagent\.onrender\.com\/\?ref=allin168\.ai\n\nCA: 0xC7F95A3bff008053A4e2f235bAf2f6d784e6C5FB$/.test(txt) && btns.join() === 'Post on X,Copy text,Save image', JSON.stringify(txt) + btns);
    await pg.click('[data-pl="cn"]');
    ok('Mint Pass post text in Chinese', /^BNAGENT Mint Pass\n\nAgent：allin168\.ai\nBorder：青铜 Bronze/.test(await pg.textContent('#passText')));
    const dl0 = pg.waitForEvent('download', { timeout: 8000 }).catch(() => null); await pg.click('#passSave'); const dlf = await dl0;
    ok('Save image downloads BNAGENT-MintPass-allin168.png', !!dlf && dlf.suggestedFilename() === 'BNAGENT-MintPass-allin168.png', dlf ? dlf.suggestedFilename() : 'none');
    await pg.click('#passClose');
    await pg.click('#inviteBtn');
    await pg.waitForSelector('#xbUrl', { timeout: 10000 }).catch(() => {});
    ok('Bind X (connected, unbound): post-link input, Bind disabled until a link is pasted, instruction names allin168.ai', !!(await pg.$('#xbUrl')) && (await pg.isDisabled('#xbBind')) && (await pg.textContent('#inviteBody')).includes('the post must include allin168.ai'));
    if (LOCAL) {
      await pg.fill('#xbUrl', 'https://x.com/allin_x/status/1234567890');
      await pg.click('#xbBind');
      await pg.waitForFunction(() => /Unbind @allin_x/.test(document.getElementById('inviteBody').textContent), null, { timeout: 10000 }).catch(() => {});
      const sent = xbPosts[0] || {}, signed = await pg.evaluate(() => window.__signed);
      const msg = signed ? Buffer.from(signed[0].slice(2), 'hex').toString() : '';
      ok('Bind X: personal_sign "bnagent.onrender.com: bind X for allin168.ai / Wallet / Time" → POST /api/x-bind {action, address, tweetUrl, proof{kind:sig}} → shows Unbind @allin_x', sent.action === 'bind' && sent.address === ADDR && sent.tweetUrl === 'https://x.com/allin_x/status/1234567890' && sent.proof && sent.proof.kind === 'sig' && sent.proof.signature === '0x' + '11'.repeat(65) && msg === `bnagent.onrender.com: bind X for allin168.ai\nWallet: ${ADDR.toLowerCase()}\nTime: ${sent.proof.time}` && (await pg.textContent('#inviteBody')).includes('Unbind @allin_x'), JSON.stringify(sent) + ' ' + msg);
      Object.assign(XB_STATE, { x: null, boundAt: null, cooldownMs: 0 });
    }
    await pg.click('#ivClose');
    ok('jager-parity page: no console errors', errs.length === 0, errs.join(' | '));
    await ctx.close();
  }
  // --- 8: whitepaper page + 375px mobile (home + whitepaper): no overflow, no console errors
  {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); const pg = await ctx.newPage(); const errs = [];
    pg.on('console', m => { if (m.type() === 'error') errs.push(m.text()); }); pg.on('pageerror', e => errs.push(String(e)));
    const r = await pg.goto(base + 'whitepaper/?lang=en', { waitUntil: 'networkidle' });
    const ref = fs.readFileSync(path.join(__dirname, 'whitepaper-reference.html'), 'utf8');
    const refEn = /<div class="en">([\s\S]*?)<\/div>\n  <div class="zh">/.exec(ref)[1].replace(/\s+/g, ' ').trim(), refZh = /<div class="zh">([\s\S]*?)<\/div>\n  <h3>/.exec(ref)[1].replace(/\s+/g, ' ').trim();
    const wp = await pg.evaluate(() => ({ en: document.querySelector('#whitepaper > div.en').innerHTML, zh: document.querySelector('#whitepaper > div.zh').innerHTML, h1: document.querySelector('.wphead h1 .en').textContent, addr: document.getElementById('addrBox').textContent, css: getComputedStyle(document.body).backgroundColor, logo: document.querySelector('header img').naturalWidth }));
    ok('whitepaper page: /whitepaper/ loads with styles + logo, "BNAGENT Whitepaper", content identical to the old section (en + zh), contracts incl. mint + treasury', r && r.status() === 200 && wp.logo > 0 && wp.css === 'rgb(7, 7, 7)' && wp.h1 === 'BNAGENT Whitepaper' && wp.en.replace(/\s+/g, ' ').trim() === refEn && wp.zh.replace(/\s+/g, ' ').trim() === refZh && wp.addr.includes(MINT) && wp.addr.includes(TREASURY), wp.h1 + ' ' + (wp.en.replace(/\s+/g, ' ').trim() === refEn) + ' ' + (wp.zh.replace(/\s+/g, ' ').trim() === refZh));
    await pg.click('#langBtn');
    ok('whitepaper page: CN/EN toggle', (await pg.evaluate(() => document.body.className)).includes('lang-zh') && (await pg.isVisible('.wphead h1 .zh')));
    ok('home has no whitepaper section any more (moved to its own page)', LOCAL ? !fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').includes('id="whitepaper"') : true);
    await ctx.close();
    for (const [name, url] of [['home', base + '?lang=en'], ['whitepaper', base + 'whitepaper/?lang=zh']]) {
      const c2 = await b.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148' });
      const p2 = await c2.newPage(); const e2 = [];
      p2.on('console', m => { if (m.type() === 'error') e2.push(m.text()); }); p2.on('pageerror', e => e2.push(String(e)));
      await p2.goto(url, { waitUntil: 'networkidle' }); await p2.waitForTimeout(800);
      const m = await p2.evaluate(() => ({ sw: document.documentElement.scrollWidth, rails: getComputedStyle(document.querySelector('.rails')).display, hc: document.querySelector('.hcount') ? getComputedStyle(document.querySelector('.hcount')).display : 'none', wp: getComputedStyle(document.querySelector('.hwp') || document.body).display }));
      ok(`mobile 375px (${name}): no horizontal overflow, rails + header counter hidden, no console errors`, m.sw <= 376 && m.rails === 'none' && m.hc === 'none' && e2.length === 0, JSON.stringify(m) + e2.join('|'));
      if (name === 'home') ok('mobile 375px: Whitepaper icon link in the header', m.wp !== 'none');
      await p2.screenshot({ path: __dirname + `/shot-375-${name}.png`, fullPage: true });
      await c2.close();
    }
    const c3 = await b.newContext({ viewport: { width: 1440, height: 900 } }); const p3 = await c3.newPage();
    await p3.goto(base + '?lang=en', { waitUntil: 'networkidle' }); await p3.waitForTimeout(800);
    await p3.screenshot({ path: __dirname + '/shot-1440-home.png', fullPage: true }); await c3.close();
  }
  await b.close();
  for (const r of results) console.log(r[0], '-', r[1], r[0] === 'FAIL' ? '  >> ' + r[2] : '');
  const failed = results.filter(r => r[0] === 'FAIL').length;
  console.log(`${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
