import { Store, VersionRow } from "../db/store.js";
import { validateInput } from "./validate.js";
import {
  CausalCycleError,
  checkSlice,
  compareClocks,
  computeClocks,
  reachable,
  type PrefixInput,
} from "./engine.js";
import type {
  BuildResult,
  CausalOrder,
  ImportInput,
  SliceResult,
  ValidationIssue,
} from "../types.js";

export class ServiceError extends Error {
  constructor(
    public code: ValidationIssue["code"],
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export class CausalService {
  constructor(public store: Store) {}

  importData(raw: unknown, datasetId?: string): { datasetId: string; version: number; issues: ValidationIssue[] } {
    const v = validateInput(raw);
    if (!v.ok || !v.data) {
      throw new ServiceError("BAD_REQUEST", "输入校验未通过", v.issues);
    }
    return { ...this.store.importInput(v.data, datasetId), issues: [] };
  }

  build(datasetId: string, version?: number): BuildResult {
    const v = this.requireVersion(datasetId, version);
    if (v.status === "computed") {
      const cached = this.store.getBuildResult(datasetId, v.version);
      if (cached) return cached;
    }
    let result: BuildResult;
    try {
      result = computeClocks(v.input, datasetId, v.version);
    } catch (err) {
      const issues: ValidationIssue[] =
        err instanceof CausalCycleError
          ? [{ code: "CYCLE_DETECTED", message: err.message, cycle: err.cycle }]
          : [{ code: "BUILD_FAILED", message: (err as Error).message }];
      this.store.saveBuildFailure(datasetId, v.version, issues);
      throw new ServiceError("CYCLE_DETECTED", "向量时钟计算失败：依赖图存在环", issues);
    }
    this.store.saveBuildSuccess(result);
    return result;
  }

  requireVersion(datasetId: string, version?: number): VersionRow {
    const v = this.store.getVersion(datasetId, version);
    if (!v) throw new ServiceError("NOT_FOUND", `数据集版本不存在: ${datasetId}${version ? ` v${version}` : ""}`);
    return v;
  }

  getResult(datasetId: string, version?: number): BuildResult {
    const v = this.requireVersion(datasetId, version);
    const result = this.store.getBuildResult(datasetId, v.version);
    if (!result) throw new ServiceError("BUILD_FAILED", `版本 v${v.version} 尚未成功计算，状态: ${v.status}`, v.error);
    return result;
  }

  getEvent(datasetId: string, eventId: string, version?: number) {
    const result = this.getResult(datasetId, version);
    const row = result.clocks.find((c) => c.eventId === eventId);
    if (!row) throw new ServiceError("NOT_FOUND", `事件不存在: ${eventId}`);
    return row;
  }

  compare(datasetId: string, a: string, b: string, version?: number): {
    a: { eventId: string; clock: number[] };
    b: { eventId: string; clock: number[] };
    order: CausalOrder;
    description: string;
    graphReachability: { aReachesB: boolean; bReachesA: boolean };
  } {
    const result = this.getResult(datasetId, version);
    const ea = result.clocks.find((c) => c.eventId === a);
    const eb = result.clocks.find((c) => c.eventId === b);
    if (!ea) throw new ServiceError("NOT_FOUND", `事件不存在: ${a}`);
    if (!eb) throw new ServiceError("NOT_FOUND", `事件不存在: ${b}`);
    const order = compareClocks(ea.clock, eb.clock);
    const desc: Record<CausalOrder, string> = {
      before: `${a} 因果先于 ${b}`,
      after: `${a} 因果后于 ${b}`,
      concurrent: `${a} 与 ${b} 并发（无因果关系）`,
      equal: `${a} 与 ${b} 向量时钟相等`,
    };
    const input = this.requireVersion(datasetId, version).input;
    return {
      a: { eventId: a, clock: ea.clock },
      b: { eventId: b, clock: eb.clock },
      order,
      description: desc[order],
      graphReachability: {
        aReachesB: reachable(input, a, b),
        bReachesA: reachable(input, b, a),
      },
    };
  }

  slice(datasetId: string, body: PrefixInput, version?: number): SliceResult {
    const result = this.getResult(datasetId, version);
    if (!body || typeof body !== "object" || typeof body.prefixes !== "object") {
      throw new ServiceError("BAD_REQUEST", "请求体需包含 prefixes 对象");
    }
    try {
      return checkSlice(result, body.prefixes);
    } catch (err) {
      const issue = err as ValidationIssue;
      throw new ServiceError(issue.code, issue.message, issue);
    }
  }

  inFlight(datasetId: string, version?: number) {
    const result = this.getResult(datasetId, version);
    return result.messages
      .filter((m) => m.recvEventId === null)
      .map((m) => ({
        msgId: m.msgId,
        sendEventId: m.sendEventId,
        sender: m.sender,
        receiver: m.receiver,
      }));
  }

  report(datasetId: string, version?: number) {
    const v = this.requireVersion(datasetId, version);
    const result = this.store.getBuildResult(datasetId, v.version);
    return {
      datasetId,
      version: v.version,
      algoVersion: v.algoVersion,
      participants: v.participants,
      participantOrder: v.participants.map((p, i) => ({ pos: i, name: p })),
      status: v.status,
      error: v.error,
      inputEvents: v.input.events.length,
      clocks: result?.clocks ?? [],
      messages: result?.messages ?? [],
      inFlight: result ? result.messages.filter((m) => m.recvEventId === null) : [],
      generatedAt: new Date().toISOString(),
    };
  }
}
