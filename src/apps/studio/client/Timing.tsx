import type { AttemptTiming } from './api';
import { timestamp, duration, attemptDuration } from './presentation';
export function Timing({ value, at }: { value?: AttemptTiming; at?: number | null }) {
  return <section className="attempt-timing" aria-label="节点时间">
    <h4>节点时间 <small>保存记录</small></h4>
    <dl><dt>开始</dt><dd>{timestamp(value?.startedAt)}</dd>
      <dt>结束</dt><dd>{value && !value.ended ? '尚未结束' : timestamp(value?.finishedAt)}</dd>
      <dt>耗时</dt><dd>{attemptDuration(value, at)}</dd></dl>
    {!!value?.execution.length && <details><summary>容器执行时间</summary>{value.execution.map((s, i) => <div key={i} className="execution-time">
      <time>{timestamp(s.startedAt)}</time><span> → </span><time>{timestamp(s.finishedAt)}</time><b>{duration(s.startedAt, s.finishedAt)}</b>
    </div>)}</details>}
  </section>;
}
