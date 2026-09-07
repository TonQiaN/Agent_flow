"""Generate a reading snapshot from canonical decisions. Python 3 + Pandoc."""
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
import html
import os
import re
import subprocess

BUNDLE = Path(__file__).resolve().parent
REPO = BUNDLE.parents[2]
INDEX = REPO / '.agents/decisions/development/README.md'
IDS = [
    'D-20260907-decision-lifecycle',
    'D-20260907-agents-writing',
    'D-20260907-decision-record-content',
    'D-20260907-mandatory-source-traceability',
    'D-20260907-documentation-layers',
]


def relative_links(markdown, source):
    def replace(match):
        label, target = match.groups()
        parsed = urlsplit(target)
        if parsed.scheme or not parsed.path:
            return match.group(0)
        destination = (source.parent / parsed.path).resolve()
        relative = os.path.relpath(destination, BUNDLE)
        return f'[{label}]({urlunsplit(("", "", relative, parsed.query, parsed.fragment))})'
    return re.sub(r'\[([^\]\n]+)\]\(([^)\n]+)\)', replace, markdown)


index = INDEX.read_text()
sections = []
nav = []
for number, decision_id in enumerate(IDS, 1):
    match = re.search(rf'^## {re.escape(decision_id)}\n(.*?)(?=^## |\Z)', index, re.M | re.S)
    if not match:
        raise ValueError(f'Missing index entry: {decision_id}')
    label, target = re.search(r'\[([^\]]+)\]\(([^)]+)\)', match.group(1)).groups()
    source = (INDEX.parent / target).resolve()
    markdown = source.read_text()
    markdown = re.sub(r'^# .+\n', '', markdown, count=1)
    markdown = re.sub(r'^(#{2,5}) ', r'\1# ', markdown, flags=re.M)
    markdown = relative_links(markdown, source)
    rendered = subprocess.run(
        ['pandoc', '-f', 'gfm', '-t', 'html5'], input=markdown,
        text=True, capture_output=True, check=True,
    ).stdout
    # Each section is rendered separately; keep duplicate subheading IDs unique.
    rendered = re.sub(r'id="([^"]+)"', rf'id="section-{number}-\1"', rendered)
    rendered = rendered.replace('<table>', '<div class="table-wrap"><table>').replace('</table>', '</table></div>')
    canonical = os.path.relpath(INDEX, BUNDLE) + '#' + decision_id.lower()
    nav.append(f'<a href="#section-{number}">{number:02d} · {html.escape(label)}</a>')
    sections.append(f'<section id="section-{number}"><div class="eyebrow">{html.escape(source.parent.name)} / {decision_id}</div><h2>{html.escape(label)}</h2><a class="source" href="{canonical}">正式正文入口 ↗</a>{rendered}</section>')

style = '''
:root{--ink:#243b46;--muted:#60767e;--accent:#127a72;--line:#dce6e4;--bg:#f0f5f3}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:22px}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.85 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
header{background:#203b45;color:#f1faf7;padding:25px 5%;display:flex;justify-content:space-between;gap:15px;flex-wrap:wrap;font-size:13px;letter-spacing:.08em}
.layout{max-width:1450px;margin:28px auto;padding:0 24px;display:grid;grid-template-columns:225px minmax(0,1fr);gap:28px}nav{position:sticky;top:24px;align-self:start}nav a{display:block;padding:9px 12px;font-size:14px;text-decoration:none;border-left:2px solid transparent;color:var(--muted)}nav a:hover{background:#e2efeb;border-color:var(--accent)}a{color:var(--accent);text-underline-offset:3px}.intro,section{background:white;border:1px solid var(--line);padding:32px 40px;border-radius:12px;margin-bottom:22px}.eyebrow{font-size:12px;color:var(--muted);letter-spacing:.05em;overflow-wrap:anywhere}h1{font-size:30px;line-height:1.4;margin:8px 0 18px}h2{font-size:25px;line-height:1.45;margin:10px 0}h3{font-size:19px;margin:29px 0 12px;padding-top:12px;border-top:1px solid var(--line)}p{margin:14px 0}.source{font-size:13px}.callout{background:#edf6f2;padding:16px 20px;border-radius:8px}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:14px;line-height:1.75;margin:18px 0}th,td{border:1px solid var(--line);padding:11px 13px;vertical-align:top;text-align:left}th{background:#edf5f2}tr:nth-child(even){background:#fafcfb}code{background:#eef4f2;padding:2px 4px;border-radius:3px;overflow-wrap:anywhere}li{margin:6px 0}
@media(max-width:950px){.layout{grid-template-columns:185px minmax(0,1fr);gap:18px}.intro,section{padding:28px}}
@media(max-width:800px){header{flex-direction:column;gap:3px;padding:20px}.layout{display:block;padding:0 12px}nav{position:static;display:flex;flex-wrap:wrap;gap:5px;margin-bottom:20px}nav a{background:#e4efeb;border-radius:5px;padding:7px 10px;font-size:13px}.intro,section{padding:24px 20px}h1{font-size:27px}h2{font-size:23px}table{min-width:550px}}
@media print{header,nav{display:none}.layout{display:block;margin:0;padding:0}body{background:white;font-size:11pt}.intro,section{padding:0;border:0}h2,h3{break-after:avoid}tr{break-inside:avoid}.table-wrap{overflow:visible}}
'''
result = f'''<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentFlow · 决策生命周期</title><style>{style}</style></head>
<body><header><span>AGENTFLOW / DECISION LIFECYCLE</span><span>2026.09.07 · 正式记录的生成阅读视图</span></header><div class="layout"><nav aria-label="决策目录">{''.join(nav)}<a href="../../../docs/development/documentation.md">当前操作指南 ↗</a></nav><main><div class="intro"><div class="eyebrow">目录管理状态 · 正文管理取舍</div><h1>一项决策，一份事实，完整的选择理由。</h1><p>本页直接从正式决策生成，便于讨论与审阅。修改以仓库中的唯一正文为准，重新生成即可更新此视图。</p><div class="callout">accepted 区分采纳与实施，也为共同审查留出位置。鼓励多人审查，启动期暂时直接设计、直接做。每份 AGENTS.md 由唯一书写决策负责，README 专注说明与导航。</div></div>{''.join(sections)}</main></div></body></html>'''
(BUNDLE / 'index.html').write_text(result)
print(BUNDLE / 'index.html')
