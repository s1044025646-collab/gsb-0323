import type {
  BuildResult,
  CausalOrder,
  ClockRow,
  ImportInput,
  InFlightMessage,
  MessageEdge,
  SliceResult,
  ValidationIssue,
  Violation,
} from "../types.js";
import { ALGO_VERSION } from "./limits.js";

export class CausalCycleError extends Error {
  constructor(public cycle: string[]) {
    super("检测到事件依赖环: " + cycle.join(" -> "));
  }
}

interface Node {
  id: string;
  participant: string;
  pIdx: number;
  seq: number;
  type: "local" | "send" | "recv";
  msgId?: string;
  receiver?: string;
  order: number; // 输入中的稳定下标
}

/**
 * 依据参与者顺序（同参与者按序号）与消息发送->接收建立依赖，
 * 再以稳定拓扑顺序计算向量时钟。输入全局顺序可以任意打乱。
 */
export function computeClocks(input: ImportInput, datasetId: string, version = 1): BuildResult {
  const { participants, events } = input;
  const pIndex = new Map(participants.map((p, i) => [p, i]));
  const n = participants.length;

  const nodes: Node[] = events.map((ev, i) => ({
    id: ev.id,
    participant: ev.participant,
    pIdx: pIndex.get(ev.participant)!,
    seq: ev.seq,
    type: ev.type,
    msgId: ev.msgId,
    receiver: ev.receiver,
    order: i,
  }));

  const byId = new Map(nodes.map((nd) => [nd.id, nd]));
  const sendByMsg = new Map<string, Node>();
  const recvByMsg = new Map<string, Node>();
  for (const nd of nodes) {
    if (nd.type === "send" && nd.msgId) sendByMsg.set(nd.msgId, nd);
    if (nd.type === "recv" && nd.msgId) recvByMsg.set(nd.msgId, nd);
  }

  const predecessors = new Map<string, Set<string>>(nodes.map((nd) => [nd.id, new Set()]));
  const successors = new Map<string, Set<string>>(nodes.map((nd) => [nd.id, new Set()]));

  const addEdge = (from: Node, to: Node) => {
    predecessors.get(to.id)!.add(from.id);
    successors.get(from.id)!.add(to.id);
  };

  // 参与者内：按序号连续
  const byParticipant = new Map<number, Node[]>();
  for (const nd of nodes) {
    const list = byParticipant.get(nd.pIdx) ?? [];
    list.push(nd);
    byParticipant.set(nd.pIdx, list);
  }
  for (const list of byParticipant.values()) {
    list.sort((a, b) => a.seq - b.seq);
    for (let i = 1; i < list.length; i++) addEdge(list[i - 1]!, list[i]!);
  }

  // 消息：发送 -> 接收（包含自发自收，此时接收序号必然更大，环会在后面被发现）
  for (const [msgId, recv] of recvByMsg) {
    const send = sendByMsg.get(msgId);
    if (send) addEdge(send, recv);
  }

  // 稳定拓扑排序：候选中按 (参与者下标, 序号) 选取，保证结果与输入行序无关且确定
  const indeg = new Map<string, number>();
  for (const nd of nodes) indeg.set(nd.id, predecessors.get(nd.id)!.size);
  const ready: Node[] = [];
  for (const nd of nodes) if (indeg.get(nd.id) === 0) ready.push(nd);
  const sorted: Node[] = [];

  const popMin = (): Node => {
    let best = 0;
    for (let i = 1; i < ready.length; i++) {
      const a = ready[i]!;
      const b = ready[best]!;
      if (a.pIdx < b.pIdx || (a.pIdx === b.pIdx && a.seq < b.seq)) best = i;
    }
    return ready.splice(best, 1)[0]!;
  };

  while (ready.length > 0) {
    const nd = popMin();
    sorted.push(nd);
    for (const succId of successors.get(nd.id)!) {
      const d = indeg.get(succId)! - 1;
      indeg.set(succId, d);
      if (d === 0) ready.push(byId.get(succId)!);
    }
  }

  if (sorted.length !== nodes.length) {
    const cycle = findCycle(nodes, predecessors, successors);
    throw new CausalCycleError(cycle);
  }

  // 向量时钟计算
  const clockOf = new Map<string, number[]>();
  const clocks: ClockRow[] = [];
  for (const nd of sorted) {
    const v = new Array<number>(n).fill(0);
    for (const predId of predecessors.get(nd.id)!) {
      const pv = clockOf.get(predId)!;
      for (let k = 0; k < n; k++) v[k] = Math.max(v[k]!, pv[k]!);
    }
    v[nd.pIdx] = v[nd.pIdx]! + 1;
    clockOf.set(nd.id, v);
    clocks.push({
      eventId: nd.id,
      participant: nd.participant,
      seq: nd.seq,
      type: nd.type,
      msgId: nd.msgId ?? null,
      clock: v,
    });
  }

  const messages: MessageEdge[] = [];
  for (const [msgId, send] of sendByMsg) {
    const recv = recvByMsg.get(msgId) ?? null;
    messages.push({
      msgId,
      sendEventId: send.id,
      sender: send.participant,
      recvEventId: recv ? recv.id : null,
      receiver: send.receiver!,
    });
  }
  messages.sort((a, b) => (a.msgId < b.msgId ? -1 : a.msgId > b.msgId ? 1 : 0));
  clocks.sort((a, b) => {
    const ia = pIndex.get(a.participant)!;
    const ib = pIndex.get(b.participant)!;
    return ia !== ib ? ia - ib : a.seq - b.seq;
  });

  return { datasetId, version, algoVersion: ALGO_VERSION, participants, clocks, messages };
}

function findCycle(
  nodes: Node[],
  predecessors: Map<string, Set<string>>,
  successors: Map<string, Set<string>>,
): string[] {
  // 反复剥离入度为 0 的节点，剩余节点构成环所在的子图
  const remaining = new Set(nodes.map((nd) => nd.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...remaining]) {
      let indeg = 0;
      for (const p of predecessors.get(id)!) if (remaining.has(p)) indeg++;
      if (indeg === 0) {
        remaining.delete(id);
        changed = true;
      }
    }
  }
  // DFS 找一条具体环
  const stack: string[] = [];
  const onStack = new Set<string>();
  let found: string[] | null = null;
  const dfs = (id: string) => {
    if (found) return;
    stack.push(id);
    onStack.add(id);
    for (const s of successors.get(id)!) {
      if (!remaining.has(s)) continue;
      if (onStack.has(s)) {
        const start = stack.indexOf(s);
        found = [...stack.slice(start), s];
        return;
      }
      dfs(s);
      if (found) return;
    }
    stack.pop();
    onStack.delete(id);
  };
  for (const id of remaining) {
    dfs(id);
    if (found) return found;
  }
  return [...remaining];
}

export function compareClocks(a: number[], b: number[]): CausalOrder {
  let aLess = false;
  let bLess = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]! < b[i]!) aLess = true;
    else if (a[i]! > b[i]!) bLess = true;
  }
  if (!aLess && !bLess) return "equal";
  if (aLess && !bLess) return "before";
  if (bLess && !aLess) return "after";
  return "concurrent";
}

/** 独立的图可达性检查：事件 x 是否在依赖图中先于 y。 */
export function reachable(input: ImportInput, fromId: string, toId: string): boolean {
  const { participants, events } = input;
  const pIndex = new Map(participants.map((p, i) => [p, i]));
  const adj = new Map<string, string[]>();
  for (const ev of events) adj.set(ev.id, []);
  const lastByP = new Map<number, string>();
  const sorted = [...events].sort(
    (x, y) =>
      (pIndex.get(x.participant)! - pIndex.get(y.participant)!) || x.seq - y.seq,
  );
  const sendByMsg = new Map<string, string>();
  for (const ev of events) if (ev.type === "send" && ev.msgId) sendByMsg.set(ev.msgId, ev.id);
  for (const ev of sorted) {
    const prev = lastByP.get(pIndex.get(ev.participant)!);
    if (prev) adj.get(prev)!.push(ev.id);
    lastByP.set(pIndex.get(ev.participant)!, ev.id);
    if (ev.type === "recv" && ev.msgId) {
      const s = sendByMsg.get(ev.msgId);
      if (s) adj.get(s)!.push(ev.id);
    }
  }
  const seen = new Set<string>([fromId]);
  const queue = [fromId];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === toId) return true;
    for (const nxt of adj.get(cur) ?? []) {
      if (!seen.has(nxt)) {
        seen.add(nxt);
        queue.push(nxt);
      }
    }
  }
  return false;
}

export interface PrefixInput {
  prefixes: Record<string, number>;
}

export function checkSlice(
  result: BuildResult,
  prefixes: Record<string, number>,
): SliceResult {
  const { participants, clocks, messages } = result;

  for (const p of participants) {
    const v = prefixes[p];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
      const err: ValidationIssue = {
        code: "SLICE_OUT_OF_RANGE",
        message: `参与者 ${p} 的前缀长度必须是非负整数`,
        participant: p,
      };
      throw err;
    }
  }
  const maxSeq = new Map<string, number>();
  for (const c of clocks) maxSeq.set(c.participant, Math.max(maxSeq.get(c.participant) ?? 0, c.seq));
  for (const p of participants) {
    if ((prefixes[p] ?? 0) > (maxSeq.get(p) ?? 0)) {
      throw {
        code: "SLICE_OUT_OF_RANGE",
        message: `参与者 ${p} 的前缀长度 ${prefixes[p]} 超出其事件总数 ${maxSeq.get(p) ?? 0}`,
        participant: p,
      } as ValidationIssue;
    }
  }

  const included = new Set<string>();
  const includedEvents: string[] = [];
  for (const c of clocks) {
    if (c.seq <= (prefixes[c.participant] ?? 0)) {
      included.add(c.eventId);
      includedEvents.push(c.eventId);
    }
  }

  const violations: Violation[] = [];
  const inFlight: InFlightMessage[] = [];
  for (const m of messages) {
    const sendIn = included.has(m.sendEventId);
    const recvIn = m.recvEventId !== null && included.has(m.recvEventId);
    if (recvIn && !sendIn) {
      violations.push({
        msgId: m.msgId,
        recvEventId: m.recvEventId!,
        sendEventId: m.sendEventId,
        receiver: m.receiver,
      });
    }
    // 在途：发送已包含，尚无接收事件或接收尚未包含
    if (sendIn && !recvIn) {
      inFlight.push({
        msgId: m.msgId,
        sendEventId: m.sendEventId,
        sender: m.sender,
        receiver: m.receiver,
      });
    }
  }

  return {
    consistent: violations.length === 0,
    prefixes,
    violations,
    inFlight,
    includedEvents,
  };
}

/** 穷举所有前缀组合，用于演示与测试。 */
export function enumerateSlices(result: BuildResult): SliceResult[] {
  const { participants, clocks } = result;
  const maxSeq = new Map<string, number>();
  for (const c of clocks) maxSeq.set(c.participant, Math.max(maxSeq.get(c.participant) ?? 0, c.seq));
  const totals = participants.map((p) => maxSeq.get(p) ?? 0);
  const out: SliceResult[] = [];
  const cur = new Array<number>(participants.length).fill(0);
  const total = totals.reduce((a, b) => a * (b + 1), 1);
  for (let t = 0; t < total; t++) {
    let x = t;
    for (let i = 0; i < participants.length; i++) {
      cur[i] = x % (totals[i]! + 1);
      x = Math.floor(x / (totals[i]! + 1));
    }
    const prefixes: Record<string, number> = {};
    participants.forEach((p, i) => (prefixes[p] = cur[i]!));
    out.push(checkSlice(result, prefixes));
  }
  return out;
}
