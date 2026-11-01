"""Only checks architecture artifacts; does not import or run product code."""
import json
import re
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[3]
BASE = ROOT / '架构与设计/A方案全景'
ARTIFACTS = Path(__file__).resolve().parents[1] / 'artifacts'
files = list(BASE.rglob('*.md'))
files += list((ROOT / 'research/2026-11-01-完整架构').glob('*.md'))
files += list((ROOT / 'research/2026-11-01-复用核查').glob('*.md'))
files += list((ROOT / 'research/2026-11-01-连接订阅与技术栈').glob('*.md'))
files += [ROOT / p for p in (
    '架构与设计/总体架构.md', '架构与设计/目录.md',
    '架构与设计/内外双工与角色边界.md', '架构与设计/主动运行、自愈与多设备.md',
    'research/README.md',
)]
files += [ROOT / '技术候选' / (name + '.md') for name in (
    '目录', 'SQLite', 'LanceDB', 'JSONSchema与Ajv', 'DSH', 'DS-Bot',
    'DSH-Superagent', 'Mem0', 'Letta', '多机控制', '备份与检查点工具', '机密存储工具',
    'Ombre-Brain', 'p-queue', 'proper-lockfile', 'MaiBot', 'macOS完全控制', 'OpenClaw',
)]
files += list(Path(__file__).resolve().parents[1].glob('*.md'))
files = sorted(set(files))
errors = []
local_links = 0
anchor_links = 0
tables = 0


def prose(text):
    return re.sub(r'^(```|~~~).*?^\1[^\n]*$', '', text, flags=re.M | re.S)


def anchors(path):
    text = prose(path.read_text())
    ids = set(re.findall(r'\bid=["\']([^"\']+)["\']', text))
    occurrences = {}
    for heading in re.findall(r'^#{1,6}\s+(.+?)\s*#*$', text, flags=re.M):
        heading = re.sub(r'\[([^\]]+)\]\([^)]*\)', r'\1', heading)
        heading = re.sub(r'<[^>]*>', '', heading).lower()
        slug = ''.join(c for c in heading if c.isalnum() or c in '-_ ')
        slug = slug.replace(' ', '-')
        duplicate = occurrences.get(slug, 0)
        occurrences[slug] = duplicate + 1
        ids.add(slug + ('-' + str(duplicate) if duplicate else ''))
    return ids


def check_link(source, destination):
    global local_links, anchor_links
    destination = unquote(destination.strip())
    if urlsplit(destination).scheme or destination.startswith('//'):
        return
    local_links += 1
    path_part, _, anchor = destination.partition('#')
    path_part = path_part.split('?')[0]
    target = (source.parent / path_part).resolve() if path_part else source
    if not target.exists():
        errors.append(f'{source.relative_to(ROOT)}: missing {destination}')
    elif anchor and target.suffix == '.md':
        anchor_links += 1
        if anchor not in anchors(target):
            errors.append(f'{source.relative_to(ROOT)}: missing anchor {destination}')


for file in files:
    text = prose(file.read_text())
    for match in re.finditer(r'!?\[[^\]\n]*\]\((?:<([^>]+)>|([^\s)]+))\)', text):
        check_link(file, match.group(1) or match.group(2))
    previous = None
    for number, line in enumerate(text.splitlines(), 1):
        if line.startswith('|'):
            columns = len(re.split(r'(?<!\\)\|', line)) - 2
            if previous is None:
                tables += 1
            elif columns != previous:
                errors.append(f'{file.relative_to(ROOT)}:{number}: table has {columns} cells, expected {previous}')
            previous = columns
        else:
            previous = None

index = (BASE / '目录.md').read_text()
module_rows = re.findall(r'^\| .*?\| 模块 \| `([^`]+)`', index, flags=re.M)
region_rows = re.findall(r'^\| .*?\| 区域 \| `([^`]+)`', index, flags=re.M)
html_path = ROOT / '架构与设计/图示/识雨全景架构-A.html'
html = html_path.read_text()
plans = json.loads(re.search(r'const planLinks=(\{[^\n]+\});', html).group(1))
for link in re.findall(r'href="([^"]+)"', html.split('<script>', 1)[0]):
    check_link(html_path, link)
for link in plans.values():
    check_link(html_path, link)
    target = html_path.parent / link
    if target.exists() and len(target.read_text()) < 700:
        errors.append(f'Short module document: {link}')

validation = (BASE / '验证与验收.md').read_text()
stack_manifest = ARTIFACTS / 'stack-links.json'
if not stack_manifest.exists():
    errors.append('Run native stack render before checking technical evidence links')
else:
    for card in json.loads(stack_manifest.read_text()):
        check_link(html_path, card['evidence'])
        if not card['modules'] or not set(card['modules']).issubset(set(plans)):
            errors.append('Invalid technical card module mapping: ' + card['id'])
case_ids = re.findall(r'<a id="(v\d+)"', validation)
coverage = set(re.findall(r'^\| ([a-z][a-z-]*) / ', validation, flags=re.M))
if len(module_rows) != 40 or len(set(module_rows)) != 40:
    errors.append('Module index must contain 40 unique IDs')
if len(region_rows) != 12 or len(set(region_rows)) != 12:
    errors.append('Region index must contain 12 unique IDs')
if set(plans) != set(module_rows) or coverage != set(module_rows):
    errors.append('Diagram / module index / validation coverage mismatch')
if case_ids != [f'v{i:02}' for i in range(1, 28)]:
    errors.append('Validation cases must be V01–V27, exactly once in order')

reuse = (BASE / '复用方案.md').read_text()
reuse_rows = re.findall(r'^\| ([a-z][a-z-]*) / ', reuse, flags=re.M)
if len(reuse_rows) != 40 or set(reuse_rows) != set(module_rows):
    errors.append('Reuse plan must match all 40 module IDs exactly once')

report = dict(reuse_modules=len(reuse_rows), markdown_files=len(files), local_links=local_links,
              anchor_links=anchor_links, markdown_tables=tables,
              regions=len(region_rows), modules=len(module_rows),
              diagram_plans=len(plans), validation_cases=len(case_ids),
              validation_coverage=len(coverage), errors=errors)
ARTIFACTS.mkdir(exist_ok=True)
(ARTIFACTS / 'document-check.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(report, ensure_ascii=False))
raise SystemExit(bool(errors))
