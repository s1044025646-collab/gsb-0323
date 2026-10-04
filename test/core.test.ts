import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkCut, compareEvents, computeVectorClocks, reachabilityOrder } from '../src/clock.js';
import { AppError } from '../src/errors.js';
import { buildDependencies } from '../src/graph.js';
import { demoInput, selfSendInput } from '../src/demoData.js';
import { validateInput } from '../src/validate.js';
import type { ImportInput, RawEvent } from '../src/types.js';

function build(input: ImportInput) {
  const { participantOrder, events } = validateInput(input);
  const { events: computed } = computeVectorClocks(participantOrder, events);
  return { participantOrder, events, computed };
}

describe('演示数据：向量时钟与因果', () => {
  const { participantOrder, events, computed } = build(demoInput());

  it('初始向量与本地/发送/接收规则正确', () => {
    const v = (id: string) => computed.find((e) => e.id === id)!.vector;
    assert.deepEqual(v('p1-1'), [1, 0, 0]);
    assert.deepEqual(v('p1-2'), [2, 0, 0]); // 发送先自增
    assert.deepEqual(v('p2-1'), [0, 1, 0]);
    assert.deepEqual(v('p2-2'), [2, 2, 0]); // max(p2前=[0,1,0], send=[2,0,0]) 后自增
    assert.deepEqual(v('p2-3'), [2, 3, 0]); // 继续本地发送先自增
    assert.deepEqual(v('p3-2'), [2, 3, 2]); // 在 p3-1 基础上合并发送时间戳再自增
    assert.deepEqual(v('p3-1'), [0, 0, 1]);
  });

  it('独立本地事件并发', () => {
    assert.equal(compareEvents(computed, 'p1-1', 'p2-1').relation, 'concurrent');
    assert.equal(compareEvents(computed, 'p1-1', 'p3-1').relation, 'concurrent');
  });

  it('发送接收建立因果', () => {
    assert.equal(compareEvents(computed, 'p1-2', 'p2-2').relation, 'before');
    assert.equal(compareEvents(computed, 'p2-2', 'p1-2').relation, 'after');
  });

  it('跨两条消息的传递因果', () => {
    assert.equal(compareEvents(computed, 'p1-1', 'p3-2').relation, 'before');
    assert.equal(compareEvents(computed, 'p3-2', 'p1-1').relation, 'after');
  });

  it('同一事件比较返回 equal', () => {
    assert.equal(compareEvents(computed, 'p2-2', 'p2-2').relation, 'equal');
  });

  it('图可达性与向量比较一致', () => {
    for (const a of events) {
      for (const b of events) {
        const vc = compareEvents(computed, a.id, b.id).relation;
        const gr = reachabilityOrder(participantOrder, events, a.id, b.id);
        assert.equal(vc, gr, `${a.id} vs ${b.id}: 向量=${vc} 可达性=${gr}`);
      }
    }
  });
});

describe('全局输入重排结果不变', () => {
  it('乱序、逆序、打乱均产生相同向量', () => {
    const base = demoInput();
  const orders: RawEvent[][] = [
      [...base.events],
      [...base.events].reverse(),
      [...base.events].sort(() => Math.random() - 0.5),
      [...base.events].sort((a, b) => a.id.localeCompare(b.id))
    ];
    const vectors = orders.map((evs) => {
      const { computed } = build({ participants: base.participants, events: evs });
      return JSON.stringify(Object.fromEntries(computed.map((e) => [e.id, e.vector])));
    });
    assert.ok(vectors.every((v) => v === vectors[0]));
  });
});

describe('错误输入', () => {
  it('重复事件编号', () => {
    const input: ImportInput = {
      participants: ['A'],
      events: [
        { id: 'x', participant: 'A', seq: 1, type: 'local' },
        { id: 'x', participant: 'A', seq: 2, type: 'local' }
      ]
    };
    assert.throws(() => validateInput(input), (e: AppError) => e.code === 'E_DUPLICATE_ID');
  });

  it('参与者缺失/未知参与者', () => {
    const input = { participants: ['A'], events: [{ id: 'x', participant: 'B', seq: 1, type: 'local' }] };
    assert.throws(() => validateInput(input), (e: AppError) => e.code === 'E_UNKNOWN_PARTICIPANT');
  });

  it('序号缺口', () => {
    const input: ImportInput = {
      participants: ['A'],
      events: [{ id: 'x', participant: 'A', seq: 3, type: 'local' }]
    };
    assert.throws(() => validateInput(input), (e: AppError) => e.code === 'E_SEQ_GAP');
  });

  it('接收者不符', () => {
    const input: ImportInput = {
      participants: ['A', 'B'],
      events: [
        { id: 's', participant: 'A', seq: 1, type: 'send', messageId: 'm', to: 'B' },
        { id: 'r', participant: 'A', seq: 2, type: 'recv', refSendId: 's' }
      ]
    };
    assert.throws(() => validateInput(input), (e: AppError) => e.code === 'E_RECV_MISMATCH');
  });

  it('重复接收', () => {
    const input: ImportInput = {
      participants: ['A', 'B'],
      events: [
        { id: 's', participant: 'A', seq: 1, type: 'send', messageId: 'm', to: 'B' },
        { id: 'r1', participant: 'B', seq: 1, type: 'recv', refSendId: 's' },
        { id: 'r2', participant: 'B', seq: 2, type: 'recv', refSendId: 's' }
      ]
    };
    assert.throws(() => validateInput(input), (e: AppError) => e.code === 'E_DUPLICATE_RECV');
  });

  it('找不到发送', () => {
    const input: ImportInput = {
      participants: ['A'],
      events: [{ id: 'r', participant: 'A', seq: 1, type: 'recv', refSendId: 'ghost' }]
    };
    assert.throws(() => validateInput(input), (e: AppError) => e.code === 'E_MISSING_SEND');
  });

  it('孤立发送合法（未投递不补接收）', () => {
    const input: ImportInput = {
      participants: ['A'],
      events: [{ id: 's', participant: 'A', seq: 1, type: 'send', messageId: 'm', to: 'A' }]
    };
    const { computed } = build(input);
    assert.deepEqual(computed[0]!.vector, [1]);
  });

  it('同参与者事件链与自发自收', () => {
    const { computed } = build(selfSendInput());
    assert.deepEqual(computed.find((e) => e.id === 'a1')!.vector, [1]);
    assert.deepEqual(computed.find((e) => e.id === 'a2')!.vector, [2]);
  });

  it('依赖成环：参与者顺序与消息依赖共同形成环', () => {
    const input: ImportInput = {
      participants: ['A', 'B'],
      events: [
        // A: 先收 m2(B->A) 后发 m1(A->B)；B: 先收 m1 后发 m2 => 环
        { id: 'a1', participant: 'A', seq: 1, type: 'recv', refSendId: 'b2' },
        { id: 'a2', participant: 'A', seq: 2, type: 'send', messageId: 'm1', to: 'B' },
        { id: 'b1', participant: 'B', seq: 1, type: 'recv', refSendId: 'a2' },
        { id: 'b2', participant: 'B', seq: 2, type: 'send', messageId: 'm2', to: 'A' }
      ]
    };
    assert.throws(
      () => build(input),
      (e: AppError) => {
        assert.equal(e.code, 'E_CYCLE');
        const evidence = e.details as { cycle: string[]; edges: string[] };
        assert.ok(evidence.cycle.length >= 2);
        assert.ok(evidence.edges.length >= 1);
        return true;
      }
    );
  });
});

describe('切片检查', () => {
  const { participantOrder, computed } = build(demoInput());

  it('包含接收漏掉发送 => 无效并给出证据', () => {
    const result = checkCut(participantOrder, computed, { P1: 1, P2: 2, P3: 0 });
    assert.equal(result.valid, false);
    assert.equal(result.violations[0]!.recvEventId, 'p2-2');
    assert.equal(result.violations[0]!.missingSendEventId, 'p1-2');
  });

  it('在途消息不误判为无效', () => {
    const result = checkCut(participantOrder, computed, { P1: 2, P2: 1, P3: 0 });
    assert.equal(result.valid, true);
    assert.ok(result.inFlight.some((m) => m.messageId === 'm1'));
  });

  it('空切片与全切片有效', () => {
    assert.equal(checkCut(participantOrder, computed, { P1: 0, P2: 0, P3: 0 }).valid, true);
    assert.equal(checkCut(participantOrder, computed, { P1: 3, P2: 3, P3: 2 }).valid, true);
  });

  it('穷举小规模前缀组合：与逐对因果闭包定义一致', () => {
    const counts = [3, 3, 2];
    const eventById = new Map(computed.map((e) => [e.id, e]));
    for (let p1 = 0; p1 <= counts[0]!; p1++) {
      for (let p2 = 0; p2 <= counts[1]!; p2++) {
        for (let p3 = 0; p3 <= counts[2]!; p3++) {
          const prefixes = { P1: p1, P2: p2, P3: p3 };
          const result = checkCut(participantOrder, computed, prefixes);
          // 参考定义：每个被包含的 recv，其 send 必须也被包含
          const included = new Set(result.includedEventIds);
          let expectedValid = true;
          for (const e of computed) {
            if (e.type === 'recv' && included.has(e.id) && !included.has(e.refSendId!)) {
              expectedValid = false;
            }
          }
          assert.equal(result.valid, expectedValid, JSON.stringify(prefixes));
          void eventById;
        }
      }
    }
  });

  it('未知参与者前缀被拒绝（防止跨版本顺序混用）', () => {
    assert.throws(
      () => checkCut(participantOrder, computed, { P1: 0, P2: 0, P3: 0, X: 1 }),
      (e: AppError) => e.code === 'E_UNKNOWN_PARTICIPANT'
    );
  });
});

describe('依赖图', () => {
  it('包含参与者序号链与消息边', () => {
    const { participantOrder, events } = validateInput(demoInput());
    const deps = buildDependencies(participantOrder, events);
    assert.deepEqual(deps.get('p2-2')!.sort(), ['p1-2', 'p2-1']);
    assert.deepEqual(deps.get('p2-3'), ['p2-2']);
    assert.deepEqual(deps.get('p1-1'), []);
  });
});
