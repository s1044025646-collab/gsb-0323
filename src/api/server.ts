import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Store } from "../db/store.js";
import { CausalService, ServiceError } from "../core/service.js";

export interface ApiContext {
  service: CausalService;
}

function send(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 5 * 1024 * 1024) {
      throw new ServiceError("LIMIT_EXCEEDED", "请求体超过 5MB 限制");
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ServiceError("BAD_REQUEST", "请求体不是合法 JSON");
  }
}

export function createApp(ctx: ApiContext): Server {
  const { service } = ctx;

  return createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    const handle = async () => {
      if (method === "GET" && path === "/health") {
        return send(res, 200, { ok: true, service: "vectorclock-causal-backend" });
      }
      if (method === "GET" && path === "/api/datasets") {
        return send(res, 200, { datasets: service.store.listDatasets() });
      }
      if (method === "POST" && path === "/api/import") {
        const body = (await readJson(req)) as { datasetId?: string };
        const datasetId = typeof body.datasetId === "string" ? body.datasetId : undefined;
        const r = service.importData(body, datasetId);
        return send(res, 201, { ...r, message: "已导入并冻结参与者顺序，尚未计算时钟，请调用 build" });
      }

      const buildMatch = path.match(/^\/api\/datasets\/([^/]+)\/versions\/(\d+)\/build$/)
        ?? path.match(/^\/api\/datasets\/([^/]+)\/build$/);
      if (method === "POST" && buildMatch) {
        const ds = decodeURIComponent(buildMatch[1]!);
        const ver = buildMatch[2] ? Number(buildMatch[2]) : undefined;
        const result = service.build(ds, ver);
        return send(res, 200, result);
      }

      const loc =
        path.match(/^\/api\/datasets\/([^/]+)\/versions\/(\d+)(\/.*)$/)
        ?? path.match(/^\/api\/datasets\/([^/]+)(\/.*)$/);
      if (loc) {
        const ds = decodeURIComponent(loc[1]!);
        const ver = loc.length === 4 && loc[2] !== undefined ? Number(loc[2]) : undefined;
        const rest = (loc.length === 4 ? loc[3] : loc[2])!;

        if (method === "GET" && rest === "/report") {
          return send(res, 200, service.report(ds, ver));
        }
        if (method === "GET" && rest === "/clocks") {
          const r = service.getResult(ds, ver);
          return send(res, 200, { participants: r.participants, algoVersion: r.algoVersion, clocks: r.clocks, messages: r.messages });
        }
        if (method === "GET" && rest === "/in-flight") {
          return send(res, 200, { inFlight: service.inFlight(ds, ver) });
        }
        let mm = rest.match(/^\/events\/([^/]+)$/);
        if (method === "GET" && mm) {
          return send(res, 200, service.getEvent(ds, decodeURIComponent(mm[1]!), ver));
        }
        mm = rest.match(/^\/compare\/([^/]+)\/([^/]+)$/);
        if (method === "GET" && mm) {
          return send(res, 200, service.compare(ds, decodeURIComponent(mm[1]!), decodeURIComponent(mm[2]!), ver));
        }
        if (method === "POST" && rest === "/slice") {
          const body = await readJson(req);
          return send(res, 200, service.slice(ds, body as never, ver));
        }
      }

      send(res, 404, { code: "NOT_FOUND", message: `没有匹配的路由: ${method} ${path}` });
    };

    handle().catch((err: unknown) => {
      if (err instanceof ServiceError) {
        const status =
          err.code === "NOT_FOUND" || err.code === "EVENT_NOT_COMPUTED" ? 404
          : err.code === "LIMIT_EXCEEDED" ? 413
          : err.code === "CYCLE_DETECTED" || err.code === "BUILD_FAILED" ? 422
          : 400;
        send(res, status, { code: err.code, message: err.message, details: err.details });
      } else {
        send(res, 500, { code: "BUILD_FAILED", message: (err as Error).message });
      }
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolveP, reject) => {
    const srv = createNetServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolveP(port));
    });
    srv.on("error", reject);
  });
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const portArg = process.argv.indexOf("--port");
  let port = portArg >= 0 ? Number(process.argv[portArg + 1]) : NaN;
  if (!Number.isInteger(port) || port <= 0) port = await freePort();
  const dbArg = process.argv.indexOf("--db");
  const dbPath = dbArg >= 0 ? process.argv[dbArg + 1]! : resolve("data/vectorclock.db");
  const store = new Store(dbPath);
  const server = createApp({ service: new CausalService(store) });
  server.listen(port, "127.0.0.1", () => {
    console.log(`向量时钟因果分析后端已启动: http://127.0.0.1:${port}`);
    console.log(`数据文件: ${dbPath}`);
    console.log("健康检查: GET /health");
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
