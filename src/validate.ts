import { AppError, ErrorCodes, LIMITS } from './errors.js';
import type { ImportInput, NormalizedEvent, RawEvent } from './types.js';

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isPosInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1;
}

/**
 * 归一化并严格校验输入。
 * 不依据数组顺序/行序推断因果：这里只做字段合法性校验，
 * 真正的处理顺序由后续依赖拓扑决定。
 */
export function validateInput(input: unknown): {
  participantOrder: string[];
  events: NormalizedEvent[];
} {
  if (typeof input !== 'object' || input === null) {
    throw new AppError(ErrorCodes.BAD_REQUEST, '请求体必须是 JSON 对象');
  }
  const body = input as Partial<ImportInput>;

  if (!Array.isArray(body.participants)) {
    throw new AppError(ErrorCodes.VALIDATION, 'participants 必须是数组');
  }
  const participants = body.participants;
  if (participants.length === 0) {
    throw new AppError(ErrorCodes.VALIDATION, '至少需要一个参与者');
  }
  if (participants.length > LIMITS.MAX_PARTICIPANTS) {
    throw new AppError(
      ErrorCodes.LIMIT_EXCEEDED,
      `参与者数量超过上限 ${LIMITS.MAX_PARTICIPANTS}`
    );
  }

  const order: string[] = [];
  const participantIndex = new Map<string, number>();
  for (const p of participants) {
    if (!isNonEmptyString(p)) {
      throw new AppError(ErrorCodes.VALIDATION, '参与者标识必须是非空字符串');
    }
    if (participantIndex.has(p)) {
      throw new AppError(ErrorCodes.DUPLICATE_ID, `参与者重复: ${p}`);
    }
    participantIndex.set(p, order.length);
    order.push(p);
  }

  if (!Array.isArray(body.events)) {
    throw new AppError(ErrorCodes.VALIDATION, 'events 必须是数组');
  }
  if (body.events.length > LIMITS.MAX_EVENTS) {
    throw new AppError(
      ErrorCodes.LIMIT_EXCEEDED,
      `事件数量超过上限 ${LIMITS.MAX_EVENTS}`
    );
  }

  const seenEventIds = new Set<string>();
  const seenMessageIds = new Set<string>();
  const events: NormalizedEvent[] = [];

  body.events.forEach((raw: unknown, idx) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new AppError(ErrorCodes.VALIDATION, `events[${idx}] 必须是对象`);
    }
    const ev = raw as Partial<RawEvent>;
    if (!isNonEmptyString(ev.id)) {
      throw new AppError(ErrorCodes.VALIDATION, `events[${idx}].id 必须是非空字符串`);
    }
    if (ev.id.length > LIMITS.MAX_ID_LENGTH) {
      throw new AppError(
        ErrorCodes.VALIDATION,
        `事件编号过长: ${ev.id}（上限 ${LIMITS.MAX_ID_LENGTH}）`
      );
    }
    if (seenEventIds.has(ev.id)) {
      throw new AppError(ErrorCodes.DUPLICATE_ID, `事件编号重复: ${ev.id}`);
    }
    seenEventIds.add(ev.id);

    if (!isNonEmptyString(ev.participant) || !participantIndex.has(ev.participant)) {
      throw new AppError(
        ErrorCodes.UNKNOWN_PARTICIPANT,
        `事件 ${ev.id} 的参与者缺失或不在固定参与者集合中: ${String(ev.participant)}`
      );
    }

    if (!isPosInt(ev.seq)) {
      throw new AppError(
        ErrorCodes.VALIDATION,
        `事件 ${ev.id} 的 seq 必须是 >= 1 的整数`
      );
    }

    if (ev.type !== 'local' && ev.type !== 'send' && ev.type !== 'recv') {
      throw new AppError(
        ErrorCodes.VALIDATION,
        `事件 ${ev.id} 的 type 必须是 local | send | recv`
      );
    }

    let messageId: string | null = null;
    let to: string | null = null;
    let refSendId: string | null = null;

    if (ev.type === 'send') {
      if (!isNonEmptyString(ev.messageId)) {
        throw new AppError(ErrorCodes.VALIDATION, `发送事件 ${ev.id} 缺少 messageId`);
      }
      if (ev.messageId.length > LIMITS.MAX_MESSAGE_LENGTH) {
        throw new AppError(
          ErrorCodes.VALIDATION,
          `消息编号过长: ${ev.messageId}（上限 ${LIMITS.MAX_MESSAGE_LENGTH}）`
        );
      }
      if (seenMessageIds.has(ev.messageId)) {
        throw new AppError(ErrorCodes.DUPLICATE_ID, `消息编号重复: ${ev.messageId}`);
      }
      seenMessageIds.add(ev.messageId);
      if (!isNonEmptyString(ev.to) || !participantIndex.has(ev.to)) {
        throw new AppError(
          ErrorCodes.UNKNOWN_PARTICIPANT,
          `发送事件 ${ev.id} 的接收者缺失或不在参与者集合中: ${String(ev.to)}`
        );
      }
      messageId = ev.messageId;
      to = ev.to;
    }

    if (ev.type === 'recv') {
      if (!isNonEmptyString(ev.refSendId)) {
        throw new AppError(ErrorCodes.VALIDATION, `接收事件 ${ev.id} 缺少 refSendId`);
      }
      refSendId = ev.refSendId;
    }

    events.push({
      id: ev.id,
      participant: ev.participant,
      seq: ev.seq,
      type: ev.type,
      messageId: messageId ?? undefined,
      to: to ?? undefined,
      refSendId: refSendId ?? undefined
    });
  });

  // 每个参与者内序号必须是从 1 开始的连续序列，无缺口无重复
  const byParticipant = new Map<string, NormalizedEvent[]>();
  for (const ev of events) {
    const list = byParticipant.get(ev.participant) ?? [];
    list.push(ev);
    byParticipant.set(ev.participant, list);
  }
  for (const [p, list] of byParticipant) {
    list.sort((a, b) => a.seq - b.seq);
    for (let i = 0; i < list.length; i++) {
      const expected = i + 1;
      const ev = list[i]!;
      if (ev.seq !== expected) {
        throw new AppError(
          ErrorCodes.SEQ_GAP,
          `参与者 ${p} 的事件序号不连续: 期望 ${expected}，实际 ${ev.seq}（事件 ${ev.id}）`,
          { participant: p, expected, actual: ev.seq, eventId: ev.id }
        );
      }
    }
  }

  const eventById = new Map(events.map((e) => [e.id, e]));

  // 接收引用校验：发送必须存在、接收者必须匹配、禁止重复接收
  for (const ev of events) {
    if (ev.type !== 'recv' || ev.refSendId === undefined) continue;
    const send = eventById.get(ev.refSendId);
    if (!send) {
      throw new AppError(
        ErrorCodes.MISSING_SEND,
        `接收事件 ${ev.id} 找不到对应发送: ${ev.refSendId}`,
        { recvEventId: ev.id, refSendId: ev.refSendId }
      );
    }
    if (send.type !== 'send') {
      throw new AppError(
        ErrorCodes.MISSING_SEND,
        `接收事件 ${ev.id} 引用的 ${send.id} 不是发送事件`,
        { recvEventId: ev.id, refSendId: ev.refSendId }
      );
    }
    if (send.to !== ev.participant) {
      throw new AppError(
        ErrorCodes.RECV_MISMATCH,
        `接收者不符: 发送 ${send.id} 指定接收者为 ${send.to}，但接收事件 ${ev.id} 属于 ${ev.participant}`,
        { sendEventId: send.id, expectedTo: send.to, actualParticipant: ev.participant, recvEventId: ev.id }
      );
    }
  }

  // 重复接收：同一发送事件被多个接收引用
  const recvRefCount = new Map<string, string[]>();
  for (const ev of events) {
    if (ev.type === 'recv' && ev.refSendId !== undefined) {
      const arr = recvRefCount.get(ev.refSendId) ?? [];
      arr.push(ev.id);
      recvRefCount.set(ev.refSendId, arr);
    }
  }
  for (const [sendId, recvIds] of recvRefCount) {
    if (recvIds.length > 1) {
      throw new AppError(
        ErrorCodes.DUPLICATE_RECV,
        `发送 ${sendId} 被重复接收: ${recvIds.join(', ')}`,
        { sendEventId: sendId, recvEventIds: recvIds }
      );
    }
  }

  return { participantOrder: order, events };
}
