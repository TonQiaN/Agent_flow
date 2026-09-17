import { pathToFileURL } from 'node:url';
export function checkGate(needs, required) {
  if (!required.length) throw new Error('No required jobs configured');
  const problems = required.filter(name => needs[name]?.result !== 'success');
  const unexpected = Object.keys(needs).filter(name => !required.includes(name));
  if (problems.length || unexpected.length) throw new Error(`CI blocked: ${problems.map(name => `${name}=${needs[name]?.result ?? 'missing'}`).concat(unexpected.map(name => `${name}=undeclared`)).join(', ')}`);
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  checkGate(JSON.parse(process.env.CI_NEEDS ?? '{}'), process.argv.slice(2));
  console.log('All required CI jobs passed.');
}
