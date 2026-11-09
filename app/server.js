import { CopilotService } from "./copilot.js";
import { createLogger } from "./logger.js";
import { loadPipeline, runPipeline } from "./pipeline.js";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const assets = new Map([
  ["/", ["./public/index.html", "text/html; charset=utf-8"]],
  ["/app.js", ["./public/app.js", "text/javascript; charset=utf-8"]],
  ["/style.css", ["./public/style.css", "text/css; charset=utf-8"]],
  ["/vendor/react.js", ["../node_modules/react/umd/react.production.min.js", "text/javascript; charset=utf-8"]],
  ["/vendor/react-dom.js", ["../node_modules/react-dom/umd/react-dom.production.min.js", "text/javascript; charset=utf-8"]],
  ["/vendor/htm.js", ["../node_modules/htm/dist/htm.umd.js", "text/javascript; charset=utf-8"]],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function modelAvailabilityMessage(error) {
  const match = /Model\s+["']([^"']+)["']\s+is not available\.?/i.exec(error?.message ?? "");
  return match ? `Execution failed: Model "${match[1]}" is not available.` : null;
}

// 大きすぎる入力や壊れた JSON は、SDK を呼ぶ前に明示的に拒否する。
async function readJsonBody(request) {
  if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") {
    throw new HttpError(415, "application/json で送信してください。");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw new HttpError(413, "入力は64KB以内にしてください。");
    chunks.push(chunk);
  }
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new HttpError(400, "JSON の形式が不正です。");
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(400, "JSON オブジェクトで送信してください。");
  }
  if ((input.sessionId !== undefined && typeof input.sessionId !== "string")
    || (input.model !== undefined && (typeof input.model !== "string" || !input.model.trim()))) {
    throw new HttpError(400, "セッション ID とモデルの形式を確認してください。");
  }
  return input;
}

async function readPrompt(request) {
  const input = await readJsonBody(request);
  if (typeof input.prompt !== "string" || !input.prompt.trim()) {
    throw new HttpError(400, "プロンプトの形式を確認してください。");
  }
  return input;
}

async function readPipelineRun(request) {
  const input = await readJsonBody(request);
  for (const key of ["from", "to"]) {
    if (input[key] !== undefined && input[key] !== "" && typeof input[key] !== "string") {
      throw new HttpError(400, "開始・終了手順の形式を確認してください。");
    }
  }
  return input;
}

function formatPipelineSteps(pipeline) {
  return pipeline.steps.map((step) => ({
    id: step.id,
    name: step.name ?? step.id,
    model: step.model ?? "auto",
    prompt: step.prompt,
    verify: step.verify,
    passed: step.passed === true,
  }));
}

// 送信とパイプラインで共通の、セッション確保・中断・解放処理。
async function runWithSession(copilot, logger, response, stream, input, work) {
  let session;
  let disconnected = false;
  const onClose = () => {
    if (response.writableEnded) return;
    disconnected = true;
    if (session) session.abort().catch((error) => logger.error(error));
  };
  response.on("close", onClose);
  try {
    const model = input.model ?? "auto";
    session = input.sessionId
      ? await copilot.resumeSession(input.sessionId, model)
      : await copilot.createSession(model);
    if (disconnected) throw new Error("画面との接続が切れました。");
    response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8" });
    response.flushHeaders();
    stream({ type: "session", sessionId: session.sessionId });
    await work(session);
  } finally {
    try {
      if (session) await session.disconnect();
    } finally {
      response.off("close", onClose);
    }
  }
  stream({ type: "done" });
  response.end();
}

export function createDashboardServer(copilot, logger, pipelineDirectory) {
  // ローカル画面全体で1件ずつ実行し、同じ会話の再開・送信競合を避ける。
  let busy = false;
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    const json = (status, data) => {
      response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(data));
    };
    const stream = (data) => {
      if (!response.destroyed) response.write(JSON.stringify(data) + "\n");
    };

    try {
      // 自動許可でツールを使うため、外部サイトからの送信と DNS rebinding を防ぐ。
      const port = server.address().port;
      const host = request.headers.host;
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(host)
        || (request.headers.origin && request.headers.origin !== `http://${host}`)) {
        throw new HttpError(403, "このローカル画面からのみ操作できます。");
      }
      const url = new URL(request.url, `http://${host}`);
      if (request.method === "GET" && url.pathname === "/api/models") {
        json(200, await copilot.listModels());
      } else if (request.method === "GET" && url.pathname === "/api/sessions") {
        json(200, (await copilot.listSessions()).sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime)));
      } else if (request.method === "GET" && url.pathname === "/api/history") {
        const sessionId = url.searchParams.get("sessionId");
        if (!sessionId?.trim()) throw new HttpError(400, "セッション ID が必要です。");
        if (busy) throw new HttpError(409, "処理中です。完了後に操作してください。");
        busy = true;
        try {
          json(200, await copilot.getHistory(sessionId));
        } finally {
          busy = false;
        }
      } else if (request.method === "GET" && url.pathname === "/api/pipeline") {
        json(200, formatPipelineSteps(await loadPipeline(pipelineDirectory)));
      } else if (request.method === "POST" && url.pathname === "/api/send") {
        if (busy) throw new HttpError(409, "処理中です。完了後に操作してください。");
        busy = true;
        try {
          const input = await readPrompt(request);
          // 画面の通信だけに枠を付ける。ログ側は元の SDK イベントのまま。
          await runWithSession(copilot, logger, response, stream, input, (session) =>
            copilot.sendMessage(session, input.prompt, (event) => stream({ type: "event", event })));
        } finally {
          busy = false;
        }
      } else if (request.method === "POST" && url.pathname === "/api/pipeline/run") {
        if (busy) throw new HttpError(409, "処理中です。完了後に操作してください。");
        busy = true;
        try {
          const input = await readPipelineRun(request);
          const pipeline = await loadPipeline(pipelineDirectory);
          const firstStep = input.from
            ? pipeline.steps.find((step) => step.id === input.from)
            : pipeline.steps[0];
          const initialModel = firstStep?.model ?? "auto";
          // 範囲内のすべての手順を、手順ごとの指定モデルへ切り替えながら同じセッションで実行する。
          await runWithSession(copilot, logger, response, stream, { ...input, model: initialModel }, async (session) => {
            let activeModel = initialModel;
            const creditLog = logger.openCreditLog?.(session.sessionId);
            if (creditLog) {
              logger.info?.(`Credit log: ${creditLog.file}`);
              stream({ type: "credit-log", file: creditLog.file });
            }
            await runPipeline({
              directory: pipelineDirectory,
              from: input.from || undefined,
              to: input.to || undefined,
              setModel: async (stepModel) => {
                if (stepModel && stepModel !== activeModel) {
                  await copilot.setModel(session, stepModel);
                  activeModel = stepModel;
                }
              },
              recordCredits: (credits) => {
                creditLog?.record({ sessionId: session.sessionId, ...credits });
              },
              send: async (prompt, onEvent) =>
                (await copilot.sendMessage(session, prompt, onEvent)).data.content,
            }, stream);
          });
        } finally {
          busy = false;
        }
      } else if (request.method === "GET" && assets.has(url.pathname)) {
        const [file, contentType] = assets.get(url.pathname);
        const content = await readFile(new URL(file, import.meta.url));
        response.writeHead(200, { "Content-Type": contentType });
        response.end(content);
      } else if (request.method !== "GET" && request.method !== "POST") {
        response.setHeader("Allow", "GET, POST");
        throw new HttpError(405, "このメソッドは使用できません。");
      } else {
        throw new HttpError(404, "見つかりません。");
      }
    } catch (error) {
      logger.error(error);
      const message = error instanceof HttpError
        ? error.message
        : modelAvailabilityMessage(error) ?? "処理に失敗しました。ターミナルのログと Copilot のログイン状態を確認してください。";
      if (response.headersSent) {
        stream({ type: "error", message });
        response.end();
      } else if (!response.destroyed) {
        json(error instanceof HttpError ? error.status : 500, { error: message });
      }
    }
  });
  return server;
}

async function main() {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  const logger = createLogger("server");
  const copilot = new CopilotService(logger);
  const server = createDashboardServer(copilot, logger);
  let closing = false;
  try {
    await copilot.start();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch (error) {
    try {
      await copilot.stop();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Dashboard startup failed");
    }
    throw error;
  }
  logger.info(`Copilot dashboard: http://127.0.0.1:${port}`);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      if (closing) return;
      closing = true;
      // 開いているストリームも閉じ、接続断の処理で SDK 実行を中断する。
      new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      }).then(() => copilot.stop()).catch((error) => {
        logger.error(error);
        process.exitCode = 1;
      });
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
