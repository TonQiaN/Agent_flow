// Test-only OpenAI-compatible server drives the installed dsh CLI without network access or real credentials.
const http = require('node:http'), fs = require('node:fs'), { spawn } = require('node:child_process');
const plan = JSON.parse(fs.readFileSync('/task/config/plan.json', 'utf8'));
let activeChild;
let turns = 0, catalog = [], networkHits = 0, authenticatedRequests = 0, invalidAuthentication = 0, contextMessages = [];
const results = new Map(), imageUrls = new Set(), requestKinds = new Map(), requestPaths = new Map();
const server = http.createServer((req, res) => {
  if (req.url === '/tool-network-probe') { networkHits++; res.end('network-reached'); return; }
  const route = `${req.method} ${req.url}`; requestPaths.set(route, (requestPaths.get(route) ?? 0) + 1);
  if (req.headers.authorization === 'Bearer fixture-deepseek-secret') authenticatedRequests++; else invalidAuthentication++;
  let size = 0, parts = [];
  req.on('data', part => { size += part.length; if (size > 4 * 1024 * 1024) req.destroy(); else parts.push(part); });
  req.on('end', () => {
    let body; try { body = JSON.parse(Buffer.concat(parts).toString()); } catch { res.writeHead(400).end(); return; }
    const requestKind = JSON.stringify({ path: req.url, model: body.model, tools: body.tools?.length ?? 0, stream: body.stream, keys: Object.keys(body).sort() });
    requestKinds.set(requestKind, (requestKinds.get(requestKind) ?? 0) + 1);
    const main = body.tools?.length > 0;
    if (plan.failModel) { res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Synthetic authentication failure', type: 'authentication_error' } })); return; }
    if (plan.cancelModel && main) { setTimeout(() => activeChild.kill('SIGTERM'), 20); return; }
    if (main) {
      catalog = body.tools;
      for (const message of body.messages ?? []) for (const block of Array.isArray(message.content) ? message.content : [])
        if (block.type === 'image_url') imageUrls.add(block.image_url.url);
      contextMessages = body.messages.filter(message => message.role === 'user');
      for (const message of body.messages ?? []) if (message.role === 'tool') results.set(message.tool_call_id, message.content);
    }
    const step = main ? plan.steps[turns++] : null;
    const tool_calls = step ? [{ index: 0, id: step.id, type: 'function', function: { name: step.name, arguments: JSON.stringify(step.input).replaceAll('FIXTURE_PORT', String(server.address().port)) } }] : undefined;
    const message = { role: 'assistant', content: step ? null : 'Probe complete.', reasoning_content: '', ...(tool_calls ? { tool_calls } : {}) };
    const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 10 };
    const finish_reason = step ? 'tool_calls' : 'stop';
    if (!body.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: `probe-${turns}`, object: 'chat.completion', model: body.model, choices: [{ index: 0, message, finish_reason }], usage })); return; }
    res.setHeader('content-type', 'text/event-stream');
    const chunk = (choices, extra = {}) => res.write(`data: ${JSON.stringify({ id: `probe-${turns}`, object: 'chat.completion.chunk', created: 1, model: body.model, choices, ...extra })}\n\n`);
    chunk([{ index: 0, delta: message, finish_reason: null }]);
    chunk([{ index: 0, delta: {}, finish_reason }], { usage });
    res.end('data: [DONE]\n\n');
  });
});
server.listen(plan.port ?? 0, '127.0.0.1', () => {
  fs.writeFileSync('/task/state/private-fixture.txt', 'private-fixture-content');
  if (plan.privateImage) fs.writeFileSync('/task/state/private-image.png', Buffer.from(plan.privateImage, 'base64'));
  fs.writeFileSync('/tmp/deepseek-test-model.json', JSON.stringify([
    { id: 'llm-deepseek', config: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: `http://127.0.0.1:${server.address().port}`, reasoningEffort: 'off' } },
    // A fallback root cannot override a normal Agent's session cwd.
    { id: 'sandbox-policy', config: { mode: 'workspace-write', workspaceRoot: '/task' } },
  ]));
  if (plan.launch) fs.writeFileSync('/task/state/deepseek-api-key.json', JSON.stringify({ schema: 'agentflow-deepseek-key/v1', api_key: 'fixture-deepseek-secret' }), { mode: 0o600 });
  const argv = plan.launch ? ['node', '/task/config/deepseek-policy/launch.mjs', '--', plan.prompt] : [...plan.argv];
  if (plan.cancelCapture) argv.splice(1, 0, '--import', '/task/config/cancel-capture.mjs');
  if (!plan.launch) argv.splice(argv.indexOf('--'), 0, '--patch', '/tmp/deepseek-test-model.json');
  const child = spawn(argv[0], argv.slice(1),
    { cwd: '/task/work', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...plan.environment, DEEPSEEK_API_KEY: plan.launch ? 'ambient-key-must-not-be-used' : 'fixture-deepseek-secret', PASSPHRASE: 'fixture-alternate-secret' } });
  activeChild = child;
  let stdout = '', stderr = '';
  child.stdout.on('data', part => { stdout += part; }); child.stderr.on('data', part => { stderr += part; });
  const timer = setTimeout(() => child.kill('SIGTERM'), 60000);
  child.on('close', async (code, signal) => {
    clearTimeout(timer); server.close();
    const sessions = [];
    function collect(path) { if (!fs.existsSync(path)) return; for (const entry of fs.readdirSync(path, { withFileTypes: true })) {
      const file = `${path}/${entry.name}`;
      if (entry.isDirectory()) collect(file); else if (entry.isFile() && entry.name.endsWith('.jsonl')) sessions.push(fs.readFileSync(file, 'utf8'));
    } }
    collect(`${plan.environment.DSH_HOME}/sessions`);
    let captureError;
    if (plan.captureSession && !plan.launch) {
      try { await (await import('/task/config/deepseek-policy/session-capture.mjs')).captureDeepseekSession(); }
      catch (error) { captureError = error.message; }
    }
    console.log(JSON.stringify({ requestPaths: Object.fromEntries(requestPaths), requestKinds: Object.fromEntries(requestKinds), code, signal, turns, catalog, networkHits, contextMessages, captureError, authenticatedRequests, invalidAuthentication, imageUrls: [...imageUrls], results: Object.fromEntries(results), stdout, stderr, sessions }));
  });
});
