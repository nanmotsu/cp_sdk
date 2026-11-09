import assert from "node:assert/strict";
import { test } from "node:test";
import { request as httpRequest } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboardServer } from "../server.js";

async function withServer(copilot, run, pipelineDirectory) {
  const errors = [];
  const server = createDashboardServer(copilot, { error: (error) => errors.push(error) }, pipelineDirectory);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`, errors);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
}

// 実際の app/pipeline を書き換えないよう、テスト用の定義を使う。
async function pipelineFixture(stepCount = 2) {
  const directory = await mkdtemp(join(tmpdir(), "pipeline-api-"));
  const steps = Array.from({ length: stepCount }, (_, index) => {
    const id = `step${index + 1}`;
    return {
      id,
      name: ["一つ目", "二つ目"][index] ?? `手順${index + 1}`,
      model: ["gpt-6-luna", "claude-sonnet-5.5"][index] ?? "auto",
      prompt: `${id}/prompt.md`,
      verify: `${id}/verify.md`,
      passed: index === 0,
    };
  });
  await writeFile(join(directory, "pipeline.json"), JSON.stringify({
    steps,
  }), "utf8");
  for (const step of steps) {
    await mkdir(join(directory, step.id), { recursive: true });
    await writeFile(join(directory, step.prompt), `${step.id} の指示`, "utf8");
    await writeFile(join(directory, step.verify), `${step.id} の検証`, "utf8");
  }
  return directory;
}

const post = (base, input, headers = {}) => fetch(base + "/api/send", {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(input),
});
const decode = (text) => text.trim().split("\n").map((line) => JSON.parse(line));

test("serves only the declared screen and vendor assets", async () => {
  await withServer({}, async (base) => {
    for (const path of ["/", "/app.js", "/style.css", "/vendor/react.js", "/vendor/react-dom.js", "/vendor/htm.js"]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.ok((await response.text()).length > 0);
    }
    assert.equal((await fetch(base + "/copilot.js")).status, 404);
    assert.equal((await fetch(base + "/logs/test.jsonl")).status, 404);
  });
});

test("lists every model and session, sorted by modification time", async () => {
  const models = Array.from({ length: 25 }, (_, i) => ({ id: `m${i}`, name: `Model ${i}` }));
  const sessions = Array.from({ length: 15 }, (_, i) => ({ sessionId: `s${i}`, modifiedTime: new Date(2026, 0, i + 1).toISOString() }));
  await withServer({ listModels: async () => models, listSessions: async () => sessions }, async (base) => {
    assert.deepEqual(await (await fetch(base + "/api/models")).json(), models);
    const result = await (await fetch(base + "/api/sessions")).json();
    assert.equal(result.length, 15);
    assert.equal(result[0].sessionId, "s14");
  });
});

test("returns saved history without running the model", async () => {
  const events = [{ type: "user.message", data: { content: "Saved prompt" } }];
  await withServer({ getHistory: async (id) => { assert.equal(id, "saved"); return events; } }, async (base) => {
    assert.equal((await fetch(base + "/api/history")).status, 400);
    assert.deepEqual(await (await fetch(base + "/api/history?sessionId=saved")).json(), events);
  });
});

test("streams a new session before completion, rejects concurrent operations and releases it", async () => {
  let finish;
  let disconnected = false;
  const event = { type: "assistant.message_delta", data: { messageId: "m1", deltaContent: "こんにちは" } };
  const session = {
    sessionId: "new",
    disconnect: async () => { disconnected = true; },
    abort: async () => { if (finish) finish(); },
  };
  const copilot = {
    createSession: async (model) => { assert.equal(model, "chosen"); return session; },
    sendMessage: async (value, prompt, emit) => {
      assert.equal(value, session);
      assert.equal(prompt, "Hello");
      emit(event);
      await new Promise((resolve) => { finish = resolve; });
    },
  };
  await withServer(copilot, async (base) => {
    const response = await post(base, { prompt: "Hello", model: "chosen" });
    assert.equal(response.status, 200);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let first = "";
    while (!first.includes("こんにちは")) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      first += decoder.decode(chunk.value, { stream: true });
    }
    assert.ok(first.includes('"sessionId":"new"'));
    assert.ok(first.includes("こんにちは"));
    assert.equal(disconnected, false);
    assert.equal((await post(base, { prompt: "Again" })).status, 409);
    assert.equal((await fetch(base + "/api/history?sessionId=new")).status, 409);
    finish();
    let rest = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      rest += decoder.decode(chunk.value, { stream: true });
    }
    const packets = decode(first + rest);
    assert.deepEqual(packets, [{ type: "session", sessionId: "new" }, { type: "event", event }, { type: "done" }]);
    assert.equal(disconnected, true);
  });
});

test("resumes the selected session with the selected model rather than creating another", async () => {
  let resumed;
  let modelUsed;
  const session = { sessionId: "saved", disconnect: async () => {} };
  await withServer({
    resumeSession: async (id, model) => { resumed = id; modelUsed = model; return session; },
    sendMessage: async () => {},
  }, async (base) => {
    const response = await post(base, { sessionId: "saved", prompt: "Hello", model: "switched" });
    assert.equal(response.status, 200);
    assert.equal(decode(await response.text()).at(-1).type, "done");
    assert.equal(resumed, "saved");
    assert.equal(modelUsed, "switched");
  });
});

test("SDK failures are streamed as errors, not successful completion", async () => {
  let disconnected = false;
  await withServer({
    createSession: async () => ({ sessionId: "new", disconnect: async () => { disconnected = true; } }),
    sendMessage: async () => { throw new Error("SDK failure"); },
  }, async (base, errors) => {
    const packets = decode(await (await post(base, { prompt: "Hello" })).text());
    assert.equal(packets.at(-1).type, "error");
    assert.equal(packets.some((packet) => packet.type === "done"), false);
    assert.equal(disconnected, true);
    assert.ok(errors.length);
  });
});

test("surfaces model availability failures clearly before and after the stream starts", async () => {
  const expected = 'Execution failed: Model "missing-model" is not available.';
  const directory = await pipelineFixture();

  await withServer({
    createSession: async () => { throw new Error(expected); },
  }, async (base) => {
    const response = await fetch(base + "/api/pipeline/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 500);
    assert.equal((await response.json()).error, expected);
  }, directory);

  await withServer({
    createSession: async () => ({ sessionId: "pipeline", disconnect: async () => {} }),
    setModel: async () => { throw new Error(expected); },
    sendMessage: async () => ({ data: { content: "OK" } }),
  }, async (base) => {
    const response = await fetch(base + "/api/pipeline/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: "step1", to: "step2" }),
    });
    const packets = decode(await response.text());
    assert.equal(packets.at(-1).type, "error");
    assert.equal(packets.at(-1).message, expected);
    assert.equal(packets.some((packet) => packet.type === "done"), false);
  }, directory);
});

test("cleanup failure is surfaced before the completion packet", async () => {
  await withServer({
    createSession: async () => ({ sessionId: "new", disconnect: async () => { throw new Error("Disconnect failed"); } }),
    sendMessage: async () => {},
  }, async (base) => {
    const packets = decode(await (await post(base, { prompt: "Hello" })).text());
    assert.equal(packets.at(-1).type, "error");
    assert.equal(packets.some((packet) => packet.type === "done"), false);
  });
});

test("disconnecting the browser aborts execution and releases the session", { timeout: 3000 }, async () => {
  let finish;
  let release;
  let aborted = false;
  const disconnected = new Promise((resolve) => { release = resolve; });
  const session = {
    sessionId: "new",
    abort: async () => { aborted = true; finish(); },
    disconnect: async () => { release(); },
  };
  await withServer({
    createSession: async () => session,
    sendMessage: async () => { await new Promise((resolve) => { finish = resolve; }); },
  }, async (base) => {
    const response = await post(base, { prompt: "Hello" });
    await response.body.cancel();
    await disconnected;
    assert.equal(aborted, true);
  });
});

test("lists all pipeline steps with fixed model IDs and rejects model updates", async () => {
  await withServer({}, async (base) => {
    assert.deepEqual(await (await fetch(base + "/api/pipeline")).json(), [
      { id: "step1", name: "一つ目", model: "gpt-6-luna", prompt: "step1/prompt.md", verify: "step1/verify.md", passed: true },
      { id: "step2", name: "二つ目", model: "claude-sonnet-5.5", prompt: "step2/prompt.md", verify: "step2/verify.md", passed: false },
    ]);
    const updateResponse = await fetch(base + "/api/pipeline/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stepId: "step1", model: "claude-opus-5" }),
    });
    assert.equal(updateResponse.status, 404);
  }, await pipelineFixture());
});

test("returns every configured step when the pipeline contains more than two", async () => {
  await withServer({}, async (base) => {
    const steps = await (await fetch(base + "/api/pipeline")).json();
    assert.equal(steps.length, 5);
    assert.deepEqual(steps.map((step) => step.id), ["step1", "step2", "step3", "step4", "step5"]);
  }, await pipelineFixture(5));
});

test("runs the requested pipeline range in one session, switches models per step, and streams credits", async () => {
  const sent = [];
  const switchedModels = [];
  const session = { sessionId: "pipeline", disconnect: async () => {} };
  let sessionCount = 0;
  let initialModelUsed = "";
  await withServer({
    createSession: async (model) => {
      sessionCount += 1;
      initialModelUsed = model;
      return session;
    },
    setModel: async (value, model) => {
      assert.equal(value, session);
      switchedModels.push(model);
    },
    sendMessage: async (value, prompt, onEvent) => {
      assert.equal(value, session);
      sent.push(prompt);
      onEvent({
        type: "assistant.usage",
        data: { inputTokens: 50, outputTokens: 10, copilotUsage: { totalNanoAiu: 100_000_000 } },
      });
      return { data: { content: "OK" } };
    },
  }, async (base) => {
    const response = await fetch(base + "/api/pipeline/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: "step1", to: "step2" }),
    });
    assert.equal(response.status, 200);
    const packets = decode(await response.text());
    assert.equal(packets[0].type, "session");
    assert.equal(packets.at(-1).type, "done");
    assert.equal(initialModelUsed, "gpt-6-luna");
    assert.deepEqual(switchedModels, ["claude-sonnet-5.5"]);
    const results = packets.filter((packet) => packet.type === "step-result");
    assert.equal(results.length, 2);
    assert.equal(results[0].stepId, "step1");
    assert.equal(results[0].model, "gpt-6-luna");
    assert.equal(results[0].credits.totalCredits, 0.2);
    assert.equal(results[1].stepId, "step2");
    assert.equal(results[1].model, "claude-sonnet-5.5");
    assert.equal(results[1].credits.totalCredits, 0.2);
    const savedSteps = await (await fetch(base + "/api/pipeline")).json();
    assert.equal(savedSteps[0].credits.totalCredits, 0.2);
    assert.equal(savedSteps[1].credits.totalCredits, 0.2);
    assert.deepEqual(sent, ["step1 の指示", "step1 の検証", "step2 の指示", "step2 の検証"]);
    assert.equal(sessionCount, 1);
  }, await pipelineFixture());
});

test("reports pipeline definition and range problems", async () => {
  await withServer({ createSession: async () => ({ sessionId: "p", disconnect: async () => {} }) }, async (base) => {
    const run = (input) => fetch(base + "/api/pipeline/run", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
    assert.equal((await run({ from: 1 })).status, 400);
    const packets = decode(await (await run({ from: "step2", to: "step1" })).text());
    assert.equal(packets.at(-1).type, "error");
    assert.equal(packets.some((packet) => packet.type === "done"), false);
  }, await pipelineFixture());
});

test("rejects invalid input before calling the SDK", async () => {  await withServer({}, async (base) => {
    for (const input of [{}, null, [], { prompt: " " }, { prompt: "Hi", sessionId: 1 }, { prompt: "Hi", model: "" }]) {
      assert.equal((await post(base, input)).status, 400);
    }
    assert.equal((await post(base, { prompt: "Hi" }, { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await fetch(base + "/api/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })).status, 400);
    assert.equal((await post(base, { prompt: "x".repeat(65 * 1024) })).status, 413);
  });
});

test("rejects cross-origin requests and untrusted Host headers", async () => {
  await withServer({}, async (base) => {
    assert.equal((await post(base, { prompt: "Hi" }, { Origin: "https://example.com" })).status, 403);
    const status = await new Promise((resolve, reject) => {
      const request = httpRequest(base, { headers: { Host: "example.com" } }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      });
      request.on("error", reject);
      request.end();
    });
    assert.equal(status, 403);
    assert.equal((await fetch(base, { method: "DELETE" })).status, 405);
  });
});
