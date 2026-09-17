"""Create synthetic documents to test every supported parser, without personal data."""
import json
import zipfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from reportlab.pdfgen import canvas

root = Path('/test/input/documents')
root.mkdir(parents=True)
text = 'Synthetic candidate: TypeScript React Node.js Playwright experience.'
(root / 'document-0.md').write_text('# Synthetic resume\n\n' + text, encoding='utf-8')
(root / 'document-1.txt').write_text(text + '\n合成测试资料，不对应真实个人。', encoding='utf-8')
with zipfile.ZipFile(root / 'document-2.docx', 'w') as doc:
    doc.writestr('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    doc.writestr('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    doc.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>' + text + '</w:t></w:r></w:p></w:body></w:document>')
pdf = canvas.Canvas(str(root / 'document-3.pdf'))
pdf.drawString(50, 750, text)
pdf.showPage()
pdf.drawString(50, 750, 'Page two: React project evidence.')
pdf.save()
picture = Image.new('RGB', (1600, 400), 'white')
draw = ImageDraw.Draw(picture)
font = ImageFont.truetype('/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc', 42)
draw.text((40, 140), 'TypeScript React Node.js Playwright', fill='black', font=font)
for index, suffix in [(4, 'png'), (5, 'jpg'), (6, 'jpeg')]:
    picture.save(root / f'document-{index}.{suffix}')
picture.save(root / 'document-7.pdf')
files = sorted(root.iterdir())
(root.parent / 'request.json').write_text(json.dumps({'documents': [{'id': f'd{i}', 'storedName': file.name, 'name': file.name, 'owner': 'c1', 'kind': 'resume'} for i, file in enumerate(files)]}))
