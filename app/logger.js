import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export function createLogger(name) {
  return {
    info(message) {
      console.log(message);
    },
    error(error) {
      console.error(error);
    },
    // 送信ごとに分け、SDK イベントのフィールドや本文を変更せず保存する。
    openStream(sessionId) {
      const directory = new URL("./logs/", import.meta.url);
      mkdirSync(directory, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const file = join(fileURLToPath(directory), `${name}-${encodeURIComponent(sessionId)}-${stamp}-${process.pid}.jsonl`);
      writeFileSync(file, "", { encoding: "utf8", flag: "wx" });
      return {
        file,
        event(event) {
          appendFileSync(file, JSON.stringify(event) + "\n", "utf8");
        },
      };
    },
    // パイプライン実行時の消費 AI クレジットを、イベントログとは別ファイルに 1 手順 1 行で記録する。
    openCreditLog(sessionId) {
      const directory = new URL("./logs/", import.meta.url);
      mkdirSync(directory, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const file = join(fileURLToPath(directory), `${name}-credits-${encodeURIComponent(sessionId)}-${stamp}-${process.pid}.jsonl`);
      writeFileSync(file, "", { encoding: "utf8", flag: "wx" });
      return {
        file,
        record(entry) {
          appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
        },
      };
    },
  };
}
