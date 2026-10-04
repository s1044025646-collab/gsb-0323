import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/storage.js';
import { demoInput, selfSendInput } from '../src/demoData.js';
import { AppError } from '../src/errors.js';

let dir: string;
let dbPath: string;
let store: Store;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'vc-test-'));
  dbPath = join(dir, 'test.sqlite');
  store = new Store(dbPath);
});
after(() => {
  try {
    store.close();
  } catch {
    // 最后一个用例可能已关闭
  }
  for (let i = 0; i < 5; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
});

describe('SQLite 持久化与重启', () => {
  it('导入成功版本并持久化向量', () => {
    const result = store.importAndCompute(demoInput());
    assert.equal(result.versionId, 1);
    assert.equal(result.events.length, 8);
  });

  it('重新打开数据库后原报告与消息证据可读', () => {
    store.close();
    const reopened = new Store(dbPath);
    const report = reopened.getReport(1)!;
    assert.equal(report.eventCount, 8);
    assert.deepEqual(report.participants, ['P1', 'P2', 'P3']);
    const recv = report.events.find((e) => e.id === 'p2-2')!;
    assert.deepEqual(recv.vector, [2, 2, 0]);
    assert.equal(recv.refSendId, 'p1-2');
    const versions = reopened.listVersions();
    assert.equal(versions[0]!.status, 'ok');
    reopened.close();
  });

  it('修改输入形成新版本，旧版本顺序冻结保留', () => {
    const s = new Store(dbPath);
    const result = s.importAndCompute(selfSendInput());
    assert.equal(result.versionId, 2);
    assert.deepEqual(s.getReport(1)!.participants, ['P1', 'P2', 'P3']);
    assert.deepEqual(s.getReport(2)!.participants, ['A']);
    s.close();
  });

  it('计算失败登记失败版本，但没有任何向量结果', () => {
    const s = new Store(dbPath);
    const bad = {
      participants: ['A', 'B'],
      events: [
        { id: 'a1', participant: 'A', seq: 1, type: 'recv', refSendId: 'b2' },
        { id: 'a2', participant: 'A', seq: 2, type: 'send', messageId: 'm1', to: 'B' },
        { id: 'b1', participant: 'B', seq: 1, type: 'recv', refSendId: 'a2' },
        { id: 'b2', participant: 'B', seq: 2, type: 'send', messageId: 'm2', to: 'A' }
      ]
    };
    assert.throws(() => s.importAndCompute(bad), (e: AppError) => e.code === 'E_CYCLE');
    const okVersions = s.listVersions().filter((v) => v.status === 'ok');
    assert.equal(okVersions.length, 2);
    assert.equal(s.getReport(1)!.eventCount, 8);

    let failedId = 0;
    try {
      s.importAndCompute(bad);
    } catch (e) {
      failedId = s.recordFailure(bad, (e as AppError).code, (e as Error).message, (e as AppError).details);
    }
    assert.ok(failedId >= 3);
    assert.equal(s.getReport(failedId), null);
    const header = s.getVersionHeader(failedId)!;
    assert.equal(header.status, 'failed');
    assert.equal(header.errorCode, 'E_CYCLE');
    s.close();
  });
});
