import { AppError, ErrorCodes } from './errors.js';
import type { CycleEvidence, NormalizedEvent } from './types.js';

/**
 * 建立事件依赖（边 from -> to 表示 from 必须先于 to 处理）：
 * 1. 同一参与者内 seq-1 -> seq（参与者顺序处理约束）
 * 2. 发送 -> 对应接收（消息先于接收；允许同参与者自发自收，
 *    此时要求接收序号在发送之后，二者共同形成环也会被检出）
 */
export function buildDependencies(
  participantOrder: string[],
  events: NormalizedEvent[]
): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const ev of events) edges.set(ev.id, []);

  const prevByParticipant = new Map<string, string>();
  // 输入全局顺序无关：按参与者内序号建立链
  const sorted = [...events].sort((a, b) => {
    const pa = participantOrder.indexOf(a.participant);
    const pb = participantOrder.indexOf(b.participant);
    if (pa !== pb) return pa - pb;
    return a.seq - b.seq;
  });
  for (const ev of sorted) {
    const prev = prevByParticipant.get(ev.participant);
    if (prev !== undefined) edges.get(ev.id)!.push(prev); // prev -> ev
    prevByParticipant.set(ev.participant, ev.id);
  }

  for (const ev of events) {
    if (ev.type === 'recv' && ev.refSendId !== undefined) {
      edges.get(ev.id)!.push(ev.refSendId); // send -> recv
    }
  }

  return edges;
}

/** 返回排序后事件（依赖在前）。deps.get(id) 为 id 的所有前驱。 */
export function stableTopologicalSort(
  participantOrder: string[],
  events: NormalizedEvent[],
  deps: Map<string, string[]>
): NormalizedEvent[] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const ev of events) {
    indegree.set(ev.id, 0);
    dependents.set(ev.id, []);
  }
  for (const ev of events) {
    for (const pred of deps.get(ev.id) ?? []) {
      indegree.set(ev.id, (indegree.get(ev.id) ?? 0) + 1);
      dependents.get(pred)!.push(ev.id);
    }
  }

  // 稳定的就绪队列：按 (参与者固定顺序, seq) 排序，保证可重复结果
  const orderKey = new Map(events.map((e) => [e.id, e]));
  const keyLess = (x: string, y: string): number => {
    const a = orderKey.get(x)!;
    const b = orderKey.get(y)!;
    if (a.participant !== b.participant) {
      return (
        participantOrder.indexOf(a.participant) -
        participantOrder.indexOf(b.participant)
      );
    }
    return a.seq - b.seq;
  };

  const ready: string[] = [];
  for (const ev of events) {
    if ((indegree.get(ev.id) ?? 0) === 0) ready.push(ev.id);
  }
  ready.sort(keyLess);

  const result: NormalizedEvent[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    result.push(orderKey.get(id)!);
    for (const dep of dependents.get(id) ?? []) {
      const left = (indegree.get(dep) ?? 0) - 1;
      indegree.set(dep, left);
      if (left === 0) {
        ready.push(dep);
        ready.sort(keyLess);
      }
    }
  }

  if (result.length !== events.length) {
    const processed = new Set(result.map((e) => e.id));
    const remainingNodes = new Set(events.map((e) => e.id).filter((id) => !processed.has(id)));
    const cycle = findCycle(events, deps, remainingNodes);
    throw new AppError(ErrorCodes.CYCLE, `依赖图存在环，无法分配有效时钟`, cycle);
  }
  return result;
}

/** 在未被排序消费的节点子图中找出一个实际事件环。 */
export function findCycle(
  events: NormalizedEvent[],
  deps: Map<string, string[]>,
  remaining?: Set<string>
): CycleEvidence {
  const inSet = remaining ?? new Set(events.map((e) => e.id));
  // 在“前驱”图上 DFS：边 x -> pred(x) 表示 x 依赖 pred
  const color = new Map<string, 0 | 1 | 2>();
  const parent = new Map<string, string | null>();
  for (const id of inSet) color.set(id, 0);
  let backFrom: string | null = null;
  let backTo: string | null = null;

  const visit = (id: string, from: string | null): boolean => {
    color.set(id, 1);
    parent.set(id, from);
    for (const pred of [...(deps.get(id) ?? [])].sort()) {
      if (!inSet.has(pred)) continue;
      const c = color.get(pred) ?? 0;
      if (c === 1) {
        backFrom = id;
        backTo = pred;
        return true;
      }
      if (c === 0 && visit(pred, id)) return true;
    }
    color.set(id, 2);
    return false;
  };

  for (const id of [...inSet].sort()) {
    if ((color.get(id) ?? 0) === 0 && visit(id, null)) break;
  }

  let foundCycle: string[] = [];
  if (backFrom !== null && backTo !== null) {
    // 由 backFrom 沿 parent 回溯到 backTo，得到环上节点（依赖方向 backTo -> ... -> backFrom -> backTo）
    const path: string[] = [backFrom];
    let cur: string | null = backFrom;
    while (cur !== null && cur !== backTo) {
      cur = parent.get(cur) ?? null;
      if (cur === null) break;
      path.push(cur);
    }
    path.reverse(); // 现在 path[0] = backTo，末尾 = backFrom
    foundCycle = [...path, backTo];
  }

  const eventById = new Map(events.map((e) => [e.id, e]));
  const cycle = foundCycle;
  const edges: string[] = [];
  // cycle 相邻节点（含首尾闭合）每一对都构成一条依赖边
  for (let i = 0; i < cycle.length - 1; i++) {
    const from = cycle[i]!;
    const to = cycle[i + 1]!;
    edges.push(describeEdge(eventById.get(from)!, eventById.get(to)!));
  }
  return { cycle, edges };
}

function describeEdge(from: NormalizedEvent, to: NormalizedEvent): string {
  if (from.type === 'send' && to.type === 'recv') {
    return `${from.id} --消息${from.messageId ?? ''}--> ${to.id}`;
  }
  return `${from.id} --同参与者序号顺序--> ${to.id}`;
}
