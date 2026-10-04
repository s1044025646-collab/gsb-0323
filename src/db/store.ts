import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  BuildResult,
  ImportInput,
  ValidationIssue,
} from "../types.js";
import { ALGO_VERSION } from "../core/limits.js";

export interface VersionRow {
  datasetId: string;
  version: number;
  algoVersion: string;
  participants: string[];
  input: ImportInput;
  status: "imported" | "computed" | "failed";
  error: ValidationIssue[] | null;
  createdAt: string;
}

export class Store {
  db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(resolve(dbPath));
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close() {
    this.db.close();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS datasets (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS versions (
        dataset_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        algo_version TEXT NOT NULL,
        participants_json TEXT NOT NULL,
        input_json TEXT NOT NULL,
        status TEXT NOT NULL,
        error_json TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (dataset_id, version),
        FOREIGN KEY (dataset_id) REFERENCES datasets(id)
      );
      CREATE TABLE IF NOT EXISTS participant_order (
        dataset_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        pos INTEGER NOT NULL,
        name TEXT NOT NULL,
        PRIMARY KEY (dataset_id, version, pos)
      );
      CREATE TABLE IF NOT EXISTS clocks (
        dataset_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        participant TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        msg_id TEXT,
        clock_json TEXT NOT NULL,
        PRIMARY KEY (dataset_id, version, event_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        dataset_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        msg_id TEXT NOT NULL,
        send_event_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        receiver TEXT NOT NULL,
        recv_event_id TEXT,
        PRIMARY KEY (dataset_id, version, msg_id)
      );
    `);
  }

  /** 导入原事件，冻结参与者顺序。datasetId 已存在则形成新版本。 */
  importInput(input: ImportInput, datasetId?: string): { datasetId: string; version: number } {
    const id = datasetId ?? randomUUID();
    const existing = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS v FROM versions WHERE dataset_id = ?")
      .get(id) as { v: number };
    const version = Number(existing.v) + 1;
    if (version === 1) {
      this.db
        .prepare("INSERT INTO datasets(id, created_at) VALUES (?, ?)")
        .run(id, new Date().toISOString());
    }
    this.db
      .prepare(
        `INSERT INTO versions(dataset_id, version, algo_version, participants_json, input_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'imported', ?)`,
      )
      .run(
        id,
        version,
        ALGO_VERSION,
        JSON.stringify(input.participants),
        JSON.stringify(input),
        new Date().toISOString(),
      );
    const insOrder = this.db.prepare(
      "INSERT INTO participant_order(dataset_id, version, pos, name) VALUES (?, ?, ?, ?)",
    );
    input.participants.forEach((name, pos) => insOrder.run(id, version, pos, name));
    return { datasetId: id, version };
  }

  saveBuildSuccess(result: BuildResult) {
    const { datasetId, version, algoVersion } = result;
    const tx = this.db;
    tx.exec("BEGIN");
    try {
      this.db
        .prepare("DELETE FROM clocks WHERE dataset_id = ? AND version = ?")
        .run(datasetId, version);
      this.db
        .prepare("DELETE FROM messages WHERE dataset_id = ? AND version = ?")
        .run(datasetId, version);
      const insClock = this.db.prepare(
        `INSERT INTO clocks(dataset_id, version, event_id, participant, seq, type, msg_id, clock_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const c of result.clocks) {
        insClock.run(
          datasetId,
          version,
          c.eventId,
          c.participant,
          c.seq,
          c.type,
          c.msgId,
          JSON.stringify(c.clock),
        );
      }
      const insMsg = this.db.prepare(
        `INSERT INTO messages(dataset_id, version, msg_id, send_event_id, sender, receiver, recv_event_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const m of result.messages) {
        insMsg.run(
          datasetId,
          version,
          m.msgId,
          m.sendEventId,
          m.sender,
          m.receiver,
          m.recvEventId,
        );
      }
      this.db
        .prepare(
          "UPDATE versions SET status = 'computed', error_json = NULL, algo_version = ? WHERE dataset_id = ? AND version = ?",
        )
        .run(algoVersion, datasetId, version);
      tx.exec("COMMIT");
    } catch (err) {
      tx.exec("ROLLBACK");
      throw err;
    }
  }

  /** 计算失败：不写入任何时钟/消息结果，仅登记失败原因。 */
  saveBuildFailure(datasetId: string, version: number, issues: ValidationIssue[]) {
    this.db
      .prepare("UPDATE versions SET status = 'failed', error_json = ? WHERE dataset_id = ? AND version = ?")
      .run(JSON.stringify(issues), datasetId, version);
  }

  getVersion(datasetId: string, version?: number): VersionRow | null {
    const row = version
      ? (this.db
          .prepare("SELECT * FROM versions WHERE dataset_id = ? AND version = ?")
          .get(datasetId, version) as Record<string, unknown> | undefined)
      : (this.db
          .prepare("SELECT * FROM versions WHERE dataset_id = ? ORDER BY version DESC LIMIT 1")
          .get(datasetId) as Record<string, unknown> | undefined);
    if (!row) return null;
    return {
      datasetId: String(row.dataset_id),
      version: Number(row.version),
      algoVersion: String(row.algo_version),
      participants: JSON.parse(String(row.participants_json)) as string[],
      input: JSON.parse(String(row.input_json)) as ImportInput,
      status: String(row.status) as VersionRow["status"],
      error: row.error_json ? (JSON.parse(String(row.error_json)) as ValidationIssue[]) : null,
      createdAt: String(row.created_at),
    };
  }

  getBuildResult(datasetId: string, version: number): BuildResult | null {
    const v = this.getVersion(datasetId, version);
    if (!v || v.status !== "computed") return null;
    const clockRows = this.db
      .prepare("SELECT * FROM clocks WHERE dataset_id = ? AND version = ? ORDER BY participant, seq")
      .all(datasetId, version) as Record<string, unknown>[];
    const msgRows = this.db
      .prepare("SELECT * FROM messages WHERE dataset_id = ? AND version = ? ORDER BY msg_id")
      .all(datasetId, version) as Record<string, unknown>[];
    return {
      datasetId,
      version,
      algoVersion: v.algoVersion,
      participants: v.participants,
      clocks: clockRows.map((r) => ({
        eventId: String(r.event_id),
        participant: String(r.participant),
        seq: Number(r.seq),
        type: String(r.type) as BuildResult["clocks"][number]["type"],
        msgId: r.msg_id === null ? null : String(r.msg_id),
        clock: JSON.parse(String(r.clock_json)) as number[],
      })),
      messages: msgRows.map((r) => ({
        msgId: String(r.msg_id),
        sendEventId: String(r.send_event_id),
        sender: String(r.sender),
        receiver: String(r.receiver),
        recvEventId: r.recv_event_id === null ? null : String(r.recv_event_id),
      })),
    };
  }

  listDatasets(): { datasetId: string; latestVersion: number; status: string }[] {
    const rows = this.db
      .prepare(
        `SELECT v.dataset_id, v.version, v.status FROM versions v
         JOIN (SELECT dataset_id, MAX(version) AS mv FROM versions GROUP BY dataset_id) m
         ON v.dataset_id = m.dataset_id AND v.version = m.mv ORDER BY v.dataset_id`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((r) => ({
      datasetId: String(r.dataset_id),
      latestVersion: Number(r.version),
      status: String(r.status),
    }));
  }
}
