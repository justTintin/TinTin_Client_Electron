# 客户端集成 DeepSeek Harness · 具体实现方案

> 状态：📋 实现方案（P0 待执行，过闸后投 P1）｜ 裁决：2026-09-12，用户确认「整体结论为客户端实现 harness」
> 关联：`docs/剪映互通整体方案_2026-09-12.md`（纯逻辑层直接搬运）、`docs/工程规范铁律.md`（全任务门禁）
> 事实基线：dsh-desktop 0.1.1（`D:\Project\dsh-desktop`，锁 `@deepseek-ai/dsh@0.1.2-rc.1`，251 个 vendored tarball，23 个上游 patch）；本文所有 API 均已在该仓库实读验证（文件:行号随文标注）

---

## 0. 裁决摘要

harness 集成在**客户端（本地）**：以 dsh-desktop 为壳（agent 工作台 + 更新/恢复/安全模式治理），TinTin 现有功能以 bundle 插件挂入；**服务端只出算力**——FastAPI（合成/声音克隆/花字）与 LLM 代理位置不变，harness 的工具只是多一层 HTTP 包装。服务端 harness 仅在 P0 失败或短期急需时作垫档（2~3 周，工具包装成果可复用）。

## 1. 目标架构

```
dsh-desktop 壳（fork 为 TinTin shell）          ← 窗口/启动流/更新器/恢复向导/Safe Mode（上游自带）
└─ deepseek-harness（本地子进程，自带 Node 24，127.0.0.1:43129）
   ├─ harness Web UI = agent 工作台（会话/审批/技能/任务——上游自带）
   ├─ TinTin bundle 插件（本项目新增，npm 包形态）
   │   ├─ Host 侧（Cordis 插件，harness 进程内，有本机全部权限）
   │   │   ├─ 本地工具：ffmpeg 轻操作 / 剪映草稿导出 / 预设读取 / 素材文件管理
   │   │   ├─ 远程工具：FastAPI 包装（/montage/concat、/voice/*、/fancy/*、/text_templates/*）
   │   │   ├─ webServer 路由：/tintin/ipc/*（桥）、/tintin/jobs/*（进度）
   │   │   └─ （P2）defineTool 注册 → agent 可编排
   │   └─ Client 侧（client module，web renderer）
   │       ├─ 薄 React 壳 mount 现有 Vue 视图（兼容路线）
   │       └─ window.tintin polyfill（现有 preload 桥 → 路由/事件）
   └─ model provider → TinTin 服务端 LLM 代理（key 不落客户端）
TinTin 服务端（FastAPI）：不改动；后续可选加无人值守 harness
```

---

## 2. P0 骨架验证（闸门，5~8 人日）

> 目的：用最小代码验证「第三方 bundle 从打包→注入→host 路由→UI 注入→进度」全链路 + 上游锁定成本评估。**过闸才投 P1。**

### P0-1 本地构建 dsh-desktop（0.5d）

```bash
cd D:\Project\dsh-desktop
npm install          # postinstall: patch-package + brand-assets + install-electron
npm run dev          # electron-vite dev；harness 用 dev 端口 43130
```
验收：壳启动 → harness 子进程就绪（stdout 抓到 `dsh web: ...?token=`）→ 工作台 UI 可用。
**fork 策略**：dsh-desktop 整仓 fork 为 `TinTin-Shell`，上游同步用 git remote 追踪；品牌资产替换走其自带 `scripts/install-brand-assets.mjs` 机制（postinstall 已挂）。

### P0-2 创建 tintin-bundle 插件包（1d）

目录（放在 `dsh-desktop/packages/tintin-bundle/`，与 market-installer 同层）：

```
tintin-bundle/
├── package.json
├── index.js        # Host 侧：Cordis 插件 + webServer 路由
└── client.js       # Client 侧：模块加载 + UI slot 占位
```

`package.json`（字段对照 `packages/dsh-desktop-market-installer/package.json` 实文）：

```json
{
  "name": "tintin-bundle",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./index.js",
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "dsh": { "client": { "inject": [], "platform": "web" } },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-host-webserver": "^0.1.2-rc.1"
  }
}
```

`index.js`（Host 骨架；API 对照 market-installer `index.js:789 apply / 969-1060 路由注册` 实文）：

```js
export const name = 'tintin-bundle'
export const inject = []

const PING_PATH = '/tintin/ping'

export async function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => webCtx.effect(() => {
    const disposePing = webCtx.webServer.register({
      kind: 'exact',
      path: PING_PATH,
      handler: async (req, res) => {
        // 移植 isTrustedRequest 校验（对照 market-installer index.js:158）
        sendJson(res, 200, { ok: true, plugin: name, pid: process.pid, time: Date.now() })
      },
    })
    return async () => disposePing()
  }, 'tintin-bundle: ping route'))
  ctx.logger.info('tintin-bundle host ready')
}

function sendJson(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
```

`client.js`（Client 骨架；对照 `market-installer/client.js` 的 `__ModuleLoader__` 实文）：

```js
window.__ModuleLoader__.load({
  id: 'tintin-bundle',
  factory: (require) => {
    const React = require('react')
    // P0-5 勘察后替换为真实 slot 注入：ctx.slots.inject('<slot-id>', ...)
    // 先以 console + 设置页占位验证加载与路由回读
    fetch('/tintin/ping').then((r) => r.json()).then(
      (j) => console.info('[tintin] host ping ok', j),
      (e) => console.error('[tintin] host ping fail', e),
    )
  },
})
```

### P0-3 注入 profile（0.5d，两条路都验）

- **开发路（改壳）**：`build/dsh-desktop.patch.yml` 追加 `- insert: {id: tintin-bundle, name: tintin-bundle}`（对照现文件 ui-brand/ppt-composer 行式），并把包加入壳依赖闭包（`file:packages/tintin-bundle`）。
- **安装路（用户形态）**：打成 tarball 后 `dsh plugin --profile web install ./tintin-bundle-0.1.0.tgz`（走 generation 注册表 + pnpm shim——这是第三方插件的真实路径，必须验通）。

### P0-4 验证清单（2~3d，逐项过、留痕到日志）

| # | 验证点 | 通过标准 |
|---|---|---|
| V1 | 插件加载 | harness 启动日志出现 `tintin-bundle host ready`，无 Cordis 加载错误 |
| V2 | Host 路由 | 浏览器/工作台内 `GET /tintin/ping` 返回 200 JSON |
| V3 | Client module | 工作台 renderer console 出现 `[tintin] host ping ok`（证明 UI 侧模块加载 + 同源 fetch 通） |
| V4 | UI slot 注入 | 勘察可用 slot 清单（`ctx.slots.inject`；已知 `settings.plugins.tab`；**必须找到大面积/主界面级 slot**），注入一个可见面板 |
| V5 | 本地文件写入 | host 插件内 `fs.writeFile` 写 `%LOCALAPPDATA%` 临时文件成功（证明 host 进程可触碰本地资源——剪映/素材的前提） |
| V6 | 外部进程 | host 插件 `spawn` 本机 ffmpeg.exe（复用现有 `resources/bin/win`）成功返回版本号 |
| V7 | 进度通道 | 参照 installer「POST 返 202 + GET status 轮询」模式建 `/tintin/jobs/:id/status`，client 侧轮询到状态翻转（SSE/WS 留 P1 增强） |
| V8 | 锁定评估 | 记录 `0.1.2-rc.1` 构建可复现性、`patches/` 23 个补丁与我们的冲突面、`pnpm patch` 升级演练一次 |

### P0 判定

- **过闸**：V1~V7 全过 → 投 P1；V4 若无大面积 slot，则 P1 UI 形态降级为「设置页多 tab + 独立窗口（shell 另开 BrowserWindow 加载插件路由页）」再评估。
- **不过闸**（路由缝不可用/锁定成本爆炸）→ 启用垫档：服务端 harness headless（2~3 周），客户端保持现状。

---

## 3. P1 旗舰链路（30~45 人日）：智能混剪在工作台内全流程可用

### 3.1 `window.tintin` polyfill 桥（10~15d）

现有渲染层全部经 `window.tintin.server.*` / `window.tintin.shell.*` 调主进程。桥的原则：**渲染层代码零改动**，polyfill 在 client module 里按同签名重建。通道映射（全部走 host 路由，同源 fetch）：

| 现有 preload API（例） | 类别 | polyfill 实现 |
|---|---|---|
| `finalMix` / `jianyingExport` / `voiceDubVideos` / `fancyListTemplates` / `finalFindSrt` / `finalListResults` / `bgmDownloadUrl` … | invoke | `POST /tintin/ipc/<channel>` body=payload → host 路由分发到移植后的逻辑模块，返回 `{result\|error}` |
| `fancyOnPreviewProgress` / `finalOnProgress`（事件订阅） | 进度 | 长任务改 **jobId 模式**：invoke 返 `{jobId}` → client 轮询 `GET /tintin/jobs/:id`（P0-V7 通道）；SSE 作 P1 后期增强 |
| `shell.openItem` | shell | `POST /tintin/shell/open`（host 侧 `child_process.exec('explorer /select,...')`——host 进程有本机权限） |
| 目录/文件选择 | dialog | 复用 harness 目录选择器（desktop-host 已带 `dsh-host-directory-picker-native`，patch 注释实证 `ctx.directoryPicker` 服务存在） |
| `serverProxy` HTTP（调 FastAPI） | 网络 | 两条路任选：host 路由转发（保持同源），或 client 直连服务端 URL（工作台是 http origin，无 CSP 阻碍——P1 实测定） |

桥实现为一个约 300~500 行的 ES 模块，逐通道对照 `desktop/preload/preload.js` 移植；**接口契约以 `desktop/types/global.d.ts` 为准，不猜字段**（铁律 6）。

### 3.2 Host 侧逻辑移植（10~15d）

现有 `desktop/main` 模块按「纯逻辑直接搬、IPC 壳重写」拆解：

| 现有模块 | 搬运方式 |
|---|---|
| `jianying-exporter.js` / `voice-tts-logic.js` / `fancy-templates.js` / `montage-final-ipc.js` 中的 `serverComposeOne`/`buildSrtFromTiming`/`buildServerFxFields`/`probeMedia` | **原样搬**（纯逻辑 + node:fs/child_process，host 进程全具备；剪映互通方案 M1/M2 产物随做随搬） |
| `montage-final-ipc.js` 的 `final:mix` handler、`montage-voice-ipc.js` 的 handler 编排 | 改写为 host 路由处理器（`ipcMain.handle` → `webServer.register`），任务状态进 jobId 注册表 |
| `ffmpeg-gate` / `server-proxy.js` 的 httpRequest | 移植精简版（getBinDir 改读 env，见 3.3） |

### 3.3 ffmpeg 分发（2d）

host 是独立 Node 子进程，读不到 Electron `resourcesPath`。方案：fork 的壳在 `src/main/index.ts` `bootstrap()` 创建 `HarnessRuntime` 处向子进程注入 env `TINTIN_BIN_DIR=<resources>/bin/win`（源码可控，fork 点唯一）；host 侧 `getBinDir()` 改为 `process.env.TINTIN_BIN_DIR ?? 旧逻辑`。

### 3.4 Vue 视图挂载（10~15d，最大风险项）

- 兼容路线：client module 的 factory 里 `require` 私有打包的 Vue 子应用 chunk（Vue 打包进插件，不与宿主 React 冲突——宿主仅强制 React/`@deepseek-ai/*` 单例），在 slot 容器上 `createApp(MontageApp).mount(el)`。
- 现有渲染层需审计的隐式依赖：`window.tintin`（3.1 已桥）、`file:///` 本地预览 URL（视频预览 `<video src>` 改为 host 路由的媒体流或保留 file:// ——http 页面加载 file: 受限，**P1 首个技术验证点**：改走 `/tintin/media?path=` 路由由 host 读文件回传 Range 流）。
- 渐进策略：P1 只挂「智能混剪」单工具；其余工具 P2 逐个挂，不阻塞。

### 3.5 模型接入（1d → 已实测降级为配置项）

harness settings 配置自定义 model provider → `base_url` 指向 TinTin 服务端 LLM 代理；bundle 配置固化默认 provider，官方 key 不下发客户端。

**2026-09-12 实测结论（192.168.111.31:8000，服务端零改造即可接入）**：

| 端点 | 实测 |
|---|---|
| `POST /llm/chat/completions` | ✅ 200 / 0.75s，返回标准 OpenAI Chat Completion 结构（`choices[0].message.content` + usage），模型 `deepseek-v4-flash`（默认）/ `deepseek-v4-pro`（`GET /llm/models` 列表，max_tokens 384k） |
| `POST /v1/chat/completions` | ❌ 500/挂起（标准 OpenAI 路径当前损坏）——建议服务端修复（~0.5d），修好即兼容全部 OpenAI 生态工具 |
| `GET /v1/models` | ✅ 正常（whisper/clip/indextts/ollama qwen 系列清单） |

接入方式：harness provider `base_url = http://<server>/llm`（harness 拼 `<base_url>/chat/completions`），model id 填 `deepseek-v4-flash`，api_key 占位符（服务端当前不鉴权）。P0 验证项相应降级为「配置级」。

### 3.5a 模型选择与工具挂载机制（2026-09-12 讨论定案）

**模型选择（harness 自主判断，无需人工指定）**：
- 默认模型由 provider 配置指定（deepseek-v4-flash），日常会话/工具决策用它（实测 0.75s 完全够）
- 复杂任务可路由 deepseek-v4-pro；`/llm/models` 清单皆可映射
- **混剪流程的"判断"**是 agent 读任务描述 → 决定调用哪个工具/什么参数——对话模型即可；**选视频等视觉需求发生在工具内部**（工具调 FastAPI，服务端自路由 qwen-vl），harness 不感知

**工具挂载（三种方式，P2 选 bundle 原生工具）**：

| 方式 | 做法 | 取舍 |
|---|---|---|
| **bundle 原生工具（选定）** | TinTin bundle 里 `defineTool()` 注册，工具内部 HTTP 调 FastAPI | 无中间层；本地工具（剪映导出/ffmpeg）与远程工具（合成/配音）统一注册；随客户端分发 |
| MCP Server | 服务端 FastAPI 包 MCP 协议 | 仅当"外部 agent 驱动服务端"（无人值守/生态开放）需求出现时再做 |
| 混合 | 两者并存 | 远期 |

**关键认知**：`/montage/concat` 等接口今天就被 Vue 前端调用，harness 只是换了个调用者——**服务端不需要改造成 MCP**。混剪执行路径（示例）：

```
用户："把这批素材混剪成带货视频，成龙音色，导出剪映草稿"
1. montage_split → /montage/split
2. montage_plan → 排列
3. voice_clone/dub → /voice/*
4. montage_compose → /montage/concat
5. jianying_export → 本地剪映草稿（bundle 本地工具）
每步 agent 读返回值决定下一步；出错重试/审批询问
```

工具粒度策略：**先粗后细**——P2 先暴露 `montage_full_pipeline` 级工具保证能跑，再逐步拆细给 agent 编排自由度。P0 验证清单新增一条：bundle 注册最小工具 `ping_server`，实测 agent 会话自主调用（机制证明）。

### 3.6 P1 验收

工作台内完成混剪全流程：选素材 → 分割/排列 →（服务端）合成 → 配音（服务端 TTS）→ 特效/BGM → 导出成片 + **一键剪映草稿**（写本机 `com.lveditor.draft` 并登记索引）；进度全程可见；关闭工作台本地功能不受服务端可用性影响（本地直出路径仍通）。

---

## 4. P2（20~40 人日，长尾渐进）

1. 其余媒体工具逐个挂入（音频生成、封面、声音克隆工作台、浏览器抽取…每个 2~5 天）。
2. **agent 工具化**（工作台的真正价值兑现）：host 侧 `defineTool()` + `ctx.tools.register()` 包装混剪步骤（`montage_split`/`montage_concat`/`voice_clone`/`fancy_burn`/`jianying_export`…），使会话里的 agent 能编排整条流水线；审批沿用 harness 默认（ask）。
3. Skill 化：把「电商混剪 SOP」做成 `SKILL.md`（name/description/whenToUse），agent 按技能走完整流程。
4. 远期：核心界面 React 原生重写（退出双栈）。

## 5. 里程碑总表

| 阶段 | 内容 | 量 | 闸门/验收 |
|---|---|---|---|
| P0 | 骨架全链路验证 V1~V8 | 5~8d | 逐项过闸；结论回写本文档 |
| P1 | 桥 + host 移植 + 混剪全流程 | 30~45d | §3.6 验收 |
| P2 | 长尾工具 + agent 工具化 + Skill | 20~40d | agent 可独立编排一次完整混剪 |
| 合计 | 首个可用版本（P0+P1） | **35~53d** | 对照：整体迁移 100~150d；服务端垫档 15~20d |

## 6. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| 上游 dev-preview 破坏性变更 | 高 | 锁 `0.1.2-rc.1`；fork 自持；升级按「上游 release note + patches 冲突演练」流程化；P0-V8 留演练基线 |
| Vue-in-React 兼容（样式/路由/双栈体积） | 高 | P1 首周技术验证；退出路径=React 原生重写（P2 远期） |
| http 页面加载本地媒体受限（file:// → http） | 中 | `/tintin/media` Range 流路由（§3.4）；P1 首个验证点 |
| 大面积 UI slot 缺失 | 中 | P0-V4 勘察；兜底=独立窗口（壳另开 BrowserWindow） |
| 安装包体积上涨（harness 闭包 + Node + pnpm） | 中 | 接受（dsh-desktop 同构）；压缩 maximum；后续评估精简闭包 |
| 低配机/agent 进程故障 | 中 | 工作台做成可禁用模块；沿用上游 Safe Mode/恢复向导 |
| LLM key 泄露 | 高 | 仅服务端代理持 key；bundle 固化 base_url（§3.5） |

## 7. 与剪映互通方案的协同

- 剪映互通方案（§6.1/6.2/6.5）**照常在现有客户端执行，不因本方案暂停**——其产物（`jianying-exporter.js` 加固、`jianying-assets.js` 解析器、root_meta_info 登记）全部是铁律 8 式纯逻辑模块，P1 host 化时**原样搬运**，零重写。
- 两个方案共享一条铁律：新增能力一律下沉「纯函数模块 + 单测」，编排壳可替换——这正是本次能「换壳不换脑」的原因，也是后续任何架构变更的通用保险。

## 8. 铁律门禁

同 `docs/剪映互通整体方案_2026-09-12.md` §8/§7.2 X4：每任务 `npm run typecheck` + build 门禁；〔渲〕新增 ref 逐键进 `return`；失败分支 `clientError` 等价物（host 侧 `ctx.logger` + 路由错误体、client 侧 console + 面板提示）全覆盖；字段映射以既有契约为准不猜测；日志打到断点值。
