"""Consumer bridge to installed Tutor tools. No model calls or production writes."""
from __future__ import annotations

import argparse
import importlib.util
import json
import shutil
import sys
import tempfile
import uuid
from pathlib import Path
from types import SimpleNamespace


def module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("prepare", "gate", "render"))
    for key in ("workspace", "input", "output", "config"):
        parser.add_argument("--" + key, type=Path, required=True)
    args = parser.parse_args()
    workspace = args.workspace.resolve()
    flow = workspace / "agentflows/exam-evaluation"
    sys.path.insert(0, str(flow / "runtime"))
    sys.path.insert(0, str(flow / "toolchain"))
    from agentflow_protocol import strict_object, write_json, sha256_file
    from contracts import ContractRegistry

    contracts = ContractRegistry(workspace / "contracts")
    config = strict_object(args.config)
    original, output = args.input, args.output
    # Output exists as an empty engine-owned directory. Preserve input bytes,
    # then append only this stage's declared files.
    shutil.copytree(original, output, dirs_exist_ok=True)
    source = output / "source"
    marking_input = strict_object(source / "input/marking-input.json")
    reference = strict_object(output / "candidate/assessment-reference.json")
    mapping = strict_object(output / "candidate/submission-mapping.json")
    candidate = strict_object(output / "candidate/marking-candidate.json")

    if args.operation == "prepare":
        if marking_input["source"]["kind"] != "UPLOADED_PDFS":
            raise ValueError("This consumer requires a prepared UPLOADED_PDFS marking bundle")
        from pathlib import PurePosixPath
        descriptors = [*marking_input["submission"]["original_files"],
                       *marking_input["submission"]["pages"],
                       *[marking_input["source"][key] for key in ("paper", "answer", "curriculum")]]
        for descriptor in descriptors:
            logical = PurePosixPath(descriptor["path"])
            if not logical.is_absolute() or ".." in logical.parts:
                raise ValueError("Unsafe marking source path")
            path = source.joinpath(*logical.parts[1:]).resolve()
            if source.resolve() not in path.parents or path.is_symlink():
                raise ValueError("Marking source escaped its root")
            if path.stat().st_size != descriptor["byte_size"] or sha256_file(path) != descriptor["sha256"]:
                raise ValueError("Marking source descriptor changed")
        curriculum = strict_object(source / marking_input["source"]["curriculum"]["path"].lstrip("/"))
        validation = module(flow / "marking/trusted/validation.py", "tutor_marking_validation")
        validation.validate_marking_candidate(contracts=contracts, input_manifest=marking_input,
            reference=reference, mapping=mapping, candidate=candidate,
            trusted_catalog_reference=None, trusted_curriculum=curriculum)
        projector = module(flow / "toolchain/project_single_submission_metrics.py", "tutor_metrics")
        report_id = uuid.UUID(config["reportId"])
        metrics = projector.project(reference=reference, candidate=candidate, curriculum=curriculum,
            snapshot_id=uuid.uuid5(report_id, "metrics:v1"), user_id=uuid.UUID(marking_input["user_id"]),
            marking_result_id=uuid.uuid5(report_id, "local-marking-result:v1"))
        contracts.validate("exam-performance-metrics-snapshot-v1.schema.json", metrics)
        prepare = module(flow / "toolchain/prepare_report_source.py", "tutor_report_prepare")
        with tempfile.TemporaryDirectory(prefix="agentflow-report-prepare-") as temp:
            temp = Path(temp)
            write_json(temp / "metrics.json", metrics)
            prepare.prepare(workspace=workspace, output=output / "report-source", request_output=temp / "request.json",
                metrics_snapshot=temp / "metrics.json", report_run_id=report_id,
                user_id=uuid.UUID(marking_input["user_id"]), operation_id=uuid.uuid5(report_id, "report:v1"),
                authority=config["authority"], jurisdiction=config["jurisdiction"],
                course_code=curriculum["course_code"], course_name=config["courseName"], exam_year=config["examYear"],
                raw_score_metric_id="overall.raw_score", raw_max_mark=candidate["max_score"],
                performance_band_scheme="UNAVAILABLE", web_estimation_enabled=False,
                minimum_metric_coverage=1)
        result = {"outcome": "completed"}
    else:
        report_source = output / "report-source"
        report_input = strict_object(report_source / "input/report-input.json")
        metrics_path = report_source / "input/metrics/metrics-snapshot.json"
        metrics = strict_object(metrics_path)
        report = strict_object(output / "report-candidate.json")
        validator = module(flow / "reporting/trusted/validation.py", "tutor_report_validation")
        try:
            validator.validate_report_candidate(contracts=contracts, input_manifest=report_input,
                metrics=metrics, candidate=report)
        except ValueError as error:
            if args.operation != "gate":
                raise
            write_json(output / "report-gate.json", {"decision": "rejected", "code": "TUTOR_REPORT_REJECTED",
                "reportHash": sha256_file(output / "report-candidate.json")})
            print(json.dumps({"outcome": "rejected"}))
            return
        if args.operation == "gate":
            write_json(output / "report-gate.json", {"decision": "passed", "code": None,
                "reportHash": sha256_file(output / "report-candidate.json")})
            result = {"outcome": "passed"}
        else:
            gate = strict_object(output / "report-gate.json")
            if gate["decision"] != "passed" or gate["reportHash"] != sha256_file(output / "report-candidate.json"):
                raise ValueError("Report Gate does not bind the current report")
            renderer = module(flow / "toolchain/render_integrated_report.py", "tutor_integrated_report")
            renderer.render(SimpleNamespace(source_root=source, marking_input=source / "input/marking-input.json",
                reference=output / "candidate/assessment-reference.json", submission_mapping=output / "candidate/submission-mapping.json",
                candidate=output / "candidate/marking-candidate.json", report_candidate=output / "report-candidate.json",
                metrics_snapshot=metrics_path, report_source=report_source, selection=None,
                output_pdf=output / "report.pdf", manifest_output=output / "render-manifest.json",
                title=config["title"], student_name=config["studentName"], exam_year=str(config["examYear"]),
                course_name=config["courseName"], assessment_name=config["assessmentName"]))
            result = {"outcome": "completed"}
    print(json.dumps(result))


if __name__ == "__main__":
    main()
