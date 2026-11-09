import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isPassed, loadPipeline, runPipeline } from "../pipeline.js";

async function fixture(steps, files = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pipeline-"));
  await writeFile(join(directory, "pipeline.json"), JSON.stringify({ steps }, null, 2), "utf8");
  for (const [path, content] of Object.entries(files)) {
    const target = join(directory, path);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return directory;
}

const twoSteps = [
  { id: "step1", name: "一つ目", prompt: "step1/prompt.md", verify: "step1/verify.md", passed: false },
  { id: "step2", name: "二つ目", prompt: "step2/prompt.md", verify: "step2/verify.md", passed: false },
];
const twoFiles = {
  "step1/prompt.md": "一つ目の指示",
  "step1/verify.md": "一つ目の検証",
  "step2/prompt.md": "二つ目の指示",
  "step2/verify.md": "二つ目の検証",
};

const readSteps = async (directory) =>
  JSON.parse(await readFile(join(directory, "pipeline.json"), "utf8")).steps;

test("judges a step only when the verification reply starts with OK", () => {
  for (const content of ["OK", "ok 条件を満たします", "OK\n理由"]) assert.equal(isPassed(content), true);
  for (const content of ["NG", "NG 不足あり", "条件は OK です", "", undefined]) assert.equal(isPassed(content), false);
});

test("sends prompt then verification per step and records true in pipeline.json", async () => {
  const directory = await fixture(twoSteps, twoFiles);
  const sent = [];
  await runPipeline({
    directory,
    send: async (prompt) => { sent.push(prompt); return "OK"; },
  }, () => {});
  assert.deepEqual(sent, ["一つ目の指示", "一つ目の検証", "二つ目の指示", "二つ目の検証"]);
  assert.deepEqual((await readSteps(directory)).map((step) => step.passed), [true, true]);
});

test("runs only the requested range and leaves other steps untouched", async () => {
  const directory = await fixture(twoSteps, twoFiles);
  const sent = [];
  await runPipeline({
    directory, from: "step2", to: "step2",
    send: async (prompt) => { sent.push(prompt); return "OK"; },
  }, () => {});
  assert.deepEqual(sent, ["二つ目の指示", "二つ目の検証"]);
  assert.deepEqual((await readSteps(directory)).map((step) => step.passed), [false, true]);
});

test("re-runs steps that are already true", async () => {
  const directory = await fixture(
    twoSteps.map((step) => ({ ...step, passed: true })), twoFiles);
  const sent = [];
  await runPipeline({
    directory, from: "step1", to: "step1",
    send: async (prompt) => { sent.push(prompt); return "NG"; },
  }, () => {});
  assert.deepEqual(sent, ["一つ目の指示", "一つ目の検証"]);
  assert.deepEqual((await readSteps(directory)).map((step) => step.passed), [false, true]);
});

test("stops at the first NG, keeps the saved result and reports the step", async () => {
  const directory = await fixture(twoSteps, twoFiles);
  const messages = [];
  const sent = [];
  await runPipeline({
    directory,
    send: async (prompt) => { sent.push(prompt); return "NG 不足しています"; },
  }, (message) => messages.push(message));
  assert.deepEqual(sent, ["一つ目の指示", "一つ目の検証"]);
  assert.deepEqual((await readSteps(directory)).map((step) => step.passed), [false, false]);
  assert.deepEqual(messages.at(-1), { type: "pipeline-stopped", stepId: "step1", name: "一つ目" });
});

test("reports progress, per-step model, and consumed AI credits for each phase", async () => {
  const stepWithModel = { ...twoSteps[0], model: "gpt-6-luna" };
  const directory = await fixture([stepWithModel], twoFiles);
  const deltaEvent = { type: "assistant.message_delta", data: { messageId: "m1", deltaContent: "進捗" } };
  const usageEvent = {
    type: "assistant.usage",
    data: { inputTokens: 100, outputTokens: 20, copilotUsage: { totalNanoAiu: 150_000_000 } },
  };
  const messages = [];
  const creditRecords = [];
  const modelsSet = [];
  await runPipeline({
    directory,
    setModel: async (m) => modelsSet.push(m),
    recordCredits: (entry) => creditRecords.push(entry),
    send: async (prompt, onEvent) => {
      onEvent(deltaEvent);
      onEvent(usageEvent);
      return "OK";
    },
  }, (message) => messages.push(message));

  assert.deepEqual(modelsSet, ["gpt-6-luna"]);
  assert.equal(creditRecords.length, 1);
  assert.equal(creditRecords[0].stepId, "step1");
  assert.equal(creditRecords[0].model, "gpt-6-luna");
  assert.equal(creditRecords[0].promptCredits, 0.15);
  assert.equal(creditRecords[0].verifyCredits, 0.15);
  assert.equal(creditRecords[0].totalCredits, 0.3);
  assert.equal(creditRecords[0].totalNanoAiu, 300_000_000);
  assert.equal(creditRecords[0].inputTokens, 200);
  assert.equal(creditRecords[0].outputTokens, 40);

  assert.deepEqual(messages.slice(0, 5), [
    { type: "pipeline-start", stepIds: ["step1"] },
    { type: "step-start", stepId: "step1", name: "一つ目", model: "gpt-6-luna", phase: "prompt" },
    { type: "event", stepId: "step1", phase: "prompt", event: deltaEvent },
    { type: "event", stepId: "step1", phase: "prompt", event: usageEvent },
    { type: "step-start", stepId: "step1", name: "一つ目", model: "gpt-6-luna", phase: "verify" },
  ]);
  const resultMsg = messages.at(-1);
  assert.equal(resultMsg.type, "step-result");
  assert.equal(resultMsg.stepId, "step1");
  assert.equal(resultMsg.model, "gpt-6-luna");
  assert.equal(resultMsg.passed, true);
  assert.equal(resultMsg.credits.totalCredits, 0.3);
});

test("runs every configured step beyond the first two", async () => {
  const steps = Array.from({ length: 5 }, (_, index) => ({
    ...twoSteps[index % twoSteps.length],
    id: `step${index + 1}`,
    name: `手順${index + 1}`,
    prompt: `step${index + 1}/prompt.md`,
    verify: `step${index + 1}/verify.md`,
  }));
  const files = Object.fromEntries(steps.flatMap((step) => [
    [step.prompt, `${step.name}の指示`],
    [step.verify, "OK"],
  ]));
  const directory = await fixture(steps, files);
  const messages = [];
  const sent = [];
  await runPipeline({
    directory,
    send: async (prompt) => { sent.push(prompt); return "OK"; },
  }, (message) => messages.push(message));
  assert.equal(sent.length, 10);
  assert.deepEqual(messages.filter((message) => message.type === "step-result").map((message) => message.stepId),
    ["step1", "step2", "step3", "step4", "step5"]);
});

test("rejects files outside app/pipeline and empty prompt files", async () => {
  const escaping = await fixture(
    [{ id: "step1", prompt: "../../secret.md", verify: "step1/verify.md" }], twoFiles);
  await assert.rejects(
    runPipeline({ directory: escaping, send: async () => "OK" }, () => {}),
    /app\/pipeline の外は参照できません/);

  const empty = await fixture([twoSteps[0]], { ...twoFiles, "step1/prompt.md": "   " });
  await assert.rejects(
    runPipeline({ directory: empty, send: async () => "OK" }, () => {}),
    /が空です/);
});

test("rejects an unusable definition and an invalid range", async () => {
  const missing = await mkdtemp(join(tmpdir(), "pipeline-"));
  await assert.rejects(loadPipeline(missing), /pipeline.json がありません/);

  const broken = await mkdtemp(join(tmpdir(), "pipeline-"));
  await writeFile(join(broken, "pipeline.json"), "{", "utf8");
  await assert.rejects(loadPipeline(broken), /JSON 形式が不正です/);

  const incomplete = await fixture([{ id: "step1", prompt: "step1/prompt.md" }]);
  await assert.rejects(loadPipeline(incomplete), /id・prompt・verify が必要です/);

  const duplicated = await fixture([twoSteps[0], { ...twoSteps[1], id: "step1" }]);
  await assert.rejects(loadPipeline(duplicated), /id が重複しています/);

  const directory = await fixture(twoSteps, twoFiles);
  const send = async () => "OK";
  await assert.rejects(runPipeline({ directory, from: "step9", send }, () => {}), /開始手順が見つかりません/);
  await assert.rejects(runPipeline({ directory, to: "step9", send }, () => {}), /終了手順が見つかりません/);
  await assert.rejects(
    runPipeline({ directory, from: "step2", to: "step1", send }, () => {}),
    /開始手順は終了手順より前に/);
});
