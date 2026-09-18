import { useState } from 'react';
import type { TaskNote, Workflow } from './api';
import { pretty } from './api';
import { outcomeNames } from './graph-model';

// Only inspect execution metadata, never node inputs or model output.
export function taskExecution(binding: any) {
  return binding?.schema === 'agentflow-json-task/v1' ? binding.execution : binding;
}
export function taskFacts(binding: any, note?: TaskNote) {
  const execution = taskExecution(binding);
  const prompt = execution?.task?.prompt ?? execution?.prompt ?? note?.prompt;
  const command = execution?.schema === 'agentflow-script-execution/v1' ? execution.definition?.argv : note?.command;
  const fixture = note?.mode === 'fixture' || /fixture/.test(execution?.schema ?? '');
  const mode = fixture ? '合成 Agent' : prompt ? 'Agent Harness' : command ? '容器脚本'
    : note ? ({ agent: 'Agent Harness', script: '容器脚本', host: '宿主程序', parallel: '并行调度', fixture: '合成 Agent' })[note.mode]
      : execution?.schema === 'agentflow-deterministic-function/v1' ? '宿主程序'
        : execution?.schema === 'agentflow-effect-workflow/v1' ? '外部操作' : '执行方式未保存';
  return { execution, prompt, command, fixture, mode };
}

function CopyText({ title, text, code = false }: { title: string; text: string; code?: boolean }) {
  const [copied, setCopied] = useState(false), [failed, setFailed] = useState(false), [expanded, setExpanded] = useState(false);
  return <section className="task-instruction">
    <div className="row"><h4>{title}</h4><button className="text-button" onClick={async () => {
      try { await navigator.clipboard.writeText(text); setCopied(true); setFailed(false); }
      catch { setFailed(true); }
    }}>{copied ? '已复制' : `复制${title}`}</button></div>
    <pre tabIndex={0} className={code ? 'task-command' : 'task-prompt'} style={expanded ? { maxHeight: 'none' } : undefined}>{text}</pre>
    {text.length > 450 && <button className="text-button" onClick={() => setExpanded(!expanded)}>{expanded ? '收起全文' : '展开全文'}</button>}
    {failed && <p role="status" className="muted">复制失败，请选择文字复制。</p>}
  </section>;
}

export function TaskRequirements({ direction, note, component, execution }: {
  direction: 'input' | 'output'; note?: TaskNote; component: any; execution?: Workflow['execution'];
}) {
  const ids: string[] = direction === 'input' ? component?.inputContract ? [component.inputContract] : []
    : [...new Set<string>(Object.values(component?.outcomes ?? {}))];
  const contracts = execution?.structure?.contracts?.filter(contract => ids.includes(contract.id)) ?? [];
  return <section className="task-requirements">
    <h4>{direction === 'input' ? '输入要求' : '输出要求'}</h4>
    {note && <p>{note[direction]}</p>}
    {!!ids.length && <div className="contract-tags">{ids.map(id => <code key={id}>{id}</code>)}</div>}
    {!note && !ids.length && <p className="muted">未保存{direction === 'input' ? '输入' : '输出'}要求。</p>}
    {!!contracts.length && <details><summary>查看数据契约</summary><pre className="json">{pretty(contracts)}</pre></details>}
  </section>;
}

export function NodeTask({ binding, note, component, execution, historical, unavailable, end }: {
  binding: any; note?: TaskNote; component: any; execution?: Workflow['execution']; historical: boolean; unavailable?: string; end?: string;
}) {
  if (end) return <section className="node-task"><h4>结束状态</h4><p>{outcomeNames[end] ?? end}</p></section>;
  const facts = taskFacts(binding, note);
  const command = facts.command as string[] | undefined;
  return <div className="node-task">
    <div className="task-source"><span>{historical ? '本次运行已保存' : '当前流程定义'}</span><b>{facts.mode}</b></div>
    {note?.summary && <p className="task-summary">{note.summary}</p>}
    {facts.prompt ? <CopyText key={facts.prompt} title="Prompt" text={facts.prompt} />
      : command ? <><CopyText title="执行命令" code text={command.map(arg => /^[\w/.:=-]+$/.test(arg) ? arg : "'" + arg.replaceAll("'", "'\\''") + "'").join(' ')} />
        <details><summary>完整命令参数</summary><pre className="json">{pretty(command)}</pre></details></>
      : <p className="muted">{note?.deferred ?? (note?.mode === 'host' || note?.mode === 'parallel'
        ? '由程序执行，未使用模型 Prompt。' : '这份记录未提供 Prompt 或执行命令。')}</p>}
    {facts.execution?.timeoutMs || facts.execution?.definition?.timeoutMs ? <p className="task-timeout">执行时限 · {(facts.execution.timeoutMs ?? facts.execution.definition.timeoutMs) / 1000} 秒</p> : null}
    {note?.source && <p className="task-code-source">源码 · <code>{note.source}</code></p>}
    {unavailable && !note?.deferred && !['host', 'parallel', 'fixture'].includes(note?.mode ?? '') && <p className="notice">{historical ? '部分执行配置未保存。' : '部分执行配置暂时无法读取，请检查本机环境。'}</p>}
    <TaskRequirements direction="input" note={note} component={component} execution={execution} />
    <TaskRequirements direction="output" note={note} component={component} execution={execution} />
  </div>;
}
