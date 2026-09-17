// Stream records immediately: the final JUnit report alone cannot locate a hang.
export default async function* events(source) {
  for await (const event of source) {
    if (!['test:dequeue', 'test:complete', 'test:fail', 'test:stdout', 'test:stderr', 'test:summary'].includes(event.type)) continue;
    const { name, file, line, nesting, message, details, counts, success } = event.data;
    const error = details?.error;
    yield JSON.stringify({ at: new Date().toISOString(), type: event.type, name, file, line, nesting,
      message: message?.slice(0, 16384), durationMs: details?.duration_ms, counts, success,
      error: error && { message: error.message, code: error.code, failureType: error.failureType, stack: error.stack } }) + '\n';
  }
}
