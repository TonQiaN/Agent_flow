"""Rich-source marking gates using installed Tutor contracts, not its old engine."""
from __future__ import annotations
import argparse
import importlib.util
import shutil
import sys
from pathlib import Path, PurePosixPath


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('operation', choices=('intake', 'candidate', 'final', 'repair'))
    for key in ('workspace', 'input', 'output', 'config'):
        parser.add_argument('--' + key, type=Path, required=True)
    args = parser.parse_args()
    flow = args.workspace / 'agentflows/exam-evaluation'
    sys.path.insert(0, str(flow / 'runtime'))
    from agentflow_protocol import strict_object, write_json, sha256_file, described_file
    from contracts import ContractRegistry
    contracts = ContractRegistry(args.workspace / 'contracts')
    spec = importlib.util.spec_from_file_location('tutor_marking_validation', flow / 'marking/trusted/validation.py')
    validation = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(validation)
    import json
    output = args.output
    shutil.copytree(args.input, output, dirs_exist_ok=True)
    manifest_path = output / 'source/input/marking-input.json'
    manifest = strict_object(manifest_path)
    contracts.validate('exam-marking-input-v1.schema.json', manifest)
    if manifest['source']['kind'] != 'UPLOADED_PDFS':
        raise ValueError('Prepared UPLOADED_PDFS source required')
    source = output / 'source'
    for item in [*manifest['submission']['original_files'], *manifest['submission']['pages'],
                 *[manifest['source'][k] for k in ('paper', 'answer', 'curriculum')]]:
        logical = PurePosixPath(item['path'])
        if not logical.is_absolute() or '..' in logical.parts:
            raise ValueError('Unsafe source descriptor')
        path = source.joinpath(*logical.parts[1:]).resolve()
        if source.resolve() not in path.parents or path.stat().st_size != item['byte_size'] or sha256_file(path) != item['sha256']:
            raise ValueError('Source descriptor changed')
    if args.operation == 'intake':
        print(json.dumps({'outcome': 'completed'})); return
    candidate_root = output / 'candidate'
    paths = {k: candidate_root / v for k, v in [('reference', 'assessment-reference.json'), ('mapping', 'submission-mapping.json'), ('candidate', 'marking-candidate.json')]}
    candidate_hash = sha256_file(paths['candidate'])
    trusted = output / 'trusted'
    trusted.mkdir(exist_ok=True)
    gate_path = trusted / 'candidate-gate-report.json'
    review_path = trusted / 'marking-review-input.json'
    final_path = trusted / 'final-gate-report.json'

    def validate_candidate():
        return validation.validate_marking_candidate(contracts=contracts, input_manifest=manifest,
            reference=strict_object(paths['reference']), mapping=strict_object(paths['mapping']),
            candidate=strict_object(paths['candidate']), trusted_catalog_reference=None,
            trusted_curriculum=strict_object(source / manifest['source']['curriculum']['path'].lstrip('/')))

    if args.operation in ('candidate', 'repair'):
        # Repair feedback comes only from the actual previous rejected Final Gate.
        failure = None
        if args.operation == 'repair':
            failure = strict_object(final_path)
            if failure['decision'] != 'rejected' or failure['candidateHash'] != candidate_hash:
                raise ValueError('Repair must bind the rejected candidate')
            final_path.unlink()
            (trusted / 'marking-reviewer-result.json').unlink()
        metrics, code, summary = None, None, None
        try:
            metrics = validate_candidate()
        except ValueError as error:
            code = 'TUTOR_MARKING_CANDIDATE_REJECTED'
            summary = str(error)[:4000] or 'Candidate violates Tutor validation.'
        passed = code is None and failure is None
        report = {'schema': 'tutor-marking-candidate-gate-report/v1',
            'submission_id': manifest['submission_id'], 'operation_id': manifest['operation_id'],
            'candidate_sha256': candidate_hash, 'decision': 'PASS' if passed else 'FAIL', 'metrics': metrics,
            'findings': [] if passed else [{'severity': 'ERROR', 'code': code or failure['code'],
                'summary': summary or failure['summary']}]}
        write_json(gate_path, report)
        # Logical /input paths are retained for the installed schema. The host
        # task maps /input/... to /task/input/..., never mounts another directory.
        review = {'schema_version': 1, 'contract_version': 'exam-marking-review-input/v1',
            'submission_id': manifest['submission_id'], 'operation_id': manifest['operation_id'],
            'input_manifest': described_file(manifest_path, '/input/source/input/marking-input.json', 'application/json'),
            **{k: described_file(v, '/input/candidate/' + v.name, 'application/json') for k, v in paths.items()},
            'gate_report': described_file(gate_path, '/input/trusted/candidate-gate-report.json', 'application/json'),
            'policy': {'minimum_accept_score': manifest['policy']['minimum_review_score'],
                'required_checks': ['reference', 'mapping', 'coverage', 'rubric', 'scoring', 'evidence', 'feedback']}}
        contracts.validate('exam-marking-review-input-v1.schema.json', review)
        write_json(review_path, review)
        outcome = 'completed' if args.operation == 'repair' else 'passed' if passed else 'rejected'
    else:
        code, summary = None, None
        try:
            review = strict_object(review_path)
            reviewer = strict_object(trusted / 'marking-reviewer-result.json')
            gate = strict_object(gate_path)
            contracts.validate('exam-marking-review-input-v1.schema.json', review)
            contracts.validate('exam-marking-reviewer-result-v1.schema.json', reviewer)
            if reviewer['decision'] != 'ACCEPT':
                raise ValueError('Review rejected')
            if (reviewer['review_input_sha256'] != sha256_file(review_path)
                or reviewer['reviewed_candidate_sha256'] != review['candidate']['sha256']
                or reviewer['final_candidate_sha256'] != candidate_hash
                or review['gate_report']['sha256'] != sha256_file(gate_path)
                or gate['candidate_sha256'] != review['candidate']['sha256']
                or review['input_manifest']['sha256'] != sha256_file(manifest_path)
                or review['submission_id'] != manifest['submission_id']
                or review['operation_id'] != manifest['operation_id']):
                raise ValueError('Review hash or identity mismatch')
            if (reviewer['quality_score'] < review['policy']['minimum_accept_score']
                or any(reviewer['checks'][key] != 'PASS' for key in review['policy']['required_checks'])):
                raise ValueError('Review quality below policy')
            validate_candidate()
        except (ValueError, KeyError, TypeError) as error:
            code = 'TUTOR_MARKING_FINAL_REJECTED'
            summary = str(error)[:4000] or 'Final candidate or review violates Tutor validation.'
        outcome = 'passed' if code is None else 'rejected'
        write_json(final_path, {'decision': outcome, 'code': code, 'summary': summary, 'candidateHash': candidate_hash,
            'reviewHash': sha256_file(trusted / 'marking-reviewer-result.json')})
    print(json.dumps({'outcome': outcome}))


if __name__ == '__main__':
    main()
