import { ALGORITHM_VERSION, AppError, ErrorCodes } from './errors.js';
import { buildDependencies, stableTopologicalSort } from './graph.js';
import type {
  CompareResult,
  ComputedEvent,
  CausalOrder,
  CutCheckResult,
  CutPrefixes,
  InFlightMessage,
  NormalizedEvent
} from './types.js';

function componentMaxInto(target: number[], other: number[]): void {
  for (let i = 0; i < target.length; i++) {
    if (other[i]! > target[i]!) target[i] = other[i]!;
  }
}

/**
 * 自行计算向量时钟：
 * - local/send：先将自身分量 +1，再记录时间戳
 * - recv：先与对应发送时间戳逐分量取 max，再将自身分量 +1
 * 计算顺序由稳定拓扑决定，与输入数组顺序无关。
 */
export function computeVectorClocks(
  participantOrder: string[],
  events: NormalizedEvent[]
): { algorithmVersion: string; events: ComputedEvent[] } {
  const deps = buildDependencies(participantOrder, events);
  const ordered = stableTopologicalSort(participantOrder, events, deps);

  const indexOf = new Map(participantOrder.map((p, i) => [p, i]));
  const vectors = new Map<string, number[]>();
  // 每个参与者的当前时钟（初始全零），事件按拓扑顺序在其上推进
  const currentByParticipant = new Map<string, number[]>();
  for (const p of participantOrder) {
    currentByParticipant.set(p, new Array<number>(participantOrder.length).fill(0));
  }
  const computed: ComputedEvent[] = [];

  for (const ev of ordered) {
    const myIndex = indexOf.get(ev.participant)!;
    // 从该参与者当前时钟继续推进
    const vector = [...currentByParticipant.get(ev.participant)!];

    if (ev.type === 'recv' && ev.refSendId !== undefined) {
      // 先与发送时间戳逐分量取最大值（同参与者自发自收也走同一规则），再自增
      const sendVector = vectors.get(ev.refSendId);
      if (!sendVector) {
        // 拓扑排序保证不会发生，作为内部不变量防御
        throw new AppError(
          ErrorCodes.INTERNAL,
          `内部错误：接收 ${ev.id} 的发送 ${ev.refSendId} 尚未计算`
        );
      }
      componentMaxInto(vector, sendVector);
    }
    // 再增加自身分量，然后记录
    vector[myIndex] = vector[myIndex]! + 1;
    vectors.set(ev.id, vector);
    currentByParticipant.set(ev.participant, vector);

    computed.push({
      id: ev.id,
      participant: ev.participant,
      seq: ev.seq,
      type: ev.type,
      messageId: ev.messageId ?? null,
      to: ev.to ?? null,
      refSendId: ev.refSendId ?? null,
      vector: [...vector]
    });
  }

  return { algorithmVersion: ALGORITHM_VERSION, events: computed };
}

/**
 * 向量时钟比较：
 * a <= b 逐分量且至少一个严格小 => before；反向 => after；
 * 两边各有更大分量 => concurrent；完全相等 => equal。
 */
export function compareVectors(a: number[], b: number[]): CausalOrder {
  if (a.length !== b.length) {
    throw new AppError(
      ErrorCodes.VALIDATION,
      `向量长度不一致（${a.length} vs ${b.length}），可能来自不同参与者顺序/版本`
    );
  }
  let aLess = false;
  let bLess = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]! < b[i]!) aLess = true;
    else if (a[i]! > b[i]!) bLess = true;
  }
  if (!aLess && !bLess) return 'equal';
  if (aLess && !bLess) return 'before';
  if (bLess && !aLess) return 'after';
  return 'concurrent';
}

export function compareEvents(
  events: ComputedEvent[],
  idA: string,
  idB: string
): CompareResult {
  const a = events.find((e) => e.id === idA);
  const b = events.find((e) => e.id === idB);
  if (!a) throw new AppError(ErrorCodes.NOT_FOUND, `事件不存在: ${idA}`);
  if (!b) throw new AppError(ErrorCodes.NOT_FOUND, `事件不存在: ${idB}`);
  return {
    a: idA,
    b: idB,
    relation: compareVectors(a.vector, b.vector),
    vectorA: a.vector,
    vectorB: b.vector
  };
}

function normalizePrefixes(
  participantOrder: string[],
  prefixes: unknown
): CutPrefixes {
  if (typeof prefixes !== 'object' || prefixes === null || Array.isArray(prefixes)) {
    throw new AppError(ErrorCodes.VALIDATION, 'prefixes 必须是以参与者为键的对象');
  }
  const result: CutPrefixes = {};
  for (const p of participantOrder) {
    const raw = (prefixes as Record<string, unknown>)[p];
    if (raw === undefined) {
      result[p] = 0;
      continue;
    }
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
      throw new AppError(
        ErrorCodes.VALIDATION,
        `参与者 ${p} 的前缀长度必须是非负整数`
      );
    }
    result[p] = raw;
  }
  for (const key of Object.keys(prefixes as object)) {
    if (!participantOrder.includes(key)) {
      throw new AppError(
        ErrorCodes.UNKNOWN_PARTICIPANT,
        `前缀中出现未知参与者（不同版本顺序不可混用）: ${key}`
      );
    }
  }
  return result;
}

/**
 * 一致切片检查：
 * - 切片=每个参与者前 prefixes[p] 个事件（按 seq）
 * - 若包含一次接收却不包含其发送 => 违反因果闭包（返回该对事件作为证据）
 * - 发送已包含而接收尚未包含 => 合法在途消息，不判无效
 */
export function checkCut(
  participantOrder: string[],
  events: ComputedEvent[],
  rawPrefixes: unknown
): CutCheckResult {
  const prefixes = normalizePrefixes(participantOrder, rawPrefixes);

  const included = new Set<string>();
  const includedList: string[] = [];
  for (const ev of events) {
    if (ev.seq <= (prefixes[ev.participant] ?? 0)) {
      included.add(ev.id);
      includedList.push(ev.id);
    }
  }

  const eventById = new Map(events.map((e) => [e.id, e]));
  const violations: CutCheckResult['violations'] = [];
  const inFlight: InFlightMessage[] = [];

  // 前缀长度不得超过该参与者事件数
  for (const p of participantOrder) {
    const total = events.filter((e) => e.participant === p).length;
    if ((prefixes[p] ?? 0) > total) {
      throw new AppError(
        ErrorCodes.VALIDATION,
        `参与者 ${p} 的前缀长度 ${prefixes[p]} 超过其事件总数 ${total}`
      );
    }
  }

  for (const ev of events) {
    if (ev.type !== 'recv' || ev.refSendId === null) continue;
    const send = eventById.get(ev.refSendId);
    if (!send) continue; // 校验阶段已排除
    if (included.has(ev.id) && !included.has(send.id)) {
      violations.push({
        recvEventId: ev.id,
        missingSendEventId: send.id,
        messageId: send.messageId,
        reason: `切片包含接收 ${ev.id} 却不包含其发送 ${send.id}，因果闭包被破坏`
      });
    }
  }

  // 在途消息：发送已包含、尚无接收事件，或接收事件未包含
  for (const ev of events) {
    if (ev.type !== 'send') continue;
    const recv = events.find(
      (e) => e.type === 'recv' && e.refSendId === ev.id
    );
    const sendIn = included.has(ev.id);
    const recvIn = recv ? included.has(recv.id) : false;
    if (sendIn && !recvIn) {
      inFlight.push({
        messageId: ev.messageId,
        sendEventId: ev.id,
        recvEventId: recv ? recv.id : null,
        from: ev.participant,
        to: ev.to ?? ''
      });
    }
  }

  includedList.sort();
  return { valid: violations.length === 0, prefixes, violations, inFlight, includedEventIds: includedList };
}

/**
 * 独立的图可达性因果判定（仅用于与向量时钟结果交叉验证）。
 * 不读取向量，只在“参与者序号链 + 消息边”的依赖图上判可达性。
 */
export function reachabilityOrder(
  participantOrder: string[],
  events: NormalizedEvent[],
  idA: string,
  idB: string
): CausalOrder {
  const deps = buildDependencies(participantOrder, events);
  // deps.get(x) 是 x 的前驱；构造正向邻接
  const adj = new Map<string, string[]>();
  for (const ev of events) adj.set(ev.id, []);
  for (const ev of events) {
    for (const pred of deps.get(ev.id) ?? []) adj.get(pred)!.push(ev.id);
  }
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>([from]);
    const stack = [from];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === to) return true;
      for (const nxt of adj.get(cur) ?? []) {
        if (!seen.has(nxt)) {
          seen.add(nxt);
          stack.push(nxt);
        }
      }
    }
    return false;
  };
  if (idA === idB) return 'equal';
  const ab = reaches(idA, idB);
  const ba = reaches(idB, idA);
  if (ab && !ba) return 'before';
  if (ba && !ab) return 'after';
  if (ab && ba) return 'equal'; // 同一可达等价类（无环时仅自身）
  return 'concurrent';
}
