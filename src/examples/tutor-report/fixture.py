"""Explicit synthetic material and canned Reporter for the consumer demo only."""
from __future__ import annotations
import argparse
import hashlib
import importlib.util
import json
import shutil
import tempfile
from pathlib import Path


def read(path):
    return json.loads(path.read_text())


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("source", "report"))
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--input", type=Path)
    args = parser.parse_args()
    spec = importlib.util.spec_from_file_location("tutor_fixture", args.workspace / "agentflows/exam-evaluation/toolchain/build_fixture_sources.py")
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)
    args.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="tutor-report-fixture-") as temporary:
        root = Path(temporary)
        if args.operation == "source":
            builder.build_marking_fixture(workspace=args.workspace, output=root / "source",
                request_output=root / "request.json", source_kind="UPLOADED_PDFS")
            from PIL import Image, ImageDraw, ImageFont
            page = root / "source/input/submission/pages/page-0001.png"
            picture = Image.new("RGB", (1200, 1600), "white")
            draw = ImageDraw.Draw(picture)
            font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 34)
            for y, text in [(80, "SYNTHETIC ACCEPTANCE SAMPLE"), (180, "Q1. Differentiate y = x^2."), (280, "My answer: dy/dx = 2x")]:
                draw.text((100, y), text, font=font, fill="black")
            picture.save(page)
            original = root / "source/input/submission/original/answer-page.png"
            shutil.copyfile(page, original)
            digest = hashlib.sha256(page.read_bytes()).hexdigest()
            manifest_path = root / "source/input/marking-input.json"
            manifest = read(manifest_path)
            for item in [*manifest["submission"]["original_files"], *manifest["submission"]["pages"]]:
                item.update(sha256=digest, byte_size=page.stat().st_size)
            write(manifest_path, manifest)
            candidate_root = root / "source/fixture/marking-candidate"
            mapping = read(candidate_root / "submission-mapping.json")
            for item in mapping["pages"]:
                item["content_sha256"] = digest
            for item in mapping["item_mappings"]:
                for region in item["regions"]:
                    region["content_sha256"] = digest
                    region["region"] = {"x0": 0.08, "y0": 0.15, "x1": 0.8, "y1": 0.22}
            write(candidate_root / "submission-mapping.json", mapping)
            candidate = read(candidate_root / "marking-candidate.json")
            candidate["submission_mapping_sha256"] = hashlib.sha256((candidate_root / "submission-mapping.json").read_bytes()).hexdigest()
            by_item = {item['item_id']: item['regions'] for item in mapping['item_mappings']}
            for item in candidate['item_results']:
                item['evidence_regions'] = by_item[item['assessable_item']['id']]
            write(candidate_root / "marking-candidate.json", candidate)
            shutil.copytree(candidate_root, args.output / "candidate")
            shutil.rmtree(root / "source/fixture")
            shutil.copytree(root / "source", args.output / "source")
        else:
            builder.build_report_fixture(workspace=args.workspace, output=root / "report", request_output=root / "request.json")
            report = read(root / "report/fixture/report-candidate/report-candidate.json")
            metrics_bytes = (args.input / "report-source/input/metrics/metrics-snapshot.json").read_bytes()
            metrics = json.loads(metrics_bytes)
            report["user_id"] = metrics["user_id"]
            report["source_marking_result_ids"] = metrics["source_marking_result_ids"]
            report["metrics_snapshot_sha256"] = hashlib.sha256(metrics_bytes).hexdigest()
            report["report"]["title"] = "Synthetic calculus report"
            report["report"]["summary"]["metric_refs"] = list(metrics["metrics"])
            report["report"]["summary"]["text"] = "This synthetic response earned 2 of 2 marks. It demonstrates the power rule in one question, not overall course mastery."
            write(args.output / "report-candidate.json", report)


if __name__ == "__main__":
    main()
