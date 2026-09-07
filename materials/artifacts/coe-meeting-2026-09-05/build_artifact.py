from pathlib import Path
import re, html, subprocess, json
from collections import Counter

ROOT = Path(__file__).resolve().parent
main = (ROOT / 'summary-main.md').read_text().replace('比較', '比较').replace('直属的会后任务', '直接的会后任务').replace('没有千并发压测结果', '没有千级并发压测结果')
main = re.sub(r'\*\*([^*\n]+)\*\*', lambda m: '**'+m.group(1)+'** ', main)
raw = (ROOT / 'sources/feishu-ai-summary.txt').read_text()
appendix = []
lee = False
image_n = 0
for line in raw.splitlines():
    if line == '相关链接':
        break
    if line == 'This content is only supported in a Feishu Docs':
        continue
    if line == '[Image]':
        image_n += 1
        caption = '付方圆设计的并行评审工作流示例' if image_n == 1 else '李孝轩设计的批改工作流示例'
        continue
    if line in ('总结', '待办'):
        line = '### ' + line
    if line.startswith('- 李孝轩的最大稳定单元思路'):
        lee = True
        line = '  ' + line
    elif line.startswith('  - 双方共识与兼容方案'):
        lee = False
    elif lee and line.startswith('  - '):
        line = '  ' + line
    if line.startswith('[] '):
        line = '- [ ] ' + line[3:]
    if line.startswith(('会议主题：','会议时间：','参会人：')):
        line += '  '
    appendix.append(line)
report = main + '\n\n' + '\n'.join(appendix).strip() + '\n'
(ROOT / 'summary.md').write_text(report)

css = '''
:root{--ink:#182b38;--muted:#627482;--accent:#147c79;--line:#dce5e9;--paper:#fff;--bg:#f2f5f6}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:28px}body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;font-size:16px;line-height:1.85}a{color:#087a7a;text-underline-offset:3px}a:hover{color:#034f50}header{background:#152e3a;color:#fff;padding:26px max(28px,calc((100vw - 1370px)/2));display:flex;align-items:center;justify-content:space-between;gap:24px}header .brand{font-size:14px;letter-spacing:.15em;font-weight:650}header .meta{font-size:13px;color:#c5d5da}header a{color:#d7eeed;text-decoration:none;margin-left:18px}.layout{display:grid;grid-template-columns:236px minmax(0,1fr);max-width:1390px;margin:30px auto;gap:28px;padding:0 24px}nav{position:sticky;top:28px;align-self:start;font-size:13px;line-height:1.7}nav .label{font-size:11px;letter-spacing:.14em;color:var(--muted);margin:0 0 14px 10px}nav a{display:block;padding:8px 10px;text-decoration:none;color:#4d646f;border-left:2px solid transparent}nav a:hover{border-color:var(--accent);background:#e6eeef}article{min-width:0;background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:45px 52px;box-shadow:0 5px 25px #182b3806}h1{font-size:34px;line-height:1.3;letter-spacing:-.025em;margin:0 0 14px}h2{font-size:24px;line-height:1.45;margin:52px 0 20px;padding-top:10px;border-top:2px solid #d9e7e8}h3{font-size:18px;line-height:1.5;margin:28px 0 12px}p{margin:0 0 17px}li{margin:8px 0}ol,ul{padding-left:24px}li>ul{font-size:15px}strong{font-weight:650}table{border-collapse:collapse;width:100%;font-size:14px;line-height:1.7;margin:22px 0 25px;table-layout:auto}th{text-align:left;background:#edf4f4;font-weight:650}th,td{padding:13px 14px;vertical-align:top;border:1px solid var(--line)}tbody tr:nth-child(even){background:#fafcfc}blockquote{border-left:3px solid var(--accent);margin:24px 0;padding:10px 20px;background:#f0f7f6}hr{border:0;border-top:1px solid var(--line);margin:45px 0}em{color:var(--muted)}article>p:first-of-type{color:var(--accent);font-size:14px;letter-spacing:.025em}article>p:nth-of-type(2){font-size:18px;line-height:1.85;padding:22px 24px;background:#eef6f5;border-radius:8px;margin:24px 0}section.utterance{scroll-margin-top:26px;padding:15px 20px;border-bottom:1px solid var(--line)}section.utterance:target{background:#e5f5f0;border-left:4px solid var(--accent)}.speaker{font-weight:650;font-size:15px}.timestamp{font-size:13px;margin-left:12px;color:var(--accent);font-variant-numeric:tabular-nums}.utterance p{margin:6px 0 0;white-space:pre-wrap}.transcript article{padding:36px}.transcript .intro{padding:0 20px 20px}.source-links{font-size:13px;margin:22px 10px;color:var(--muted)}.appendix-source{font-size:14px;background:#f5f6f7;padding:18px}
@media(max-width:1100px){.layout{grid-template-columns:190px minmax(0,1fr);gap:16px}article{padding:30px 28px}h1{font-size:29px}td,th{padding:10px}}
@media(max-width:800px){header{padding:20px;display:block}header .meta{margin-top:10px}.layout{display:block;margin:18px auto;padding:0 12px}nav{position:static;margin:0 5px 22px;display:flex;flex-wrap:wrap;gap:4px}nav .label{width:100%;margin-bottom:4px}nav a{padding:4px 8px;background:#e7eff0;border-radius:4px}nav .source-links{width:100%;margin:8px}article{padding:28px 20px}h1{font-size:27px}h2{font-size:22px}table{font-size:12px}td,th{padding:7px;overflow-wrap:anywhere}article>p:nth-of-type(2){font-size:16px;padding:17px}}
@media print{body{background:#fff;font-size:11pt}header,nav{display:none!important}.layout{display:block;margin:0;padding:0;max-width:none}article{border:0;padding:0!important;box-shadow:none}h1{font-size:25pt}h2{break-after:avoid;font-size:17pt}h3{break-after:avoid}table{font-size:10pt}tr{break-inside:avoid}a{color:inherit}h2[id^="appendix"]{break-before:page}}
'''
(ROOT / 'styles.css').write_text(css)
fragment = subprocess.run(['pandoc','-f','gfm','-t','html5'], input=report,text=True,capture_output=True,check=True).stdout
assert '**' not in fragment
headings = re.findall(r'<h2 id="([^"]+)">(.*?)</h2>',fragment,re.S)
nav = '<div class="label">MEETING NOTES / 会议内容</div>' + ''.join(f'<a href="#{i}">{t}</a>' for i,t in headings)
nav += '<div class="source-links"><a href="summary.md">下载 Markdown</a><a href="transcript.html">阅读完整逐字稿 ↗</a></div>'
header = '<header><div class="brand">COE / MEETING ARTIFACT</div><div class="meta">2026.09.05 · GMT+08 · 1h 55m<a href="https://fcnovfj762l9.feishu.cn/minutes/obcnul428zhzz345vb4u96l1">原始录音 ↗</a></div></header>'
def page(title,body):
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+html.escape(title)+'</title><link rel="stylesheet" href="styles.css"></head><body>'+header+body+'</body></html>'
(ROOT / 'index.html').write_text(page('COE · AgentFlow 会议总结｜2026-09-05','<div class="layout"><nav>'+nav+'</nav><article>'+fragment+'</article></div>'))

transcript = (ROOT/'sources/transcript.txt').read_text()
blocks = re.findall(r'^([^\n]+?) (\d{2}:\d{2}(?::\d{2})?) \n(.*?)(?=^[^\n]+? \d{2}:\d{2}(?::\d{2})? \n|\Z)',transcript,re.M|re.S)
seen = Counter()
ids = set()
sections = []
canonical = {}
for index, (speaker, stamp, words) in enumerate(blocks):
    if stamp not in canonical or len(words.strip()) > len(blocks[canonical[stamp]][2].strip()):
        canonical[stamp] = index
for index, (speaker, stamp, words) in enumerate(blocks):
    slug = 't-' + stamp.replace(':','-')
    seen[slug] += 1
    unique = slug if canonical[stamp] == index else slug+'-alt-'+str(seen[slug])
    ids.add(unique)
    sections.append(f'<section class="utterance" id="{unique}"><span class="speaker">{html.escape(speaker)}</span><a class="timestamp" href="#{unique}">{stamp}</a><p>{html.escape(words.strip())}</p></section>')
missing = [s for s in re.findall(r'transcript\.html#([\w-]+)', report) if s not in ids]
assert not missing, missing
assert len(blocks)>500
assert blocks[0][0] == '李孝轩' and blocks[0][1] == '01:06'
intro = '<div class="intro"><h1>完整逐字稿</h1><p>付方圆的视频会议 · 2026-09-05 20:08:39 · GMT+08</p><p>飞书录音原始转写，保留说话人、时间戳与识别错误。可用浏览器查找搜索全文；点击时间戳可定位发言。</p><a href="summary.md">总结 Markdown</a> · <a href="sources/transcript.txt">原始 TXT</a></div>'
transcript_nav = '<div class="label">SOURCE / 原始记录</div><a href="index.html">← 返回会议总结</a><a href="sources/transcript.txt">下载原始 TXT</a>'
(ROOT/'transcript.html').write_text(page('COE · 会议完整逐字稿｜2026-09-05','<div class="layout transcript"><nav>'+transcript_nav+'</nav><article>'+intro+''.join(sections)+'</article></div>'))
(ROOT/'sources/metadata.json').write_text(json.dumps({'organization':'COE','meeting_date':'2026-09-05','timezone':'GMT+08','start_time':'20:08:39','meeting_duration_seconds':6931,'recording_export_duration_seconds':6930,'participants':['付方圆','李孝轩'],'minute_url':'https://fcnovfj762l9.feishu.cn/minutes/obcnul428zhzz345vb4u96l1','ai_notes_url':'https://fcnovfj762l9.feishu.cn/docx/NQrKdXbeUouTw8x91GFcNEgQncd','retrieved_date':'2026-09-06','retrieval':'Authenticated Feishu COE desktop meeting history and browser UI; Minutes TXT export and AI Notes document copy','transcript_characters':len(transcript),'utterance_blocks':len(blocks),'first_utterance':blocks[0][1],'last_utterance':blocks[-1][1],'appendix':'AI Notes full summary and todo text; visual and interactive blocks linked to original; wording retained'},ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'report_chars':len(report),'transcript_blocks':len(blocks),'verified_time_links':len(re.findall(r'transcript\.html#([\w-]+)',report)),'files':['index.html','summary.md','transcript.html']},ensure_ascii=False))
