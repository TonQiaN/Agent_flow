import { runGrading } from './grading.js';
import { gradingHarness } from './selected-harness.js';

if (process.argv.length > 3 || process.argv[2] !== undefined && process.argv[2] !== '--preflight') throw new Error('INVALID_ACCEPTANCE_ARGUMENTS');
await runGrading(gradingHarness(process.env.AGENTFLOW_ACCEPTANCE_HARNESS), process.argv[2] === '--preflight');
