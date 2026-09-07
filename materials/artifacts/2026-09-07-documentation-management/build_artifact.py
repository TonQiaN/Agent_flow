"""Render the discussion artifact: Python 3 + Pandoc, no network access."""
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parent
source = (ROOT / 'discussion.md').read_text()
# Keep CJK bold delimiters unambiguous for the Markdown reader.
source = re.sub(r'\*\*([^*\n]+)\*\*', lambda m: '**' + m.group(1) + '** ', source)
body = subprocess.run(
    ['pandoc', '-f', 'gfm', '-t', 'html5'],
    input=source, capture_output=True, text=True, check=True,
).stdout
headings = re.findall(r'<h2 id="([^"]+)">(.*?)</h2>', body, re.S)
nav = ''.join(f'<a href="#{slug}">{label}</a>' for slug, label in headings)
style = '''
:root{--ink:#213641;--muted:#58707d;--line:#dbe4e6;--accent:#187c77;--bg:#f2f6f5}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:30px}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.85 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}
header{background:#1d3640;color:#eff9f7;padding:27px 5%;display:flex;justify-content:space-between;gap:20px;font-size:13px;letter-spacing:.1em}.layout{display:grid;grid-template-columns:230px minmax(0,1fr);max-width:1400px;margin:30px auto;padding:0 24px;gap:30px}nav{position:sticky;top:30px;align-self:start;font-size:14px}nav .label{font-size:11px;letter-spacing:.13em;color:var(--muted);margin:0 0 15px 12px}a{color:var(--accent);text-underline-offset:3px}nav a{display:block;color:var(--muted);text-decoration:none;padding:9px 12px;border-left:2px solid transparent}nav a:hover{border-color:var(--accent);background:#e3efec}nav .files{margin-top:25px}article{background:white;border:1px solid var(--line);border-radius:12px;padding:42px 48px;min-width:0}h1{font-size:31px;line-height:1.4;margin:0 0 12px}h2{font-size:24px;margin:45px 0 20px;padding-top:15px;border-top:2px solid #e1eae9}h3{font-size:19px;margin:26px 0 12px}p{margin:0 0 18px}strong{font-weight:650}article>p:first-of-type{font-size:14px;color:var(--accent)}article>p:nth-of-type(2){padding:21px 24px;background:#edf6f3;border-radius:8px;font-size:18px}li{margin:7px 0}table{border-collapse:collapse;width:100%;font-size:14px;line-height:1.7;margin:22px 0}td,th{border:1px solid var(--line);padding:12px 14px;vertical-align:top;text-align:left}th{background:#eef5f3}tr:nth-child(even){background:#fbfcfc}code{font-size:.9em;background:#f0f5f5;padding:1px 4px;border-radius:3px;overflow-wrap:anywhere}pre{padding:18px 20px;background:#f3f7f6;border-radius:7px;overflow:auto;line-height:1.75}pre code{padding:0;background:transparent;font-size:14px;overflow-wrap:normal}.table-scroll{overflow-x:auto}
@media(max-width:1100px){.layout{grid-template-columns:185px minmax(0,1fr);gap:20px}article{padding:30px 28px}h1{font-size:27px}}
@media(max-width:800px){header{flex-direction:column;gap:4px;padding:20px}.layout{display:block;padding:0 12px;margin:20px auto}nav{position:static;display:flex;flex-wrap:wrap;gap:3px;margin-bottom:20px;font-size:13px}nav .label{width:100%}nav a{padding:5px 9px;background:#e5efed;border-radius:4px}nav .files{margin:0}article{padding:25px 20px}article>p:nth-of-type(2){font-size:16px;padding:16px}h1{font-size:25px}h2{font-size:22px}table{min-width:560px;font-size:13px}}
@media print{header,nav{display:none}body{background:white;font-size:11pt}.layout{display:block;margin:0;padding:0}article{border:0;padding:0}h2,h3{break-after:avoid}tr{break-inside:avoid}.table-scroll{overflow:visible}}
'''
body = body.replace('<table>', '<div class="table-scroll"><table>').replace('</table>', '</table></div>')
result = f'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AgentFlow · 文档管理设计讨论</title><style>{style}</style></head>
<body><header><span>AGENTFLOW / DOCUMENTATION</span><span>2026.09.07 · 骨架已落地 / 补充建议待讨论</span></header>
<div class="layout"><nav aria-label="文档目录"><div class="label">DESIGN REVIEW / 文档管理</div>{nav}<div class="files"><a href="discussion.md">Markdown 原稿</a><a href="../../docs/README.md">项目文档入口 ↗</a></div></nav><article>{body}</article></div></body></html>'''
(ROOT / 'index.html').write_text(result)
print(ROOT / 'index.html')
