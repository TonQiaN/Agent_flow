"""Advisory sandbox check using copies of the installed Tutor validator; never a host receipt."""
import sys
sys.dont_write_bytecode = True
import json
from pathlib import Path
from contracts import ContractRegistry
from agentflow_protocol import strict_object
from validation import validate_marking_candidate

root = Path(sys.argv[1])
source = root / 'source'
manifest = strict_object(source / 'input/marking-input.json')
candidate = root / 'candidate'
validate_marking_candidate(
    contracts=ContractRegistry(source / 'contracts'), input_manifest=manifest,
    reference=strict_object(candidate / 'assessment-reference.json'),
    mapping=strict_object(candidate / 'submission-mapping.json'),
    candidate=strict_object(candidate / 'marking-candidate.json'),
    trusted_catalog_reference=None,
    trusted_curriculum=strict_object(source / manifest['source']['curriculum']['path'].lstrip('/')),
)
print(json.dumps({'advisory_validation': 'passed', 'host_gate_receipt': False}))
