import type { HarnessPlan, Invocation } from '@agentflow/engine';
const script = String.raw`
const {spawn} = require('node:child_process');
const fs = require('node:fs'), path = require('node:path');
const args = JSON.parse(fs.readFileSync('/task/config/codex-argv.json','utf8'));
const child = spawn('codex', args, {stdio:'inherit'});
child.on('error', () => process.exitCode = 1);
child.on('close', code => {
  const records = []; let bytes=0, truncated=false, error=null;
  // Budget encoded records, including JSON escaping, commas and envelope overhead.
  const limit=16*1024*1024-1024;
  const visit = directory => { if (!fs.existsSync(directory)) return; for (const entry of fs.readdirSync(directory,{withFileTypes:true})) {
    const file=path.join(directory,entry.name);
    if (entry.isDirectory()) visit(file);
    else if(entry.isFile() && entry.name.endsWith('.jsonl')) {
      const size=fs.statSync(file).size;
      if(size>limit) {truncated=true;continue;}
      const record={path:path.relative('/task/state/codex/sessions',file),content:fs.readFileSync(file,'utf8')};
      const encoded=Buffer.byteLength(JSON.stringify(record))+1;
      if(bytes+encoded>limit) {truncated=true;continue;}
      bytes+=encoded;records.push(record);
    }
  }};
  try {visit('/task/state/codex/sessions');} catch {error='SESSION_READ_FAILED';}
  try {fs.writeFileSync('/task/state/codex-session.json',JSON.stringify({schema:'agentflow-codex-session/v1',complete:!truncated&&!error,truncated,error,records,memory:'disabled'}),{mode:0o600});}
  catch {process.exitCode=1;return;}
  process.exitCode=code??1;
});
`;
/** Only the isolated session tree is exported; auth/profile/config files are never read. */
export function codexInvocation(plan: HarnessPlan): Pick<Invocation, 'argv' | 'configFiles' | 'recordFiles'> {
  if (plan.argv.includes('--ephemeral')) return { argv: plan.argv, configFiles: plan.configFiles };
  return { argv: ['node', '/task/config/codex-session.cjs'], configFiles: [...plan.configFiles,
    { name: 'codex-session.cjs', content: script }, { name: 'codex-argv.json', content: JSON.stringify(plan.argv.slice(1)) }],
    recordFiles: [{ id: 'codex-session', path: 'codex-session.json', maxBytes: 16 * 1024 * 1024 }] };
}
