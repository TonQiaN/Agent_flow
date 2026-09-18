// Loaded only by the example regression test, never by normal Studio runs.
import {PersistentNodeQueue} from '@agentflow/integrations';
import {NodeWorker, DefinitionError} from '@agentflow/engine';
const originalClaim = PersistentNodeQueue.prototype.claim;
PersistentNodeQueue.prototype.claim = async function (...args) {
  const claim = await originalClaim.apply(this, args);
  if (claim) {
    // A real event-loop pause: the heartbeat cannot run before this returns.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
    console.error(`paused claim: ${claim.worker}`);
  }
  return claim;
};
if (process.env.AGENTFLOW_TEST_FAIL_COORDINATOR === '1') {
  const originalBind = PersistentNodeQueue.prototype.bind;
  PersistentNodeQueue.prototype.bind = function (claim) {
    if (claim.worker === 'coordinator') throw new DefinitionError('INJECTED_COORDINATOR_FAILURE');
    return originalBind.call(this, claim);
  };
}
const originalRunOnce = NodeWorker.prototype.runOnce;
NodeWorker.prototype.runOnce = async function () {
  const result = await originalRunOnce.call(this);
  if (result?.error) console.error(`worker error: ${result.claim.worker} ${result.error}`);
  return result;
};
