# 工程铁律审计报告 & 整改方案

> **审计日期**：2026-08-28
> **审计依据**：[docs/SKILL.md](./SKILL.md) 11 条软件工程铁律（映射到 Electron/JS 工程）
> **审计范围**：`desktop/main/` 全部模块 + `desktop/renderer/src/` 渲染层 + `desktop/preload/` 桥接层
> **审计人**：AI 辅助审查

---

## 一、总体评分

| 维度 | 合规模块 | 违规模块 | 评分 |
|---|---|---|---|
| **IRON-06 分层** | inference-router, media-storage, ffmpeg-gate, env-ipc, preload, extensions-panel, Vue views/stores | server-proxy(臃肿), media-downloader(3处), thickShell-ipc(1处), useScheduledTasks(1处) | **6/10** |
| **IRON-11 任务调度** | tasks store（走服务端） | download-manager, media-downloader | **7/10** |
| **架构完整性** | preload 桥接层、IPC 白名单体系 | main.js(双窗口 bug)、server-proxy(904行) | **5/10** |
| **代码规范** | 注释/命名/错误处理整体良好 | preload 内存泄漏风险 | **8/10** |

---

## 二、合规标杆（值得保持的做法）

| 模块 | 合规点 |
|---|---|
| `preload.js` | **contextBridge + 白名单暴露**：渲染层无法直接访问 ipcRenderer，安全性好。16 个命名空间分组清晰 |
| `inference-router.js` | **纯 core 层**：无 GUI 引用、无 HTTP 直接调用（通过注入的 httpExecutor）。决策逻辑清晰（server-only/force-local/hybrid-auto 三分支） |
| `env-ipc.js` | **47 行极简**：只做探测+清缓存，职责单一，零违规 |
| `media-storage.js` | **纯 config + core**：只操作 electron-store + fs，无 GUI/HTTP 引用 |
| `server.ts` (store) | **纯状态管理**：所有 HTTP 调用通过 `window.tintin.server.*` 业务方法，无路径拼接 |
| Vue views/stores | **渲染层零直接 HTTP 调用**：grep `fetch(/axios./http.get` 结果为 0，全部走 preload 桥接 |
| `Browser.vue` | **容器组件模式**：已按"容器+展示+composable"拆分，本文件只做组合函数接线 |

---

## 三、P0 — 必须立即修复（阻断性 / 安全 / 数据丢失风险）

### 3.1 [BUG] main.js 双窗口泄漏 + IPC 竞态

**文件**：`desktop/main/main.js`
**铁律**：架构完整性
**位置**：L500 和 L595 在同一个 `app.whenReady()` 回调中调用了两次 `createMainWindow(store)`
**整改状态**：✅ **已修复（2026-08-28）** —— 删除 IPC 注册前的提前建窗调用，窗口仅在全部 IPC 注册后创建一次；保留单例守卫（L308）作为纵深防御。

**现状代码流程**：
```
L500: createMainWindow(store)          ← 第一次创建，窗口 A
L508: createThickShellIpc(ipcMain, sharedCtx)  ← 在窗口 A 之后注册 IPC
L511: createMediaDownloader(...)
  ...（大量 IPC 注册）...
L595: createMainWindow(store)          ← 第二次创建，窗口 B（覆盖 mainWindow 引用）
```

**后果**：
1. 窗口 A 创建后 `mainWindow` 引用被窗口 B 覆盖 → **窗口 A 泄漏**（仍在屏幕上可见但无法被代码控制关闭/最小化/隐藏到托盘）
2. 窗口 A 的渲染层先加载，此时业务 IPC handlers 尚未注册（L508-L594），如果渲染层在 `did-finish-load` 中调用 IPC → **静默超时/报错**
3. C8 规格要求"IPC 必须在 createMainWindow 之前注册"被违反

**整改方案**：
```javascript
// 删除 L500 的第一次调用，只保留 L595（在全部 IPC 注册之后）
// 修改前：
//   L500: createMainWindow(store)
//   L508: createThickShellIpc(...)
//   ...
//   L595: createMainWindow(store)
//
// 修改后：
//   L500: （删除）
//   L508: createThickShellIpc(...)
//   ...
//   L595: createMainWindow(store)   ← 唯一一次，在所有 IPC 注册之后
```

**验证方式**：启动应用后，任务管理器中只应看到一个主窗口进程；DevTools 控制台无 IPC timeout 报错。

---

### 3.2 [IRON-06] useScheduledTasks.ts 绕过业务级 IPC 直接拼路径

**文件**：`desktop/renderer/src/composables/useScheduledTasks.ts`
**铁律**：IRON-06（不混层，UI 只允许调 client.method()）
**位置**：L160, L180, L199
**整改状态**：✅ **已修复（2026-08-28）** —— 列表改用新增业务方法 `agentTaskList()`（`/agent/tasks` 同端点同结构）、确认改用 `agentTaskAction({id,action:'confirm'})`、注册表改用 `agentRegistry()`；`loadRegistry` 按 V2 §13.3 数组结构收敛（兼容 `{capabilities}` 包裹）。

**现状**：
```typescript
// L160 — 直接用通用 server.get 拼路径
const data = await window.tintin.server.get('/agent/tasks', { page: 1, page_size: 10 })
// L180 — 直接拼确认接口路径
const res = await window.tintin.server.post(`/agent/tasks/${id}/confirm`)
// L199 — 直接拼注册表路径
const reg = await window.tintin.server.get('/agent/registry')
```

**问题**：preload.js 和 server-proxy.js 已提供了对应的业务级方法：
- `window.tintin.server.agentRegistry()` → `agent:registry` IPC → `GET /agent/registry`
- `window.tintin.server.agentTaskAction({id, action:'confirm'})` → `agent:taskAction` IPC
- `window.tintin.server.tasksUnifiedList()` → `tasks:unifiedList` IPC

渲染层直接拼 URL 路径 = 绕过 IPC 层参数校验，路径变更时找不到调用方（IRON-06 踩坑清单中"3 处硬编码同时改漏"的模式）。

**整改方案**：
```typescript
// L160 改为：
const data = await window.tintin.server.tasksUnifiedList({ page: 1, page_size: 10 })

// L180 改为：
const res = await window.tintin.server.agentTaskAction({ id, action: 'confirm' })

// L199 改为：
const reg = await window.tintin.server.agentRegistry()
```

**验证方式**：grep `useScheduledTasks.ts` 中不再出现 `server.get(` 或 `server.post(`。

---

## 四、P1 — 本迭代内修复（分层违规 / 重复实现）

### 4.1 [IRON-06] media-downloader.js 平台知识硬编码（3 处）
> **整改状态**：🟡 部分修复（2026-08-28）—— ①视频页识别改用 `detectPlatformFromUrl`+老平台兼容集 ✅；②Cookie 域名改用 `platform-meta.PLATFORM_COOKIE_DOMAINS` ✅；③FFmpeg 合并改走 `ffmpeg-gate` ⏳ 下轮（需运行时验证）。

**文件**：`desktop/main/media-downloader.js`
**铁律**：IRON-06（平台知识不应散落在 core 层）

| # | 位置 | 问题 | 整改方案 |
|---|---|---|---|
| ① | L32-40 `_isValidVideoPageUrl()` | 10 个平台 URL 硬编码（youtube/bilibili/douyin/kuaishou/xiaohongshu/weibo/iqiyi/youku/mgtv） | 改为引用 `platform-meta.js` 的 `URL_TO_PLATFORM` + `detectPlatformFromUrl()` |
| ② | L261-267 Cookie 域名映射 | `youtube→.youtube.com` 等 3 平台 if/else 硬编码 | 改为引用统一的 `PLATFORM_COOKIE_DOMAINS`（需从 thickShell-ipc.js 迁移到 platform-meta.js） |
| ③ | L416-432 直接 exec FFmpeg | 绕过已有 `ffmpeg-gate.js` 的合并能力 | 改为调用 `ffmpeg-gate.js` 导出的函数式接口（如 `concatSegments` 或新增 `mergeAV` 方法） |

**整改步骤**：
1. 在 `platform-meta.js` 中新增 `PLATFORM_COOKIE_DOMAINS` 和 `VIDEO_PAGE_PLATFORMS` 导出
2. `media-downloader.js` 改为 `const { PLATFORM_COOKIE_DOMAINS, detectPlatformFromUrl } = require('./platform-meta')`
3. `ffmpeg-gate.js` 新增 `mergeAudioVideo(ffmpegPath, videoPath, audioPath, outPath)` 函数并导出

---

### 4.2 [IRON-06] thickShell-ipc.js Cookie 域名映射重复
> **整改状态**：✅ 已修复（2026-08-28）—— `PLATFORM_COOKIE_DOMAINS` 迁入 `platform-meta.js` 单一维护点，thickShell-ipc.js 改引用。

**文件**：`desktop/main/thickShell-ipc.js` L587-593
**铁律**：IRON-06（同一知识不重复维护）

**现状**：`PLATFORM_COOKIE_DOMAINS` 在 thickShell-ipc.js 中定义，但 platform-meta.js 已有 `URL_TO_PLATFORM` 和 `PLATFORM_DEFS`。

**整改方案**：
1. 将 `PLATFORM_COOKIE_DOMAINS` 迁移到 `platform-meta.js`，作为 `PLATFORM_DEFS` 的补充字段或独立导出
2. `thickShell-ipc.js` 改为 `const { PLATFORM_COOKIE_DOMAINS } = require('./platform-meta')`

---

### 4.3 [架构] server-proxy.js 904 行 — 职责过重

**文件**：`desktop/main/server-proxy.js`
**铁律**：IRON-06 分层（utils 不应混入 core 业务逻辑）

**现状**：同时承担四类职责：
| 职责 | 行范围 | 行数 |
|---|---|---|
| 通用 HTTP 基础设施（httpRequest/multipartUpload/getMimeType/isExpectedOfflineError） | L132-366 | ~235 |
| API 路径常量（API_ENDPOINTS） | L70-111 | ~42 |
| 通用 IPC 代理（server:get/post/put/delete/upload/sse） | L368-502 | ~135 |
| **业务级 IPC handlers**（30+ 个 agent:/tasks:/rembg:/vsr:/asr:/tts: 等） | L504-893 | ~390 |

**整改方案**：
1. 提取 `business-handlers.js`：将所有业务级 IPC handlers（L504-893）移入，接收 `{ ipcMain, httpRequest, multipartUpload, API_ENDPOINTS, isExpectedOfflineError }` 参数
2. `server-proxy.js` 只保留：HTTP 基础设施 + API_ENDPOINTS + 通用 IPC 代理 + `createServerProxy()` 中调用 `business-handlers.js` 的注册函数
3. 拆分后 server-proxy.js 目标 ~400 行，business-handlers.js ~400 行

---

## 五、P2 — 下迭代修复（隐患 / 代码质量）

### 5.1 [内存泄漏] preload.js mediaDownload.onProgress listener 累积
> **整改状态**：✅ 已修复（2026-08-28）—— 共享 channel 改为单监听模式（后注册覆盖前一个，退订时清空句柄）。

**文件**：`desktop/preload/preload.js` L345-349
**铁律**：代码规范

**现状**：
```javascript
onProgress: (cb) => {
  const handler = (_e, payload) => cb(payload)
  ipcRenderer.on('browser:downloads-updated', handler)
  return () => ipcRenderer.removeListener('browser:downloads-updated', handler)
}
```

每次调用 `onProgress(cb)` 都会在共享 channel 上注册新 listener。渲染层组件重新挂载时，旧 listener 不会被自动清除。

**对比**：同文件 `downloads.onProgress`（L34-44）使用 `progressListeners` Map 做 taskId 级别管理，模式更安全。

**整改方案**：
```javascript
// 方案 A：限制单 channel 只允许一个 listener（后注册覆盖前一个）
let _mediaDlProgressHandler = null
const mediaDownload = {
  // ...
  onProgress: (cb) => {
    if (_mediaDlProgressHandler) {
      ipcRenderer.removeListener('browser:downloads-updated', _mediaDlProgressHandler)
    }
    const handler = (_e, payload) => cb(payload)
    _mediaDlProgressHandler = handler
    ipcRenderer.on('browser:downloads-updated', handler)
    return () => {
      ipcRenderer.removeListener('browser:downloads-updated', handler)
      _mediaDlProgressHandler = null
    }
  },
}
```

---

### 5.2 [架构] main.js 730 行 — 浮动面板管理 + 杂项 IPC 内嵌

**文件**：`desktop/main/main.js`
**铁律**：IRON-06 分层

**现状**：
- L36-206：`openHistoryPanel`/`closeHistoryPanel`/`_openFloatingPanel`/`_closeFloatingPanel`（170 行浮动面板管理）
- L606-700：`app:*`/`history:*`/`dialog:*`/`shell:*` 等杂项 IPC 直接写在顶层

**整改方案**：
1. 提取 `floating-panel-manager.js`：浮动面板的创建/关闭/blur 防抖逻辑
2. 提取 `app-ipc.js`：`app:*`/`dialog:*`/`shell:*`/`history:*` 等杂项 IPC handlers
3. main.js 只保留：模块初始化编排 + 窗口创建 + 生命周期管理，目标 ~300 行

---

### 5.3 [IRON-11] download-manager.js + media-downloader.js 本地任务管理

**文件**：`desktop/main/download-manager.js` L9, `desktop/main/media-downloader.js` L9
**铁律**：IRON-11（任务调度必须走服务端）

**现状**：两个模块各自维护本地 `Map` 管理任务状态，不走服务端队列。

**评估**：
- 通用文件下载（download-manager.js）：属于客户端本地行为（浏览器触发的下载），可以接受不走服务端队列
- 媒体下载（media-downloader.js）：如果后续扩展到批量嗅探结果一键下载，需要引入并发控制

**整改方案**（渐进）：
1. 短期：在 `media-downloader.js` 中增加并发上限（`MAX_CONCURRENT_DOWNLOADS = 2`），新任务排队等待
2. 中期：评估是否需要上报下载任务到服务端 `/material/tasks`（m_ 前缀）

---

## 六、整改执行顺序

按铁律 Step 0-5 的标准执行顺序：

| 步骤 | 动作 | 涉及文件 |
|---|---|---|
| **Step 1** | TodoWrite 创建整改任务列表 | — |
| **Step 2** | Read 目标文件最新内容 | 按 P0→P1→P2 顺序 |
| **Step 3** | 增量 Edit（只改指出的点，IRON-08） | 见各条整改方案 |
| **Step 4** | 门禁：Node.js 语法检查 + 启动验证 | 每个文件改完即验证 |
| **Step 5** | 提交：`fix(main): 删除重复 createMainWindow 调用修复窗口泄漏` | IRON-09 格式 |

---

## 七、违规案例清单（持续积累）

| 时间 | 违规 | 后果 | 对应铁律 |
|---|---|---|---|
| 2026-08-28 | main.js 两次 `createMainWindow()` | 第一个窗口泄漏不可控，IPC 竞态 | 架构完整性 |
| 2026-08-28 | useScheduledTasks.ts 用 `server.get` 拼路径 | 绕过业务 IPC 参数校验，路径变更改漏 | IRON-06 |
| 2026-08-28 | media-downloader.js 硬编码 10 平台 URL | 新增平台需改下载器，易漏 | IRON-06 |
| 2026-08-28 | media-downloader.js 直接 exec FFmpeg | 与 ffmpeg-gate.js 重复实现，维护两套 | IRON-06 |
| 2026-08-28 | thickShell-ipc.js 重复定义 PLATFORM_COOKIE_DOMAINS | 与 platform-meta.js 不一致风险 | IRON-06 |
| 2026-08-28 | server-proxy.js 904 行混合四类职责 | 新增业务 handler 时文件越来越难维护 | IRON-06 |
| 2026-08-28 | preload.js mediaDownload.onProgress listener 累积 | 组件反复挂载后 listener 泄漏 | 代码规范 |

---

> **本文档是"零容忍"铁律审计的产出，任何 P0 项未修复不允许发版。P1 项在本迭代结束前必须修复。P2 项排入下迭代 backlog。**
