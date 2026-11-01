const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createCanvas, GlobalFonts } = require('@napi-rs/canvas');
const root = path.resolve(__dirname, '../../..');
const source = path.join(root, '架构与设计/图示/识雨全景架构-A.html');
const html = fs.readFileSync(source, 'utf8');
const sourceScript = html.match(/<script>([\s\S]*?)<\/script>/)[1];
new vm.Script(sourceScript);
GlobalFonts.loadSystemFonts();
GlobalFonts.registerFromPath('/System/Library/Fonts/Hiragino Sans GB.ttc', 'Shiyu CJK');
const script = sourceScript.replaceAll('"PingFang SC","Microsoft YaHei",system-ui,sans-serif', '"Shiyu CJK"');
const elements = new Map();
function node() { return { value: '', innerHTML: '', textContent: '', style: {}, listeners: {}, appendChild() {}, addEventListener(type, fn) { this.listeners[type] = fn; }, setAttribute(name, value) { this[name] = value; }, classList: { add() {}, remove() {} }, getBoundingClientRect: () => ({ width: 1600, height: 1100, left: 0, top: 0 }) }; }
const modeButtons = ['stack', 'logical'].map(mode => Object.assign(node(), {dataset:{mode}}));
const atlas = Object.assign(createCanvas(1, 1), node());
elements.set('atlas', atlas);
const document = {
  getElementById(id) { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); },
  querySelectorAll(selector) { return selector === '[data-mode]' ? modeButtons : []; },
  createElement(tag) { return tag === 'canvas' ? createCanvas(1, 1) : node(); }
};
const context = { document, window: {}, ResizeObserver: class { observe() {} }, requestAnimationFrame() {}, setTimeout() {}, URL: {} };
vm.runInNewContext(script, context, { timeout: 5000 });
const api = context.window.shiyuAtlas;
const uiChecks=[];
for (const button of modeButtons) {
 button.listeners.click.call(button);
 if(api.getState().mode!==button.dataset.mode||button['aria-pressed']!=='true') throw new Error('Mode button failed');
 uiChecks.push('mode-button:'+button.dataset.mode);
}
api.setMode('stack');
for(const card of api.stackCards){
 api.select(card.id, false);
 const detail=document.getElementById('detail').innerHTML;
 if(!detail.includes(card.title)||!detail.includes(card.evidence)||!detail.includes(card.api)) throw new Error('Missing tech detail: '+card.id);
}
uiChecks.push('20 technical card details');
const picker=document.getElementById('node-picker');
picker.value='stack-core';picker.listeners.change.call(picker);
if(api.getState().selected!=='stack-core')throw new Error('Picker failed');
uiChecks.push('technical picker');
api.setMode('logical');api.select('core',false);
if(api.getState().selected!=='core')throw new Error('Logical selection failed');
uiChecks.push('logical mode selection');
const results = path.resolve(__dirname, '../artifacts');
fs.mkdirSync(results, { recursive: true });
const reports=[];
for (const mode of ['stack','logical']) {
 api.setMode(mode);
 const data=api.exportDataURL(2.5);
 const png=Buffer.from(data.split(',')[1], 'base64');
 const report={...api.inspect(),version:api.version,width:png.readUInt32BE(16),height:png.readUInt32BE(20)};
 reports.push(report);
 fs.writeFileSync(path.join(results, mode+'-preview.png'),png);
}
const coverage=new Set(api.stackCards.flatMap(n=>n.modules));
const missing=api.nodes.filter(n=>!coverage.has(n.id)).map(n=>n.id);
const extra=[...coverage].filter(id=>!api.nodes.some(n=>n.id===id));
const report={reports,uiChecks,coverage:coverage.size,missing,extra};
fs.writeFileSync(path.join(results,'stack-layout.json'),JSON.stringify(report,null,2));
fs.writeFileSync(path.join(results,'stack-links.json'),JSON.stringify(api.stackCards.map(n=>({id:n.id,evidence:n.evidence,modules:n.modules})),null,2));
console.log(JSON.stringify(report));
if(reports.some(r=>r.text.overflow.length)||missing.length||extra.length)process.exitCode=1;
