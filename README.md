# 向量时钟因果关系与一致切片核验后端

离线分布式事件因果分析后端。给定**固定参与者集合**与一批事件（本地 / 发送 / 接收），自行构建依赖图并计算[向量时钟](https://en.wikipedia.org/wiki/Vector_clock)，提供事件因果比较、一致切片检查、在途消息查询与报告导出。仅提供 HTTP API 与命令行（CLI），无图形界面、无消息传输、无在线服务。

- 语言/运行时：TypeScript + Node.js（建议 Node ≥ 22，本项目在 Node 25 上开发验证）
- 存储：内置 `node:sqlite`（Node 自带，**无需编译原生模块**），数据库文件位于项目内 `data/`
- 平台：Windows 本地直接运行；不依赖 Docker、WSL、付费服务或外部 API

## 因果模型

参与者顺序在导入时**冻结**，向量各分量始终按该顺序解释。

- 初始向量全零。
- 本地事件与发送：先把自身分量加 1，再记录时间戳。
- 接收：先与对应发送事件的时间戳**逐分量取最大值**，再把接收者自身分量加 1。
- 同一参与者的事件严格按其连续序号处理；每条消息建立“发送 → 接收”依赖。
- 输入事件列表可以全局打乱：系统先建立参与者序号与消息两类依赖，再以**稳定拓扑顺序**（候选事件按参与者位置、序号取最小）计算，结果与日志行序、墙钟时间无关。
- 支持自发自收，但接收序号必须在发送之后，否则与参与者顺序共同构成事件环。
- 已发送但未接收的消息是**合法的在途消息**，系统不会补造接收事件。

比较两事件向量 `a`、`b`：

| 条件 | 结果 |
| --- | --- |
| 各分量 `a ≤ b` 且至少一个严格小 | `before`（a 因果先于 b） |
| 各分量 `a ≥ b` 且至少一个严格大 | `after` |
| 两边各有分量更大 | `concurrent`（并发） |
| 完全相等 | `equal` |

一致切片：为每个参与者给出包含的前缀长度。若切片**包含一次接收却不包含其发送**，该消息对作为违反因果闭包的证据返回；**发送已包含而接收尚未包含属于在途消息，切片仍判定为一致**。

## 快速开始

```powershell
npm install
npm run demo     # 构建并运行内置演示（事件表 + 向量表 + 切片）
npm test         # 构建并运行全部测试
npm start        # 启动 HTTP 服务（默认自动选择空闲端口）
```

也可显式指定端口与数据库文件：

```powershell
node dist/src/api/server.js --port 8080 --db data/vectorclock.db
```

## CLI

先执行 `npm run build`。示例：

```powershell
node dist/src/cli/index.js import examples/sample-events.json
node dist/src/cli/index.js build  <datasetId>
node dist/src/cli/index.js events <datasetId>
node dist/src/cli/index.js compare <datasetId> a2 c2
node dist/src/cli/index.js slice  <datasetId> --prefixes A:2,B:1,C:0
node dist/src/cli/index.js in-flight <datasetId>
node dist/src/cli/index.js report <datasetId>
```

`--version N` 可访问历史版本，`--db 路径` 可换库。`demo` 使用的数据集 id 固定为 `demo` / `demo-slice`，因此可直接：

```powershell
npm run demo
node dist/src/cli/index.js report demo --db data/demo.db
```

## HTTP API

导入与计算分两步：导入只冻结原事件与参与者顺序，构建成功后才登记时钟结果；构建失败（如成环）不会写入任何向量，只登记失败原因。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| POST | `/api/import` | 导入事件；body 可带 `datasetId`，对已存在 id 导入形成新版本 |
| POST | `/api/datasets/:id/build` | 构建最新版本向量时钟 |
| POST | `/api/datasets/:id/versions/:n/build` | 构建指定版本 |
| GET | `/api/datasets/:id/report` | 完整报告（参与者顺序、时钟、消息、在途、算法版本） |
| GET | `/api/datasets/:id/clocks` | 事件向量表与消息表 |
| GET | `/api/datasets/:id/events/:eventId` | 单个事件 |
| GET | `/api/datasets/:id/compare/:a/:b` | 因果比较（含独立图可达性核验字段） |
| POST | `/api/datasets/:id/slice` | body：`{"prefixes":{"A":2,"B":1}}` |
| GET | `/api/datasets/:id/in-flight` | 从未被接收的消息 |
| GET | `/api/datasets` | 数据集列表 |

```powershell
$body = Get-Content -Raw examples/sample-events.json
$imp  = Invoke-RestMethod http://127.0.0.1:8080/api/import -Method Post -ContentType 'application/json; charset=utf-8' -Body $body
Invoke-RestMethod "http://127.0.0.1:8080/api/datasets/$($imp.datasetId)/build" -Method Post
```

错误响应统一为 `{ code, message, details }`，HTTP 状态码：400 校验错误、404 不存在、413 超规模、422 构建失败（成环）。

## 输入格式与错误码

```json
{
  "participants": ["A", "B", "C"],
  "events": [
    { "id": "a1", "participant": "A", "seq": 1, "type": "local" },
    { "id": "a2", "participant": "A", "seq": 2, "type": "send", "msgId": "m1", "receiver": "B" },
    { "id": "b2", "participant": "B", "seq": 2, "type": "recv", "msgId": "m1" }
  ]
}
```

校验错误码：`PARTICIPANTS_EMPTY`、`PARTICIPANT_DUPLICATE`、`EVENT_ID_DUPLICATE`、`EVENT_ID_EMPTY`、`SEQ_INVALID`、`SEQ_GAP`、`SEQ_DUPLICATE`、`UNKNOWN_PARTICIPANT`、`UNKNOWN_RECEIVER`、`SEND_FIELDS_MISSING`、`RECV_FIELDS_MISSING`、`LOCAL_FIELDS_FORBIDDEN`、`MSG_ID_DUPLICATE_SEND`、`SEND_NOT_FOUND`、`RECV_RECEIVER_MISMATCH`、`MSG_ALREADY_RECEIVED`、`CYCLE_DETECTED`（携带实际事件环 `cycle`）、`SLICE_OUT_OF_RANGE`、`LIMIT_EXCEEDED`。

规模上限（`src/core/limits.ts`）：参与者 64、事件 10000、单次返回 2000 行、请求体 5MB。算法版本固定为 `vectorclock-1.0.0`。

## 版本化

SQLite 表 `datasets / versions / participant_order / clocks / messages` 持久化：冻结的参与者顺序、原事件 JSON、算法版本、时钟结果与消息证据。对同一 `datasetId` 再次导入会新增版本；旧向量仍按旧参与者顺序读取，新版本的向量按新顺序解释，二者不混用。重启后可直接读取旧报告与消息证据。

## 测试

`npm test` 覆盖：三参与者演示场景、用**独立图可达性**对全部事件对交叉核验向量比较、全局输入 8 种重排结果不变、依赖成环（含环路径）、重复接收、孤立发送、自发自收、穷举全部前缀组合的切片判定、失败不登记完整结果、重启后报告/消息证据可读、以及参与者顺序改变的新版本隔离。

## 已验证结果与限制

- `npm run build` 通过；`npm test` 9 个用例全部通过；CLI `demo` 与上述 HTTP API 均在 Windows 实测通过。
- 限制：单机离线分析工具，不做鉴权与多用户并发控制；规模为教学/审计级别（见上限）；`node:sqlite` 在当前 Node 版本会打印一次实验性警告，不影响功能；本项目不实现广播、消息重传合并等规则——每条消息恰好一次发送、至多一次接收。
