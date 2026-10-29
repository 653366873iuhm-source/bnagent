// Headless wallet-connect test for site/ (playwright-core 1.49 + chromium headless shell).
// Usage: node wallet-connect.test.js [siteDir] [liveUrl]. Expects a ./libs dir with missing chromium deps when run in the Hark sandbox.
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const exe = require('child_process').execSync("find ~/.cache/ms-playwright/chromium_headless_shell-1148 -name headless_shell -type f").toString().trim();
const ROOT = process.argv[2] || '/workspace/work/bnagent/site';
const BASE = process.argv[3]; // optional: test a live URL instead of a local server
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.md': 'text/markdown' };
const srv = http.createServer((q, r) => { let f = path.join(ROOT, decodeURIComponent(q.url.split('?')[0])); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); }); });
const ADDR = '0x49E6fb3812fdfD67eDfE17259f03CcbE59f39BCE'; // holds allin168.ai on BSC
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
    ok('no-wallet: mint button says 合约未部署', (await pg.textContent('#mintBtn')).includes('合约未部署'));
    await pg.click('#connectBtn');
    const body = await pg.textContent('#modalBody');
    ok('no-wallet: chooser opens and says no wallet detected', body.includes('未检测到浏览器钱包'));
    ok('no-wallet: chooser has mobile deep links', (await pg.$$('#modalBody a.wbtn')).length === 3);
    ok('no-wallet: chooser has agent prompt with llms.txt', (await pg.inputValue('#agentPrompt')).includes('llms.txt'));
    await pg.fill('#watchAddr', ADDR); await pg.click('#watchBtn');
    await pg.waitForFunction(() => /allin168|无 \.ai|失败/.test(document.getElementById('watchOut').textContent), null, { timeout: 20000 }).catch(() => {});
    const w = await pg.textContent('#watchOut');
    ok('no-wallet: read-only Agent ID check works', w.includes('allin168.ai') && w.includes('合约未部署'), w);
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
    ok('mock: shows contracts not deployed', wb.includes('Contracts not deployed yet'));
    ok('mock: mint button disabled with not-deployed label', (await pg.isDisabled('#mintBtn')) && (await pg.textContent('#mintBtn')).includes('not deployed'));
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
  await b.close();
  for (const r of results) console.log(r[0], '-', r[1], r[0] === 'FAIL' ? '  >> ' + r[2] : '');
  const failed = results.filter(r => r[0] === 'FAIL').length;
  console.log(`${results.length - failed}/${results.length} passed`); process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
