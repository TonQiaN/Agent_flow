import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { JsonValue, ComponentDefinition } from "@agentflow/domain";
import {
  ContractRegistry,
  compileWorkflow,
  ScriptExecutor,
  snapshotJson,
} from "@agentflow/engine";
import type {
  AgentExecutionDriver,
  WorkflowDefinition,
  ArtifactStore,
} from "@agentflow/engine";
import {
  DockerBackend,
  FileScriptRecordReader,
  JsonTaskWorkflowCatalog,
  systemClock,
} from "@agentflow/integrations";
import type { SqliteRunRecordStore } from "@agentflow/integrations";
import { validateInput, analysisErrors, reviewedState } from "./contracts.js";
import type { RecruitmentState } from "./contracts.js";
import { matchPrompt, auditPrompt } from "./prompts.js";

const retry = {
  maxAttempts: 2,
  on: ["execution_failure", "timeout"] as ("execution_failure" | "timeout")[],
  delayMs: 1200,
};
export const recruitmentDefinition: WorkflowDefinition = {
  id: "recruitment",
  start: "parse",
  input: { kind: "json", id: "state" },
  outcomes: {
    completed: { kind: "json", id: "state" },
    rejected: { kind: "json", id: "state" },
  },
  maxSteps: 10,
  nodes: {
    parse: { component: "parse" },
    match: { component: "match", retry },
    audit: { component: "audit", retry },
    render: { component: "render" },
  },
  routes: [
    { from: "parse", outcome: "completed", to: { node: "match" } },
    { from: "match", outcome: "completed", to: { node: "audit" } },
    { from: "audit", outcome: "passed", to: { node: "render" } },
    {
      from: "audit",
      outcome: "revise",
      to: { node: "match" },
      limit: { max: 2, exhausted: { end: "rejected" } },
    },
    { from: "audit", outcome: "rejected", to: { end: "rejected" } },
    { from: "render", outcome: "completed", to: { end: "completed" } },
  ],
};
const asState = (value: JsonValue) => value as unknown as RecruitmentState;
const json = (value: unknown): JsonValue => snapshotJson(value);
const component = (
  id: string,
  kind: ComponentDefinition["kind"],
  outcomes = ["completed"],
): ComponentDefinition => ({
  id,
  implementation: id,
  kind,
  inputContract: "state",
  outcomes: Object.fromEntries(outcomes.map((o) => [o, "state"])),
});
export const recruitmentScripts = {
  parse: { argv: ["python3", "/opt/agentflow/documents.py"], timeoutMs: 600000 },
  render: { argv: ["python3", "/opt/agentflow/documents.py", "render"], timeoutMs: 120000 },
};
export const recruitmentScriptResources = { network: "none" as const, cpus: 1, memoryMiB: 1024 };
export async function createRecruitmentFlow(
  root: string,
  documentsRoot: string,
  records: SqliteRunRecordStore,
  driver: (artifacts: ArtifactStore) => AgentExecutionDriver,
  config: JsonValue,
  image: string,
  testScenarios = false,
) {
  const contracts = new ContractRegistry();
  contracts.register("state", { type: "object" });
  const files = new JsonTaskWorkflowCatalog(
    contracts,
    join(root, "tasks"),
    async (identity, data) => {
      await records.appendEvent(
        identity.runId,
        json({ identity, ...(data as object) }),
      );
    },
  );
  const model = driver(files.artifacts),
    script = new ScriptExecutor(
      new DockerBackend({
        workspaceRoot: join(root, "scripts"),
        image,
        ...recruitmentScriptResources,
      }),
      systemClock,
      new FileScriptRecordReader(),
    );
  files.registerScript(
    component("parse", "transform"),
    script,
    recruitmentScripts.parse,
    {
      revision: "documents-v1",
      input: (input) => {
        validateInput(input);
        return json({ documents: asState(input).documents });
      },
      prepare: async (input, destination) => {
        await mkdir(join(destination, "documents"));
        for (const document of asState(input).documents)
          await cp(
            join(documentsRoot, document.storedName),
            join(destination, "documents", document.storedName),
            { errorOnExist: true, force: false },
          );
      },
      output: (input, output) =>
        json({
          ...asState(input),
          documents: (output as unknown as { documents: unknown }).documents,
        }),
    },
  );
  files.registerAgent(
    component("match", "agent"),
    model,
    { prompt: matchPrompt, config },
    {
      revision: "batch-match-v2",
      input: (input) => json({ ...asState(input), stage: "match" }),
      output: (input, output) => {
        const state = asState(input),
          result = output as unknown as Pick<
            RecruitmentState,
            "requirements" | "recommendations"
          >;
        // Only analysis fields may come from the model. Original documents and owners are immutable.
        return json({
          ...state,
          requirements: result.requirements ?? [],
          recommendations: result.recommendations ?? [],
          audits: [],
          analysisIssues: analysisErrors(output, state),
          round: state.round ?? 0,
        });
      },
      fault: (input, identity) =>
        testScenarios &&
        (asState(input).scenario === "failure" ||
          (asState(input).scenario === "retry" &&
            identity.attemptNumber === 1)),
    },
  );
  files.registerAgent(
    component("audit", "agent", ["passed", "revise", "rejected"]),
    model,
    { prompt: auditPrompt, config },
    {
      revision: "batch-audit-v2",
      input: (input) => json({ ...asState(input), stage: "audit" }),
      output: (input, output) => json(reviewedState(asState(input), output)),
      outcome: (_input, output) =>
        !asState(output).repairReasons?.length
          ? "passed"
          : (asState(output).round ?? 0) > 2
            ? "rejected"
            : "revise",
    },
  );
  files.registerScript(
    component("render", "transform"),
    script,
    recruitmentScripts.render,
    {
      revision: "report-v2",
      input: (input) => {
        const state = asState(input);
        if (
          analysisErrors(state, state).length ||
          state.repairReasons?.length ||
          !state.audits?.length
        )
          throw new Error("REVIEWED_RESULTS_REQUIRED");
        return input;
      },
    },
  );
  return { compiled: compileWorkflow(recruitmentDefinition, files), files };
}
