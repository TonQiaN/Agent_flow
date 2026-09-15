import { runGrading } from './grading.js';

// Preserve the original Codex-only entry and its environment variables.
await runGrading('codex');
