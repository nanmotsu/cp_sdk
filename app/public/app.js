const { useState, useEffect, useRef } = window.React;
const html = window.htm.bind(window.React.createElement);

async function getJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

// HTTP の受信境界は JSON の行や UTF-8 の文字境界と一致しないため、行単位に復元する。
async function readStream(response, onMessage) {
  if (!response.body) throw new Error("ストリームを受信できません。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line) onMessage(JSON.parse(line));
      }
      if (done) break;
    }
    if (pending.trim()) onMessage(JSON.parse(pending));
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally {
    reader.releaseLock();
  }
}

// pipeline.json などのモデル ID を、SDK のモデル一覧から表示名（name）へ解決する。
function resolveModelName(modelId, models) {
  if (!modelId) return "Auto";
  const matched = models.find((item) => item.id === modelId);
  if (matched) return matched.name;
  return modelId === "auto" ? "Auto" : modelId;
}

function formatCredits(credits) {
  const value = Number(credits ?? 0);
  if (!Number.isFinite(value) || value === 0) return "0 cr";
  return `${value.toFixed(9).replace(/\.?0+$/, "")} cr`;
}

function formatSessionLabel(session) {
  const summary = session.summary?.split(/\r?\n/)[0].slice(0, 42) || "概要なし";
  const client = session.client ? ` [${session.client}]` : "";
  return `${summary}${client} (${session.sessionId})`;
}

// 1回の発話データを作る。ストリーミング中も不変更新で React 状態へ反映する。
function createTurnState(id, title, prompt, status = "実行中", modelId = "") {
  return {
    id,
    title: title || prompt.split(/\r?\n/)[0].slice(0, 100) || "保存された応答",
    prompt,
    status,
    error: false,
    modelId,
    nanoAiu: 0,
    messages: [],
    tools: [],
    toolNames: {},
  };
}

// SDK イベントを 1 つの発話状態へ反映する（断片の追記、確定本文での置換、ツール履歴、消費クレジット）。
function applyEventToTurn(turn, event) {
  if (!event || event.agentId || event.data?.parentToolCallId) return turn;
  const next = {
    ...turn,
    messages: [...turn.messages],
    tools: [...turn.tools],
    toolNames: { ...turn.toolNames },
  };

  if (event.type === "assistant.message_delta" || event.type === "assistant.message") {
    const messageId = event.data.messageId || "default";
    const index = next.messages.findIndex((msg) => msg.id === messageId);
    const currentText = index >= 0 ? next.messages[index].text : "";
    const updatedText = event.type === "assistant.message_delta"
      ? currentText + (event.data.deltaContent ?? "")
      : (event.data.content ?? "");
    if (index >= 0) {
      next.messages[index] = { id: messageId, text: updatedText };
    } else {
      next.messages.push({ id: messageId, text: updatedText });
    }
  } else if (event.type === "tool.execution_start") {
    next.toolNames[event.data.toolCallId] = event.data.toolName;
    next.tools.push(`開始: ${event.data.toolName}`);
  } else if (event.type === "tool.execution_complete") {
    const name = next.toolNames[event.data.toolCallId] ?? event.data.toolCallId;
    delete next.toolNames[event.data.toolCallId];
    next.tools.push(event.data.success
      ? `完了: ${name}`
      : `失敗: ${name}: ${event.data.error?.message ?? "詳細なし"}`);
    const toolNano = Number(event.data?.toolUsage?.copilotUsage?.totalNanoAiu ?? 0);
    if (Number.isFinite(toolNano) && toolNano > 0) next.nanoAiu += toolNano;
  } else if (event.type === "assistant.usage") {
    const nano = Number(event.data?.copilotUsage?.totalNanoAiu ?? 0);
    if (Number.isFinite(nano) && nano > 0) next.nanoAiu += nano;
    if (!next.modelId && event.data?.model) next.modelId = event.data.model;
  } else if (event.type === "session.error") {
    next.status = "エラー";
    next.error = true;
    next.messages.push({ id: `err-${Date.now()}`, text: event.data.message, isError: true });
  }
  return next;
}

// 発話ごとの折りたたみカード。実行中に閉じても、開閉状態を維持したまま中身だけ更新される。
function TurnCard({ turn, models, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  const outputText = turn.messages.filter((m) => !m.isError).map((m) => m.text).join("");
  const errorMessages = turn.messages.filter((m) => m.isError);
  const credits = Number((turn.nanoAiu / 1_000_000_000).toFixed(9));
  const modelName = turn.modelId ? resolveModelName(turn.modelId, models) : "";

  return html`
    <details
      className=${`turn ${turn.status === "実行中" ? "turn-active" : ""}`}
      open=${open}
      onToggle=${(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        <span className="turn-title">${turn.title}</span>
        <span className="turn-meta">
          ${modelName && html`<span className="pill model-pill">${modelName}</span>`}
          ${credits > 0 && html`<span className="pill credit-pill">${formatCredits(credits)}</span>`}
          <span className=${`turn-status ${turn.error || turn.status === "NG" || turn.status === "失敗" ? "error" : turn.status === "OK" || turn.status === "完了" ? "ok" : ""}`}>
            ${turn.status}
          </span>
        </span>
      </summary>
      ${turn.prompt && html`<pre className="user-prompt">${turn.prompt}</pre>`}
      <div className="turn-output-wrap">
        ${outputText && html`<pre className="assistant-output">${outputText}</pre>`}
        ${errorMessages.map((msg) => html`<p key=${msg.id} className="error">${msg.text}</p>`)}
      </div>
      <details className="tool-details" hidden=${turn.tools.length === 0}>
        <summary>ツール実行 (${turn.tools.length})</summary>
        <pre>${turn.tools.join("\n")}</pre>
      </details>
    </details>
  `;
}

function App() {
  const [models, setModels] = useState([{ id: "auto", name: "Auto" }]);
  const [sessions, setSessions] = useState([]);
  const [sessionId, setSessionId] = useState("");
  const [selectedModel, setSelectedModel] = useState("auto");
  const [steps, setSteps] = useState([]);
  const [fromStep, setFromStep] = useState("");
  const [toStep, setToStep] = useState("");
  const [stepProgress, setStepProgress] = useState({});
  const [stepCredits, setStepCredits] = useState({});
  const [creditLogFile, setCreditLogFile] = useState("");
  const [historyTurns, setHistoryTurns] = useState([]);
  const [turns, setTurns] = useState([]);
  const [promptText, setPromptText] = useState("");
  const [busy, setBusy] = useState(false);
  const [chatStatus, setChatStatus] = useState({ message: "", error: false });
  const [pipelineStatus, setPipelineStatus] = useState({ message: "", error: false });
  const [unavailableModel, setUnavailableModel] = useState(null);
  const turnSeq = useRef(0);

  const nextTurnId = (prefix = "turn") => {
    turnSeq.current += 1;
    return `${prefix}-${turnSeq.current}`;
  };

  async function fetchModels() {
    const data = await getJson("/api/models");
    const list = data.some((m) => m.id === "auto") ? data : [{ id: "auto", name: "Auto" }, ...data];
    setModels(list);
    setSelectedModel((prev) => (list.some((m) => m.id === prev) ? prev : "auto"));
    return data;
  }

  async function fetchSessions(activeId = sessionId) {
    const data = await getJson("/api/sessions");
    setSessions(data);
    if (activeId) setSessionId(activeId);
  }

  async function fetchPipeline() {
    const data = await getJson("/api/pipeline");
    setSteps(data);
    setFromStep((prev) => (data.some((s) => s.id === prev) ? prev : data[0]?.id ?? ""));
    setToStep((prev) => (data.some((s) => s.id === prev) ? prev : data.at(-1)?.id ?? ""));
  }

  function handleFromStepChange(stepId) {
    const newIndex = steps.findIndex((step) => step.id === stepId);
    const endIndex = steps.findIndex((step) => step.id === toStep);
    setFromStep(stepId);
    if (newIndex > endIndex) setToStep(stepId);
  }

  function handleToStepChange(stepId) {
    const newIndex = steps.findIndex((step) => step.id === stepId);
    const startIndex = steps.findIndex((step) => step.id === fromStep);
    setToStep(stepId);
    if (newIndex < startIndex) setFromStep(stepId);
  }

  async function loadAll() {
    if (busy) return;
    setBusy(true);
    try {
      await Promise.all([fetchModels(), fetchSessions(), fetchPipeline()]);
      setPipelineStatus({ message: "", error: false });
    } catch (error) {
      console.error(error);
      setChatStatus({ message: `取得失敗: ${error.message}`, error: true });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  async function handleSelectSession(nextId) {
    if (busy) return;
    if (!nextId) {
      setSessionId("");
      setHistoryTurns([]);
      setTurns([]);
      setChatStatus({ message: "", error: false });
      return;
    }
    const previousId = sessionId;
    setBusy(true);
    setChatStatus({ message: "履歴を取得中…", error: false });
    try {
      const events = await getJson(`/api/history?sessionId=${encodeURIComponent(nextId)}`);
      setSessionId(nextId);
      setTurns([]);
      const loaded = [];
      let current = null;
      for (const event of events) {
        if (event.agentId || event.checkpoint || event.data?.parentToolCallId) continue;
        if (event.type === "user.message") {
          current = createTurnState(nextTurnId("hist"), "", event.data.content, "履歴");
          loaded.push(current);
        } else if (["assistant.message", "tool.execution_start", "tool.execution_complete", "assistant.usage", "session.error"].includes(event.type)) {
          if (!current) {
            current = createTurnState(nextTurnId("hist"), "保存された応答", "", "履歴");
            loaded.push(current);
          }
          current = applyEventToTurn(current, event);
          loaded[loaded.length - 1] = current;
        }
      }
      setHistoryTurns(loaded);
      setChatStatus({
        message: loaded.length ? "履歴を取得しました。" : "保存された会話はありません。",
        error: false,
      });
    } catch (error) {
      console.error(error);
      setSessionId(previousId);
      setChatStatus({ message: `履歴の取得失敗: ${error.message}`, error: true });
    } finally {
      setBusy(false);
    }
  }

  async function handleSendPrompt(event) {
    event.preventDefault();
    if (busy) return;
    if (!promptText.trim()) {
      setChatStatus({ message: "プロンプトを入力してください。", error: true });
      return;
    }
    setBusy(true);
    const turnId = nextTurnId("chat");
    const initialTurn = createTurnState(turnId, "", promptText, "実行中", selectedModel);
    setTurns((prev) => [...prev, initialTurn]);
    setChatStatus({ message: "実行中…（本文が生成され次第表示します）", error: false });

    let finished = false;
    let sessionError = "";
    let activeSession = sessionId;

    try {
      const response = await fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: promptText, sessionId, model: selectedModel }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      await readStream(response, (message) => {
        if (message.type === "session") {
          activeSession = message.sessionId;
          setSessionId(message.sessionId);
        } else if (message.type === "event") {
          if (message.event.type === "session.error") sessionError = message.event.data.message;
          setTurns((prev) => prev.map((t) => (t.id === turnId ? applyEventToTurn(t, message.event) : t)));
        } else if (message.type === "error") {
          throw new Error(message.message);
        } else if (message.type === "done") {
          finished = true;
        }
      });
      if (sessionError) throw new Error(sessionError);
      if (!finished) throw new Error("完了通知を受信する前に接続が切れました。");
      setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, status: "完了" } : t)));
      setPromptText("");
      setChatStatus({ message: "完了しました。SDK イベントは app/logs に保存されています。", error: false });
    } catch (error) {
      console.error(error);
      setTurns((prev) => prev.map((t) => (t.id === turnId ? { ...t, status: "失敗", error: true } : t)));
      setChatStatus({ message: `送信失敗: ${error.message}`, error: true });
    } finally {
      setBusy(false);
      await fetchSessions(activeSession).catch((err) => console.error(err));
    }
  }

  async function handleRunPipeline() {
    if (busy) return;
    setBusy(true);
    setUnavailableModel(null);
    setPipelineStatus({ message: "pipeline.json のモデルを確認中…", error: false });
    setStepProgress({});
    setStepCredits({});
    setCreditLogFile("");

    const phaseTurnIds = new Map();
    let finished = false;
    let stopped = "";
    let activeSession = sessionId;

    try {
      let availableModels;
      try {
        availableModels = await fetchModels();
      } catch (error) {
        console.error(error);
        const listError = `SDK のモデル一覧を取得できませんでした: ${error.message}`;
        setPipelineStatus({ message: listError, error: true });
        setUnavailableModel({ missingModels: [], models: [], listError });
        return;
      }

      const availableModelIds = new Set(availableModels.map((model) => model.id));
      const missingModels = [...new Set(steps
        .map((step) => step.model?.trim() || "auto")
        .filter((modelId) => modelId !== "auto" && !availableModelIds.has(modelId)))];
      if (missingModels.length > 0) {
        const message = `pipeline.json の使用可能なモデル ID が見つかりません: ${missingModels.join(", ")}`;
        setPipelineStatus({ message, error: true });
        setUnavailableModel({ missingModels, models: availableModels, listError: "" });
        return;
      }

      setPipelineStatus({ message: "パイプラインを実行中…", error: false });
      const response = await fetch("/api/pipeline/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: fromStep,
          to: toStep,
          sessionId,
        }),
      });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      await readStream(response, (message) => {
        if (message.type === "session") {
          activeSession = message.sessionId;
          setSessionId(message.sessionId);
        } else if (message.type === "credit-log") {
          setCreditLogFile(message.file);
        } else if (message.type === "pipeline-start") {
          const initial = {};
          for (const id of message.stepIds) initial[id] = { phase: "queued", status: "待機中" };
          setStepProgress(initial);
        } else if (message.type === "step-start") {
          const key = `${message.stepId}:${message.phase}`;
          if (message.phase === "verify") {
            const promptTurnId = phaseTurnIds.get(`${message.stepId}:prompt`);
            if (promptTurnId) {
              setTurns((prev) => prev.map((t) => (t.id === promptTurnId ? { ...t, status: "完了" } : t)));
            }
          }
          const turnId = nextTurnId("pipe");
          phaseTurnIds.set(key, turnId);
          const phaseLabel = message.phase === "prompt" ? "実行" : "検証";
          const newTurn = createTurnState(
            turnId,
            `${message.name}（${phaseLabel}）`,
            `${message.name} (${message.stepId}) - ${phaseLabel}`,
            "実行中",
            message.model,
          );
          setTurns((prev) => [...prev, newTurn]);
          setStepProgress((prev) => ({
            ...prev,
            [message.stepId]: {
              phase: message.phase,
              status: message.phase === "prompt" ? "実行中" : "検証中",
              model: message.model,
            },
          }));
        } else if (message.type === "event") {
          const turnId = phaseTurnIds.get(`${message.stepId}:${message.phase}`);
          if (turnId) {
            setTurns((prev) => prev.map((t) => (t.id === turnId ? applyEventToTurn(t, message.event) : t)));
          }
        } else if (message.type === "step-result") {
          const verifyTurnId = phaseTurnIds.get(`${message.stepId}:verify`);
          if (verifyTurnId) {
            setTurns((prev) => prev.map((t) => (t.id === verifyTurnId
              ? { ...t, status: message.passed ? "OK" : "NG", error: !message.passed }
              : t)));
          }
          setStepProgress((prev) => ({
            ...prev,
            [message.stepId]: {
              phase: "done",
              status: message.passed ? "OK" : "NG",
              passed: message.passed,
            },
          }));
          if (message.credits) {
            setStepCredits((prev) => ({ ...prev, [message.stepId]: message.credits }));
          }
        } else if (message.type === "pipeline-stopped") {
          stopped = `${message.name} (${message.stepId})`;
        } else if (message.type === "error") {
          throw new Error(message.message);
        } else if (message.type === "done") {
          finished = true;
        }
      });
      if (!finished) throw new Error("完了通知を受信する前に接続が切れました。");
      setPipelineStatus({
        message: stopped
          ? `${stopped} が NG のため停止しました。`
          : "すべての手順が OK になりました。",
        error: Boolean(stopped),
      });
    } catch (error) {
      console.error(error);
      setPipelineStatus({ message: `パイプライン失敗: ${error.message}`, error: true });
      const modelError = /Model\s+["']([^"']+)["']\s+is not available\.?/i.exec(error.message);
      if (modelError) {
        try {
          setUnavailableModel({
            missingModels: [modelError[1]],
            models: await fetchModels(),
            listError: "",
          });
        } catch (listError) {
          console.error(listError);
          setUnavailableModel({
            missingModels: [modelError[1]],
            models: [],
            listError: `SDK のモデル一覧を取得できませんでした: ${listError.message}`,
          });
        }
      }
    } finally {
      setBusy(false);
      await fetchPipeline().catch((err) => console.error(err));
      await fetchSessions(activeSession).catch((err) => console.error(err));
    }
  }

  const totalPipelineCredits = Object.values(stepCredits).reduce(
    (sum, item) => sum + Number(item?.totalCredits ?? 0),
    0,
  );
  const rangeStartIndex = steps.findIndex((step) => step.id === fromStep);
  const rangeEndIndex = steps.findIndex((step) => step.id === toStep);
  const hasSelectedRange = rangeStartIndex >= 0 && rangeEndIndex >= rangeStartIndex;
  const hasKnownSession = !sessionId || sessions.some((s) => s.sessionId === sessionId);

  function renderPipelineNode(step, index, showConnector = index < steps.length - 1) {
    const progress = stepProgress[step.id];
    const credits = stepCredits[step.id];
    const modelName = resolveModelName(step.model, models);
    const isRunningPrompt = progress?.phase === "prompt";
    const isRunningVerify = progress?.phase === "verify";
    const isRunning = isRunningPrompt || isRunningVerify;
    const isPassed = progress?.phase === "done" ? progress.passed : step.passed;
    const isFailed = progress?.phase === "done" && !progress.passed;

    return html`
      <li
        key=${step.id}
        className=${`pipeline-node ${isRunning ? "node-running" : ""} ${isPassed ? "node-passed" : ""} ${isFailed ? "node-failed" : ""}`}
        aria-label=${`STEP ${index + 1}`}
      >
        <div className="node-card">
          <div className="node-top">
            <span className="step-index">STEP ${String(index + 1).padStart(2, "0")}</span>
            <span className=${`state ${isRunning ? "running" : isFailed ? "failed" : isPassed ? "passed" : ""}`}>
              ${isRunningPrompt
                ? "実行中"
                : isRunningVerify
                  ? "検証中"
                  : isFailed
                    ? "NG"
                    : isPassed
                      ? "true"
                      : "false"}
            </span>
          </div>

          <div className="node-title-wrap">
            <h3 className="node-title">${step.name}</h3>
            <code className="node-id">${step.id}</code>
          </div>

          <div className="node-model-box">
            <div className="node-model-header">
              <span className="node-model-label">使用モデル（pipeline.json）</span>
              <strong className="step-model-name" data-step-id=${step.id} title=${step.model || "auto"}>
                ${modelName}
              </strong>
            </div>
          </div>

          <div className="phase-pipeline" aria-label="フェーズ進行状況">
            <div className=${`phase-chip ${isRunningPrompt ? "active" : isRunningVerify || isPassed || isFailed ? "done" : ""}`}>
              <span className="phase-dot"></span>
              <span>1. 実行 (${step.prompt || "prompt.md"})</span>
            </div>
            <span className="phase-connector">→</span>
            <div className=${`phase-chip ${isRunningVerify ? "active" : isPassed ? "done" : isFailed ? "ng" : ""}`}>
              <span className="phase-dot"></span>
              <span>2. 検証 (${step.verify || "verify.md"})</span>
            </div>
          </div>

          <div className="node-footer">
            <span className="step-credits" data-step-id=${step.id}>
              AI クレジット: ${credits ? formatCredits(credits.totalCredits) : "—"}
            </span>
            ${credits && html`
              <span className="step-credits-detail">
                (実行 ${formatCredits(credits.promptCredits)} / 検証 ${formatCredits(credits.verifyCredits)})
              </span>
            `}
          </div>
        </div>
        ${showConnector && html`
          <div className=${`pipeline-connector ${isPassed ? "connector-active" : ""}`} aria-hidden="true">
            <div className="connector-line"></div>
            <span className="connector-arrow">▶</span>
          </div>
        `}
      </li>
    `;
  }

  return html`
    <div className="studio-shell">
      <header className="studio-header">
        <div className="brand-group">
          <div className=${`brand-pulse ${busy ? "active" : ""}`}></div>
          <div>
            <span className="eyebrow">GITHUB COPILOT SDK</span>
            <h1>ぱいぷらんなぁ</h1>
          </div>
        </div>
        <div className="controls header-controls">
          <label className="control-field">
            <span>セッション</span>
            <select
              id="session"
              value=${sessionId}
              disabled=${busy}
              onChange=${(e) => handleSelectSession(e.target.value)}
            >
              <option value="">新規セッション（送信時に作成）</option>
              ${sessions.map((item) => html`
                <option key=${item.sessionId} value=${item.sessionId}>
                  ${formatSessionLabel(item)}
                </option>
              `)}
              ${!hasKnownSession && html`
                <option value=${sessionId}>セッション (${sessionId})</option>
              `}
            </select>
          </label>
          <label className="control-field">
            <span>チャット用モデル</span>
            <select
              id="model"
              value=${selectedModel}
              disabled=${busy}
              onChange=${(e) => setSelectedModel(e.target.value)}
            >
              ${models.map((m) => html`
                <option key=${m.id} value=${m.id}>${m.name}</option>
              `)}
            </select>
          </label>
          <button id="refresh" className="btn-secondary" type="button" disabled=${busy} onClick=${loadAll}>
            ↻ 再読み込み
          </button>
        </div>
      </header>

      <p className="warning">
        ローカル専用です。ファイル編集・コマンド実行は自動許可されます。信頼できる指示だけを送信し、同じセッションを VS Code と同時に操作しないでください。
      </p>

      <section id="pipeline-group" className="pipeline-board" aria-label="パイプライン">
        <div className="pipeline-board-header">
          <div className="pipeline-title-row">
            <h2>パイプライン・ワークフロー</h2>
            <span id="pipeline-count" className="badge">${steps.length}</span>
            <span id="pipeline-credits" className="badge credit-total-badge" title="パイプライン消費 AI クレジット合計">
              消費 AI クレジット: ${formatCredits(totalPipelineCredits)}
            </span>
            <span className="badge credit-rate-badge" title="GitHub の AI クレジット料金レート。消費量は SDK が報告した値です。">
              $0.01 = 1 AI Credit
            </span>
          </div>
          <div className="controls pipeline-controls">
            <label className="control-field compact">
              <span>開始</span>
              <select
                id="pipeline-from"
                value=${fromStep}
                disabled=${busy}
                onChange=${(e) => handleFromStepChange(e.target.value)}
              >
                ${steps.map((s) => html`<option key=${s.id} value=${s.id}>${s.name} (${s.id})</option>`)}
              </select>
            </label>
            <span className="range-arrow" aria-hidden="true">→</span>
            <label className="control-field compact">
              <span>終了</span>
              <select
                id="pipeline-to"
                value=${toStep}
                disabled=${busy}
                onChange=${(e) => handleToStepChange(e.target.value)}
              >
                ${steps.map((s) => html`<option key=${s.id} value=${s.id}>${s.name} (${s.id})</option>`)}
              </select>
            </label>
            <button
              id="pipeline-run"
              className=${`btn-primary ${busy ? "running" : ""}`}
              type="button"
              disabled=${busy || steps.length === 0}
              onClick=${handleRunPipeline}
            >
              ${busy ? "● パイプライン稼働中…" : "▶ パイプライン実行"}
            </button>
          </div>
        </div>

        <p
          id="pipeline-status"
          role="status"
          className=${pipelineStatus.error ? "error status-banner" : "status-banner"}
          hidden=${!pipelineStatus.message}
        >
          ${pipelineStatus.message}
        </p>

        ${creditLogFile && html`
          <p id="credit-log-path" className="credit-log-banner">
            クレジット別ログ出力先: <code>${creditLogFile}</code>
          </p>
        `}

        <ul id="pipeline-steps" className="pipeline-track" aria-label="パイプラインの全ステップ">
          ${hasSelectedRange && steps.slice(0, rangeStartIndex).map((step, index) => renderPipelineNode(step, index))}
          ${hasSelectedRange && html`
            <li
              className="pipeline-range-shell"
              aria-label=${`実行範囲: ${steps[rangeStartIndex].name} から ${steps[rangeEndIndex].name}`}
            >
              <span className="pipeline-range-caption">実行範囲</span>
              <ol className="pipeline-range-group" aria-label="選択されたステップ">
                ${steps.slice(rangeStartIndex, rangeEndIndex + 1).map((step, offset) => {
                  const index = rangeStartIndex + offset;
                  return renderPipelineNode(step, index, index < rangeEndIndex);
                })}
              </ol>
            </li>
          `}
          ${hasSelectedRange && rangeEndIndex < steps.length - 1 && html`
            <li
              className=${`pipeline-connector ${(stepProgress[steps[rangeEndIndex].id]?.passed ?? steps[rangeEndIndex].passed) ? "connector-active" : ""}`}
              aria-hidden="true"
            >
              <div className="connector-line"></div>
              <span className="connector-arrow">▶</span>
            </li>
          `}
          ${hasSelectedRange && steps.slice(rangeEndIndex + 1).map((step, offset) =>
            renderPipelineNode(step, rangeEndIndex + 1 + offset))}
          ${!hasSelectedRange && steps.map((step, index) => renderPipelineNode(step, index))}
        </ul>
      </section>

      <section className="workspace-grid">
        <div className="stream-column">
          <details id="history-group" className="group history-panel" hidden=${historyTurns.length === 0}>
            <summary>
              <span>過去の履歴</span>
              <span id="history-count" className="badge">${historyTurns.length}</span>
            </summary>
            <div id="history-list">
              ${historyTurns.map((turn) => html`
                <${TurnCard} key=${turn.id} turn=${turn} models=${models} defaultOpen=${false} />
              `)}
            </div>
          </details>

          <div className="stream-panel">
            <div className="panel-header">
              <h2>ライブ実行ストリーム</h2>
              <p id="chat-status" role="status" className=${chatStatus.error ? "error" : ""}>
                ${chatStatus.message}
              </p>
            </div>
            <div id="conversation">
              ${turns.length === 0 && html`
                <p className="empty-stream">
                  パイプラインを実行するか、下のフォームからプロンプトを送信すると、ここにリアルタイムでストリーム出力が表示されます。
                </p>
              `}
              ${turns.map((turn) => html`
                <${TurnCard} key=${turn.id} turn=${turn} models=${models} defaultOpen=${true} />
              `)}
            </div>
          </div>
        </div>

        <form id="prompt-form" className="composer-card" onSubmit=${handleSendPrompt}>
          <div className="composer-header">
            <label htmlFor="prompt">個別プロンプト送信</label>
            <span className="pill model-pill">${resolveModelName(selectedModel, models)}</span>
          </div>
          <textarea
            id="prompt"
            rows="4"
            required
            disabled=${busy}
            value=${promptText}
            onInput=${(e) => setPromptText(e.target.value)}
            placeholder="選択中のセッションへ個別に指示を送る場合はここに入力してください"
          ></textarea>
          <button id="send" className="btn-secondary send-btn" type="submit" disabled=${busy}>
            ${busy ? "処理中…" : "プロンプト送信"}
          </button>
        </form>
      </section>

      ${unavailableModel && html`
        <div
          className="model-modal-backdrop"
          role="presentation"
          onClick=${(event) => {
            if (event.target === event.currentTarget) setUnavailableModel(null);
          }}
          onKeyDown=${(event) => {
            if (event.key === "Escape") setUnavailableModel(null);
          }}
        >
          <section
            className="model-availability-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="model-dialog-title"
            aria-describedby="model-dialog-description"
          >
            <header className="model-dialog-header">
              <div>
                <span className="eyebrow">COPILOT SDK</span>
                <h2 id="model-dialog-title">モデルが利用できません</h2>
              </div>
              <button
                className="model-dialog-close"
                type="button"
                aria-label="閉じる"
                onClick=${() => setUnavailableModel(null)}
              >
                ×
              </button>
            </header>
            <p id="model-dialog-description" className="model-dialog-description">
              ${unavailableModel.missingModels.length > 0
                ? "pipeline.json の以下のモデル ID は SDK の使用可能な一覧で解決できませんでした。"
                : "SDK から使用可能なモデル一覧を取得できませんでした。"}
            </p>
            ${unavailableModel.missingModels.length > 0 && html`
              <ul className="unavailable-model-list" aria-label="解決できないモデル ID">
                ${unavailableModel.missingModels.map((modelId) => html`<li key=${modelId}><code>${modelId}</code></li>`)}
              </ul>
            `}
            <h3 className="available-model-heading">使用可能なモデル (${unavailableModel.models.length})</h3>
            ${unavailableModel.listError && html`
              <p className="model-dialog-error" role="alert">${unavailableModel.listError}</p>
            `}
            ${unavailableModel.models.length > 0
              ? html`
                <ul className="available-model-list">
                  ${unavailableModel.models.map((model) => html`
                    <li key=${model.id}>
                      <span>${model.name}</span>
                      <code>${model.id}</code>
                    </li>
                  `)}
                </ul>
              `
              : !unavailableModel.listError && html`
                <p className="model-dialog-empty">SDK から使用可能なモデルが返されませんでした。</p>
              `}
            <p className="model-dialog-hint">モデルは画面から変更せず、pipeline.json の model を更新して再実行してください。</p>
            <button
              className="btn-primary model-dialog-dismiss"
              type="button"
              onClick=${() => setUnavailableModel(null)}
            >
              閉じる
            </button>
          </section>
        </div>
      `}
    </div>
  `;
}

window.ReactDOM.createRoot(document.getElementById("root")).render(html`<${App} />`);
