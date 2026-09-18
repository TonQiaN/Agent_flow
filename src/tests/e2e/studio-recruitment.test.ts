import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runRecruitment } from "../../examples/recruitment/run.js";
import {
  SqliteRunRecordStore,
  projectRun,
  FileArtifactArchive,
} from "@agentflow/integrations";
import { ContractRegistry, FileContractRegistry } from "@agentflow/engine";
const enabled = process.env["AGENTFLOW_STUDIO_TESTS"] === "1";
for (const scenario of [
  "normal",
  "rework",
  "job-rework",
  "retry",
  "failure",
  "cancel",
  "exhausted",
])
  test(
    `recruitment real queue, offline documents and PDF: ${scenario}`,
    { skip: !enabled, timeout: 240000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "af-recruitment-"));
      t.after(() => rm(root, { recursive: true, force: true }));
      await mkdir(join(root, "uploads"));
      const names = ["job.md", "resume-a.md", "resume-b.md", "resume-c.md"],
        documents = [];
      for (const [i, name] of names.entries()) {
        await cp(
          join("src/examples/recruitment/fixtures", name),
          join(root, `uploads/document-${i}.md`),
        );
        documents.push({
          id: `d${i + 1}`,
          owner: i ? `c${i}` : "job",
          kind: i ? "resume" : "job",
          name,
          storedName: `document-${i}.md`,
        });
      }
      const input = {
        job: { name: "合成 TypeScript 岗位", notes: "" },
        candidates: [1, 2, 3].map((i) => ({
          id: `c${i}`,
          name: `合成候选人 ${i}`,
        })),
        documents,
        scenario,
      };
      const snapshot = await runRecruitment(root, "acceptance", input, {
        ...process.env,
        AGENTFLOW_STUDIO_FIXTURE: "1",
      });
      const store = await SqliteRunRecordStore.open(join(root, "records"));
      t.after(() => store.close());
      const rows = await store.list({ limit: 100 }),
        all = rows.map(projectRun).filter((v) => v !== null),
        main = all.find((v) => v.runId === "acceptance")!;
      assert.equal(all.length, 1);
      assert.ok(
        (
          await store.history(
            rows.find((r) => projectRun(r)?.runId === "acceptance")!.runId,
            0,
            1000,
          )
        ).length > 10,
      );
      if (["failure", "cancel"].includes(scenario)) {
        assert.equal(
          snapshot.status,
          scenario === "failure" ? "failed" : "cancelled",
        );
        assert.ok(!snapshot.steps.some((s: any) => s.node === "render"));
        return;
      }
      assert.equal(
        snapshot.status,
        "succeeded",
        JSON.stringify({ reason: snapshot.reason, issues: snapshot.issues }),
      );
      if (scenario === "exhausted") {
        assert.equal(snapshot.outcome, "rejected");
        assert.equal(
          snapshot.steps.filter((s: any) => s.node === "match").length,
          3,
        );
        assert.ok(!snapshot.steps.some((s: any) => s.node === "render"));
        return;
      }
      assert.equal(snapshot.outcome, "completed");
      const result = snapshot.lastAccepted.result.output;
      assert.deepEqual(
        result.recommendations.map((r: any) => r.recommendation),
        ["推荐通过", "推荐不通过", "推荐不通过"],
      );
      assert.ok(result.recommendations[2].uncertaintyImpact);
      if (scenario === "rework")
        assert.ok(
          snapshot.steps.filter((s: any) => s.node === "audit").length === 2,
        );
      if (scenario === "job-rework")
        assert.equal(
          snapshot.steps.filter((s: any) => s.node === "match").length,
          2,
        );
      if (scenario === "retry")
        assert.equal(
          main.attempts.filter((a: any) => a.node === "match").length,
          2,
        );
      assert.deepEqual(Object.keys(main.execution!.structure.workflow.nodes), [
        "parse",
        "match",
        "audit",
        "render",
      ]);
      if (scenario === "normal") {
        assert.equal(snapshot.steps.length, 4);
        assert.equal(
          main.attempts.filter((a: any) => ["match", "audit"].includes(a.node))
            .length,
          2,
        );
      }
      const events = await store.events("acceptance", 0, 1000),
        final = events.findLast((e) => (e.content as any).kind === "artifact")!
          .content as any;
      const archive = new FileArtifactArchive(
          join(root, "tasks/archive"),
          new FileContractRegistry(new ContractRegistry()),
        ),
        manifest = await archive.read(final.saved.archive);
      assert.equal(
        manifest.files.filter((f) => f.path.endsWith(".pdf")).length,
        3,
      );
      assert.equal(
        manifest.files.filter((f) => f.path.endsWith(".md")).length,
        4,
      );
      const bytes = await readFile(
        join(
          root,
          "tasks/archive",
          final.saved.archive.id,
          "data/reports/c1.pdf",
        ),
      );
      assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
      assert.equal(main.execution!.structure.workflow.id, "recruitment");
    },
  );
