import type { ImportInput, InputEvent, ValidationIssue } from "../types.js";
import { LIMITS } from "./limits.js";

function issue(
  code: ValidationIssue["code"],
  message: string,
  extra: Partial<ValidationIssue> = {},
): ValidationIssue {
  return { code, message, ...extra };
}

/**
 * 校验输入。只检查结构与显式一致性，不依赖事件列表顺序或墙钟时间。
 */
export function validateInput(input: unknown): {
  ok: boolean;
  data?: ImportInput;
  issues: ValidationIssue[];
} {
  const issues: ValidationIssue[] = [];

  if (typeof input !== "object" || input === null) {
    return { ok: false, issues: [issue("BAD_REQUEST", "请求体必须是 JSON 对象")] };
  }
  const obj = input as Record<string, unknown>;
  const participants = obj.participants;
  const events = obj.events;

  if (!Array.isArray(participants)) {
    issues.push(issue("BAD_REQUEST", "participants 必须是字符串数组"));
    return { ok: false, issues };
  }
  if (!Array.isArray(events)) {
    issues.push(issue("BAD_REQUEST", "events 必须是数组"));
    return { ok: false, issues };
  }

  if (participants.length === 0) {
    issues.push(issue("PARTICIPANTS_EMPTY", "参与者集合不能为空"));
  }
  if (participants.length > LIMITS.maxParticipants) {
    issues.push(
      issue(
        "LIMIT_EXCEEDED",
        `参与者数量 ${participants.length} 超过上限 ${LIMITS.maxParticipants}`,
      ),
    );
  }
  if (events.length > LIMITS.maxEvents) {
    issues.push(
      issue(
        "LIMIT_EXCEEDED",
        `事件数量 ${events.length} 超过上限 ${LIMITS.maxEvents}`,
      ),
    );
  }

  const participantSet = new Set<string>();
  for (const p of participants) {
    if (typeof p !== "string" || p.trim() === "") {
      issues.push(issue("BAD_REQUEST", "参与者名称必须是非空字符串"));
      continue;
    }
    if (participantSet.has(p)) {
      issues.push(
        issue("PARTICIPANT_DUPLICATE", `参与者重复: ${p}`, { participant: p }),
      );
    }
    participantSet.add(p);
  }

  const seenEventIds = new Set<string>();
  const seenMsgSends = new Set<string>();
  const seqsByParticipant = new Map<string, Set<number>>();

  const normalized: InputEvent[] = [];

  events.forEach((raw, idx) => {
    const at = { eventId: typeof raw?.id === "string" ? raw.id : `#${idx}` };
    if (typeof raw !== "object" || raw === null) {
      issues.push(issue("BAD_REQUEST", `第 ${idx} 项不是对象`, at));
      return;
    }
    const ev = raw as Record<string, unknown>;
    const id = ev.id;
    const participant = ev.participant;
    const seq = ev.seq;
    const type = ev.type;

    if (typeof id !== "string" || id.trim() === "") {
      issues.push(issue("EVENT_ID_EMPTY", `第 ${idx} 个事件缺少唯一编号`, at));
      return;
    }
    if (seenEventIds.has(id)) {
      issues.push(issue("EVENT_ID_DUPLICATE", `事件编号重复: ${id}`, { eventId: id }));
    }
    seenEventIds.add(id);

    if (typeof participant !== "string" || !participantSet.has(participant as string)) {
      issues.push(
        issue(
          "UNKNOWN_PARTICIPANT",
          `事件 ${id} 的参与者 "${String(participant)}" 不在固定参与者集合中`,
          { eventId: id, participant: String(participant) },
        ),
      );
      return;
    }

    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) {
      issues.push(
        issue("SEQ_INVALID", `事件 ${id} 的序号必须是 >= 1 的整数`, { eventId: id }),
      );
    } else {
      let set = seqsByParticipant.get(participant);
      if (!set) {
        set = new Set<number>();
        seqsByParticipant.set(participant, set);
      }
      if (set.has(seq)) {
        issues.push(
          issue(
            "SEQ_DUPLICATE",
            `参与者 ${participant} 的序号 ${seq} 被事件 ${id} 重复使用`,
            { eventId: id, participant },
          ),
        );
      }
      set.add(seq);
    }

    if (type !== "local" && type !== "send" && type !== "recv") {
      issues.push(
        issue("BAD_REQUEST", `事件 ${id} 的类型必须是 local/send/recv`, { eventId: id }),
      );
      return;
    }

    const msgId = typeof ev.msgId === "string" ? ev.msgId : undefined;
    const receiver = typeof ev.receiver === "string" ? ev.receiver : undefined;

    if (type === "send") {
      if (!msgId || !receiver) {
        issues.push(
          issue(
            "SEND_FIELDS_MISSING",
            `发送事件 ${id} 必须包含 msgId 与 receiver`,
            { eventId: id },
          ),
        );
      } else {
        if (!participantSet.has(receiver)) {
          issues.push(
            issue(
              "UNKNOWN_RECEIVER",
              `发送事件 ${id} 的接收者 "${receiver}" 不在参与者集合中`,
              { eventId: id, msgId },
            ),
          );
        }
        if (seenMsgSends.has(msgId)) {
          issues.push(
            issue(
              "MSG_ID_DUPLICATE_SEND",
              `消息编号 ${msgId} 已被另一个发送事件使用`,
              { eventId: id, msgId },
            ),
          );
        } else seenMsgSends.add(msgId);
      }
    } else if (type === "recv") {
      if (!msgId) {
        issues.push(
          issue("RECV_FIELDS_MISSING", `接收事件 ${id} 必须包含 msgId`, { eventId: id }),
        );
      }
    } else if (msgId !== undefined || receiver !== undefined) {
      issues.push(
        issue(
          "LOCAL_FIELDS_FORBIDDEN",
          `本地事件 ${id} 不允许携带 msgId/receiver`,
          { eventId: id },
        ),
      );
    }

    normalized.push({
      id,
      participant,
      seq: typeof seq === "number" ? seq : -1,
      type,
      msgId,
      receiver,
    });
  });

  // 序号缺口检查（同一参与者内必须从 1 连续）
  for (const [p, set] of seqsByParticipant) {
    for (let s = 1; s <= Math.max(0, ...set); s++) {
      if (!set.has(s)) {
        issues.push(
          issue("SEQ_GAP", `参与者 ${p} 的事件序号缺少 ${s}`, { participant: p }),
        );
      }
    }
  }

  // 消息配对检查（不依赖列表顺序）
  const sends = new Map<string, InputEvent>();
  const recvCounts = new Map<string, InputEvent[]>();
  for (const ev of normalized) {
    if (ev.type === "send" && ev.msgId) sends.set(ev.msgId, ev);
    if (ev.type === "recv" && ev.msgId) {
      const list = recvCounts.get(ev.msgId) ?? [];
      list.push(ev);
      recvCounts.set(ev.msgId, list);
    }
  }

  for (const ev of normalized) {
    if (ev.type !== "recv" || !ev.msgId) continue;
    const send = sends.get(ev.msgId);
    if (!send) {
      issues.push(
        issue(
          "SEND_NOT_FOUND",
          `接收事件 ${ev.id} 引用的消息 ${ev.msgId} 找不到对应发送`,
          { eventId: ev.id, msgId: ev.msgId },
        ),
      );
      continue;
    }
    if (send.receiver !== ev.participant) {
      issues.push(
        issue(
          "RECV_RECEIVER_MISMATCH",
          `接收事件 ${ev.id} 的参与者 ${ev.participant} 与消息 ${ev.msgId} 的接收者 ${send.receiver} 不符`,
          { eventId: ev.id, msgId: ev.msgId },
        ),
      );
    }
    const list = recvCounts.get(ev.msgId) ?? [];
    if (list.length > 1) {
      issues.push(
        issue(
          "MSG_ALREADY_RECEIVED",
          `消息 ${ev.msgId} 存在 ${list.length} 个接收事件，每条消息只能被接收一次`,
          { eventId: ev.id, msgId: ev.msgId },
        ),
      );
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, data: { participants: participants as string[], events: normalized }, issues };
}
