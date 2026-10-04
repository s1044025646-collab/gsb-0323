import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { validateInput } from "../src/core/validate.js";
import {
  CausalCycleError,
  checkSlice,
  compareClocks,
  computeClocks,
  enumerateSlices,
  reachable,
} from "../src/core/engine.js";
import { Store } from "../src/db/store.js";
import { CausalService } from "../src/core/service.js";
import { demoInput, invalidSliceInput } from "../examples/demo-data.js";
import type { ImportInput } from "../src/types.js";

function shuffled<T>(arr: T[], seed: number): T[] {
  const a = [...arr];
  let s = seed;
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

test("三参与者演示：本地事件、发送接收、传递因果的向量时钟", () => {
  const r = computeClocks(demoInput, "t", 1);
  const clock = new Map(r.clocks.map((c) => [c.eventId, c.clock]));
  assert.deepEqual(clock.get("a1"), [1, 0, 0]);
  assert.deepEqual(clock.get("b1"), [0, 1, 0]);
  assert.deepEqual(clock.get("c1"), [0, 0, 1]);
  assert.deepEqual(clock.get("a2"), [2, 0, 0]);
  assert.deepEqual(clock.get("b2"), [2, 2, 0]);
  assert.deepEqual(clock.get("b3"), [2, 3, 0]);
  assert.deepEqual(clock.get("c2"), [2, 3, 2]);
  assert.deepEqual(clock.get("a3"), [3, 0, 0]);
  assert.deepEqual(clock.get("a4"), [4, 0, 0]);

  const m3 = r.messages.find((m) => m.msgId === "m3");
  assert.equal(m3?.recvEventId, null);
});

test("比较结果与独立图可达性完全一致（全部事件对）", () => {
  const r = computeClocks(demoInput, "t", 1);
  const clock = new Map(r.clocks.map((c) => [c.eventId, c.clock]));
  const ids = r.clocks.map((c) => c.eventId);
  for (const x of ids) {
    for (const y of ids) {
      const order = compareClocks(clock.get(x)!, clock.get(y)!);
      const xy = reachable(demoInput, x, y);
      const yx = x === y ? false : reachable(demoInput, y, x);
      if (order === "equal") assert.equal(x, y);
      if (order === "before") assert.ok(xy && !yx, `${x} before ${y} 但图可达性不符`);
      if (order === "after") assert.ok(yx && !xy, `${x} after ${y} 但图可达性不符`);
      if (order === "concurrent") assert.ok(!xy && !yx, `${x} concurrent ${y} 但图上可达`);
    }
  }
});

test("全局输入任意重排，时钟结果不变", () => {
  const base = JSON.stringify(computeClocks(demoInput, "t", 1).clocks);
  for (let seed = 1; seed <= 8; seed++) {
    const reordered: ImportInput = {
      participants: demoInput.participants,
      events: shuffled(demoInput.events, seed),
    };
    assert.deepEqual(computeClocks(reordered, "t", 1).clocks, JSON.parse(base));
  }
});

test("自发自收：接收序号必须在发送之后，否则成环并给出实际事件环", () => {
  const valid: ImportInput = {
    participants: ["X"],
    events: [
      { id: "x1", participant: "X", seq: 1, type: "send", msgId: "m", receiver: "X" },
      { id: "x2", participant: "X", seq: 2, type: "recv", msgId: "m" },
    ],
  };
  const r = computeClocks(valid, "t", 1);
  assert.deepEqual(r.clocks.find((c) => c.eventId === "x2")?.clock, [2]);

  const cyclic: ImportInput = {
    participants: ["X"],
    events: [
      { id: "x1", participant: "X", seq: 1, type: "recv", msgId: "m" },
      { id: "x2", participant: "X", seq: 2, type: "send", msgId: "m", receiver: "X" },
    ],
  };
  assert.throws(
    () => computeClocks(cyclic, "t", 1),
    (err: unknown) => err instanceof CausalCycleError && err.cycle.includes("x1") && err.cycle.includes("x2"),
  );
});

test("校验：重复编号、序号缺口、接收者不符、重复接收、找不到发送", () => {
  const codes = (input: unknown) => validateInput(input).issues.map((i) => i.code);
  assert.ok(codes({ participants: ["A", "A"], events: [] }).includes("PARTICIPANT_DUPLICATE"));
  assert.ok(
    codes({
      participants: ["A"],
      events: [{ id: "a2", participant: "A", seq: 2, type: "local" }],
    }).includes("SEQ_GAP"),
  );
  assert.ok(
    codes({
      participants: ["A", "B"],
      events: [
        { id: "a1", participant: "A", seq: 1, type: "send", msgId: "m", receiver: "B" },
        { id: "b1", participant: "B", seq: 1, type: "recv", msgId: "m" },
        { id: "b2", participant: "B", seq: 2, type: "recv", msgId: "m" },
      ],
    }).includes("MSG_ALREADY_RECEIVED"),
  );
  assert.ok(
    codes({
      participants: ["A", "B"],
      events: [{ id: "b1", participant: "B", seq: 1, type: "recv", msgId: "ghost" }],
    }).includes("SEND_NOT_FOUND"),
  );
  assert.ok(
    codes({
      participants: ["A", "B"],
      events: [
        { id: "a1", participant: "A", seq: 1, type: "send", msgId: "m", receiver: "A" },
        { id: "b1", participant: "B", seq: 1, type: "recv", msgId: "m" },
      ],
    }).includes("RECV_RECEIVER_MISMATCH"),
  );
  assert.ok(
    codes({
      participants: ["A"],
      events: [
        { id: "a1", participant: "A", seq: 1, type: "local" },
        { id: "a1", participant: "A", seq: 2, type: "local" },
      ],
    }).includes("EVENT_ID_DUPLICATE"),
  );
});

test("孤立发送合法：成功计算且出现在在途消息中，不补接收", () => {
  const input: ImportInput = {
    participants: ["A", "B"],
    events: [{ id: "a1", participant: "A", seq: 1, type: "send", msgId: "m", receiver: "B" }],
  };
  const r = computeClocks(input, "t", 1);
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0]!.recvEventId, null);
  assert.deepEqual(r.clocks[0]!.clock, [1, 0]);
});

test("穷举前缀组合：切片判定与直接闭包规则一致", () => {
  const r = computeClocks(invalidSliceInput, "t", 1);
  const all = enumerateSlices(r);
  assert.equal(all.length, (2 + 1) * (1 + 1));
  for (const s of all) {
    const expect = checkSlice(r, s.prefixes);
    assert.equal(s.consistent, expect.consistent);
    assert.deepEqual(s.violations, expect.violations);
  }
  const bad = checkSlice(r, { P: 0, Q: 1 });
  assert.equal(bad.consistent, false);
  assert.equal(bad.violations[0]?.recvEventId, "q1");
  assert.equal(bad.violations[0]?.sendEventId, "p1");
  const good = checkSlice(r, { P: 2, Q: 0 });
  assert.equal(good.consistent, true);
  assert.deepEqual(good.inFlight.map((m) => m.msgId).sort(), ["m4", "m5"]);
});

test("计算失败不登记完整结果；重启后报告与消息证据可读", () => {
  const dbPath = resolve("data/test-persist.db");
  for (const ext of ["", "-wal", "-shm"]) rmSync(dbPath + ext, { force: true });

  let store = new Store(dbPath);
  let service = new CausalService(store);
  const imp = service.importData(demoInput, "persist");
  const built = service.build(imp.datasetId, imp.version);
  assert.equal(built.messages.find((m) => m.msgId === "m1")?.recvEventId, "b2");

  const cyclic: ImportInput = {
    participants: ["X"],
    events: [
      { id: "x1", participant: "X", seq: 1, type: "recv", msgId: "m" },
      { id: "x2", participant: "X", seq: 2, type: "send", msgId: "m", receiver: "X" },
    ],
  };
  const imp2 = service.importData(cyclic, "persist-bad");
  assert.throws(() => service.build(imp2.datasetId, imp2.version));
  const failed = store.getVersion(imp2.datasetId, imp2.version)!;
  assert.equal(failed.status, "failed");
  assert.equal(store.getBuildResult(imp2.datasetId, imp2.version), null);
  assert.ok(failed.error?.[0]?.cycle?.includes("x1"));
  store.close();

  store = new Store(dbPath);
  service = new CausalService(store);
  const report = service.report(imp.datasetId, imp.version);
  assert.equal(report.status, "computed");
  assert.equal(report.algoVersion, "vectorclock-1.0.0");
  assert.deepEqual(report.participantOrder, [
    { pos: 0, name: "A" },
    { pos: 1, name: "B" },
    { pos: 2, name: "C" },
  ]);
  const msg = report.messages.find((m) => m.msgId === "m2");
  assert.deepEqual([msg?.sendEventId, msg?.recvEventId], ["b3", "c2"]);
  const cmp = service.compare(imp.datasetId, "a2", "c2", imp.version);
  assert.equal(cmp.order, "before");
  store.close();

  for (const ext of ["", "-wal", "-shm"]) rmSync(dbPath + ext, { force: true });
});

test("修改输入形成新版本，旧向量按旧参与者顺序保留", () => {
  const dbPath = resolve("data/test-version.db");
  for (const ext of ["", "-wal", "-shm"]) rmSync(dbPath + ext, { force: true });
  const store = new Store(dbPath);
  const service = new CausalService(store);
  const i1 = service.importData(demoInput, "ver");
  service.build(i1.datasetId, i1.version);
  const changed: ImportInput = {
    participants: ["C", "B", "A"],
    events: demoInput.events,
  };
  const i2 = service.importData(changed, "ver");
  assert.equal(i2.version, 2);
  const r2 = service.build(i2.datasetId, i2.version);
  assert.deepEqual(r2.participants, ["C", "B", "A"]);
  const r1 = service.getResult(i1.datasetId, 1);
  assert.deepEqual(r1.participants, ["A", "B", "C"]);
  assert.deepEqual(r1.clocks.find((c) => c.eventId === "a1")?.clock, [1, 0, 0]);
  assert.deepEqual(r2.clocks.find((c) => c.eventId === "a1")?.clock, [0, 0, 1]);
  store.close();
  for (const ext of ["", "-wal", "-shm"]) rmSync(dbPath + ext, { force: true });
});
