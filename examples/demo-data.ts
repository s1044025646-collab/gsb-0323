import type { ImportInput } from "../src/types.js";

/**
 * 三参与者 A、B、C（注意：事件列表故意打乱，发送记录不一定在接收之前）。
 * - a1,b1,c1：互相独立的本地事件
 * - m1: a2 发送给 B，b2 接收 => b2 因果依赖 a2
 * - m2: b3 发送给 C，c2 接收 => c2 传递性地因果依赖 a2
 * - a3：A 上后续本地事件；m3: a4 发送给 C，尚未接收（合法在途消息）
 */
export const demoInput: ImportInput = {
  participants: ["A", "B", "C"],
  events: [
    { id: "c1", participant: "C", seq: 1, type: "local" },
    { id: "b2", participant: "B", seq: 2, type: "recv", msgId: "m1" },
    { id: "a1", participant: "A", seq: 1, type: "local" },
    { id: "c2", participant: "C", seq: 2, type: "recv", msgId: "m2" },
    { id: "b1", participant: "B", seq: 1, type: "local" },
    { id: "b3", participant: "B", seq: 3, type: "send", msgId: "m2", receiver: "C" },
    { id: "a3", participant: "A", seq: 3, type: "local" },
    { id: "a4", participant: "A", seq: 4, type: "send", msgId: "m3", receiver: "C" },
    { id: "a2", participant: "A", seq: 2, type: "send", msgId: "m1", receiver: "B" },
  ],
};

/** 用于切片演示：m4 由 P1 发往 Q1。 */
export const invalidSliceInput: ImportInput = {
  participants: ["P", "Q"],
  events: [
    { id: "q1", participant: "Q", seq: 1, type: "recv", msgId: "m4" },
    { id: "p1", participant: "P", seq: 1, type: "send", msgId: "m4", receiver: "Q" },
    { id: "p2", participant: "P", seq: 2, type: "send", msgId: "m5", receiver: "Q" },
  ],
};

export const inFlightSliceInput = invalidSliceInput;
