import { CopilotClient, approveAll } from "@github/copilot-sdk";

export class CopilotService {
  constructor(logger, client = new CopilotClient()) {
    this.client = client;
    this.logger = logger;
    this.config = { onPermissionRequest: approveAll, streaming: true };
  }

  async start() {
    await this.client.start();
  }

  async stop() {
    const errors = await this.client.stop();
    if (errors.length) throw new AggregateError(errors, "Copilot cleanup failed");
  }

  async listModels() {
    return (await this.client.listModels()).map(({ id, name }) => ({ id, name }));
  }

  async listSessions() {
    const sessions = (await this.client.listSessions()).map((session) => ({
      sessionId: session.sessionId,
      summary: session.summary ?? "",
      client: session.clientName ?? "",
      workingDirectory: session.context?.workingDirectory ?? "",
      modifiedTime: session.modifiedTime.toISOString(),
    }));
    return sessions;
  }

  async createSession(model = "auto") {
    const session = await this.client.createSession({
      ...this.config, model, name: "SDK demo",
    });
    return session;
  }

  async resumeSession(sessionId, model) {
    if (!sessionId) throw new Error("A session ID is required.");
    const session = await this.client.resumeSession(sessionId, {
      ...this.config,
      ...(model ? { model } : {}),
    });
    return session;
  }

  // 会話履歴を保ったまま、次の発話で使うモデルを切り替える。
  async setModel(session, model) {
    if (model && typeof session?.setModel === "function") {
      await session.setModel(model);
    }
  }

  async getHistory(sessionId) {
    const session = await this.resumeSession(sessionId);
    try {
      return await session.getEvents();
    } finally {
      // 接続だけを解放し、保存済みの会話は削除しない。
      await session.disconnect();
    }
  }

  async sendMessage(session, prompt, onEvent) {
    const log = this.logger.openStream(session.sessionId);
    this.logger.info(`Log: ${log.file}`);
    let streamError;
    let abortPromise;
    // ログと表示で同じイベントを使う。表示用の改行や完了通知はログに混ぜない。
    const unsubscribe = session.on((event) => {
      if (streamError) return;
      try {
        log.event(event);
        onEvent(event);
      } catch (error) {
        streamError = error;
        this.logger.error(error);
        // SDK のイベントハンドラー内の例外は伝播しないため、送信も中断して失敗を返す。
        abortPromise = session.abort().catch((abortError) => {
          streamError = new AggregateError([error, abortError], "Stream abort failed");
          this.logger.error(abortError);
        });
      }
    });
    try {
      const response = await session.sendAndWait({ prompt }, 600_000);
      if (streamError) throw streamError;
      if (!response) throw new Error("No assistant message received.");
      return response;
    } catch (error) {
      if (abortPromise) await abortPromise;
      throw streamError ?? error;
    } finally {
      unsubscribe();
    }
  }
}
