import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, open, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  projectRun,
  redactView,
  FileCredentialStore,
  DeepSeekApiKeyCodec,
  CodexSubscriptionCodec,
  ClaudeSubscriptionCodec,
} from '@agentflow/integrations';
import { configuration, environment, prerequisites } from './config.js';
import { prepareUpload } from './upload.js';
import { projectTimeline } from './timing.js';
import type { RunRevision, RunEvent } from '@agentflow/integrations';
import {
  identifier,
  summaries,
  views,
  viewsAt,
  jsonFile,
  openRecords,
  files,
  publicFiles,
  fileBytes,
  hash,
  safeFile,
} from './data.js';

async function projectRoot() {
  let path = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 7; i++) {
    try {
      if (
        (await jsonFile(join(path, 'package.json'))).name ===
        'agentflow-workspace'
      )
        return path;
    } catch {}
    path = dirname(path);
  }
  throw new Error('找不到项目根目录');
}
const json = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(redactView(value)));
};
async function body(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 129 * 1024 ** 2) throw new Error('上传总量超过 128 MiB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
const brief = (view: any) => ({
  ...view.snapshot,
  steps: view.snapshot.steps.map((s: any) => ({
    ...s,
    result: Object.fromEntries(
      Object.entries(s.result).filter(([key]) => key !== 'output'),
    ),
  })),
  lastAccepted: null,
});
export async function startStudio(
  options: { dataRoot?: string; port?: number; project?: string } = {},
) {
  const project = options.project ?? (await projectRoot()),
    dataRoot = resolve(
      options.dataRoot ??
        process.env['AGENTFLOW_STUDIO_DATA'] ??
        join(project, '.local/studio'),
    );
  await mkdir(join(dataRoot, 'runs'), { recursive: true, mode: 0o700 });
  const config = await configuration(dataRoot),
    env = environment(config, dataRoot);
  const command = join(project, 'src/examples/studio/entry.ts');
  const list = JSON.parse(
    (
      await promisify(execFile)(
        process.execPath,
        ['--import', 'tsx', command, 'catalogue'],
        {
          cwd: project,
          env: {
            ...env,
            AGENTFLOW_STUDIO_RUN_ROOT: '',
            AGENTFLOW_HISTORY_DISABLED: '1',
          },
          maxBuffer: 8 * 1024 ** 2,
        },
      )
    ).stdout,
  );
  const fixture = process.env['AGENTFLOW_STUDIO_FIXTURE'] === '1';
  let launching = false;
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    const host = request.headers.host ?? '',
      port = (server.address() as { port: number }).port;
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(host))
      return json(response, 403, { error: '仅支持本机访问' });
    const url = new URL(request.url ?? '/', `http://${host}`),
      origin = request.headers.origin;
    if (
      url.pathname.startsWith('/api/') &&
      (request.headers['sec-fetch-site'] === 'cross-site' ||
        (origin && origin !== `http://${host}`) ||
        (request.method === 'POST' && origin !== `http://${host}`))
    )
      return json(response, 403, { error: '请从本机工作台发起操作' });
    try {
      if (request.method === 'GET' && url.pathname === '/api/workflows') {
        const ready = await prerequisites(config);
        const source = new FileCredentialStore(config.credentialStore, [
          new CodexSubscriptionCodec(),
          new ClaudeSubscriptionCodec(),
          new DeepSeekApiKeyCodec(),
        ]);
        const credential =
          fixture ||
          !!(await source
            .inspect({
              service:
                config.harness === 'codex'
                  ? 'openai'
                  : config.harness === 'claude'
                    ? 'anthropic'
                    : 'deepseek',
              method:
                config.harness === 'deepseek' ? 'api-key' : 'subscription',
              credentialRef: config.credentialRef,
            })
            .catch(() => null));
        return json(response, 200, {
          workflows: list.map((w: any) => ({
            ...w,
            missing: w.requires
              .filter((r: keyof typeof ready) => !ready[r])
              .map(
                (r: string) =>
                  (
                    ({
                      docker: '请启动 Docker',
                      documents: '请构建材料解析镜像',
                      harness: '请构建 Agent 与代理镜像',
                      tutor: '请设置 TUTOR 工作区与 Python',
                    }) as any
                  )[r],
              )
              .concat(
                w.requires.includes('harness') && !credential
                  ? ['请配置本机模型凭据']
                  : [],
              ),
          })),
          settings: {
            ...config,
            credentialConfigured: credential,
            fixture,
            dataRoot,
          },
          retention: '运行历史和文件保存在本机，不自动清理。',
        });
      }
      if (request.method === 'GET' && url.pathname === '/api/runs') {
        const all = (await summaries(dataRoot))
          .filter(
            (r) =>
              (!url.searchParams.get('workflow') ||
                r.workflowId === url.searchParams.get('workflow')) &&
              (!url.searchParams.get('status') ||
                r.status === url.searchParams.get('status')) &&
              (!url.searchParams.get('from') ||
                r.createdAt >= Number(url.searchParams.get('from'))) &&
              (!url.searchParams.get('to') ||
                r.createdAt <= Number(url.searchParams.get('to'))),
          )
          .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
        return json(response, 200, { runs: all });
      }
      if (request.method === 'POST' && url.pathname === '/api/runs') {
        if (launching)
          return json(response, 409, {
            error: '另一次上传正在校验，请稍后重试',
          });
        launching = true;
        let root: string | undefined;
        try {
          const requestKey = request.headers['idempotency-key'];
          if (typeof requestKey !== 'string' || !identifier(requestKey))
            throw new Error('启动请求缺少有效标识');
          const bytes = await body(request);
          const form = await new Request(`http://${host}`, {
            method: 'POST',
            headers: { 'content-type': request.headers['content-type'] ?? '' },
            body: new Uint8Array(bytes),
          }).formData();
          const manifest = JSON.parse(String(form.get('manifest'))),
            workflow = list.find((w: any) => w.id === manifest.workflowId);
          if (!workflow) throw new Error('未知工作流');
          const fingerprint = await Promise.all(
            [...form.entries()].map(async ([key, value]) => [
              key,
              typeof value === 'string'
                ? value
                : {
                    name: value.name,
                    hash: hash(Buffer.from(await value.arrayBuffer())),
                  },
            ]),
          );
          const digest = hash(JSON.stringify(fingerprint)),
            existing = (await summaries(dataRoot)).find(
              (r) => r.requestKey === requestKey,
            );
          if (existing)
            return json(
              response,
              existing.requestDigest === digest ? 200 : 409,
              existing.requestDigest === digest
                ? { id: existing.id }
                : { error: '重复请求内容已变化' },
            );
          const ready = await prerequisites(config);
          if (workflow.requires.some((r: keyof typeof ready) => !ready[r]))
            throw new Error('运行环境尚未就绪，请查看工作流的环境提示');
          const id = 'run-' + randomUUID();
          root = join(dataRoot, 'runs', id);
          await mkdir(root, { mode: 0o700 });
          const prepared = await prepareUpload(form, root, workflow, fixture);
          const meta = {
            id,
            workflowId: workflow.id,
            title: prepared.title,
            mainRunId: id,
            createdAt: Date.now(),
            source: 'page',
            requestKey,
            requestDigest: digest,
            uploads: prepared.uploads,
            settings: config,
            fixture,
          };
          await writeFile(join(root, 'meta.json'), JSON.stringify(meta), {
            mode: 0o600,
          });
          const log = await open(join(root, 'worker.log'), 'a', 0o600);
          let child;
          try {
            child = spawn(
              process.execPath,
              ['--import', 'tsx', command, 'run', root, id],
              {
                cwd: project,
                env: environment(config, root),
                detached: true,
                stdio: ['ignore', log.fd, log.fd],
              },
            );
          } finally {
            await log.close();
          }
          const currentRoot = root;
          await writeFile(
            join(root, 'meta.json'),
            JSON.stringify({ ...meta, pid: child.pid }),
            { mode: 0o600 },
          );
          child.on('error', () => {
            void writeFile(
              join(currentRoot, 'completion.json'),
              JSON.stringify({
                finishedAt: Date.now(),
                error: '执行进程无法启动',
              }),
              { mode: 0o600, flag: 'wx' },
            ).catch(() => {});
          });
          child.on('exit', (code) => {
            void writeFile(
              join(currentRoot, 'completion.json'),
              JSON.stringify({
                finishedAt: Date.now(),
                error:
                  code === 0 ? null : '执行进程未正常结束，请查看节点和日志',
              }),
              { mode: 0o600, flag: 'wx' },
            ).catch(() => {});
          });
          child.unref();
          root = undefined;
          return json(response, 201, { id });
        } finally {
          launching = false;
          if (root) await rm(root, { recursive: true, force: true });
        }
      }
      const match = /^\/api\/runs\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
      if (request.method === 'GET' && match && identifier(match[1]!)) {
        const root = join(dataRoot, 'runs', match[1]!),
          action = match[2] ?? '',
          meta = await jsonFile(join(root, 'meta.json'));
        if (!action)
          return json(response, 200, {
            meta,
            runs: await views(root).catch((error) => {
              if (error.code === 'ENOENT') return [];
              throw new Error('本地运行记录损坏或无法读取，请检查数据目录。');
            }),
            completion: await jsonFile(join(root, 'completion.json')).catch(
              () => null,
            ),
          });
        if (action === 'at')
          return json(response, 200, {
            runs: await viewsAt(root, Number(url.searchParams.get('time'))),
          });
        if (action === 'files')
          return json(response, 200, {
            files: publicFiles(
              await files(
                root,
                url.searchParams.has('at')
                  ? Number(url.searchParams.get('at'))
                  : undefined,
              ),
            ),
          });
        if (action.startsWith('file/')) {
          const { file, bytes } = await fileBytes(root, action.slice(5));
          const inline = url.searchParams.get('download') !== '1';
          const media = ['application/pdf', 'image/png', 'image/jpeg'].includes(
            file.mediaType,
          )
            ? file.mediaType
            : file.mediaType === 'application/json'
              ? 'application/json; charset=utf-8'
              : 'text/plain; charset=utf-8';
          response.setHeader(
            'Content-Security-Policy',
            "sandbox; default-src 'none'",
          );
          response.setHeader(
            'Content-Type',
            inline ? media : 'application/octet-stream',
          );
          response.setHeader(
            'Content-Disposition',
            `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name.split('/').at(-1)!)}`,
          );
          const preview = url.searchParams.get('preview') === '1';
          if (preview) response.setHeader('X-Preview-Truncated', bytes.length > 256 * 1024 ? '1' : '0');
          response.end(preview ? bytes.subarray(0, 256 * 1024) : bytes);
          return;
        }
        const store = await openRecords(root);
        try {
          const all = await views(root),
            selected =
              all.find((r) => r.view.runId === url.searchParams.get('run')) ??
              all.find((r) => !r.view.runId.startsWith('parallel-')) ??
              all[0];
          if (!selected) return json(response, 200, { entries: [] });
          if (action === 'timing') {
            const at = url.searchParams.has('at') ? Number(url.searchParams.get('at')) : undefined;
            const revision = url.searchParams.has('revision') ? Number(url.searchParams.get('revision')) : undefined;
            if (at !== undefined && (!Number.isSafeInteger(at) || at < 0)) throw new Error('回放时间无效');
            if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new Error('修订无效');
            const rows: RunRevision[] = [], events: RunEvent[] = [];
            let after = 0;
            for (;;) {
              const page = await store.history(selected.key, after, 100);
              for (const row of page) {
                if (revision !== undefined && row.revision > revision) continue;
                const raw = row.content as any, value = raw?.checkpoint ?? raw, s = value?.snapshot;
                if (s) rows.push({ ...row, content: { snapshot: { runId: s.runId, currentNode: s.currentNode, currentIdentity: s.currentIdentity, status: s.status,
                  steps: s.steps.map((step: any) => ({ node: step.node, result: { identity: step.result.identity } })) },
                  attempts: (value.attempts ?? []).map((a: any) => ({ node: a.node, identity: a.identity, resultStep: a.resultStep, retry: !!a.retry, interrupted: a.interrupted })) } });
              }
              if (page.length < 100) break;
              after = page.at(-1)!.sequence;
            }
            after = 0;
            for (;;) {
              const page = await store.events(selected.view.runId, after, 500);
              events.push(...page.filter(row => (row.content as any).kind === 'execution' && (revision === undefined || at !== undefined)));
              if (page.length < 500) break;
              after = page.at(-1)!.sequence;
            }
            return json(response, 200, projectTimeline(rows, events, at));
          }
          const after = Number(url.searchParams.get('after') ?? 0);
          if (!Number.isSafeInteger(after) || after < 0)
            throw new Error('无效的记录位置');
          if (action === 'history') {
            const rows = await store.history(selected.key, after, 100);
            return json(response, 200, {
              entries: rows.map((row) => ({
                sequence: row.sequence,
                revision: row.revision,
                recordedAt: row.recordedAt,
                snapshot: brief(projectRun(row)),
              })),
              next: rows.length === 100 ? rows.at(-1)!.sequence : null,
            });
          }
          if (action === 'revision') {
            const row = await store.revision(
              selected.key,
              Number(url.searchParams.get('revision')),
            );
            if (!row) throw new Error('这次历史修订未保存');
            return json(response, 200, {
              view: projectRun(row),
              recordedAt: row.recordedAt,
            });
          }
          if (action === 'events') {
            const rows = await store.events(selected.view.runId, after, 200);
            return json(response, 200, {
              entries: rows,
              next: rows.length === 200 ? rows.at(-1)!.sequence : null,
            });
          }
        } finally {
          store.close();
        }
      }
      if (request.method !== 'GET')
        return json(response, 405, { error: '首版仅支持启动运行和查看' });
      if (url.pathname.startsWith('/api/'))
        return json(response, 404, { error: '没有这个查询入口' });
      const asset = url.pathname.startsWith('/assets/')
        ? url.pathname.slice(1)
        : 'index.html';
      try {
        const bytes = await safeFile(
          join(project, 'src/apps/studio/public'),
          asset,
        );
        response.setHeader(
          'Content-Type',
          /\.m?js$/.test(asset)
            ? 'text/javascript'
            : asset.endsWith('.css')
              ? 'text/css'
              : 'text/html; charset=utf-8',
        );
        response.end(bytes);
      } catch {
        response.writeHead(404, {
          'content-type': 'text/plain; charset=utf-8',
        });
        response.end('前端尚未构建。请运行 npm run studio:build。');
      }
    } catch (error) {
      json(response, 400, {
        error: error instanceof Error ? error.message : '本地操作失败',
      });
    }
  });
  await new Promise<void>((resolve) =>
    server.listen(
      options.port ?? Number(process.env['PORT'] ?? 3587),
      '127.0.0.1',
      resolve,
    ),
  );
  return {
    server,
    dataRoot,
    port: (server.address() as { port: number }).port,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const app = await startStudio();
  console.log(`AgentFlow: http://127.0.0.1:${app.port}`);
}
