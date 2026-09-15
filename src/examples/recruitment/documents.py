"""Bounded offline document extraction and report rendering; no provider credentials."""
import html
import json
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from xml.etree import ElementTree

INPUT = Path('/task/input')
OUTPUT = Path('/task/outputs')
MAX_PAGES = 60
MAX_TEXT = 200000


def command(args):
    result = subprocess.run(args, capture_output=True, timeout=120, check=True)
    return result.stdout.decode('utf-8', errors='strict')


def ocr(file):
    from PIL import Image, ImageOps
    Image.MAX_IMAGE_PIXELS = 40000000
    with Image.open(file) as image, tempfile.TemporaryDirectory() as temp:
        image = ImageOps.exif_transpose(image).convert('RGB')
        image.thumbnail((2400, 2400))
        target = str(Path(temp) / 'page.png')
        image.save(target)
        return command(['tesseract', target, 'stdout', '-l', 'chi_sim+eng'])


def extract(document):
    filename = document['storedName']
    if not re.fullmatch(r'document-[0-9]+\.(pdf|docx|txt|md|png|jpe?g)', filename):
        raise ValueError('INVALID_DOCUMENT_PATH')
    file = INPUT / 'documents' / filename
    if file.is_symlink() or not file.is_file() or file.stat().st_size > 20 * 1024 * 1024:
        raise ValueError('INVALID_DOCUMENT_FILE')
    suffix = file.suffix.lower()
    pages = []
    if suffix == '.pdf':
        info = command(['pdfinfo', str(file)])
        count = int(re.search(r'^Pages:\s+(\d+)', info, re.M).group(1))
        if not 1 <= count <= MAX_PAGES:
            raise ValueError('DOCUMENT_PAGE_LIMIT')
        text = command(['pdftotext', '-layout', '-enc', 'UTF-8', str(file), '-']).split('\f')
        for index in range(count):
            value = text[index] if index < len(text) else ''
            method = 'text'
            if len(value.strip()) < 20:
                with tempfile.TemporaryDirectory() as temp:
                    prefix = str(Path(temp) / 'page')
                    command(['pdftoppm', '-f', str(index + 1), '-l', str(index + 1), '-singlefile', '-scale-to', '1800', '-png', str(file), prefix])
                    value = ocr(prefix + '.png')
                method = 'ocr'
            pages.append({'page': index + 1, 'text': value.strip(), 'method': method})
    elif suffix == '.docx':
        with zipfile.ZipFile(file) as archive:
            info = archive.getinfo('word/document.xml')
            if info.file_size > 10 * 1024 * 1024:
                raise ValueError('DOCX_XML_LIMIT')
            xml = ElementTree.fromstring(archive.read(info))
            ns = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
            value = '\n'.join(''.join(part.itertext()) for part in xml.iter(ns + 'p'))
        pages.append({'page': 1, 'text': value.strip(), 'method': 'paragraphs'})
    elif suffix in ('.png', '.jpg', '.jpeg'):
        pages.append({'page': 1, 'text': ocr(file).strip(), 'method': 'ocr'})
    else:
        pages.append({'page': 1, 'text': file.read_text(encoding='utf-8').strip(), 'method': 'paragraphs'})
    if not any(page['text'] for page in pages):
        raise ValueError('DOCUMENT_TEXT_EMPTY')
    if sum(len(page['text']) for page in pages) > MAX_TEXT:
        raise ValueError('DOCUMENT_TEXT_LIMIT')
    return {**document, 'pages': pages, 'notes': ['OCR 内容请对照原图核实'] if any(p['method'] == 'ocr' for p in pages) else []}


def render(data):
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    pdfmetrics.registerFont(TTFont('WenQuanYi', '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', subfontIndex=0))
    reports = OUTPUT / 'reports'
    reports.mkdir()
    styles = getSampleStyleSheet()
    style = ParagraphStyle('Chinese', parent=styles['BodyText'], fontName='WenQuanYi', fontSize=10, leading=16, wordWrap='CJK')
    for result in data['recommendations']:
        person = next(c for c in data['candidates'] if c['id'] == result['candidateId'])
        lines = [f"# {person['name']} · {result['recommendation']}", f"岗位：{data['job']['name']}", result['rationale'], '决定性岗位要求：' + '、'.join(result['decisiveRequirementIds']), result.get('uncertaintyImpact', '')]
        for item in result['criteria']:
            label = next(r['label'] for r in data['requirements'] if r['id'] == item['requirementId'])
            lines += [f"## {item['requirementId']} · {label} · {item['state']}", item['reason']]
            for evidence in item['evidence']:
                lines += [f"{evidence['documentId']} / 第 {evidence['page']} 页：{evidence['quote']}"]
        lines += ['## 补充面试问题', *result.get('questions', [])]
        markdown = '\n\n'.join(lines)
        base = reports / person['id']
        base.with_suffix('.md').write_text(markdown, encoding='utf-8')
        base.with_suffix('.html').write_text('<!doctype html><meta charset="utf-8"><title>匹配报告</title><main>' + ''.join('<p>' + html.escape(line) + '</p>' for line in lines) + '</main>', encoding='utf-8')
        story = []
        for line in lines:
            story.extend([Paragraph(html.escape(line), style), Spacer(1, 8)])
        SimpleDocTemplate(str(base.with_suffix('.pdf'))).build(story)
    comparison = ['# 候选人对照表', '', '| 候选人 | 最终推荐 | 理由 |', '| --- | --- | --- |']
    for result in data['recommendations']:
        person = next(c for c in data['candidates'] if c['id'] == result['candidateId'])
        comparison.append('| ' + ' | '.join(str(value).replace('|', '／').replace('\n', ' ') for value in [person['name'], result['recommendation'], result['rationale']]) + ' |')
    (reports / 'comparison.md').write_text('\n'.join(comparison), encoding='utf-8')
    (reports / 'results.json').write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    return data


try:
    request = json.loads((INPUT / 'request.json').read_text())
    result = render(request) if len(sys.argv) > 1 and sys.argv[1] == 'render' else {'documents': [extract(d) for d in request['documents']]}
    if sum(len(p['text']) for d in result.get('documents', []) for p in d.get('pages', [])) > 2000000:
        raise ValueError('TOTAL_TEXT_LIMIT')
    (OUTPUT / 'result.json').write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
    print(json.dumps({'schema': 'agentflow-script-result/v1', 'outcome': 'completed'}))
except Exception as exc:
    print(type(exc).__name__ + ': ' + (str(exc) if re.fullmatch(r'[A-Z][A-Z0-9_]*', str(exc)) else 'DOCUMENT_PROCESSING_FAILED'), file=sys.stderr)
    sys.exit(1)
