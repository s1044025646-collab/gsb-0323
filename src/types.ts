// 核心领域类型定义

export type EventType = 'local' | 'send' | 'recv';

export interface RawEvent {
  /** 全局唯一事件编号 */
  id: string;
  /** 参与者标识，必须出现在固定参与者列表中 */
  participant: string;
  /** 该参与者内的连续序号，从 1 开始 */
  seq: number;
  type: EventType;
  /** send：唯一消息编号 */
  messageId?: string;
  /** send：接收者参与者标识（允许等于发送者自身） */
  to?: string;
  /** recv：对应发送事件的编号 */
  refSendId?: string;
}

export interface ImportInput {
  /** 固定参与者顺序，向量分量始终按此顺序解释 */
  participants: string[];
  events: RawEvent[];
}

/** 归一化后的事件（校验后使用） */
export interface NormalizedEvent extends RawEvent {
  type: EventType;
}

export interface ComputedEvent {
  id: string;
  participant: string;
  seq: number;
  type: EventType;
  messageId: string | null;
  to: string | null;
  refSendId: string | null;
  vector: number[];
}

export interface CycleEvidence {
  /** 成环事件编号序列，末尾事件的依赖回到首个事件 */
  cycle: string[];
  /** 对每条环边的人类可读说明 */
  edges: string[];
}

export interface ComputeResult {
  algorithmVersion: string;
  participantOrder: string[];
  events: ComputedEvent[];
}

export type CausalOrder = 'before' | 'after' | 'concurrent' | 'equal';

export interface CompareResult {
  a: string;
  b: string;
  relation: CausalOrder;
  vectorA: number[];
  vectorB: number[];
}

/** 一致切片：每个参与者包含的前缀长度（事件条数） */
export type CutPrefixes = Record<string, number>;

export interface CutViolation {
  recvEventId: string;
  missingSendEventId: string;
  messageId: string | null;
  reason: string;
}

export interface InFlightMessage {
  messageId: string | null;
  sendEventId: string;
  recvEventId: string | null;
  from: string;
  to: string;
}

export interface CutCheckResult {
  valid: boolean;
  prefixes: CutPrefixes;
  violations: CutViolation[];
  inFlight: InFlightMessage[];
  includedEventIds: string[];
}

export interface Report {
  versionId: number;
  algorithmVersion: string;
  createdAt: string;
  participants: string[];
  events: ComputedEvent[];
  eventCount: number;
}
