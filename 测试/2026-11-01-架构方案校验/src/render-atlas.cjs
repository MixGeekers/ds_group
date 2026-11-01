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
function node() { return { value: '', innerHTML: '', textContent: '', style: {}, appendChild() {}, addEventListener() {}, setAttribute() {}, classList: { add() {}, remove() {} }, getBoundingClientRect: () => ({ width: 1600, height: 1100, left: 0, top: 0 }) }; }
const atlas = Object.assign(createCanvas(1, 1), node());
elements.set('atlas', atlas);
const document = {
  getElementById(id) { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); },
  querySelectorAll() { return []; },
  createElement(tag) { return tag === 'canvas' ? createCanvas(1, 1) : node(); }
};
const context = { document, window: {}, ResizeObserver: class { observe() {} }, requestAnimationFrame() {}, setTimeout() {}, URL: {} };
vm.runInNewContext(script, context, { timeout: 5000 });
const api = context.window.shiyuAtlas;
const data = api.exportDataURL(2.5);
const png = Buffer.from(data.split(',')[1], 'base64');
const report = { renderer: 'existing @napi-rs/canvas, no browser', version: api.version, regions: api.regions.length, nodes: api.nodes.length, edges: api.edges.length, plans: api.nodes.filter(n => n.planPath).length, width: png.readUInt32BE(16), height: png.readUInt32BE(20), text: api.inspect().text };
if (report.nodes !== 40 || report.regions !== 12 || report.plans !== 40 || report.text.overflow.length) throw new Error(JSON.stringify(report));
const results = path.resolve(__dirname, '../artifacts');
fs.mkdirSync(results, { recursive: true });
fs.writeFileSync(path.join(root, '架构与设计/图示/识雨全景架构-A.png'), png);
fs.writeFileSync(path.join(results, 'canvas-render.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
