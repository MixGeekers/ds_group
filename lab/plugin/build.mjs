import { mkdir, readdir, copyFile, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist', 'gym', 'fixtures');
await mkdir(output, { recursive: true });
for (const name of await readdir(path.join(root, 'fixtures'))) {
  if (name.endsWith('.json')) await copyFile(path.join(root, 'fixtures', name), path.join(output, name));
}
// Bundle only used glyph rules and their font blocks; all assets stay local to DSH.
const icons = ['barbell', 'chevron-down', 'folder', 'file', 'copy', 'check', 'player-play', 'plus', 'upload', 'player-stop', 'send', 'refresh', 'plug', 'message', 'edit', 'users', 'x', 'settings'];
const tabler = path.join(root, 'node_modules', '@tabler', 'icons-webfont');
const source = await readFile(path.join(tabler, 'dist', 'tabler-icons.css'), 'utf8');
const faces = [...source.matchAll(/@font-face \{[^}]+\}/g)].map(match => match[0]);
const usedFaces = new Set(), fonts = new Set();
const rules = icons.map(name => {
  const rule = source.match(new RegExp(`\\.ti-${name}:before \\{[^}]+\\}`))?.[0];
  if (!rule) throw new Error(`Missing bundled icon: ${name}`);
  const code = parseInt(rule.match(/content: "\\([0-9a-f]+)"/)[1], 16);
  const face = faces.find(value => [...value.matchAll(/U\+([0-9A-F]+)(?:-([0-9A-F]+))?/g)].some(([, start, end]) => code >= parseInt(start, 16) && code <= parseInt(end ?? start, 16)));
  if (!face) throw new Error(`Missing font block for icon: ${name}`);
  usedFaces.add(face.replaceAll('"tabler-icons"', '"shiyu-gym-icons"').replaceAll('./fonts/', './'));
  fonts.add(face.match(/fonts\/([^?]+)/)[1]);
  return `.syg .ti-${name}:before, .syg-nav-icon .ti-${name}:before ${rule.slice(rule.indexOf('{'))}`;
});
const assets = path.join(root, 'dist', 'gym', 'assets');
await mkdir(assets, { recursive: true });
await writeFile(path.join(assets, 'icons.css'), `/*! Tabler Icons 3.50.0, MIT; see LICENSE. */\n${[...usedFaces].join('\n')}\n.syg .ti,.syg-nav-icon .ti{font-family:"shiyu-gym-icons"!important;font-style:normal;font-weight:400;speak:none;display:inline-block;text-decoration:none;text-transform:none;letter-spacing:0;line-height:1;-webkit-font-smoothing:antialiased}\n${rules.join('\n')}\n`);
for (const font of fonts) await copyFile(path.join(tabler, 'dist', 'fonts', font), path.join(assets, font));
await copyFile(path.join(tabler, 'LICENSE'), path.join(assets, 'LICENSE'));
console.log('Built DSH gym JavaScript, synthetic fixtures and local icon assets in lab/dist/gym.');
