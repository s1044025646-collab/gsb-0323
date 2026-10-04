import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { checkCut, compareEvents } from './clock.js';
import { AppError, ErrorCodes, LIMITS } from './errors.js';
import { Store } from './storage.js';
import { reachabilityOrder } from './clock.js';
import { validateInput } from './validate.js';

interface Json {
  [key: string]: unknown;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) {
        reject(new AppError(ErrorCodes.LIMIT_EXCEEDED, '请求体超过 5MB 限制'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8');
      if (text.length === 0) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(text));
      } catch {
        reject(new AppError(ErrorCodes.BAD_REQUEST, '请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function errorStatus(code: string): number {
  switch (code) {
    case ErrorCodes.NOT_FOUND:
      return 404;
    case ErrorCodes.LIMIT_EXCEEDED:
      return 413;
    case ErrorCodes.CYCLE:
      return 422;
    case ErrorCodes.BAD_REQUEST:
      return 400;
    default:
      return 422;
  }
}

export function createApp(store: Store): Server {
  const resolveVersion = (url: URL): number => {
    const raw = url.searchParams.get('version');
    if (raw !== null) {
      const id = Number(raw);
      if (!Number.isInteger(id) || id < 1) {
        throw new AppError(ErrorCodes.VALIDATION, 'version 查询参数必须是正整数');
      }
      const header = store.getVersionHeader(id);
      if (!header) throw new AppError(ErrorCodes.NOT_FOUND, `版本不存在: ${id}`);
      if (header.status !== 'ok') {
        throw new AppError(
          ErrorCodes.VALIDATION,
          `版本 ${id} 是失败版本，无完整结果（错误 ${header.errorCode}: ${header.errorMessage}）`,
          header.errorDetails
        );
      }
      return id;
    }
    const latest = store.latestVersionId();
    if (latest === null) {
      throw new AppError(ErrorCodes.NOT_FOUND, '尚无成功版本，请先 POST /api/versions/import');
    }
    return latest;
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const method = req.method ?? 'GET';

      if (method === 'GET' && (path === '/' || path === '/health')) {
        sendJson(res, 200, { ok: true, service: 'vc-causal-backend' });
        return;
      }

      if (method === 'POST' && path === '/api/versions/import') {
        const body = (await readJson(req)) as Json;
        try {
          const result = store.importAndCompute(body);
          sendJson(res, 201, {
            versionId: result.versionId,
            participantOrder: result.participantOrder,
            eventCount: result.events.length,
            events: result.events.slice(0, LIMITS.MAX_RETURN_ROWS)
          });
        } catch (err) {
          if (err instanceof AppError) {
            const failureId = store.recordFailure(body, err.code, err.message, err.details);
            sendJson(res, errorStatus(err.code), {
              error: { code: err.code, message: err.message, details: err.details ?? null, failedVersionId: failureId }
            });
            return;
          }
          throw err;
        }
        return;
      }

      if (method === 'GET' && path === '/api/versions') {
        sendJson(res, 200, { versions: store.listVersions() });
        return;
      }

      const versionMatch = path.match(/^\/api\/versions\/(\d+)$/);
      if (method === 'GET' && versionMatch) {
        const id = Number(versionMatch[1]);
        const header = store.getVersionHeader(id);
        if (!header) throw new AppError(ErrorCodes.NOT_FOUND, `版本不存在: ${id}`);
        sendJson(res, 200, header);
        return;
      }

      if (method === 'GET' && path === '/api/events') {
        const versionId = resolveVersion(url);
        const events = store.getEvents(versionId).slice(0, LIMITS.MAX_RETURN_ROWS);
        const participant = url.searchParams.get('participant');
        const filtered = participant
          ? events.filter((e) => e.participant === participant)
          : events;
        sendJson(res, 200, { versionId, events: filtered });
        return;
      }

      const eventMatch = path.match(/^\/api\/events\/([^/]+)$/);
      if (method === 'GET' && eventMatch) {
        const versionId = resolveVersion(url);
        const ev = store.getEvents(versionId).find((e) => e.id === decodeURIComponent(eventMatch[1]!));
        if (!ev) throw new AppError(ErrorCodes.NOT_FOUND, `事件不存在: ${eventMatch[1]}`);
        sendJson(res, 200, { versionId, event: ev });
        return;
      }

      if (method === 'POST' && path === '/api/compare') {
        const versionId = resolveVersion(url);
        const body = (await readJson(req)) as Json;
        if (typeof body.a !== 'string' || typeof body.b !== 'string') {
          throw new AppError(ErrorCodes.VALIDATION, '请求体需要字符串字段 a 与 b（事件编号）');
        }
        const events = store.getEvents(versionId);
        const result = compareEvents(events, body.a, body.b);
        sendJson(res, 200, { versionId, ...result });
        return;
      }

      if (method === 'POST' && path === '/api/cut/check') {
        const versionId = resolveVersion(url);
        const body = (await readJson(req)) as Json;
        const events = store.getEvents(versionId);
        const header = store.getVersionHeader(versionId)!;
        const result = checkCut(header.participantOrder, events, body.prefixes);
        sendJson(res, 200, { versionId, ...result });
        return;
      }

      if (method === 'GET' && path === '/api/messages/inflight') {
        const versionId = resolveVersion(url);
        const events = store.getEvents(versionId);
        const header = store.getVersionHeader(versionId)!;
        // 以全空前缀计算“尚未被接收”与“发送/接收对”；同时支持给前缀看切片内在途
        const emptyPrefixes = Object.fromEntries(header.participantOrder.map((p) => [p, 0]));
        const prefixes =
          url.searchParams.get('cut') === '1'
            ? (() => {
                const raw = url.searchParams.get('prefixes');
                return raw ? JSON.parse(raw) : emptyPrefixes;
              })()
            : emptyPrefixes;
        const result = checkCut(header.participantOrder, events, prefixes);
        sendJson(res, 200, {
          versionId,
          unDelivered: events
            .filter(
              (e) => e.type === 'send' && !events.some((r) => r.type === 'recv' && r.refSendId === e.id)
            )
            .map((e) => ({
              messageId: e.messageId,
              sendEventId: e.id,
              from: e.participant,
              to: e.to
            })),
          inFlightInCut: result.inFlight
        });
        return;
      }

      if (method === 'GET' && path === '/api/report/export') {
        const versionId = resolveVersion(url);
        const report = store.getReport(versionId);
        if (!report) throw new AppError(ErrorCodes.NOT_FOUND, `版本 ${versionId} 无报告（可能是失败版本）`);
        sendJson(res, 200, report);
        return;
      }

      if (method === 'POST' && path === '/api/debug/validate') {
        // 只校验不落库，便于排错
        const body = (await readJson(req)) as Json;
        const result = validateInput(body);
        sendJson(res, 200, {
          participantOrder: result.participantOrder,
          eventCount: result.events.length
        });
        return;
      }

      if (method === 'POST' && path === '/api/debug/reachability') {
        const versionId = resolveVersion(url);
        const body = (await readJson(req)) as Json;
        if (typeof body.a !== 'string' || typeof body.b !== 'string') {
          throw new AppError(ErrorCodes.VALIDATION, '请求体需要字符串字段 a 与 b');
        }
        const header = store.getVersionHeader(versionId)!;
        const events = store.getEvents(versionId);
        // reachability 需要 NormalizedEvent，ComputedEvent 结构兼容
        const relation = reachabilityOrder(header.participantOrder, events as never, body.a, body.b);
        sendJson(res, 200, { versionId, a: body.a, b: body.b, relation, method: 'graph-reachability' });
        return;
      }

      sendJson(res, 404, { error: { code: ErrorCodes.NOT_FOUND, message: `无此路由: ${method} ${path}` } });
    } catch (err) {
      if (err instanceof AppError) {
        sendJson(res, errorStatus(err.code), {
          error: { code: err.code, message: err.message, details: err.details ?? null }
        });
        return;
      }
      sendJson(res, 500, {
        error: { code: ErrorCodes.INTERNAL, message: (err as Error).message }
      });
    }
  });

  return server;
}

/** 在 0 或指定端口上监听；端口 0（默认）由操作系统分配空闲端口。 */
export function listen(server: Server, preferredPort: number): Promise<{ port: number }> {
  return new Promise((promiseResolve, reject) => {
    server.once('error', reject);
    server.listen(preferredPort, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        promiseResolve({ port: addr.port });
      } else {
        reject(new Error('无法获取监听端口'));
      }
    });
  });
}

async function main(): Promise<void> {
  const dbPath = process.env.VC_DB_PATH ?? resolve('data', 'vc.sqlite');
  const portArg = Number(process.env.PORT ?? '0');
  const port = Number.isInteger(portArg) && portArg >= 0 && portArg <= 65535 ? portArg : 0;
  const store = new Store(dbPath);
  const server = createApp(store);
  const { port: actual } = await listen(server, port);
  console.log(`向量时钟因果分析后端已启动`);
  console.log(`监听地址: http://127.0.0.1:${actual}`);
  console.log(`数据库:   ${store.dbPath}`);
  console.log(`提示: 默认选择空闲端口；可用环境变量 PORT=8080 指定，VC_DB_PATH 指定数据库路径`);
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
