import { readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { resolve, sep } from "node:path";

const defaultDirectory = fileURLToPath(new URL("./pipeline/", import.meta.url));

// pipeline.json に書かれたパスが app/pipeline の外を指さないようにする。
function resolveStepFile(directory, relativePath) {
  const root = resolve(directory) + sep;
  const target = resolve(directory, relativePath);
  if (!target.startsWith(root)) {
    throw new Error(`app/pipeline の外は参照できません: ${relativePath}`);
  }
  return target;
}

function definitionFile(directory) {
  return resolve(directory, "pipeline.json");
}

export async function loadPipeline(directory = defaultDirectory) {
  let data;
  try {
    data = JSON.parse(await readFile(definitionFile(directory), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error("app/pipeline/pipeline.json がありません。");
    if (error instanceof SyntaxError) throw new Error("pipeline.json の JSON 形式が不正です。");
    throw error;
  }
  if (!data || !Array.isArray(data.steps) || data.steps.length === 0) {
    throw new Error("pipeline.json には 1 件以上の steps が必要です。");
  }
  for (const step of data.steps) {
    if (!step || typeof step.id !== "string" || !step.id.trim()
      || typeof step.prompt !== "string" || !step.prompt.trim()
      || typeof step.verify !== "string" || !step.verify.trim()) {
      throw new Error("各 step には id・prompt・verify が必要です。");
    }
    if (step.model !== undefined && (typeof step.model !== "string" || !step.model.trim())) {
      throw new Error("各 step の model には空でないモデル ID を指定してください。");
    }
  }
  const ids = data.steps.map((step) => step.id);
  if (new Set(ids).size !== ids.length) throw new Error("step の id が重複しています。");
  return data;
}

// 検証用 .md の回答は OK または NG で始める約束にしている。
export function isPassed(content) {
  return /^\s*ok\b/i.test(content ?? "");
}

// SDK が報告する totalNanoAiu（10億分の1 AI クレジット）を AI クレジット単位へ変換する。
export function nanoToCredits(nanoAiu) {
  return Number((nanoAiu / 1_000_000_000).toFixed(9));
}

function accumulateUsage(usage, phase, event) {
  if (!event || typeof event !== "object") return;
  if (event.type === "assistant.usage" && event.data) {
    const nano = Number(event.data.copilotUsage?.totalNanoAiu ?? 0);
    if (Number.isFinite(nano) && nano > 0) {
      if (phase === "prompt") usage.promptNanoAiu += nano;
      else usage.verifyNanoAiu += nano;
    }
    usage.inputTokens += Number(event.data.inputTokens ?? 0) || 0;
    usage.outputTokens += Number(event.data.outputTokens ?? 0) || 0;
    usage.calls += 1;
  } else if (event.type === "tool.execution_complete" && event.data?.toolUsage) {
    const nano = Number(event.data.toolUsage.copilotUsage?.totalNanoAiu ?? 0);
    if (Number.isFinite(nano) && nano > 0) {
      if (phase === "prompt") usage.promptNanoAiu += nano;
      else usage.verifyNanoAiu += nano;
    }
  }
}

function buildCredits(stepId, name, model, passed, usage, durationSeconds) {
  const totalNanoAiu = usage.promptNanoAiu + usage.verifyNanoAiu;
  return {
    timestamp: new Date().toISOString(),
    durationSeconds,
    stepId,
    name,
    model,
    passed: passed === true,
    promptNanoAiu: usage.promptNanoAiu,
    verifyNanoAiu: usage.verifyNanoAiu,
    totalNanoAiu,
    promptCredits: nanoToCredits(usage.promptNanoAiu),
    verifyCredits: nanoToCredits(usage.verifyNanoAiu),
    totalCredits: nanoToCredits(totalNanoAiu),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    calls: usage.calls,
  };
}

function stepRange(steps, from, to) {
  const start = from ? steps.findIndex((step) => step.id === from) : 0;
  const end = to ? steps.findIndex((step) => step.id === to) : steps.length - 1;
  if (start === -1) throw new Error(`開始手順が見つかりません: ${from}`);
  if (end === -1) throw new Error(`終了手順が見つかりません: ${to}`);
  if (start > end) throw new Error("開始手順は終了手順より前に指定してください。");
  return steps.slice(start, end + 1);
}

export async function runPipeline({ send, setModel, recordCredits, from, to, directory = defaultDirectory }, onMessage) {
  const pipeline = await loadPipeline(directory);
  const targets = stepRange(pipeline.steps, from, to);
  onMessage({ type: "pipeline-start", stepIds: targets.map((step) => step.id) });

  for (const step of targets) {
    const startedAt = performance.now();
    const name = step.name ?? step.id;
    const model = step.model?.trim() || "auto";
    if (setModel) await setModel(model);
    const usage = { promptNanoAiu: 0, verifyNanoAiu: 0, inputTokens: 0, outputTokens: 0, calls: 0 };

    // prompt.md を送ったあと、検証用 .md を同じ会話へ送って合否を判定する。
    const runPhase = async (phase, path) => {
      onMessage({ type: "step-start", stepId: step.id, name, model, phase });
      const text = await readFile(resolveStepFile(directory, path), "utf8");
      if (!text.trim()) throw new Error(`${path} が空です。`);
      return send(text, (event) => {
        accumulateUsage(usage, phase, event);
        onMessage({ type: "event", stepId: step.id, phase, event });
      }, model);
    };

    await runPhase("prompt", step.prompt);
    step.passed = isPassed(await runPhase("verify", step.verify));
    const durationSeconds = Number(((performance.now() - startedAt) / 1000).toFixed(3));
    const credits = buildCredits(step.id, name, model, step.passed, usage, durationSeconds);
    step.credits = credits;
    if (recordCredits) await recordCredits(credits);
    // 途中で止めても、ここまでの合否と消費クレジットを pipeline.json に残す。
    await writeFile(definitionFile(directory), JSON.stringify(pipeline, null, 2) + "\n", "utf8");
    onMessage({ type: "step-result", stepId: step.id, model, passed: step.passed, credits });

    if (!step.passed) {
      onMessage({ type: "pipeline-stopped", stepId: step.id, name });
      return;
    }
  }
}
