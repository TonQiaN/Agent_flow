// Test-only local model fixture. The real Claude CLI executes its own tools; no remote model is used.
const http = require('node:http'), fs = require('node:fs'), { spawn } = require('node:child_process');
const plan = JSON.parse(fs.readFileSync('/task/config/plan.json', 'utf8'));
const steps = JSON.parse(fs.readFileSync('/task/config/steps.json', 'utf8'));
let turns = 0, networkHits = 0;
const results = new Map();
const server = http.createServer((req, res) => {
  if (req.url === '/tool-network-probe') { networkHits++; res.end('NETWORK_REACHED'); return; }
  let size = 0, parts = [];
  req.on('data', part => { size += part.length; if (size > 4 * 1024 * 1024) req.destroy(); else parts.push(part); });
  req.on('end', () => {
    let body; try { body = JSON.parse(Buffer.concat(parts).toString()); } catch { body = {}; }
    if (!req.url.startsWith('/v1/messages')) { res.setHeader('content-type', 'application/json'); res.end('{}'); return; }
    const main = body.tools?.some(tool => tool.name === 'Read');
    if (main) for (const message of body.messages ?? []) for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block.type === 'tool_result') results.set(block.tool_use_id, block);
    }
    const step = main ? steps[turns++] : null;
    const content = step ? [{ type: 'tool_use', ...step }] : [{ type: 'text', text: 'Probe complete.' }];
    const message = { id: `msg_probe_${turns}`, type: 'message', role: 'assistant', model: body.model, content,
      stop_reason: step ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 2 } };
    if (!body.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(message)); return; }
    res.setHeader('content-type', 'text/event-stream');
    const emit = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    emit('message_start', { message: { ...message, content: [], stop_reason: null } });
    content.forEach((block, index) => {
      emit('content_block_start', { index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } });
      emit('content_block_delta', { index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
      emit('content_block_stop', { index });
    });
    emit('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 2 } }); emit('message_stop', {}); res.end();
  });
});
server.listen(0, '127.0.0.1', () => {
  // Replace a fixture port marker only; task data never chooses an outbound host.
  for (const step of steps) if (step.name === 'Bash') step.input.command = step.input.command.replaceAll('FIXTURE_PORT', String(server.address().port));
  const child = spawn(plan.argv[0], plan.argv.slice(1), {
    cwd: '/task/work', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...plan.environment, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}` },
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', part => { stdout += part; }); child.stderr.on('data', part => { stderr += part; });
  const timer = setTimeout(() => child.kill('SIGTERM'), 45000);
  child.on('close', (code, signal) => {
    clearTimeout(timer); server.close();
    console.log(JSON.stringify({ code, signal, turns, networkHits, results: Object.fromEntries(results), stdout, stderr }));
  });
});
