import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ALGORITHM_VERSION } from './errors.js';
import { buildDependencies } from './graph.js';
import { computeVectorClocks } from './clock.js';
import { validateInput } from './validate.js';
import type { ComputedEvent, NormalizedEvent, Report } from './types.js';

export interface VersionSummary {
  versionId: number;
  algorithmVersion: string;
  createdAt: string;
  participantCount: number;
  eventCount: number;
  status: 'ok' | 'failed';
  errorCode: string | null;
  errorMessage: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS versions (
  version_id INTEGER PRIMARY KEY AUTOINCREMENT,
  algorithm_version TEXT NOT NULL,
  participant_order TEXT NOT NULL,
  raw_input TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok','failed')),
  error_code TEXT,
  error_message TEXT,
  error_details TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  version_id INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  participant TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  message_id TEXT,
  to_participant TEXT,
  ref_send_id TEXT,
  PRIMARY KEY (version_id, event_id)
);
CREATE TABLE IF NOT EXISTS vectors (
  version_id INTEGER NOT NULL,
  event_id TEXT NOT NULL,
  vector TEXT NOT NULL,
  PRIMARY KEY (version_id, event_id)
);
CREATE TABLE IF NOT EXISTS edges (
  version_id INTEGER NOT NULL,
  from_event TEXT NOT NULL,
  to_event TEXT NOT NULL,
  kind TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_version ON events(version_id);
CREATE INDEX IF NOT EXISTS idx_vectors_version ON vectors(version_id);
CREATE INDEX IF NOT EXISTS idx_edges_version ON edges(version_id);
`;

export class Store {
  readonly dbPath: string;
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.dbPath = resolve(dbPath);
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  /**
   * 导入并计算，整体在一个事务内：
   * 计算失败时只登记失败记录，绝不写入 events/vectors/edges 完整结果。
   */
  importAndCompute(rawInput: unknown): { versionId: number; events: ComputedEvent[]; participantOrder: string[] } {
    // 先在事务外完成校验与计算，避免半成品落库
    const { participantOrder, events } = validateInput(rawInput);
    const computed = computeVectorClocks(participantOrder, events);

    const now = new Date().toISOString();
    const insertVersion = this.db.prepare(
      `INSERT INTO versions (algorithm_version, participant_order, raw_input, status, created_at)
       VALUES (?, ?, ?, 'ok', ?)`
    );

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const res = insertVersion.run(
        ALGORITHM_VERSION,
        JSON.stringify(participantOrder),
        JSON.stringify(rawInput),
        now
      );
      const versionId = Number(res.lastInsertRowid);
      this.persistResults(versionId, participantOrder, events, computed.events);
      this.db.exec('COMMIT');
      return { versionId, events: computed.events, participantOrder };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 计算失败：登记失败版本（不含任何向量结果）。 */
  recordFailure(rawInput: unknown, code: string, message: string, details: unknown): number {
    let participantOrder: string[] = [];
    try {
      if (rawInput && typeof rawInput === 'object' && Array.isArray((rawInput as { participants?: unknown }).participants)) {
        participantOrder = ((rawInput as { participants: unknown[] }).participants).filter(
          (p): p is string => typeof p === 'string'
        );
      }
    } catch {
      participantOrder = [];
    }
    const res = this.db
      .prepare(
        `INSERT INTO versions (algorithm_version, participant_order, raw_input, status, error_code, error_message, error_details, created_at)
         VALUES (?, ?, ?, 'failed', ?, ?, ?, ?)`
      )
      .run(
        ALGORITHM_VERSION,
        JSON.stringify(participantOrder),
        JSON.stringify(rawInput ?? null),
        code,
        message,
        JSON.stringify(details ?? null),
        new Date().toISOString()
      );
    return Number(res.lastInsertRowid);
  }

  private persistResults(
    versionId: number,
    participantOrder: string[],
    normalized: NormalizedEvent[],
    computed: ComputedEvent[]
  ): void {
    void participantOrder;
    const insertEvent = this.db.prepare(
      `INSERT INTO events (version_id, event_id, participant, seq, type, message_id, to_participant, ref_send_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertVector = this.db.prepare(
      'INSERT INTO vectors (version_id, event_id, vector) VALUES (?, ?, ?)'
    );
    const vectorById = new Map(computed.map((c) => [c.id, c.vector]));
    for (const ev of normalized) {
      insertEvent.run(
        versionId,
        ev.id,
        ev.participant,
        ev.seq,
        ev.type,
        ev.messageId ?? null,
        ev.to ?? null,
        ev.refSendId ?? null
      );
      insertVector.run(versionId, ev.id, JSON.stringify(vectorById.get(ev.id)!));
    }
    const deps = buildDependencies(
      JSON.parse(this.getVersionRawOrder(versionId)!),
      normalized
    );
    const insertEdge = this.db.prepare(
      'INSERT INTO edges (version_id, from_event, to_event, kind) VALUES (?, ?, ?, ?)'
    );
    for (const ev of normalized) {
      for (const pred of deps.get(ev.id) ?? []) {
        const predEvent = normalized.find((e) => e.id === pred)!;
        const kind =
          predEvent.type === 'send' && ev.type === 'recv' ? 'message' : 'seq';
        insertEdge.run(versionId, pred, ev.id, kind);
      }
    }
  }

  private getVersionRawOrder(versionId: number): string | null {
    const row = this.db
      .prepare('SELECT participant_order AS participantOrder FROM versions WHERE version_id = ?')
      .get(versionId) as { participantOrder: string } | undefined;
    return row?.participantOrder ?? null;
  }

  listVersions(): VersionSummary[] {
    return this.db
      .prepare(
        `SELECT v.version_id AS versionId, v.algorithm_version AS algorithmVersion,
                v.created_at AS createdAt, v.status AS status,
                v.error_code AS errorCode, v.error_message AS errorMessage,
                (SELECT COUNT(*) FROM events e WHERE e.version_id = v.version_id) AS eventCount,
                json_array_length(v.participant_order) AS participantCount
         FROM versions v ORDER BY v.version_id DESC`
      )
      .all()
      .map((r) => {
        const row = r as Record<string, unknown>;
        return {
          versionId: Number(row.versionId),
          algorithmVersion: String(row.algorithmVersion),
          createdAt: String(row.createdAt),
          participantCount: Number(row.participantCount),
          eventCount: Number(row.eventCount),
          status: String(row.status) as 'ok' | 'failed',
          errorCode: (row.errorCode as string | null) ?? null,
          errorMessage: (row.errorMessage as string | null) ?? null
        };
      });
  }

  latestVersionId(): number | null {
    const row = this.db
      .prepare("SELECT version_id AS id FROM versions WHERE status = 'ok' ORDER BY version_id DESC LIMIT 1")
      .get() as { id: number } | undefined;
    return row ? Number(row.id) : null;
  }

  getVersionHeader(versionId: number): {
    versionId: number;
    algorithmVersion: string;
    createdAt: string;
    participantOrder: string[];
    status: string;
    errorCode: string | null;
    errorMessage: string | null;
    errorDetails: unknown;
  } | null {
    const row = this.db
      .prepare(
        `SELECT version_id AS versionId, algorithm_version AS algorithmVersion, created_at AS createdAt,
                participant_order AS participantOrder, status, error_code AS errorCode,
                error_message AS errorMessage, error_details AS errorDetails
         FROM versions WHERE version_id = ?`
      )
      .get(versionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      versionId: Number(row.versionId),
      algorithmVersion: String(row.algorithmVersion),
      createdAt: String(row.createdAt),
      participantOrder: JSON.parse(String(row.participantOrder)) as string[],
      status: String(row.status),
      errorCode: (row.errorCode as string | null) ?? null,
      errorMessage: (row.errorMessage as string | null) ?? null,
      errorDetails: row.errorDetails ? JSON.parse(String(row.errorDetails)) : null
    };
  }

  getEvents(versionId: number): ComputedEvent[] {
    const rows = this.db
      .prepare(
        `SELECT e.event_id AS id, e.participant AS participant, e.seq AS seq, e.type AS type,
                e.message_id AS messageId, e.to_participant AS toParticipant,
                e.ref_send_id AS refSendId, v.vector AS vector
         FROM events e JOIN vectors v
           ON v.version_id = e.version_id AND v.event_id = e.event_id
         WHERE e.version_id = ?
         ORDER BY e.participant, e.seq`
      )
      .all(versionId) as Record<string, unknown>[];
    // ORDER BY participant 用字典序不对，需要按冻结顺序重排
    const header = this.getVersionHeader(versionId);
    const order = header?.participantOrder ?? [];
    return rows
      .map((row) => ({
        id: String(row.id),
        participant: String(row.participant),
        seq: Number(row.seq),
        type: String(row.type) as ComputedEvent['type'],
        messageId: (row.messageId as string | null) ?? null,
        to: (row.toParticipant as string | null) ?? null,
        refSendId: (row.refSendId as string | null) ?? null,
        vector: JSON.parse(String(row.vector)) as number[]
      }))
      .sort(
        (a, b) =>
          order.indexOf(a.participant) - order.indexOf(b.participant) || a.seq - b.seq
      );
  }

  getReport(versionId: number): Report | null {
    const header = this.getVersionHeader(versionId);
    if (!header || header.status !== 'ok') return null;
    const events = this.getEvents(versionId);
    return {
      versionId,
      algorithmVersion: header.algorithmVersion,
      createdAt: header.createdAt,
      participants: header.participantOrder,
      events,
      eventCount: events.length
    };
  }
}
