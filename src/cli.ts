import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkCut, compareEvents, computeVectorClocks, reachabilityOrder } from './clock.js';
import { AppError } from './errors.js';
import { Store } from './storage.js';
import { demoInput, selfSendInput } from './demoData.js';
import { renderTable, vectorLabel } from './table.js';
import { validateInput } from './validate.js';

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Map<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, 'true');
      }
    } else {
      positional.push(token);
    }
  }
  return { command, positional, flags };
}

function defaultDbPath(): string {
  return process.env.VC_DB_PATH ?? resolve('data', 'vc.sqlite');
}

function loadInput(path?: string): unknown {
  if (!path) return demoInput();
  return JSON.parse(readFileSync(resolve(path), 'utf-8'));
}

function printEventsTable(order: string[], events: { id: string; participant: string; seq: number; type: string; vector: number[]; messageId: string | null; refSendId: string | null }[]): void {
  const rows = events.map((e) => [
    e.id,
    e.participant,
    String(e.seq),
    e.type,
    e.messageId ?? '-',
    e.refSendId ?? '-',
    vectorLabel(order, e.vector)
  ]);
  console.log(renderTable(['事件', '参与者', '序号', '类型', '消息', '引用发送', '向量时钟'], rows));
}

const HELP = `向量时钟因果关系与一致切片核验 — CLI

用法:
  node dist/src/cli.js <命令> [参数]

命令:
  import [--file <输入.json>]            导入事件、构建时钟并写入 SQLite（缺省使用内置演示数据）
  events [--version <id>]                列出事件与向量时钟
  get <事件编号> [--version <id>]        查询单个事件
  compare <事件A> <事件B> [--version <id>] 比较因果（before/after/concurrent/equal）
  reachability <A> <B> [--version <id>]  独立图可达性判定（交叉验证用）
  cut --prefixes '<JSON>' [--version <id>] 检查一致切片，例如 --prefixes "{\\"P1\\":2,\\"P2\\":1,\\"P3\\":0}"
  inflight [--version <id>]              查看在途消息与未投递发送
  report [--version <id>] [--out <文件>] 导出 JSON 报告
  versions                               列出所有版本（含失败版本）
  demo                                   完整演示（独立事件/收发因果/传递因果/无效切片/在途切片/自发自收）
  self-send                              同参与者自发自收演示
  help                                   显示本帮助

环境变量:
  VC_DB_PATH   SQLite 路径（默认 ./data/vc.sqlite）
`;

function withStore<T>(fn: (store: Store) => T): T {
  const store = new Store(defaultDbPath());
  try {
    return fn(store);
  } finally {
    store.close();
  }
}

function requireVersion(store: Store, flags: Map<string, string>): number {
  const raw = flags.get('version');
  if (raw !== undefined) {
    const id = Number(raw);
    const header = store.getVersionHeader(id);
    if (!header) throw new AppError('E_NOT_FOUND', `版本不存在: ${raw}`);
    if (header.status !== 'ok') {
      throw new AppError('E_VALIDATION', `版本 ${id} 是失败版本: ${header.errorMessage}`);
    }
    return id;
  }
  const latest = store.latestVersionId();
  if (latest === null) throw new AppError('E_NOT_FOUND', '数据库中尚无成功版本，请先执行 import');
  return latest;
}

export function runCli(argv: string[]): number {
  const args = parseArgs(argv);

  try {
    switch (args.command) {
      case 'help':
      case '--help':
      case '-h':
        console.log(HELP);
        return 0;

      case 'import': {
        const input = loadInput(args.flags.get('file'));
        return withStore((store) => {
          const result = store.importAndCompute(input);
          console.log(`已创建版本 ${result.versionId}，参与者顺序: ${result.participantOrder.join(', ')}，事件 ${result.events.length} 个`);
          printEventsTable(result.participantOrder, result.events);
          return 0;
        });
      }

      case 'events':
        return withStore((store) => {
          const id = requireVersion(store, args.flags);
          const header = store.getVersionHeader(id)!;
          printEventsTable(header.participantOrder, store.getEvents(id));
          return 0;
        });

      case 'get':
        return withStore((store) => {
          const eventId = args.positional[0];
          if (!eventId) throw new AppError('E_VALIDATION', '用法: get <事件编号>');
          const id = requireVersion(store, args.flags);
          const ev = store.getEvents(id).find((e) => e.id === eventId);
          if (!ev) throw new AppError('E_NOT_FOUND', `事件不存在: ${eventId}`);
          console.log(JSON.stringify(ev, null, 2));
          return 0;
        });

      case 'compare':
        return withStore((store) => {
          const [a, b] = args.positional;
          if (!a || !b) throw new AppError('E_VALIDATION', '用法: compare <事件A> <事件B>');
          const id = requireVersion(store, args.flags);
          const result = compareEvents(store.getEvents(id), a, b);
          const label: Record<string, string> = {
            before: `${a} 因果在前于 ${b}`,
            after: `${a} 因果在后于 ${b}`,
            concurrent: `${a} 与 ${b} 并发`,
            equal: `${a} 与 ${b} 向量相等（同一事件/同一时间戳）`
          };
          console.log(`${label[result.relation]}（${result.relation}）`);
          console.log(`  ${a}: [${result.vectorA.join(', ')}]`);
          console.log(`  ${b}: [${result.vectorB.join(', ')}]`);
          return 0;
        });

      case 'reachability':
        return withStore((store) => {
          const [a, b] = args.positional;
          if (!a || !b) throw new AppError('E_VALIDATION', '用法: reachability <A> <B>');
          const id = requireVersion(store, args.flags);
          const header = store.getVersionHeader(id)!;
          const relation = reachabilityOrder(header.participantOrder, store.getEvents(id) as never, a, b);
          console.log(`图可达性判定 ${a} vs ${b}: ${relation}`);
          return 0;
        });

      case 'cut':
        return withStore((store) => {
          const raw = args.flags.get('prefixes');
          if (!raw) throw new AppError('E_VALIDATION', '需要 --prefixes JSON 参数');
          let prefixes: unknown;
          try {
            prefixes = JSON.parse(raw);
          } catch {
            throw new AppError('E_VALIDATION', '--prefixes 不是合法 JSON');
          }
          const id = requireVersion(store, args.flags);
          const header = store.getVersionHeader(id)!;
          const result = checkCut(header.participantOrder, store.getEvents(id), prefixes);
          console.log(`切片判定: ${result.valid ? '有效（因果闭包成立）' : '无效（违反因果闭包）'}`);
          console.log(`前缀: ${header.participantOrder.map((p) => `${p}=${result.prefixes[p] ?? 0}`).join(', ')}`);
          if (result.violations.length > 0) {
            console.log('违反证据:');
            for (const v of result.violations) {
              console.log(`  - 接收 ${v.recvEventId} 已包含，但发送 ${v.missingSendEventId}（消息 ${v.messageId ?? '-'}）未包含`);
            }
          }
          if (result.inFlight.length > 0) {
            console.log('在途消息（不影响切片有效性）:');
            for (const m of result.inFlight) {
              console.log(`  - 消息 ${m.messageId ?? '-'}: ${m.from} 发送 ${m.sendEventId}，接收 ${m.recvEventId ?? '尚未投递'}`);
            }
          }
          return result.valid ? 0 : 2;
        });

      case 'inflight':
        return withStore((store) => {
          const id = requireVersion(store, args.flags);
          const events = store.getEvents(id);
          const sends = events.filter((e) => e.type === 'send');
          const rows = sends.map((s) => {
            const recv = events.find((r) => r.type === 'recv' && r.refSendId === s.id);
            return [s.messageId ?? '-', s.id, s.participant, s.to ?? '-', recv ? recv.id : '尚未投递'];
          });
          console.log(renderTable(['消息', '发送事件', '发送者', '接收者', '接收事件'], rows));
          return 0;
        });

      case 'report':
        return withStore((store) => {
          const id = requireVersion(store, args.flags);
          const report = store.getReport(id);
          if (!report) throw new AppError('E_NOT_FOUND', `版本 ${id} 无报告`);
          const json = JSON.stringify(report, null, 2);
          const out = args.flags.get('out');
          if (out) {
            writeFileSync(resolve(out), json, 'utf-8');
            console.log(`报告已导出到 ${out}`);
          } else {
            console.log(json);
          }
          return 0;
        });

      case 'versions':
        return withStore((store) => {
          const rows = store.listVersions().map((v) => [
            String(v.versionId),
            v.status,
            v.algorithmVersion,
            String(v.participantCount),
            String(v.eventCount),
            v.errorCode ?? '-',
            v.createdAt
          ]);
          console.log(renderTable(['版本', '状态', '算法版本', '参与者', '事件', '错误码', '创建时间(UTC)'], rows));
          return 0;
        });

      case 'demo':
        return runDemo();

      case 'self-send': {
        const { participantOrder, events } = validateInput(selfSendInput());
        const { events: computed } = computeVectorClocks(participantOrder, events);
        console.log('同参与者自发自收（接收序号必须在发送之后）:');
        printEventsTable(participantOrder, computed);
        return 0;
      }

      default:
        console.error(`未知命令: ${args.command}`);
        console.log(HELP);
        return 1;
    }
  } catch (err) {
    if (err instanceof AppError) {
      console.error(`错误 [${err.code}]: ${err.message}`);
      if (err.details) console.error(JSON.stringify(err.details));
      return 1;
    }
    console.error((err as Error).message);
    return 1;
  }
}

function runDemo(): number {
  const { participantOrder, events } = validateInput(demoInput());
  const { events: computed } = computeVectorClocks(participantOrder, events);

  console.log('=== 1. 事件与向量时钟（输入为乱序，结果与顺序无关） ===');
  console.log(`参与者固定顺序: ${participantOrder.join(', ')}`);
  printEventsTable(participantOrder, computed);

  console.log('\n=== 2. 互相独立的本地事件（并发） ===');
  console.log(JSON.stringify(compareEvents(computed, 'p1-1', 'p2-1')));
  console.log(JSON.stringify(compareEvents(computed, 'p1-1', 'p3-1')));

  console.log('\n=== 3. 一次发送接收后建立因果（p1-2 -> p2-2） ===');
  console.log(JSON.stringify(compareEvents(computed, 'p1-2', 'p2-2')));

  console.log('\n=== 4. 跨两条消息的传递关系（p1-1 -> p3-2 经由 m1,m2） ===');
  console.log(JSON.stringify(compareEvents(computed, 'p1-1', 'p3-2')));

  console.log('\n=== 5. 无效切片：P2 前缀包含接收 p2-2，却漏掉 P1 上的发送 p1-2 ===');
  const invalid = checkCut(participantOrder, computed, { P1: 1, P2: 2, P3: 0 });
  console.log(JSON.stringify(invalid, null, 2));

  console.log('\n=== 6. 有效切片但存在在途消息：P1 已发 m3（自发自收尚未接收） ===');
  const valid = checkCut(participantOrder, computed, { P1: 3, P2: 1, P3: 0 });
  console.log(JSON.stringify(valid, null, 2));
  return 0;
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`) {
  process.exit(runCli(process.argv.slice(2)));
}
