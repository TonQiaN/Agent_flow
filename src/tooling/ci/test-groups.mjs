import { readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
export function discover(directory = 'src') {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['dist', 'node_modules'].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? discover(path) : /\.test\.(ts|mjs)$/.test(entry.name) ? [path] : [];
  }).sort();
}
export function groupTests(tests) {
  const groups = { unit: [], integration: [], workflows: [] };
  for (const path of tests) {
    const e2e = path.startsWith(join('src', 'tests', 'e2e') + sep);
    const group = !e2e ? 'unit' : /studio-(documents|recruitment)\.test\.ts$/.test(path) ? 'workflows' : 'integration';
    groups[group].push(path);
  }
  return groups;
}
