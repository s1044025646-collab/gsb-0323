import type { ImportInput } from './types.js';

export const DEMO_PARTICIPANTS = ['P1', 'P2', 'P3'];

/**
 * 三个参与者演示（输入顺序故意打乱，不按因果顺序排列）：
 * - P1/P2/P3 各有相互独立的本地事件（并发）
 * - m1: P1 发送给 P2，建立 P1 -> P2 因果
 * - m2: P2 发送给 P3，与 m1 形成跨两条消息的传递因果 P1 -> P2 -> P3
 * - m3: P1 自发自收的孤立发送（尚未投递，合法）
 */
export function demoInput(): ImportInput {
  return {
    participants: [...DEMO_PARTICIPANTS],
    // 数组顺序故意打乱；按序号的真实链路为：
    // P1: p1-1(local) -> p1-2(send m1) -> p1-3(send m3, 自发自收未投递)
    // P2: p2-1(local) -> p2-2(recv m1) -> p2-3(send m2)
    // P3: p3-1(local) -> p3-2(recv m2)
    events: [
      { id: 'p3-1', participant: 'P3', seq: 1, type: 'local' },
      { id: 'p3-2', participant: 'P3', seq: 2, type: 'recv', refSendId: 'p2-3' },
      { id: 'p1-2', participant: 'P1', seq: 2, type: 'send', messageId: 'm1', to: 'P2' },
      { id: 'p2-3', participant: 'P2', seq: 3, type: 'send', messageId: 'm2', to: 'P3' },
      { id: 'p1-3', participant: 'P1', seq: 3, type: 'send', messageId: 'm3', to: 'P1' },
      { id: 'p2-1', participant: 'P2', seq: 1, type: 'local' },
      { id: 'p1-1', participant: 'P1', seq: 1, type: 'local' },
      { id: 'p2-2', participant: 'P2', seq: 2, type: 'recv', refSendId: 'p1-2' }
    ]
  };
}

/** 含同参与者自发自收的小输入（接收序号在发送之后） */
export function selfSendInput(): ImportInput {
  return {
    participants: ['A'],
    events: [
      { id: 'a1', participant: 'A', seq: 1, type: 'send', messageId: 'self1', to: 'A' },
      { id: 'a2', participant: 'A', seq: 2, type: 'recv', refSendId: 'a1' }
    ]
  };
}
