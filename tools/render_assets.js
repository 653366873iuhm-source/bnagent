// Renders SVGs to PNG with the sandbox playwright chromium. Usage: node render_assets.js "[[in.svg,out.png,w,h,bg?],...]"
// node render.js in.svg out.png width height  (renders an SVG/HTML file with headless chromium)
const { chromium } = require('/workspace/work/webtest/node_modules/playwright-core');
const fs=require('fs');
(async()=>{const exe=require('child_process').execSync("find ~/.cache/ms-playwright/chromium_headless_shell-1148 -name headless_shell -type f").toString().trim();
const b=await chromium.launch({executablePath:exe,args:['--no-sandbox'],env:{...process.env,LD_LIBRARY_PATH:'/workspace/work/webtest/libs'}});
const jobs=JSON.parse(process.argv[2]);
for(const [inp,out,w,h,bg] of jobs){const p=await b.newPage({viewport:{width:w,height:h}});
const svg=fs.readFileSync(inp,'utf8');
await p.setContent(`<html><body style="margin:0;background:${bg||'transparent'}">${svg.replace('<svg ','<svg width="'+w+'" height="'+h+'" ')}</body></html>`);
await p.screenshot({path:out,omitBackground:!bg,clip:{x:0,y:0,width:w,height:h}});await p.close();}
await b.close();})();
