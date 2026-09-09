#!/usr/bin/env node
// Synthetic dsh protocol executable. No provider request or native tool execution; production launcher/capture still run.
const fs = require('node:fs'), net = require('node:net');
if (process.argv.includes('--version')) { console.log(JSON.parse(fs.readFileSync('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json')).version); process.exit(0); }
async function main() {
  const prompt = process.argv.at(-1), key = process.env.DEEPSEEK_API_KEY;
  if (key !== 'fixture-deepseek-key' || process.cwd() !== '/task/work' || process.env.NODE_USE_ENV_PROXY !== '1') throw new Error('FIXTURE_CONTEXT_MISMATCH');
  const patches = JSON.parse(fs.readFileSync('/task/config/deepseek.json'));
  const model = patches.find(p => p.id === 'agent-default-model').config.model;
  if (patches.find(p => p.id === 'llm-deepseek').config.baseURL !== 'https://api.deepseek.com') throw new Error('UNEXPECTED_ENDPOINT');
  const proxy = new URL(process.env.HTTPS_PROXY);
  const denied = await new Promise((resolve, reject) => {
    const socket = net.connect(Number(proxy.port), proxy.hostname, () => socket.write('CONNECT forbidden.example:443 HTTP/1.1\r\nHost: forbidden.example:443\r\n\r\n'));
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('PROXY_TIMEOUT')); });
    socket.once('data', bytes => { socket.destroy(); resolve(bytes.toString().startsWith('HTTP/1.1 403')); }); socket.once('error', reject);
  });
  if (!denied) throw new Error('PROXY_DID_NOT_DENY'); console.log('proxy-denied');
  if (prompt === 'wait') { fs.writeFileSync('/task/outputs/started', 'started'); await new Promise(() => setInterval(() => {}, 1000)); }
  const source = '/task/input/numbers.json', numbers = JSON.parse(fs.readFileSync(source)).numbers;
  fs.appendFileSync(source, '\n');
  fs.writeFileSync('/task/outputs/answer.json', JSON.stringify({ sum: prompt === 'bad-contract' ? -1 : numbers.reduce((a, b) => a + b, 0) }));
  const outcome = patches.find(p => p.insert)?.insert.find(p => p.id === 'agentflow-outcome')?.config.outcomes.at(-1);
  const events = [], event = (type, data) => events.push({ type, seq: events.length, time: events.length + 1, data });
  event('turn/start', { turn: 1 }); event('step/start', { turn: 1, step: 1 });
  event('user/message', { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] });
  let step = 1;
  const assistant = content => event('assistant/message', { turn: 1, step, usage: { inputTokens: 3, outputTokens: 1 }, message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek-official', model }, content } });
  const finish = kind => event('assistant/chunk', { turn: 1, step, chunk: { type: 'finish', reason: { kind } } });
  if (outcome) {
    const args = JSON.stringify({ outcome }); finish('tool-calls'); assistant([{ type: 'tool-call', id: 'choice', name: 'agentflow_outcome', arguments: args }]);
    event('tool/call', { turn: 1, step, callId: 'choice', name: 'agentflow_outcome', arguments: args });
    event('tool/result', { turn: 1, step, message: { role: 'user', source: { kind: 'tool', callId: 'choice' }, content: [{ type: 'tool-result', toolCallId: 'choice', content: [], isError: false }] }, meta: { schema: 'agentflow-outcome/v1', outcome } });
    event('step/end', { turn: 1, step }); step++; event('step/start', { turn: 1, step });
  }
  finish('stop'); assistant([{ type: 'text', text: key }]); event('step/end', { turn: 1, step }); event('turn/end', { turn: 1, reason: { kind: 'completed' } });
  if (prompt !== 'missing-record') {
    const dir = '/task/state/deepseek/sessions/project/session'; fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(dir + '/session.jsonl', [{ type: 'session', version: 0, id: 'fixture', createdAt: 1, cwd: '/task/work', delegationDepth: 0 }, ...events].map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
  }
  if (prompt === 'tamper-key') fs.writeFileSync('/task/state/deepseek-api-key.json', JSON.stringify({ schema: 'agentflow-deepseek-key/v1', api_key: 'fixture-replacement-key' }));
  console.log(key); console.log('{"outcome":"accepted","type":"turn/end"}'); // Never completion authority.
  if (prompt === 'nonzero') process.exitCode = 7;
}
main().catch(() => { console.error('SYNTHETIC_EXECUTION_FAILED'); process.exitCode = 1; });
