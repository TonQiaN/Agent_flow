import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContractRegistry,
  compileWorkflow,
  WorkflowRuntime,
} from "@agentflow/engine";
import { JsonTaskWorkflowCatalog } from "@agentflow/integrations";
import { RecruitmentFixtureDriver } from "../../examples/recruitment/fixture-driver.js";

for (const selected of ["passed", "revise", "unregistered"])
  test(`JSON Agent routes only to a declared host outcome: ${selected}`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "af-json-outcome-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const contracts = new ContractRegistry();
    contracts.register("state", { type: "object" });
    const events: any[] = [];
    const files = new JsonTaskWorkflowCatalog(
      contracts,
      root,
      async (_id, event) => {
        events.push(event);
      },
    );
    const driver = new RecruitmentFixtureDriver(
      files.artifacts,
      join(root, "fixture"),
    );
    files.registerAgent(
      {
        id: "check",
        kind: "agent",
        implementation: "check",
        inputContract: "state",
        outcomes: { passed: "state", revise: "state" },
      },
      driver,
      { prompt: "Synthetic test", config: {} },
      { revision: "routing-v1", outcome: () => selected },
    );
    const compiled = compileWorkflow(
      {
        id: "test",
        start: "check",
        input: { kind: "json", id: "state" },
        maxSteps: 1,
        nodes: { check: { component: "check" } },
        outcomes: {
          passed: { kind: "json", id: "state" },
          revise: { kind: "json", id: "state" },
        },
        routes: ["passed", "revise"].map((outcome) => ({
          from: "check",
          outcome,
          to: { end: outcome },
        })),
      },
      files,
    );
    const result = await new WorkflowRuntime().start(compiled, "test", {
      stage: "audit",
      candidates: [],
      documents: [],
      outcome: "passed",
    }).completion;
    const archive = events.findLast((event) => event.kind === "artifact");
    if (selected === "unregistered") {
      assert.equal(result.status, "failed");
      assert.equal(result.steps[0]!.result.status, "failed");
      assert.equal(archive.accepted, false);
    } else {
      assert.equal(result.status, "succeeded");
      assert.equal(result.outcome, selected);
      assert.equal(archive.accepted, true);
    }
  });

test("multiple JSON Agent outcomes require host selection and registered contracts", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "af-json-bind-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contracts = new ContractRegistry();
  contracts.register("state", { type: "object" });
  const files = new JsonTaskWorkflowCatalog(contracts, root, async () => {});
  const driver = new RecruitmentFixtureDriver(
    files.artifacts,
    join(root, "fixture"),
  );
  const component = {
    id: "check",
    kind: "agent" as const,
    implementation: "check",
    inputContract: "state",
    outcomes: { passed: "state", revise: "state" },
  };
  assert.throws(
    () =>
      files.registerAgent(
        component,
        driver,
        { prompt: "test", config: {} },
        { revision: "v1" },
      ),
    /INVALID_JSON_TASK_BINDING/,
  );
  assert.throws(() =>
    files.registerAgent(
      { ...component, outcomes: { passed: "state", revise: "missing" } },
      driver,
      { prompt: "test", config: {} },
      { revision: "v1", outcome: () => "passed" },
    ),
  );
});
