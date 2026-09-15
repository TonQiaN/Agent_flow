"""Replace placeholder PDFs in an explicit synthetic fixture, never a student source."""
import hashlib
import json
import sys
from pathlib import Path
from reportlab.pdfgen import canvas
source = Path(sys.argv[1])
manifest_path = source / 'input/marking-input.json'
manifest = json.loads(manifest_path.read_text())
for name, lines in [('paper', ['SYNTHETIC ACCEPTANCE PAPER', 'Question 1 (2 marks)', 'Differentiate y = x^2 with respect to x.']),
                    ('answer', ['SYNTHETIC ACCEPTANCE MARKING GUIDE', 'Question 1: dy/dx = 2x. Maximum 2 marks.', 'Criterion: Correct use of the power rule and derivative: 2 marks.', 'Incorrect answer: 0 marks.'])]:
    descriptor = manifest['source'][name]
    path = source / descriptor['path'].lstrip('/')
    document = canvas.Canvas(str(path), pagesize=(595, 842), invariant=1)
    document.setFont('Helvetica', 15)
    for n, line in enumerate(lines):
        document.drawString(40, 780 - n * 40, line)
    document.save()
    descriptor['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
    descriptor['byte_size'] = path.stat().st_size
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(',', ':')))
