import assert from "node:assert/strict";
import { readFileSync, unlinkSync } from "node:fs";
import { test } from "node:test";
import { CopilotService } from "../copilot.js";
import { createLogger } from "../logger.js";

function fixture(run, record = () => {}) {
  const errors = [];
  const logged = [];
  let handler;
  let unsubscribed = false;
  let aborted = false;
  const logger = {
    info() {},
    error(error) { errors.push(error); },
    openStream() {
      return { file: "test.jsonl", event(event) { record(event); logged.push(event); } };
    },
  };
  const session = {
    sessionId: "test-session",
    on(callback) { handler = callback; return () => { unsubscribed = true; }; },
    async abort() { aborted = true; },
    async sendAndWait(options, timeout) {
      assert.deepEqual(options, { prompt: "Hello" });
      assert.equal(timeout, 600_000);
      return run((event) => handler(event));
    },
  };
  const service = new CopilotService(logger, {});
  return { service, session, logged, errors, get unsubscribed() { return unsubscribed; }, get aborted() { return aborted; } };
}

test("logs and forwards the same SDK events immediately and does not append a synthetic final response", async () => {
  const events = [
    { id: "1", type: "user.message", timestamp: "2026-11-09T13:00:00Z", data: { content: "Hello" } },
    { id: "2", type: "assistant.message_delta", ephemeral: true, data: { messageId: "m1", deltaContent: "こんにちは\n" } },
    { id: "3", type: "tool.execution_start", data: { toolCallId: "t1", toolName: "view" } },
    { id: "4", type: "assistant.message", data: { messageId: "m1", content: "こんにちは\n" } },
  ];
  let finish;
  const f = fixture((emit) => {
    emit(events[0]);
    emit(events[1]);
    return new Promise((resolve) => {
      finish = () => { events.slice(2).forEach(emit); resolve(events[3]); };
    });
  });
  const displayed = [];
  const pending = f.service.sendMessage(f.session, "Hello", (event) => displayed.push(event));
  assert.deepEqual(displayed, events.slice(0, 2));
  assert.equal(f.unsubscribed, false);
  finish();
  await pending;
  assert.deepEqual(displayed, events);
  assert.deepEqual(f.logged, events);
  assert.equal(f.unsubscribed, true);
});

test("JSONL stores the original event fields, Unicode, line breaks and sub-agent events unchanged, and credit log writes to a separate file", () => {
  const logger = createLogger("test");
  const log = logger.openStream("raw-events");
  const creditLog = logger.openCreditLog("raw-events");
  try {
    const events = [
      { type: "assistant.message_delta", agentId: "child", ephemeral: true, timestamp: "2026-11-09T13:00:00Z", data: { messageId: "m1", deltaContent: "こんにちは\n\t😀" } },
      { type: "assistant.message", data: { messageId: "m1", content: "<script>test</script>\n" } },
    ];
    events.forEach((event) => log.event(event));
    const text = readFileSync(log.file, "utf8");
    assert.equal(text, events.map((event) => JSON.stringify(event) + "\n").join(""));
    assert.deepEqual(text.trimEnd().split("\n").map((line) => JSON.parse(line)), events);

    const creditEntry = { sessionId: "raw-events", stepId: "step1", model: "gpt-6-luna", totalCredits: 0.175 };
    creditLog.record(creditEntry);
    assert.notEqual(creditLog.file, log.file);
    assert.deepEqual(JSON.parse(readFileSync(creditLog.file, "utf8").trim()), creditEntry);
  } finally {
    unlinkSync(log.file);
    unlinkSync(creditLog.file);
  }
});

test("log write failures abort the run, reject and unsubscribe", async () => {
  const failure = new Error("Disk full");
  const f = fixture(async (emit) => {
    emit({ type: "assistant.message_delta", data: { messageId: "m1", deltaContent: "Hi" } });
    return { data: { content: "Hi" } };
  }, () => { throw failure; });
  await assert.rejects(f.service.sendMessage(f.session, "Hello", () => {}), (error) => error === failure);
  assert.equal(f.aborted, true);
  assert.equal(f.unsubscribed, true);
  assert.equal(f.errors[0], failure);
});

test("SDK rejection and missing final response remain failures", async () => {
  for (const run of [async () => { throw new Error("Timeout"); }, async () => undefined]) {
    const f = fixture(run);
    await assert.rejects(f.service.sendMessage(f.session, "Hello", () => {}));
    assert.equal(f.unsubscribed, true);
  }
});

test("history resumes without sending a prompt and disconnects without deleting the session", async () => {
  const events = [{ type: "assistant.message", data: { content: "Saved" } }];
  let disconnected = false;
  const client = {
    async resumeSession(id, config) {
      assert.equal(id, "saved");
      assert.equal(config.streaming, true);
      assert.equal(typeof config.onPermissionRequest, "function");
      return { getEvents: async () => events, disconnect: async () => { disconnected = true; } };
    },
  };
  const service = new CopilotService({}, client);
  assert.equal(await service.getHistory("saved"), events);
  assert.equal(disconnected, true);
});

test("history failures also release the SDK connection", async () => {
  let disconnected = false;
  const client = {
    resumeSession: async () => ({
      getEvents: async () => { throw new Error("History unavailable"); },
      disconnect: async () => { disconnected = true; },
    }),
  };
  await assert.rejects(new CopilotService({}, client).getHistory("saved"), /History unavailable/);
  assert.equal(disconnected, true);
});

test("new and resumed sessions use the selected model and shared streaming/permission configuration", async () => {
  let created;
  let resumed;
  const client = {
    createSession: async (value) => { created = value; return { sessionId: "new" }; },
    resumeSession: async (id, value) => { resumed = { id, value }; return { sessionId: id }; },
  };
  const service = new CopilotService({}, client);
  await service.createSession("selected-model");
  assert.equal(created.model, "selected-model");
  assert.equal(created.streaming, true);
  assert.equal(typeof created.onPermissionRequest, "function");

  await service.resumeSession("saved", "switched-model");
  assert.equal(resumed.id, "saved");
  assert.equal(resumed.value.model, "switched-model");
  assert.equal(resumed.value.streaming, true);
});

test("new sessions get unique timestamped names", async () => {
  const names = [];
  const service = new CopilotService({}, {
    createSession: async (options) => {
      names.push(options.name);
      return { sessionId: `session-${names.length}` };
    },
  });

  await service.createSession();
  await service.createSession();

  assert.notEqual(names[0], names[1]);
  assert.match(names[0], /^SDK_\d{6}_\d{2}:\d{2}:\d{2}(?:_\d+)?$/);
  assert.match(names[1], /^SDK_\d{6}_\d{2}:\d{2}:\d{2}(?:_\d+)?$/);
});
