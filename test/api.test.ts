import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp, listen } from '../src/server.js';
import { Store } from '../src/storage.js';
import { demoInput } from '../src/demoData.js';

let dir: string;
let server: Server;
let port: number;
let store: Store;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vc-api-'));
  store = new Store(join(dir, 'api.sqlite'));
  server = createApp(store);
  ({ port } = await listen(server, 0));
});

after(async () => {
  server.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const json = await res.json();
  return { status: res.status, json };
}

describe('HTTP API', () => {
  it('健康检查', async () => {
    const { status, json } = await api('GET', '/health');
    assert.equal(status, 200);
    assert.equal(json.ok, true);
  });

  it('导入并构建时钟', async () => {
    const { status, json } = await api('POST', '/api/versions/import', demoInput());
    assert.equal(status, 201);
    assert.equal(json.versionId, 1);
    assert.equal(json.eventCount, 8);
  });

  it('成环返回 422 与事件环证据', async () => {
    const bad = {
      participants: ['A', 'B'],
      events: [
        { id: 'a1', participant: 'A', seq: 1, type: 'recv', refSendId: 'b2' },
        { id: 'a2', participant: 'A', seq: 2, type: 'send', messageId: 'm1', to: 'B' },
        { id: 'b1', participant: 'B', seq: 1, type: 'recv', refSendId: 'a2' },
        { id: 'b2', participant: 'B', seq: 2, type: 'send', messageId: 'm2', to: 'A' }
      ]
    };
    const { status, json } = await api('POST', '/api/versions/import', bad);
    assert.equal(status, 422);
    assert.equal(json.error.code, 'E_CYCLE');
    assert.ok(json.error.details.cycle.length >= 2);
    assert.ok(json.error.failedVersionId >= 1);
  });

  it('查询事件 / 比较 / 切片 / 在途 / 报告', async () => {
    const ev = await api('GET', '/api/events/p2-2');
    assert.deepEqual(ev.json.event.vector, [2, 2, 0]);

    const cmp = await api('POST', '/api/compare', { a: 'p1-1', b: 'p3-2' });
    assert.equal(cmp.json.relation, 'before');

    const badCut = await api('POST', '/api/cut/check', { prefixes: { P1: 1, P2: 2, P3: 0 } });
    assert.equal(badCut.json.valid, false);
    assert.equal(badCut.json.violations[0].missingSendEventId, 'p1-2');

    const goodCut = await api('POST', '/api/cut/check', { prefixes: { P1: 2, P2: 1, P3: 0 } });
    assert.equal(goodCut.json.valid, true);
    assert.ok(goodCut.json.inFlight.some((m: any) => m.messageId === 'm1'));

    const inflight = await api('GET', '/api/messages/inflight');
    assert.ok(inflight.json.unDelivered.some((m: any) => m.messageId === 'm3'));

    const report = await api('GET', '/api/report/export');
    assert.equal(report.json.eventCount, 8);
  });

  it('版本路由与失败版本隔离', async () => {
    const list = await api('GET', '/api/versions');
    assert.ok(list.json.versions.length >= 2);
    const failed = list.json.versions.find((v: any) => v.status === 'failed');
    const denied = await api('GET', `/api/events?version=${failed.versionId}`);
    assert.equal(denied.status, 422);
  });

  it('非法 JSON 与未知路由', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/versions/import`, {
      method: 'POST',
      body: 'not-json',
      headers: { 'Content-Type': 'application/json' }
    });
    assert.equal(res.status, 400);
    const nf = await api('GET', '/nope');
    assert.equal(nf.status, 404);
  });
});
