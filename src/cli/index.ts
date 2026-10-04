#!/usr/bin/env node
import { readFileSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Store } from "../db/store.js";
import { CausalService, ServiceError } from "../core/service.js";
import { enumerateSlices } from "../core/engine.js";
import { demoInput, invalidSliceInput, inFlightSliceInput } from "../../examples/demo-data.js";
import type { BuildResult, SliceResult } from "../types.js";

const DEFAULT_DB = resolve("data/vectorclock.db");

function parseFlags(argv: string[]) {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags[a.slice(2)] = next;
        i++;
      } else flags[a.slice(2)] = "true";
    } else positional.push(a);
  }
  return { flags, positional };
}

function vec(v: number[]): string {
  return "(" + v.join(", ") + ")";
}

function printClocks(result: BuildResult) {
  console.log(`参与者顺序（向量分量顺序）: ${result.participants.map((p, i) => `[${i}]${p}`).join("  ")}`);
  console.log("事件编号 | 参与者 | 序号 | 类型 | 消息 | 向量时钟");
  console.log("-".repeat(72));
  for (const c of result.clocks) {
    console.log(
      [
        c.eventId.padEnd(7),
        c.participant.padEnd(4),
        String(c.seq).padEnd(4),
        c.type.padEnd(4),
        (c.msgId ?? "-").padEnd(4),
        vec(c.clock),
      ].join(" | "),
    );
  }
  console.log("-".repeat(72));
  console.log("消息:");
  for (const m of result.messages) {
    console.log(
      `  ${m.msgId}: ${m.sendEventId}(${m.sender}) -> ${m.recvEventId ?? "（未投递）"}(${m.receiver})`,
    );
  }
}

function printSlice(s: SliceResult) {
  console.log(`前缀: ${JSON.stringify(s.prefixes)} => ${s.consistent ? "一致 ✓" : "不一致 ✗"}`);
  for (const v of s.violations) {
    console.log(
      `  违反因果闭包: 接收 ${v.recvEventId} 已包含，但发送 ${v.sendEventId}（消息 ${v.msgId}）未包含`,
    );
  }
  for (const f of s.inFlight) {
    console.log(`  在途消息（合法）: ${f.msgId} 由 ${f.sendEventId}(${f.sender}) 发往 ${f.receiver}，接收尚未包含`);
  }
}

function runDemo() {
  const dbPath = resolve("data/demo.db");
  for (const ext of ["", "-wal", "-shm"]) {
    if (existsSync(dbPath + ext)) rmSync(dbPath + ext);
  }
  const service = new CausalService(new Store(dbPath));

  console.log("========== 演示 1：三参与者向量时钟 ==========");
  console.log("场景：独立本地事件；m1 发送/接收建立因果；m2 跨消息传递因果");
  const imp = service.importData(demoInput, "demo");
  const result = service.build(imp.datasetId, imp.version);
  printClocks(result);

  console.log("\n========== 因果比较（附独立图可达性交叉核验） ==========");
  for (const [a, b] of [
    ["a1", "b1"],
    ["a2", "b2"],
    ["a3", "c1"],
    ["a1", "c1"],
    ["a3", "b3"],
  ] as [string, string][]) {
    const cmp = service.compare(imp.datasetId, a, b, imp.version);
    console.log(
      `  ${a} ${vec(cmp.a.clock)} vs ${b} ${vec(cmp.b.clock)} => ${cmp.order}；` +
        `图可达 a→b:${cmp.graphReachability.aReachesB} b→a:${cmp.graphReachability.bReachesA}`,
    );
  }

  console.log("\n========== 演示 2：无效切片（含接收漏发送） ==========");
  const imp2 = service.importData(invalidSliceInput, "demo-slice");
  const r2 = service.build(imp2.datasetId, imp2.version);
  const bad = service.slice(imp2.datasetId, { prefixes: { P: 0, Q: 1 } }, imp2.version);
  printSlice(bad);

  console.log("\n========== 演示 3：有效切片但存在在途消息 ==========");
  const good = service.slice(imp2.datasetId, { prefixes: { P: 2, Q: 0 } }, imp2.version);
  printSlice(good);
  const allInFlight = service.inFlight(imp2.datasetId, imp2.version);
  console.log("全局未投递消息:", JSON.stringify(allInFlight));

  console.log("\n========== 演示 4：穷举所有前缀组合的切片判定 ==========");
  const all = enumerateSlices(r2);
  const inconsistent = all.filter((s) => !s.consistent).length;
  console.log(`共 ${all.length} 个前缀组合，其中 ${inconsistent} 个不一致，${all.length - inconsistent} 个一致`);
  console.log("不一致组合示例:");
  all.filter((s) => !s.consistent).slice(0, 5).forEach(printSlice);

  console.log("\n========== 报告导出（持久化，重启后可读） ==========");
  console.log(JSON.stringify(service.report(imp.datasetId, imp.version), null, 2).slice(0, 1200) + "\n  ...");
  console.log(`\n演示数据库: ${dbPath}`);
  console.log("可用 `npm run cli -- report demo` 重新读取已存报告与消息证据。");
  service.store.close();
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "help";
  const { flags, positional } = parseFlags(argv.slice(1));
  const dbPath = flags.db ? resolve(flags.db) : DEFAULT_DB;

  if (cmd === "demo") return runDemo();
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(`用法: vcclock <命令> [参数] [--db 路径] [--version N]
  import <events.json> [--dataset ID]   导入事件并冻结参与者顺序
  build <datasetId>                      构建向量时钟
  events <datasetId>                     查看事件与向量表
  compare <datasetId> <a> <b>            比较两事件因果（含图可达性核验）
  slice <datasetId> --prefixes A:2,B:1   一致切片检查
  in-flight <datasetId>                  查看未投递/在途消息
  report <datasetId>                     导出完整 JSON 报告
  demo                                   运行内置演示
  help                                   显示本帮助`);
    return;
  }

  const service = new CausalService(new Store(dbPath));
  try {
    if (cmd === "import") {
      const file = positional[0];
      if (!file) throw new ServiceError("BAD_REQUEST", "缺少 events.json 路径");
      const raw = JSON.parse(readFileSync(resolve(file), "utf8"));
      const r = service.importData(raw, flags.dataset);
      console.log(JSON.stringify(r, null, 2));
    } else if (cmd === "build") {
      const r = service.build(positional[0]!, flags.version ? Number(flags.version) : undefined);
      printClocks(r);
    } else if (cmd === "events") {
      printClocks(service.getResult(positional[0]!, flags.version ? Number(flags.version) : undefined));
    } else if (cmd === "compare") {
      const r = service.compare(positional[0]!, positional[1]!, positional[2]!, flags.version ? Number(flags.version) : undefined);
      console.log(JSON.stringify(r, null, 2));
    } else if (cmd === "slice") {
      if (!flags.prefixes) throw new ServiceError("BAD_REQUEST", "需要 --prefixes A:2,B:1");
      const prefixes: Record<string, number> = {};
      for (const pair of flags.prefixes.split(",")) {
        const [k, n] = pair.split(":");
        prefixes[k!.trim()] = Number(n);
      }
      printSlice(service.slice(positional[0]!, { prefixes }, flags.version ? Number(flags.version) : undefined));
    } else if (cmd === "in-flight") {
      console.log(JSON.stringify(service.inFlight(positional[0]!, flags.version ? Number(flags.version) : undefined), null, 2));
    } else if (cmd === "report") {
      console.log(JSON.stringify(service.report(positional[0]!, flags.version ? Number(flags.version) : undefined), null, 2));
    } else {
      console.error(`未知命令: ${cmd}（运行 help 查看用法）`);
      process.exitCode = 2;
    }
  } catch (err) {
    if (err instanceof ServiceError) {
      console.error(`错误 [${err.code}]: ${err.message}`);
      if (err.details) console.error(JSON.stringify(err.details, null, 2));
      process.exitCode = 1;
    } else throw err;
  } finally {
    service.store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
