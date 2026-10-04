# 向量时钟因果关系与一致切片核验后端

离线分布式事件因果分析后端。给定**固定参与者集合**与一批事件（本地事件 / 发送 / 接收），
自行计算向量时钟、判定事件间因果关系、检查一致切片（一致全局检查点）并列出在途消息。

仅提供 **HTTP API 与 CLI**，无图形界面；不做实际消息传输、白板协作或数据同步；
不依据日志行序或墙钟时间推断因果。

技术栈：TypeScript + Node.js（内置 `node:sqlite` 与 `node:http`，无第三方运行时依赖，
无需 Docker / WSL / 在线服务）。SQLite 数据库位于项目内 `data/` 目录。

## 环境要求

- Windows 本地运行（也兼容其他平台）
- Node.js >= 22.5（开发与验证使用 Node v25；需支持内置 `node:sqlite`）
- npm

> 运行脚本带 `--experimental-sqlite` 标志，控制台会有一条 experimental 警告，属正常现象。

## 快速开始

```powershell
npm install        # 安装 TypeScript 与类型声明
npm run build      # 编译到 dist/
npm test           # 编译并运行全部测试
npm run demo       # 终端表演示（事件表 + 向量 + 因果 + 切片）
npm start          # 启动 HTTP 服务（默认由系统分配空闲端口，启动时打印实际端口）
```

指定端口或数据库路径：

```powershell
$env:PORT='8080'              # 默认 0 = 自动选择空闲端口
$env:VC_DB_PATH='data\vc.sqlite'
npm start
```

## 输入格式

```json
{
  "participants": ["P1", "P2", "P3"],
  "events": [
    { "id": "p1-2", "participant": "P1", "seq": 2, "type": "send", "messageId": "m1", "to": "P2" },
    { "id": "p2-2", "participant": "P2", "seq": 2, "type": "recv", "refSendId": "p1-2" }
  ]
}
```

- `participants`：参与者**固定顺序**，向量分量始终按该顺序解释。
- 事件字段：
  - `id`：全局唯一事件编号。
  - `participant`：事件所属参与者，必须在参与者集合中。
  - `seq`：该参与者内**从 1 开始的连续序号**，不得有缺口或重复。
  - `type`：`local` | `send` | `recv`。
  - 发送：`messageId`（全局唯一）+ `to`（接收者，允许等于发送者自身）。
  - 接收：`refSendId` 引用对应发送事件的 `id`。
- 事件在数组中的**全局顺序可以任意打乱**：处理顺序只由“参与者序号链 + 消息边”
  的稳定拓扑排序决定，不要求发送记录出现在接收之前。

## 向量时钟规则（算法版本 `vc-vector-clock-1.0.0`）

- 初始向量全零。
- 本地事件 / 发送：先把自身分量 +1，再记录时间戳。
- 接收：先与对应发送的时间戳**逐分量取最大值**，再把接收者自身分量 +1。
- 同一参与者支持自发自收，但若参与者顺序与消息依赖共同构成环，返回 `E_CYCLE`
  并给出实际事件环，不分配任何看似有效的时钟。
- 发送尚未被接收是**合法的未投递消息**，系统不会补造接收事件；无广播、无重传合并。

## 因果比较语义

对两个事件向量 `a`、`b`（同参与者顺序）：

- 逐分量 `a[i] <= b[i]` 且至少一个严格小：`before`（a 因果在前）。
- 反向：`after`。
- 两边各有更大分量：`concurrent`（并发）。
- 完全相等：`equal`。

另提供独立的**依赖图可达性**判定（不读取向量），用于与向量结果交叉验证。

## 一致切片检查

切片由各参与者包含的前缀长度描述，例如 `{"P1":2,"P2":1,"P3":0}` 表示
P1 前 2 个事件、P2 前 1 个事件、P3 空前缀。

- 若切片**包含一次接收却不包含其发送**，该 (接收, 发送) 事件对作为违反因果闭包的
  证据返回，切片判为无效。
- **发送已包含而接收尚未包含**属于在途消息（含完全未投递的孤立发送），单独列出，
  不会把切片误判为无效。

## HTTP API

除导入外，接口默认操作最新成功版本；可加 `?version=<id>` 指定版本。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/api/versions/import` | 导入事件、校验、构建时钟并冻结为新版本 |
| GET | `/api/versions` | 列出所有版本（含失败版本与错误码） |
| GET | `/api/versions/:id` | 查看版本头（参与者顺序、算法版本、状态） |
| GET | `/api/events?version=` | 查询事件与向量（可加 `&participant=P1`） |
| GET | `/api/events/:id?version=` | 查询单个事件 |
| POST | `/api/compare?version=` | 比较两事件因果，体：`{"a":"e1","b":"e2"}` |
| POST | `/api/cut/check?version=` | 一致切片检查，体：`{"prefixes":{...}}` |
| GET | `/api/messages/inflight?version=` | 未投递发送与（可选）切片内在途消息 |
| GET | `/api/report/export?version=` | 导出完整 JSON 报告 |
| POST | `/api/debug/validate` | 只校验不落库 |
| POST | `/api/debug/reachability?version=` | 独立图可达性判定 |

调用示例（PowerShell）：

```powershell
$body = Get-Content -Raw examples\demo.json
Invoke-RestMethod -Uri http://127.0.0.1:<端口>/api/versions/import -Method Post -ContentType 'application/json' -Body $body
Invoke-RestMethod -Uri http://127.0.0.1:<端口>/api/compare -Method Post -ContentType 'application/json' -Body '{"a":"p1-1","b":"p3-2"}'
Invoke-RestMethod -Uri http://127.0.0.1:<端口>/api/cut/check -Method Post -ContentType 'application/json' -Body '{"prefixes":{"P1":1,"P2":2,"P3":0}}'
```

## CLI

```powershell
node --experimental-sqlite dist/src/cli.js import --file examples\demo.json
node --experimental-sqlite dist/src/cli.js events
node --experimental-sqlite dist/src/cli.js get p2-2
node --experimental-sqlite dist/src/cli.js compare p1-1 p3-2
node --experimental-sqlite dist/src/cli.js reachability p1-1 p2-1
node --experimental-sqlite dist/src/cli.js cut --prefixes '{\"P1\":1,\"P2\":2,\"P3\":0}'
node --experimental-sqlite dist/src/cli.js inflight
node --experimental-sqlite dist/src/cli.js report --out report.json
node --experimental-sqlite dist/src/cli.js versions
node --experimental-sqlite dist/src/cli.js demo
```

`cut` 命令：切片有效退出码 0，无效退出码 2，参数错误退出码 1。

## 错误码

| 错误码 | 含义 | HTTP 状态 |
| --- | --- | --- |
| `E_BAD_REQUEST` | 请求体不是合法 JSON 等 | 400 |
| `E_VALIDATION` | 字段校验失败 / 失败版本被查询 | 422 |
| `E_DUPLICATE_ID` | 事件或消息编号重复 | 422 |
| `E_UNKNOWN_PARTICIPANT` | 参与者不在固定集合中 | 422 |
| `E_SEQ_GAP` | 参与者内序号不连续（缺口/重复） | 422 |
| `E_RECV_MISMATCH` | 接收事件参与者与发送指定接收者不符 | 422 |
| `E_DUPLICATE_RECV` | 同一发送被多个接收引用 | 422 |
| `E_MISSING_SEND` | 接收引用的发送不存在或不是发送事件 | 422 |
| `E_CYCLE` | 依赖成环，响应体含事件环证据 | 422 |
| `E_LIMIT_EXCEEDED` | 超过参与者/事件/请求体上限 | 413 |
| `E_NOT_FOUND` | 版本、事件或路由不存在 | 404 |
| `E_INTERNAL` | 服务器内部错误 | 500 |

## 限额

- 参与者最多 64；事件最多 10000；单次返回事件最多 1000；请求体上限 5 MB。
- 限额集中在 `src/errors.ts` 的 `LIMITS`，可按需调整。

## 持久化与版本冻结

- SQLite 表：`versions`（参与者顺序、原始输入 JSON、算法版本、状态、错误信息）、
  `events`（原事件）、`vectors`（结果向量）、`edges`（序号链 / 消息依赖边）。
- 每次成功导入生成一个**不可变新版本**，冻结当时的参与者顺序与结果；
  修改输入（含改变参与者顺序）只会产生新版本，旧向量永远在旧顺序下解释，
  查询旧版本不受影响。
- 计算失败时事务回滚，不写入任何 `events/vectors/edges` 半成品；
  同时登记一条 `status=failed` 版本记录（错误码、消息、环证据），但失败版本
  不提供向量结果与报告。
- 重启进程后，旧报告与消息证据可直接从 SQLite 重新读出（有测试覆盖）。

## 演示数据说明

`npm run demo` 与 `examples/demo.json` 覆盖：

1. 三个参与者互相独立的本地事件（并发）。
2. 一次发送/接收建立因果（`p1-2 -> p2-2`）。
3. 跨两条消息的传递关系（`p1-1 -> p3-2`，经由 m1、m2）。
4. 无效切片：包含接收 `p2-2` 却漏掉发送 `p1-2`，返回该对证据。
5. 有效但存在在途消息的切片（m1 在途；m3 为 P1 自发自收、尚未投递）。
6. 同参与者自发自收（`cli.js self-send`）。

`examples/cycle.json` 是依赖成环的反例（A、B 互相要求先收到对方消息）。

## 测试

`npm test` 使用 Node 内置测试运行器，覆盖：

- 向量时钟规则、并发 / 因果 / 传递因果 / 相等判定。
- 小输入下向量比较与独立图可达性结论逐一对照。
- 全局输入重排（逆序、随机洗牌、编号排序）结果不变。
- 依赖成环（含事件环证据）、重复接收、孤立发送、同参与者事件、
  重复编号、未知参与者、序号缺口、接收者不符、找不到发送。
- 穷举小规模前缀组合（4×4×3 = 48 种）核对切片判定与参考定义一致。
- SQLite 持久化、重启后报告与消息证据可读、版本顺序冻结、
  失败版本不产生向量结果。
- HTTP API 全链路（导入、比较、切片、在途、报告、错误码）。

## 项目结构

```
src/
  types.ts      领域类型
  errors.ts     错误码、限额、算法版本
  validate.ts   输入归一化与校验
  graph.ts      依赖构建、稳定拓扑排序、环检测
  clock.ts      向量时钟、因果比较、切片检查、图可达性
  storage.ts    SQLite 版本/事件/向量/边持久化
  server.ts     HTTP API（node:http，默认空闲端口）
  cli.ts        命令行
  demo.ts       演示入口
  demoData.ts   演示数据
  table.ts      终端表格
test/           三组测试
examples/       demo.json / cycle.json
data/           SQLite 数据目录
```

## 已知限制与合理假设

- 向量值按事件总数上界存储为普通整数（JS 安全整数范围内）。
- 不实现真实网络、认证、分页游标；面向本地单机离线分析。
- 消息模型为严格的“一次发送至多一次接收”，无多播 / 重传 / 合并。
- 墙钟时间与输入数组位置一律不参与因果推断。
