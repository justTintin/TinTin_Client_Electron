# 螺丝钉 V3 客户端迁移全栈文档（界面层 → 模块层 → 打包）

> 版本：V3.0 | 日期：2026-08-25 | 上游文档：
>
> - `PRD_Electron_v3_SchemeA.md`（功能需求 & 不可变约束 & UAT 验收标准）
> - `DESIGN_Electron_v3.md`（Luosiding tokens + Cherry Studio 风格 UI 规范）
> - `V2_模块调用流程与客户端服务端分工.md` + 5 份 V2 接口文档（服务端契约源）
>
> **代码落地进度**（本轮交付「基于设计稿的完整 V3 UI」，已通过 `vite build --config ./renderer/vite.config.ts` 构建，48 modules transformed，exit\_code=0；拆包结果：main + vue + 4 页独立 chunk（Workbench / MediaTools / Browser / Settings））：
>
> - ✅ 3-Tab 全局壳 + keep-alive 切换（顶栏 56px / 底栏 44px / 三 Tab 胶囊）
> - ✅ 设计稿对齐：工作台重写为「260px 会话侧栏（今天/昨天/更早分组 + 系统设置）+ 聊天主区（AI/用户气泡 + 脚本镜头卡 + 底部输入框）」
> - ✅ 设计稿对齐：媒体工具 10 张卡片无分组网格（AI脚本创作/一键成片/产品库管理/素材生成/音频素材/视频混剪/直播切片/数据分析/视频修复/封面设计），含 HOT 徽章 + 渐变图标 + 5/4/3/2/1 列响应式
> - ✅ 设计稿对齐：浏览器顶栏工具条（前进后退刷新 + 胶囊地址栏 + 锁图标 + 解析并导入 + 下载徽章） + 左栏 240px（浏览历史分组 + 下载管理进度卡） + 平台 Tabs + 主区 BrowserView 占位
> - ✅ 新增 Settings 页：左栏 240px（平台接入/本地配置/环境维护/扩展插件/任务队列/关于 + 返回工作台） + 右区分段控件 + 开关行 + 路径行 + 环境维护按钮组 + 版本信息网格
> - ✅ 多端适配：4 个一级页分别内置 3\~5 档响应式断点（1440/1100/900/800/640/560/768），≤900px 自动抽屉化侧边栏，≤640px 压缩导航/网格
> - ✅ 路由扩展：一级路由增加 `/settings`，stores/app.ts TabKey 扩展 `'settings'`，设置页保持工作台 Tab 高亮（因为入口在工作台侧栏）
> - ✅ 页面交互：新建会话、切换会话、发送消息、脚本镜头展示、平台 Tab 切换、历史回溯、下载进度/状态、设置开关/分段控件/路径选择/环境维护/返回工作台
> - ✅ 设计系统 tokens.css / global.css（完整明暗双主题 Luosiding tokens）
> - ✅ electron/types/server-api.ts（单源类型契约：13 域命名空间 + 17 域路径常量 + 通用类型）
> - ✅ server-proxy.js：API\_ENDPOINTS + resolveEndpoint + 26 业务级 IPC handlers
> - ✅ global.d.ts TintinBridge / TintinBridgeServer：29 业务方法签名
> - ✅ preload.js：window\.tintin.\* 白名单桥 + \_withUploadProgress 进度通道
> - ✅ stores/server.ts：12 能力开关 + capabilityDetail(models/modes/engines) + registry + workbenchStats
> - ✅ stores/tasks.ts：tasks/unified 子任务树 / a\_\* 前缀 / waiting\_user\_input / children\_progress
> - ✅ start-dev.bat：ASCII-safe 一键启动（端口清理/首次安装/依赖安装/Vite+Electron）
> - ✅ package.json build.\*：electron-builder NSIS + 三档 extraResources（bin/icons/studio-legacy）
> - 🔄 **P1.5 WIP（厚壳化 · 对齐 Cherry Studio 方案）**：
>   - 🔄 **自绘标题栏**：`BrowserWindow frame:false` + 36px 自绘栏（左 Logo/产品名/拖拽区 + 右 最小化/最大化/关闭）+ `electronAPI.win.*` IPC 白名单 + 全屏/最大化/最小化状态还原 + `-webkit-app-region` 拖拽与按钮点击区严格拆分（Experience 302020 修正：按钮必须 `no-drag`，防止"看起来有按钮但点不动"）
>   - 🔄 **BrowserView 真嵌入**：主进程 BrowserView 实例池（5 平台 5 个 `partition:persist:*` 隔离 cookie）+ 按 Tab 路由 attach/detach + bounds 精确跟随窗口 resize/reflow + 地址栏/后退/刷新/解析并导入 按钮真实触发 `loadURL / goBack / reload / executeJavaScript 抽 DOM`，替代 Browser.vue 原有灰色 mock 占位块
>   - 🔄 **安全基线保持不变**：全程 `contextIsolation:true / nodeIntegration:false / sandbox:true`，只用 preload contextBridge 暴露白名单通道（绝不回退为直接挂 window\.Node API）；打包资源沿用现有 `extraResources` 单一策略（不新增大段 files glob 混用，避免 preload/入口路径分叉 —— Experience 302020 Failure 3 修正）

> 非目标（本文档不覆盖）：bridge.exe 打包细节 / 服务端 S1\~S4 实现 / 自动升级 update.json 后端。

***

## 0. 文档范围与目标

本文档是 V2.x PySide6 客户端 → V3 Electron 客户端的**端到端迁移总纲**，面向三类读者：

| 读者       | 关注章节                                         |
| -------- | -------------------------------------------- |
| 产品 / UI  | §1 目标里程碑 · §3 界面层 3-Tab 规格 · §7.2/7.4/7.5 验收 |
| 前端工程师（主） | §2 工程构造 · §4 模块层架构 · §5 接口契约                 |
| 发布 / 运维  | §6 打包产物规格 · §7.1 CI 门禁                       |

### 0.1 三条不可变约束（任何阶段不得违背）

1. **不引入本地 Python runtime**：安装目录下不得出现 `python.exe` / `python3x.dll` / `site-packages/`。
2. **服务端现有 API 字节级一致**：除 S1~S4 新增接口外，所有 A 类 / A2 类接口路径、字段名、请求体必须与 V2 PySide6 客户端完全相同（以 `V2_*.md` 6 份文档为准）。
3. **历史产物互通**：同一账号下，V2 脚本 / 成片任务 / 素材库 / 音色库在 V3 中必须 100% 可见。

### 0.2 软件工程铁律零容忍附录（IRON-01 ~ IRON-11）

> **强制索引**：工程开发 & 代码审查必须先读 [`docs/SKILL.md`](./SKILL.md)，任何违反 IRON-01~IRON-11 的改动（尤其是 IRON-06 分层混写 & IRON-11 客户端本地并行）不得合入主干。
>
> 铁律快速索引（详见 SKILL.md）：
> - IRON-01 禁止 `git checkout / restore / reset --hard` 整文件回退
> - IRON-02 大文件拆分 5 项完整性校验（行数/类/导入/测试/分支）
> - IRON-03 改代码必跑编译期语法检查（等价 `tsc --noEmit` / `vite build`）
> - IRON-04 核心链路补红测试 & 全量单测通过
> - IRON-05 静态检查（eslint / ruff / mypy 等价）
> - IRON-06 不允许混层：**GUI 层禁 URL 硬编码 & HTTP 响应字段解析**
> - IRON-07 Parser → Builder → Runner 三段拆分 + TDD 驱动
> - IRON-08 只改被指出的地方，不顺手重构
> - IRON-09 提交信息 `<type>(<scope>): <what>` 具体不模糊
> - IRON-10 跨模块行为变动 → 补对应测试 & 双写一致性校验
> - IRON-11 任务调度必须走服务端，禁客户端本地并行（ThreadPool/Worker/直调 FFmpeg 等）

***

## 1. 迁移目标与里程碑

### 1.1 SMART 指标（验收硬边界）

| 指标                   | V2.x PySide6（现状）             | V3 Electron（目标）                      |
| -------------------- | ---------------------------- | ------------------------------------ |
| 冷启动到工作台可见            | ≤ 8 s                        | **≤ 2.5 s**                          |
| Windows 安装包 NSIS EXE | \~ 900 MB（含 python\_embeded） | **≤ 450 MB**（仅 ffmpeg + bridge + 资源） |
| UI 渲染                | Qt 软件光栅化                     | Chromium GPU 合成（60 FPS）              |
| 本地 Python 依赖         | 必须（PySide6 + rembg/VSR）      | **彻底移除**（S1\~S4 全部服务端化）              |
| 三模块窗口形态              | 3 个独立进程/窗口                   | **同窗口 3 Tab**，keep-alive 无闪烁切换       |
| 崩溃影响                 | 全进程丢失上下文                     | 单 Tab 崩溃不影响其他 Tab，主进程 3 次自动恢复        |

### 1.2 里程碑与交付物（与 PRD §六 对齐）

| 阶段                               | 内容                                                                                                              | 工期      | 完成标志                                                                                                                                                                       | 代码落地现状                                                                                                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0（基建 & 依赖）**                  | Scaffold + 3-Tab 壳 + 服务端契约 + 离线容错                                                                               | 1 周     | `npm run dev` 启动三 Tab 可见 + S4 能力探测通过                                                                                                                                       | ✅ 已完成                                                                                                                                                             |
| **P1（浏览器 & 媒体工具）**               | Browser Tab + 10 张设计稿对齐卡片（含响应式） + 8 表单骨架 + S1/S2/S3 对接                                                          | 2 周     | W7\~W10 验收通过                                                                                                                                                               | ✅ **UI 层本轮完成**：浏览器按设计稿重写为顶栏工具条 + 240px 左栏（历史/下载） + 平台 Tabs；媒体工具 10 卡片 5 档响应式；接口方法已落地，待 UI 层调用绑定                                                                   |
| **P1.5（厚壳化 · 对齐 Cherry Studio）** | ① 自绘标题栏（36px · 无系统框架 · win/mac 双端兼容）② BrowserView 真嵌入（5 平台 partition 隔离 + 真实 DOM 采集 + 按钮真实动作）③ 统一 IPC 通道与安全基线加固 | 3 天     | 验收：① 系统标题栏不可见且 3 个控制按钮 100% 可点击（全屏/最大化/还原/最小化 4 种状态走通）② 切到抖音 Tab 能真实打开 douyin.com 并在内部滚动/登录，点击「解析并导入」抽 DOM 返回前 10 条视频 JSON ③ 全程 `contextIsolation=true` 未被改动过且 preload 不抛错 | 🔄 **WIP 本专项规格写入中**：交付含 §1.3 + 主进程 BrowserView 池 + preload 新增 8 条通道 + App.vue 标题栏 UI + Browser.vue 移除 mock 5 处改动（详见 §1.3 规格表 & 文件改动映射）                            |
| **P2（工作台 4 高频页 + 设置）**           | AiScript / Storyboard + ShotMaterialDialog / VectorSearch / ScheduledTasks；新增系统设置页（6 菜单项 + 分段控件 + 开关组件）         | 3 周     | W1\~W6 验收通过                                                                                                                                                                | ✅ **工作台本轮升级为聊天会话入口**：260px 侧栏（新建会话/分组会话列表/系统设置）+ 消息流 + 输入框（含脚本镜头卡）；✅ **设置页本轮新增完成**：平台接入 / 本地配置 / 环境维护 / 扩展插件 / 任务队列 / 关于 + 返回工作台；子组件（AiScript/Storyboard/…）路由位仍预留 |
| **P3（打包 & 升级 & 回归）**             | electron-builder NSIS + 自动升级迁移 + V2→V3 覆盖升级回归                                                                   | 1 周     | U1\~U11 全通过，安装包 ≤ 450 MB                                                                                                                                                   | ✅ build.\* 配置完成；renderer build 48 modules 1.14s 0 错误通过；NSIS EXE 未实跑                                                                                               |
| **合计**                           | <br />                                                                                                          | **7 周** | V3.0 RC 灰度发版                                                                                                                                                               | <br />                                                                                                                                                            |

***

## 1.3 厚壳化专项规格（对齐 Cherry Studio 厚壳方案）

> 本专项目标：**把 V3 客户端从「Web SPA + Electron 薄框」改造为「Electron 厚壳本地软件 + 浏览器 Tab 只是内置功能（BrowserView 真嵌入）」**，对齐 Cherry Studio 的窗口分层、BrowserView 隔离、IPC 安全基线三项核心实践；**任何阶段不得破坏 §0.1 三条不可变约束，也不得回退 §4.1.1 的安全基线**。

***

### 1.3.1 规格 A：自绘标题栏（36px · 无系统框架 · win/mac 双端）

**最终视觉**：启动后**看不到 Windows 系统标题栏**（"Chrome 外套浏览器"那一条蓝色系统栏直接消失），换成与 Luosiding tokens 完全融合的 36px 自绘栏；用户仍可拖拽、双击最大化、三按钮控制窗口。

#### A1. 主进程 BrowserWindow 配置（`main.js createMainWindow`，必须与 §4.1.1 安全基线合并写入）

| 字段                                                        | 值（Windows）                         | 值（macOS）           | 说明                                                                          |
| --------------------------------------------------------- | ---------------------------------- | ------------------ | --------------------------------------------------------------------------- |
| `frame`                                                   | `false`                            | `false`            | ★ 去掉系统框架（实现"无外套"视觉的开关）                                                      |
| `titleBarStyle`                                           | —                                  | `'hidden'`         | macOS 保留原生交通灯，放到自绘区右侧；Windows 自己画三按钮                                        |
| `trafficLightPosition`                                    | —                                  | `{ x: 14, y: 10 }` | macOS 交通灯精确对齐自绘栏 36px 居中                                                    |
| `backgroundColor`                                         | `#0f1020`（= tokens `--background`） | 同左                 | 避免「关闭时白闪」和「启动 200ms 白屏」                                                     |
| `minWidth / minHeight`                                    | `1024 / 700`                       | 同左                 | **硬约束**：小于后停止 setBounds 计算，防止 BrowserView 负坐标越界                             |
| `show`                                                    | `false`                            | `false`            | 配合 `ready-to-show` 事件再 `mainWindow.show()`（防空白闪烁，§4.1.1 已落地，保持不变）           |
| 安全字段（contextIsolation/nodeIntegration/sandbox/webviewTag） | §4.1.1 原样不动                        | §4.1.1 原样不动        | **强约束（Experience 302020 Failure 2 修正）**：任何情况下不得为调试按钮"临时关掉 contextIsolation" |

#### A2. 渲染层 UI：`App.vue` 36px 自绘标题栏（插入到原 Header 56px **之上**）

```
┌─ 36px .title-bar（-webkit-app-region: drag，整行可拖拽）──────────────────────────────────────┐
│ [🐚 螺丝钉 18×18] [螺丝钉-电商智能体矩阵 13px 600]          空白拖拽区       [—] [ ] [×] 12×36 │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
├─ 原有 Header 56px（Logo / 三 Tab / 服务器灯 / CPU…）保持不变，高度/设计稿视觉 1:1 ──┤
├─ Content Area（router-view）保持不变 ──┤
└─ Footer 44px 保持不变 ──┘
```

- `.title-bar` 高度 36px，背景 `--surface`，底 1px `--border-subtle`；**整行默认** **`-webkit-app-region: drag`**（用户拖任何空白都能拖动窗口）
- **窗口控制按钮组** **`.win-controls`（右对齐，12px gap）**：3 个按钮全部 36×36、圆角 0（Windows 原生视觉）、**`-webkit-app-region: no-drag`** **+** **`pointer-events: auto`**
  > ★ **Experience 302020 Failure 1 强制修正**：3 个控制按钮必须显式 `no-drag`，**且 z-index 必须高于** **`.title-bar`** **的任何伪元素/遮罩**，否则会出现"看起来有按钮但点了没反应"的经典死循环。
- 按钮图标（SVG 16×16 stroke=1.5，与设计稿图标统一线宽）：
  - 最小化：`M5 12h14`
  - 最大化 / 还原：**根据窗口状态切换图标**：最大化时画「还原双矩形」，还原时画「单矩形」（由主进程 `browser-window:state-change` 事件推送）
  - 关闭：`M6 6l12 12M18 6L6 18`，hover 背景 `--error` + 白字
- 拖拽区白名单：标题栏中间空白可拖；Logo、产品名、App 内任何按钮默认 **不要** 设 `drag`（防止拖拽误操作）
- **双击标题栏**：行为与 Windows 原生一致（最大化/还原切换）——通过渲染层监听 `dblclick` 发 IPC `win:toggle-maximize` 实现，不依赖系统默认双击（因为 `frame:false` 系统不会帮你处理）

#### A3. Preload IPC 白名单通道（`preload.js` 新增 `electronAPI.win.*`，与现有 `window.tintin.*` 并列）

> 必须走 `contextBridge.exposeInMainWorld`，**不得直接 require('electron').remote**（remote 已废弃且绕过安全模型）

| IPC 通道名                       | 方向                                 | 参数                           | 主进程动作                                                                 | 返回                                                     |
| ----------------------------- | ---------------------------------- | ---------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------ |
| `win:minimize`                | Renderer → Main                    | 无                            | `mainWindow.minimize()`                                               | void                                                   |
| `win:toggle-maximize`         | Renderer → Main                    | 无                            | 若 maximized → unmaximize 否则 maximize；**macOS 走 setFullScreen 逻辑区分**   | `{maximized: boolean}`                                 |
| `win:close`                   | Renderer → Main                    | 无                            | 先保存窗口 bounds/状态到 electron-store → `mainWindow.close()`（不直接 quit）      | void                                                   |
| `win:get-state`               | Renderer → Main                    | 无                            | 读取 `isMaximized() / isMinimized() / isFullScreen() / getBounds()`     | `{maximized, minimized, fullscreen, bounds:{x,y,w,h}}` |
| `browser-window:state-change` | Main → Renderer（mainWindow\.on 广播） | `{state, maximized, bounds}` | Main 在 `maximize/unmaximize/minimize/restore/move/resize` 发生时主动推送给渲染层 | Renderer 更新标题栏按钮图标和响应式断点                               |

#### A4. 状态还原（冷启动 & 二次打开）

启动 createMainWindow 时先读 `electron-store.get('windowState')`，若存在且 bounds 在当前显示器工作区内（必须校验，避免用户上次拖到第二块屏后拔屏再也看不到窗口）：

```
restore bounds → 若上次 maximized/fullscreen=true → show() 后立即 maximize/setFullScreen
否则 → 默认 1440×900 居中
```

任意 `close` 前写回 store。

#### A5. 验收硬标准（必须 100% 通过）

1. 启动窗口：Windows 原生蓝色系统标题栏 **完全不出现**；显示为自绘 36px 栏 + 3 个控制按钮在右上
2. 拖拽：标题栏任意空白拖拽移动窗口正常；拖到屏幕顶自动触发 Aero Snap 最大化（`frame:false` 下 Electron 会自动处理 Aero Snap，不需额外写）
3. 按钮点击：最小化/最大化/还原/关闭 4 个动作**每次点击都生效**，不存在"点 3 下只成功 1 下"的拖拽区穿透 bug（302020 防坑目标）
4. 窗口状态记忆：关闭后二次打开，尺寸/位置/最大化状态 **100% 还原**（拔掉副屏后不会出现在不可见坐标）
5. macOS：交通灯在 (14,10) 正常显示、可点；不画自绘三按钮避免冲突

***

### 1.3.2 规格 B：BrowserView 真嵌入（浏览器 Tab 内置功能，不是外套浏览器）

**最终视觉**：在 `/browser` 路由下，原设计稿"平台 Tabs + 中间主区灰色 mock 块"改为：**平台 Tabs 点击后中间主区真的加载对应平台网页**（抖音/视频号/快手/小红书/B 站），用户可以在内部滚动、登录、播放视频；「解析并导入」按钮真从页面 DOM 抽出视频列表，而不是一个前端假卡片。

#### B1. 为什么不用 iframe / `<webview>`，必须用 BrowserView（对齐 Cherry Studio 选型）

| 方案                   | 隔离性                                 | 独立进程                                 | DOM 抽取能力                                                  | 与现有窗口布局冲突                                                              | 选择                           |
| -------------------- | ----------------------------------- | ------------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------- |
| iframe               | 同源限制，无 cookie 隔离                    | 与主渲染同一 renderer 进程（崩溃带走主窗口）          | 受限 cross-origin                                           | 不占 Electron 窗口层级，只是 DOM                                                | ❌ V2 用的，V3 淘汰                |
| `<webview>` Tag      | 有 partition，但仍在 renderer 树          | 独立进程，但出问题时 Electron 官方说"废弃"          | `executeJavaScript` 可以                                    | 要在 Vue template 里用 webview 元素，Vite 要声明 customElement                   | ⚠️ 保留为兜底，但默认不选               |
| **BrowserView**（本规格） | partition 完整隔离 cookie/cache/storage | **完全独立 WebContents 独立进程**（抖音崩不带走工作台） | `webContents.executeJavaScript` 原生 + `session.cookies` 访问 | **占"原生窗口层级"——必须用 setBounds 精确贴到 Browser.vue 主区的 DOM 真实坐标，才能看起来和设计稿融合** | ✅ Cherry Studio 默认选型，本规格唯一推荐 |

**关键视觉理解**：BrowserView 不是 Vue DOM 的子元素，它是"**贴在 BrowserWindow 上层的原生子窗口**"——所以必须严格按 Browser.vue 内主区容器的 `getBoundingClientRect()` 来 `setBounds`，并且**窗口 resize、侧栏抽屉开/关、工具条高度变化、平台 Tabs 切换时都要重算 bounds**，否则会错位或覆盖到侧边栏/顶栏。

#### B2. 主进程 BrowserView 实例池（5 平台 = 5 个 partition 隔离）

主进程 `main.js`（或抽 `browser-view-pool.ts`）维护：

```ts
type PlatformKey = 'douyin' | 'weixin-sphere' | 'kuaishou' | 'xiaohongshu' | 'bilibili'
interface PoolItem {
  view: BrowserView          // 独立 BrowserView
  url: string                // 首次加载 URL（平台域名）
  createdAt: number
}
const pool = new Map<PlatformKey, PoolItem>()
const PLATFORM_DEFS: Record<PlatformKey, {name: string, seedUrl: string, partition: string}> = {
  douyin:          { name: '抖音',   seedUrl: 'https://www.douyin.com/',              partition: 'persist:tintin-douyin' },
  'weixin-sphere': { name: '视频号', seedUrl: 'https://channels.weixin.qq.com/',       partition: 'persist:tintin-weixin' },
  kuaishou:        { name: '快手',   seedUrl: 'https://www.kuaishou.com/',             partition: 'persist:tintin-kuaishou' },
  xiaohongshu:     { name: '小红书', seedUrl: 'https://www.xiaohongshu.com/explore',   partition: 'persist:tintin-xhs' },
  bilibili:        { name: 'B站',    seedUrl: 'https://www.bilibili.com/',             partition: 'persist:tintin-bili'  },
}
```

- 懒创建：首次切到某平台 Tab 才 new BrowserView，第二次切到复用实例（保留用户登录态/滚动位置——**这就是 partition 的价值**）
- `BrowserView.webPreferences`：
  ```
  partition: PLATFORM_DEFS[k].partition   # ★ 每个平台独立 cookie jar，互不通
  contextIsolation: true                   # 安全基线不动
  nodeIntegration: false                   # ★ 防止平台页面拿到 Node
  sandbox: true
  ```

#### B3. bounds 精确计算（核心工程难点，必须落到函数签名）

**Render 侧**（Browser.vue 每次挂载、平台切换、窗口 resize、侧栏抽屉状态变化后）：

1. 取主区容器 `.browser-view-host` 的 DOMRect：
   ```ts
   const host = document.querySelector<HTMLDivElement>('.browser-view-host')!
   const r = host.getBoundingClientRect() // {left, top, width, height} 相对窗口（不是屏幕）
   ```
2. 通过 IPC 发：`browser:set-bounds({ platformKey, rect: {x:r.left, y:r.top, w:r.width, h:r.height} })`

**Main 侧**接收后：

```ts
// 把"相对窗口的 DOM 像素"直接 setBounds（BrowserView 的 x/y 就是相对父 BrowserWindow 的，正好匹配）
const view = pool.get(platformKey).view
view.setBounds({
  x: Math.max(0, Math.floor(rect.x)),
  y: Math.max(0, Math.floor(rect.y)),
  width: Math.max(320, Math.floor(rect.w)),
  height: Math.max(200, Math.floor(rect.h)),
})
```

> ⚠️ **常见坑（必须在规格中明确约束）**：
>
> - 当侧栏 240px 展开 / 关闭（≤900px 抽屉化）→ DOMRect.left 变化 240px → **Browser.vue 的 watch 必须监听 store 侧栏状态 + window resize 两个源 + nextTick 后再发 IPC 重算**，不能只在 mounted 算一次
> - 切到非 /browser 路由（工作台/媒体/设置）→ **必须** **`mainWindow.removeBrowserView(view)`**，否则 BrowserView 会压在工作台界面上（因为它是原生层级）
> - 进入 /browser 路由 → 必须立即 `mainWindow.addBrowserView(view)` + 立刻 setBounds（加完立即贴对位置，不能等下一帧）

#### B4. 生命周期 attach / detach（路由级）——由渲染层发 IPC 通知主进程

| Browser.vue 生命周期钩子                         | IPC 通道                                 | 主进程动作                                                                                                                 |
| ------------------------------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `onMounted`（进入 /browser）                   | `browser:attach-platform(platformKey)` | `addBrowserView(view)` + 初始化首次 `loadURL(seedUrl)`（仅第一次）+ setBounds                                                    |
| `watch(currentPlatformKey)` 平台切换           | `browser:switch-platform(from,to)`     | 如果是已创建过的：先 remove from，再 add to，最后 setBounds；未创建则懒创建 → setBounds                                                      |
| `onBeforeUnmount`（离开 /browser → 其他 Tab）    | `browser:detach-all`                   | `mainWindow.removeBrowserView(当前 view)`（不要 destroy，保留 pool 内实例，因为要保留登录态）                                              |
| `mainWindow.on('resize' / 'move')`（主进程自监听） | 主进程内部直调                                | 取当前 attached 的 platformKey → 触发 Renderer 重算 DOMRect 的事件（或主进程直接按上次缓存的 DOM 偏移 + 新窗口 bounds 估算，但推荐 Renderer 重新发 rect 更准） |

#### B5. 按钮真实动作（地址栏 / 后退 / 刷新 / 解析并导入 / 下载徽章）

| Browser.vue 现有 UI（设计稿） | 点击后的真实动作（不再是 alert/console）                                                                                                                                 | IPC 通道 + 返回                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 左 ← 后退按钮               | `webContents.goBack()`（历史 -1，禁用态按 `canGoBack()` 变灰）                                                                                                         | `browser:nav(platformKey, 'back') → {canGoBack, canGoForward}`                                                                       |
| 右 → 前进按钮               | `webContents.goForward()`                                                                                                                                   | `browser:nav(platformKey, 'forward') → {canGoBack, canGoForward}`                                                                    |
| ⟳ 刷新按钮                 | `webContents.reloadIgnoringCache()`                                                                                                                         | `browser:nav(platformKey, 'reload') → void`                                                                                          |
| 🔒 胶囊地址栏               | 1) 只读模式显示当前 `webContents.getURL()`；2) 用户 Enter 后：若输入非空 → `loadURL(用户输入)`；输入未填 → 回到平台 seedUrl                                                                | `browser:load-url(platformKey, url) → {finalUrl}`；**反向主进程推送**：`browser:url-updated(platformKey, url, title)`（Renderer 每跳一次自动刷新地址栏显示） |
| 🟣「解析并导入」Primary 按钮    | 主进程 `webContents.executeJavaScript(EXTRACT_SCRIPT)`，抽出当前平台页面前 10 条视频（作者/标题/封面/播放量/链接）→ JSON 返回渲染层，**渲染层推送到工作台新建会话并作为"脚本镜头初始素材卡"展示**（打通 Browser → Workbench） | `browser:extract(platformKey) → Array<VideoItem>`（失败返回 `{error:string}`）                                                             |
| ⬇ 下载徽章红点               | 用主进程已有的 `download-manager.js` 全局 EventEmitter：`webContents.session.on('will-download')` → 挂到统一下载池 → 推送 `downloads/updated` 到底栏 Footer + Browser 左栏下载卡片 UI   | Renderer 不需要主动 IPC，订阅 `download-manager:*` 广播即可（§4.1.2 已有总线）                                                                         |

**EXTRACT\_SCRIPT 采集脚本规范（平台差异化）**：

- 每平台一个 30\~50 行 JS（放在 `electron/main/extractors/{douyin,xhs,bilibili}.ts`）
- 必须 try/catch 整段包裹，异常返回 `{error: '平台DOM结构变化，无法解析'}`，**永远不允许让主进程崩溃**
- 返回必须是统一 schema：`[{platformKey, author, title, coverUrl, playCountOrLikes, videoUrl, fetchedAt}]`（TypeScript 单源类型写在 `electron/types/browser-extract.d.ts`）

#### B6. 验收硬标准（必须 100% 通过）

1. 切 `/browser` → 默认抖音 Tab → 中间 2 秒内显示真实抖音页面，能滚动、能点按钮、不出现"渲染层 DOM 覆盖上去"的错位
2. 切 B 站 Tab → 立即显示 bilibili.com，cookie 独立（不会拿抖音的登录态去访问 B 站）；切回抖音 Tab → **登录态和滚动位置都还在**（partition 复用生效）
3. 切到工作台 Tab → 抖音页面不压在工作台上（BrowserView 被 detach 了）；切回 /browser → 页面还原无刷新
4. 地址栏显示真实当前 URL；用户手动输入合法网址后回车，页面会跳转，地址栏同步更新
5. 点「解析并导入」→ 返回 JSON schema 合规（10 条，字段非空），然后工作台自动出现一个"新建会话"含 10 条素材卡（跨 Tab 数据流打通）
6. 窗口拉到 1024×700 最小尺寸 → BrowserView 不越界覆盖顶栏/侧栏；侧栏关闭（抽屉态）→ 主区变宽，BrowserView 随之变宽（setBounds 重算生效）

***

### 1.3.3 规格 C：安全基线 & 兼容约束（本专项"不能踩的红线"）

> 来自 Experience 302020 Failure 集合的「强约束 + 唯一正确路径」，违反任何一条即视为本专项未通过。

| 编号  | 强约束                                                                                                                                                                                                                                                                                     | 原因（踩坑记录）                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| C1  | `contextIsolation:true / nodeIntegration:false / sandbox:true` 三开关 **全程不得修改**；任何窗口控制/BrowserView 能力必须通过 `contextBridge.exposeInMainWorld` 白名单通道暴露                                                                                                                                       | 302020 Failure 2：曾经为"快速修复"关掉 contextIsolation → 后面 3 个版本没法回滚，安全基线永久下降                                     |
| C2  | 资源路径唯一策略：preload / 主入口 / extraResources **沿用 §2.1 的现有单一链**：`asar 内 electron/` + `extraResources bin/icons/studio-legacy` 三档；不得为厚壳化新增第二套路径推导                                                                                                                                             | 302020 Failure 3：`app.getAppPath() vs process.resourcesPath` 两条链混用 → 用户报告 3 台机器 1 台找不到 preload → 花 2 天才还原 |
| C3  | 自绘标题栏任何可点击元素（三按钮 / Logo / 产品名链接 / 未来菜单）必须显式 **`-webkit-app-region: no-drag`** **+ z-index:高于拖拽区**；不要为了"按钮不响应"去改安全配置 / preload                                                                                                                                                           | 302020 Failure 1：花 2 天查 preload，最后根因是"最小化按钮被 drag 父容器吞了点击"                                                |
| C4  | 浏览器嵌入方案选型单一：默认 BrowserView；只有当用户在 2K 以下缩放 150% 且出现 setBounds 漂移时，才允许切换 `<webview>` 做降级回退，回退路径写入 `electron-store('embed-mode')` 可手动切换                                                                                                                                                    | 防止为了"快速对齐"混用 iframe+webview+BrowserView 三种，后续维护成本 3 倍                                                     |
| C5  | `BrowserView.setBounds` 的 width/height **永远不会返回负数**：主进程接收到任何 IPC rect 后必须 `Math.max(320,w) / Math.max(200,h)` 裁剪；小于 minWidth 1024 的窗口停止 bounds 广播                                                                                                                                       | 防止极端尺寸下 BrowserView 越界卡死                                                                                  |
| C6  | `ready-to-show` 再 `mainWindow.show()` + 背景色固定 `--background #0f1020`；不允许 `BrowserWindow.show()` 立即调                                                                                                                                                                                     | 防止用户启动第一帧看到白屏，误以为"浏览器外套正在加载 Chrome"                                                                       |
| C7  | BrowserView 的 `webContents` 的 `new-window` / `did-navigate` 事件必须 **全部拦截**：外链不在 BrowserView 内部打开，改为 `shell.openExternal(url)` 用用户系统默认浏览器打开（安全边界：BrowserView 只做"平台登录 + DOM 采集"，不做通用 Web 浏览器）                                                                                              | 防止用户在软件内误跳到钓鱼站 / 支付页，误以为"软件自己支持全网浏览"                                                                      |
| C8  | **IPC 注册时序（硬约束，来自 Recall 280024 Failure 2）**：所有 `ipcMain.handle('win:* / browser:*')` 必须在 **`app.whenReady()`** **最早期、且在任何** **`createMainWindow()`** **调用之前** 同步完成注册；集中到独立模块 `electron/main/ipc/thick-shell.ts`，用布尔量 `handlersRegistered` 保证只注册一次                                      | 防止"渲染进程 onMounted 先发 win:get-state，但 handler 还没注册 → 全部 reject"的竞态 bug                                     |
| C9  | **Loading Gate 门控（硬约束，来自 Recall 280024 Failure 3）**：App.vue 必须引入 `thickShellReady.value = false` 状态：onMounted `await window.electronAPI.win.get-state()` 成功后才置 true → true 之前**不渲染 TitleBar 三按钮图标 + 不渲染 BrowserTab 默认 Platform**；`win.get-state` 2s 未返回必须自动降级为「1440×900 居中 + 非最大化」默认值渲染 | 防止启动 300ms 内"最大化图标显示错（窗口是最大化但图标是单矩形）/ BrowserView 空白闪烁"                                                   |
| C10 | **主进程 = 能力执行者，渲染层 = 决策触发者（边界强约束，来自 Recall 280024 Failure 1）**：主进程**不得主动**（不得监听路由跳转/自己判断 attach 哪个 BrowserView / 直接把抽取结果 sendToWorkbenchRenderer 绕过渲染层）；所有 attach/detach/extract/load-url **100% 由 Browser.vue/App.vue 的生命周期钩子 + watcher + 用户 click 事件发起 IPC**                           | 防止主进程偷偷做业务判断导致启动时序混乱，保持单向数据流原则                                                                            |
| C11 | **DOM 抽取跨 Tab 数据流（边界强约束，C10 延伸）**：`browser:extract` 返回的 VideoItem 数组 **必须由 Browser.vue 收到后**，再通过 Pinia `appStore.pushPendingShots()` 或 `router.push('/workbench')` + `sessionStore.attachInitialMedia()` 送给工作台，**禁止主进程直接** **`webContents.fromId(workbenchId).send`** **绕过 IPC**        | 防止跨 Tab 数据流破坏单向数据流，避免未来多窗口场景下的时序错乱                                                                        |
| C12 | **IPC 监听器注册 = 配对清理（硬约束，防止 keep-alive 泄漏）**：Browser.vue 中所有 `window.electronAPI.*.on(event, cb)` 必须保存 handler 引用（`const off = window.electronAPI.browser.onUrlUpdated(cb)`），在 `onBeforeUnmount` 或 keep-alive 的 `onDeactivated` 里**逐个调用 off()**                                           | 防止用户切 Tab 50 次 = 挂 50 次监听器 → 内存泄漏 + 每个事件触发 30 次回调 → bounds 重算抖动                                           |
| C13 | **Bounds 重算必须去抖（工程必要）**：`window resize / scroll / router-view transitionEnd` 等尺寸变化触发的 `browser:set-bounds` 必须走 **`useDebounceFn(200ms)`（VueUse）**，尺寸稳定 200ms 后才发一次 IPC；禁止 16ms/次的高频 setBounds                                                                                           | 防止用户 500ms 拖窗口 = 发 30 次 IPC → BrowserView 频繁重绘出现肉眼可见的闪屏                                                   |
| C14 | **IPC 通道白名单总表（工程边界）**：在 §1.3.4 另附「electronAPI 全量白名单」清单（win 5 条 + browser 7 条 = 12 条），任何实现不得超出清单新增通道；清单变更必须走 PRD 评审 + C1 安全基线复核                                                                                                                                                          | 防止开发时图方便新增 IPC 暴露全量 fs 读写，破坏 C1 安全基线                                                                      |

***

### 1.3.4 文件改动映射表（厚壳化交付物：改哪些文件）

#### electronAPI 白名单总表（C14 约束：实现不得超出本清单，新增通道需评审）

| 命名空间                                                                | 通道                                                                            | 方向                                                                                                                                                                                                                    | 说明（对应规格 A/B 中的条目）                                   |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `win`                                                               | `getState()` → `WinState`                                                     | invoke（单向请求）                                                                                                                                                                                                          | 主渲染启动握手 + Loading Gate 判定（C9）                       |
| `win`                                                               | `minimize()` → `void`                                                         | invoke（单向）                                                                                                                                                                                                            | 三按钮最小化（A3）                                          |
| `win`                                                               | `toggleMaximize()` → `WinState`                                               | invoke（请求+返回新状态）                                                                                                                                                                                                      | 三按钮最大化/还原（A3）                                       |
| `win`                                                               | `close()` → `void`                                                            | invoke（单向）                                                                                                                                                                                                            | 三按钮关闭（A3，会走现有 close-before-save 流程）                 |
| `win`                                                               | `onStateChange(cb: (state: WinState) => void)` → `off()`                      | 双向订阅（preload 广播）                                                                                                                                                                                                      | 外部 Aero Snap / 任务栏右键最大化 → 同步到渲染层图标（A2.3）            |
| `browser`                                                           | `attachPlatform(params: { platform: PlatformKey, seedUrl: string })` → `void` | invoke（单向）                                                                                                                                                                                                            | 切 Tab / 首次进入浏览器时懒创建 + 贴 BrowserView（B2/B4）          |
| `browser`                                                           | `setBounds(rect: DOMRectJSON)` → `void`                                       | invoke（单向）                                                                                                                                                                                                            | 响应式尺寸变化 / 抽屉开合 → 通知主进程 setBounds（B3/B6.6，C13 去抖后发送） |
| `browser`                                                           | `goBack() / goForward() / reload()` → `void`                                  | invoke（三条独立单向）                                                                                                                                                                                                        | 工具条后退/前进/刷新按钮真实动作（B6.1）                             |
| `browser`                                                           | `loadUrl(url: string)` → `void`                                               | invoke（单向）                                                                                                                                                                                                            | 地址栏回车真实动作（B6.2）                                     |
| `browser`                                                           | `extractDOM() → ExtractResult`                                                | invoke（请求+返回）                                                                                                                                                                                                         | 「解析并导入」按钮真实动作 + schema 结构化错误（B5/B6.4 + §1.3.6 E3）   |
| `browser`                                                           | `onUrlUpdated(cb: (url: string) => void)` → `off()`                           | 双向订阅                                                                                                                                                                                                                  | BrowserView did-navigate → 地址栏显示当前 URL（B6.2）        |
| `browser`                                                           | `onDownloadsUpdated(cb: (dls: DownloadTask[]) => void)` → `off()`             | 双向订阅                                                                                                                                                                                                                  | 浏览器下载挂总线 → 与下载徽章/下载列表合并（B6.3 + §3.3 Footer）         |
| **└─ A2 双模式推理 10 条（C14 清单扩展，实现前必须安全复核）** | | | |
| `ocr`                                                               | `imageToText(imageBuffer: ArrayBuffer) → OcrResult`                            | invoke（请求+返回）                                                                                                                                                                                                         | OCR 图片转文字：hybrid-auto 路由（§1.5.1）→ 本地 onnxruntime-node 或服务端 HTTP `/ocr/image-to-text`；Q2 红线：渲染层不允许直接 require onnxruntime-node |
| `vector`                                                            | `textToEmbedding(text: string) → {success, vector: number[], durationMs}`     | invoke（请求+返回）                                                                                                                                                                                                         | 文本 embedding：hybrid-auto 路由 → 本地 bge-small onnx 或服务端 HTTP `/embeddings/text-to-vector`（§1.5.1 决策分支） |
| `vector`                                                            | `search(query: string, topK: number) → {success, items, durationMs}`          | invoke（请求+返回）                                                                                                                                                                                                         | 知识库 ANN 检索：hybrid-auto 路由 → 本地 sqlite-vss vss0 虚拟表（Q4 红线：严格按 §1.5.3.1 建表 SQL 真实列名）或服务端 HTTP `/vector/search` |
| `knowledge`                                                         | `importFile(filePath: string, sourceType) → {success, documentId, progress}`  | invoke（请求+返回，进度经 progress 事件推送）                                                                                                                                                                                   | 导入 PDF/DOCX/TXT/MD → 切片 → 入库：纯客户端 JS 解析（pdf-parse/mammoth）→ 事务批量插入 doc_chunks + vss_doc_chunks（§1.5.3.2 规范）；完全不依赖 Python langchain（符合 P1 红线） |
| `knowledge`                                                         | `listDocuments(page, pageSize) → {success, items, total}`                     | invoke（请求+返回）                                                                                                                                                                                                         | 知识库文档列表查询：严格按 §1.5.3.1 documents 表列名（Recall 174008 唯一事实源） |
| `knowledge`                                                         | `deleteDocument(id: number) → {success}`                                       | invoke（单向，返回操作结果）                                                                                                                                                                                                      | 删除文档 + ON DELETE CASCADE 自动清理切片 + 向量（§1.5.3.1 级联约束） |
| `knowledge`                                                         | `rebuildVectorIndex() → {success, progress}`                                   | invoke（单向 + 进度事件）                                                                                                                                                                                                      | 手动重建 vss_doc_chunks 虚拟表索引；防止 embedding 模型升级后旧向量不兼容 |
| `image`                                                             | `coverCompose(params: CoverComposeParams) → {success, outFilePath}`           | invoke（请求+返回）                                                                                                                                                                                                         | 封面制作（sharp 4 维度落地：asarUnpack + rebuild + ≈30MB + 白名单 IPC，§1.4.2 封面制作行）；hybrid-auto 路由 → 下载 sharp 用本地，没下走服务端 `/material/cover-compose` |
| `model`                                                             | `getStatus() / startDownload() / cancelDownload() / uninstall()`              | invoke（4 条独立单向，getStatus 返回状态清单）                                                                                                                                                                                 | Settings → 高级选项「本地推理能力」卡片控制（§1.4.2 矩阵行）；下载走 HTTP Range 断点续传 + manifest SHA256 校验（§1.5.4） |
| `model`                                                             | `onStatusUpdate(cb: (status) => void) → off()`                                | 双向订阅（preload 广播）                                                                                                                                                                                                      | 模型下载进度 / 已下载字节 / SHA256 校验进度 → 挂全局下载总线与浏览器下载合并显示（§1.5.4.2） |
| 文件                                                                  | 改动类型                                                                          | 预计改动点                                                                                                                                                                                                                 | 与现有代码的关系                                            |
| ---                                                                 | ---                                                                           | ---                                                                                                                                                                                                                   | ---                                                 |
| `electron/main/main.js`                                             | 增量修改                                                                          | ① BrowserWindow 加 `frame:false` + macOS trafficLightPosition；② 新增 browser-view-pool（200\~300 行）；③ 新增 7 条 IPC handlers（win.\* 4 条 + browser.\* 3 条）；④ `mainWindow.on('resize/move')` 重算 bounds；⑤ `will-download` 挂下载总线 | 与现有 §4.1.1 安全基线叠加写入，不替换原内容                          |
| `electron/preload/preload.js`                                       | 增量修改                                                                          | `contextBridge.exposeInMainWorld('electronAPI', { win, browser })` 新增 2 个命名空间，共约 8\~10 条通道；与原有 `window.tintin.*` 并存                                                                                                   | 不影响 V2→V3 迁移 bridge IPC                             |
| `electron/types/browser-extract.d.ts`                               | 新增                                                                            | VideoItem / ExtractResult / WinState 类型定义                                                                                                                                                                             | 单源类型契约（与 server-api.ts 同规范）                         |
| `electron/main/extractors/{douyin,xhs,bilibili,weixin,kuaishou}.ts` | 新增（5 份）                                                                       | 每平台 30\~50 行 DOM 抽取脚本 + 统一 try/catch 返回 schema                                                                                                                                                                        | 与 BrowserView 池解耦，可独立测试                             |
| `electron/renderer/src/App.vue`                                     | 增量修改                                                                          | `<template>` 顶部插入 `.title-bar` 36px；`<script>` 新增 useWindowControl composable（调 electronAPI.win.\* + 监听 state-change）；样式新增标题栏 tokens 样式                                                                               | 原有 Header/Footer/router-view **零改动**                |
| `electron/renderer/src/views/Browser.vue`                           | 局部替换                                                                          | ① 移除 `webview-mock` 灰色占位块 \~10 行，替换为 `<div class="browser-view-host">`（空容器，仅作为 bounds 计算锚点）；② 新增 IPC 通信层（attach-platform / switch / set-bounds / extract） + watch 重算触发；③ 按钮动作指向真实 IPC 而不是 mock                        | 原有顶栏工具条 / 240px 左栏 / 平台 Tabs **外观和设计稿一致性 100% 保留**  |
| `electron/renderer/src/global.d.ts`                                 | 增量修改                                                                          | 补 `interface Window { electronAPI: { win, browser } }` TS 类型                                                                                                                                                          | 防止 TS 类型报错                                          |
| `docs/MIGRATION_V2_TO_V3_Full_Stack.md`                             | 增量修改                                                                          | 本节 §1.3 写入 + P1.5 里程碑 + 头部进度清单 + §1.4 移除 Python 影响 + **§1.5 A2 双模式规格（本节就是 A2 的规格源头）** | 就是你现在正在看的这一节                                        |
| **└─ A2 双模式推理 8 项新增文件（与厚壳化完全解耦，可独立实现/测试）** | | | |
| `electron/main/inference-router.js`                                 | **新增**（A2 核心单例） | ① 实现 §1.5.1 ASCII 决策流程图的「hybrid-auto / server-only / force-local」3 模式路由；② 本地异常自动 fallback 服务端 HTTP（Q3 红线：用户零感知）；③ 单例导出 `route(namespace, params)`，ocr/vector/image 4 个命名空间 100% 经此入口 | 不影响 main.js：main.js 只注册新 IPC handlers 到 inference-router（符合 C8 IPC 注册时序：whenReady 最早期 before createWindow） |
| `electron/main/ocr.js`                                              | **新增**（OCR 主进程模块） | ① 懒加载 PaddleOCR 3 个 onnx InferenceSession（冷启动不阻塞）；② 封装 `imageToText(buffer): Promise<OcrResult>`；③ 失败返回结构化 error（与 §1.3.6 E3 规则一致） | 与 inference-router 对接；渲染层只能通过 C14 白名单 `electronAPI.ocr.imageToText` 调用，Q2 红线 |
| `electron/main/embeddings.js` + `electron/main/vector-store.js`     | **新增**（B 选择 2 件套） | ① embeddings.js：懒加载 bge-small-zh.onnx → `textToEmbedding(text)` 返回 768 维向量；② vector-store.js：**Recall 174008 规范** → better-sqlite3 单例连接 userData/db/knowledge.db + 启动时严格执行 §1.5.3.1 4 条建表 SQL（唯一事实源）+ 统一 success/code/msg/data 返回格式 + 事务批量入库（Q4 红线：不允许臆测列名）+ sqlite_vss 扩展从 userData/native-addons/ 动态加载 | 与 C2 资源路径单一链一致：db/knowledge.db 只存 userData；备份迁移 = 拷贝一个 db 文件（符合"本地软件"预期） |
| `electron/main/model-download-manager.js` + `electron/main/model-manifest.json` | **新增**（下载器 + manifest） | ① model-manifest.json（§1.5.4.1 结构）= 随包携带，CDN 地址 + 14 个文件 SHA256 + 平台白名单；② model-download-manager.js = 全局单例下载器：HTTP Range 断点续传 + 每文件 crypto.createHash('sha256') 校验（失败删文件重试 2 次）+ 复用 download-manager.js EventBus 推送给 Footer 下载徽章 + 启动时 verifyInstallation()（§1.4.2 冷启动第 4 项检查）；③ 支持 uninstall() = 删 userData 下 models + native-addons 目录，释放 ≈140MB | Q1 红线：model 与 onnx 绝不打进安装包；下载失败/取消不阻塞启动（失败自动 server-only 模式） |
| `electron/types/{ocr,knowledge,embedding}.d.ts`                    | **新增**（3 份单源类型契约） | ① ocr.d.ts = OcrResult / OcrResultLine（§1.5.2.2）；② knowledge.d.ts = DocumentRow / ChunkRow / SearchResultItem（严格对应 §1.5.3.1 建表 SQL 列，Q4 红线保证「类型 ↔ SQL 列」双源一致）；③ embedding.d.ts = EmbeddingModel / VectorSearchParams | 与 server-api.ts 同规范；未来改列只改 SQL + 这 2 个类型（Recall 174008 成功经验 1） |
| `electron/renderer/src/views/Settings.vue`                          | **增量修改**（扩展插件分组加 2 张卡片） | ① 「本地推理能力」卡片（§1.4.2 矩阵行）= 显示状态（未下载/下载中/已下载/校验失败）+ 总大小 ≈140MB + 「一键下载/取消/卸载释放空间 + 后台静默更新开关」；② 「本地知识库管理」卡片 = 导入文件对话框 / 已入库文档分页列表 / 删除按钮 / 重建索引按钮；两张卡片均复用 Luosiding tokens 卡片样式，不新增色号 | 原有 6 个一级设置菜单（平台接入/本地配置/环境维护/扩展插件/任务队列/关于）+ 返回工作台按钮 **外观和设计稿一致性 100% 保留**；两张卡片塞在「扩展插件」分组下，不新增一级菜单 |
| `electron/renderer/src/global.d.ts`                                 | **增量修改**（扩展 electronAPI 类型） | Window.electronAPI 接口扩展 4 个命名空间（原 win/browser → 新增 ocr / vector / knowledge / image / model）→ 合计 5 命名空间 22 条 IPC（C14 总数）；补 `inference.mode` 等 electron-store 配置类型 | 与 §1.3.4 C14 白名单总表保持 1:1（类型 = 实现的唯一契约） |
| `electron/package.json` + `electron-builder.yml`                    | **增量修改**（原生模块 + asarUnpack 配置） | ① package.json：新增 dependencies（onnxruntime-node / better-sqlite3 已有 + sqlite-vss / sharp / pdf-parse / mammoth）+ 新增 scripts `"postinstall": "electron-rebuild -f -w onnxruntime-node,sqlite-vss,sharp"`（Recall 850755 标准 2：ABI 匹配 Electron，避免 self-register 报错）；② electron-builder.yml：新增 `asarUnpack: ["node_modules/onnxruntime-node/**", "node_modules/sharp/**", "node_modules/sqlite-vss/**"]`（Recall 850755 标准 1：.node + DLL 必须解包到 app.asar.unpacked 路径，走 §2.1 C2 资源路径单一链，避免第二套推导） | 不影响现有打包配置；Electron 版本必须固定为精确版本号（Recall 345519 Success 3 建议，防止 ^ 漂移导致原生模块 ABI 不匹配） |

***

### 1.3.5 本专项 UAT 验收标准（通过 = 厚壳化完成）

| 编号  | 验收项              | 通过判定                                                                                                                                                         |
| --- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| U1  | 窗口视觉             | Windows 系统标题栏完全不可见；自绘栏 36px 与 Luosiding tokens 完全融合；控制按钮 hover/active 状态视觉正常                                                                                 |
| U2  | 三按钮操作            | 最小化 / 最大化 / 还原 / 关闭 各点 10 次，10/10 生效，无穿透 bug                                                                                                                 |
| U3  | 状态记忆             | 关闭 → 重开 → 窗口位置 / 尺寸 / 最大化状态完全还原；拔掉副屏后不会出现在不可见区域                                                                                                              |
| U4  | BrowserView 抖音打开 | 首次切 /browser → 2s 内显示真实抖音首页；内部滚动正常；不覆盖顶栏/侧栏                                                                                                                  |
| U5  | 5 平台独立登录态        | 每个平台 Tab 切一遍，登录其中一个后切换其他平台 → cookie 不串；切回已登录平台 → 保持登录                                                                                                        |
| U6  | 路由 detach        | 切到工作台 Tab → 抖音页面不可见；切回 /browser → 页面还在（无刷新，保留滚动位置）                                                                                                           |
| U7  | 解析跨 Tab 推送       | 抖音列表页点「解析并导入」→ 工作台自动新建会话 + 10 条视频素材卡片结构正确（字段齐全）                                                                                                              |
| U8  | 响应式 bounds       | 窗口拖 1024×700 / 1440×900 / 最大化 三档，BrowserView 每档都对齐 DOM 容器不越界；侧栏展开/收起（≤900px 抽屉）→ bounds 立即正确重算                                                               |
| U9  | 安全基线审计           | 主进程 BrowserWindow 创建时打印 contextIsolation/nodeIntegration/sandbox 三字段值 → 与 §4.1.1 一致（true/false/true）；任何 IPC 通道不暴露 fs 全量读写；未出现 `window.require` / `remote` 调用 |
| U10 | 崩溃隔离             | 用 DevTools 手动 crash 抖音的 BrowserView WebContents → 主窗口、工作台、媒体工具其他 Tab 不崩溃，显示 1 秒后 BrowserView 自动恢复 `pool.delete + 重新 new`（最多 3 次）                             |

***

### 1.3.6 工程时序 & 降级策略（DPR 缩放 / 离线 / 抽取失败 三种场景）
> 14 条补充方案的 9~11 条。只写「规格没有覆盖的系统边界与降级路径」，代码实现按表格执行即可。

| 编号 | 场景 | 规格说明（What + Why） | 对应实现位置 |
|---|---|---|---|
| E1 | Windows DPI 125% / 150% / 175% 缩放漂移 | **结论**：BrowserView.setBounds 单位 = CSS 像素 = DOMRect 单位，**渲染层不要手乘 `window.devicePixelRatio`**。**主进程必须显式加两条**：① 启动时 `app.commandLine.appendSwitch('high-dpi-support', 'true')`；② BrowserWindow `webPreferences: { zoomFactor: 1 }`（防止 Chromium 内部 DPR 缩放导致 BrowserView 贴偏 1.25x/1.5x）。如果仍然出现贴偏（极个别 Intel 核显老驱动）→ 自动切 C4 的 `<webview>` 降级路径。 | main.js app 启动段 + BrowserWindow 创建段 |
| E2 | 首次切平台 Tab 但无网络（BrowserView 显示 Chromium "No internet" 大白页） | **必须主进程监听 `view.webContents.on('did-fail-load', (_, errCode, errDesc, url) => {...})`**：当 `errCode != 0` 且当前 BrowserView 为用户可见时，调用 `view.webContents.loadURL('data:text/html;charset=utf-8,...')` 注入 Luosiding tokens 风格的暗色「网络离线页」（配色与 tokens 一致：`background: var(--surface)` + 文案「网络连接失败，请检查网络后刷新重试」 + 一个 `点击刷新` 按钮触发 `window.location.reload()`），**绝对不允许显示 Chromium 默认白底的无网络页**（会给用户"软件是浏览器外套"的观感）。 | main.js browser-view-pool 创建 BrowserView 段 |
| E3 | 平台 DOM 抽取脚本失败（风控 / 登录态过期 / 反爬改版 / CAPTCHA） | **必须返回结构化错误，禁止只返回字符串 msg**：主进程 `extractors/*.ts` 的 try/catch 返回 `ExtractResult = { ok: boolean, data?: VideoItem[], error?: { type: 'NEED_LOGIN' | 'RISK_CAPTCHA' | 'DOM_MISMATCH' | 'NETWORK_ERROR', message: string, hint?: string } }`；Browser.vue 收到后按 type 分支：① NEED_LOGIN → 弹 toast「请先在右侧平台 Tab 扫码登录，再重新解析」+ 让 BrowserView focus；② RISK_CAPTCHA → 弹 toast「平台要求滑块/短信验证，请在 BrowserView 内完成后重试」+ 不切走当前页；③ DOM_MISMATCH → 记录 error 到 preload 日志 + 弹「平台页面结构已更新，请联系技术支持升级脚本」；④ NETWORK_ERROR → 提示「网络异常，3 秒后自动重试」（最多 2 次）。 | types/browser-extract.d.ts + extractors/*.ts + Browser.vue toast 分支 |

***

### 1.3.7 CI 门禁、回归互斥检查 & 打包兼容兜底（14 条补充方案的 12~14 条）
> 把"防回退 / 防踩坑"写成可执行的门禁，而不是口头约束。

| 编号 | 类型 | 规格说明 | 对应实现位置 |
|---|---|---|---|
| F1 | Playwright + Electron 冒烟 CI（Case 1：标题栏时序 & 按钮 no-drag） | 启动 Electron 主窗口 → 等待 window.thickShellReady === true → Playwright locator 取 `.title-bar .controls .btn-minimize / .btn-maximize / .btn-close` 三个 DOM 元素 → 断言三元素的 CSS 同时满足：① computedStyle.webkitAppRegion === 'no-drag'（按钮不会被 drag 父容器吞了点击，C3）；② computedStyle.zIndex > 父 `.title-bar` 的 zIndex（按钮能显示在 BrowserView 之上）。本 Case 不通过 = PR 不能合并。 | `tests/playwright/thick-shell-title.spec.ts` |
| F2 | Playwright + Electron 冒烟 CI（Case 2：IPC 注册时序 & 竞态防御） | 启动 Electron 后 100ms 内连续调用 `window.electronAPI.win.getState()` × 10 次 → 断言 10 次全部 resolve（状态有返回或 2s 降级默认值），没有任何一条 reject / Error: No handler registered。本 Case 不通过 = PR 不能合并（防止 C8 时序约束被开发时偷偷改回 whenReady 业务分支里注册 IPC）。 | `tests/playwright/thick-shell-ipc.spec.ts` |
| F3 | 回归互斥检查 grep 门禁（C1 三条 + remote 强拒绝） | CI 跑 `grep -rE "nodeIntegration:\s*true|contextIsolation:\s*false|require\(['\"]electron['\"]\)\.remote" electron/` → 如果 grep 有命中 = **直接 CI fail**。本门禁目的：防止某人为了调试临时改 BrowserWindow 三开关后忘了改回来，永久破坏安全基线（Recall 302020 Failure 2 的长期兜底）。 | `.github/workflows/electron-ci.yml` 的 prebuild step |
| F4 | 打包兼容故障开关 `TINTIN_USE_FRAME`（frame:false 的极端环境兜底） | **主进程启动时**，检查：① 命令行参数 `process.argv.includes('--enable-system-frame')`；② 环境变量 `process.env.TINTIN_USE_FRAME === 'true'`；③ electron-store 配置 `store.get('window.useSystemFrame') === true` → 三者任意一条命中，BrowserWindow 的 `frame` 字段强制切回 `true`（同时 macOS 端忽略 titleBarStyle），其余厚壳化功能（BrowserView 池 / IPC 白名单 / bounds 重算）仍然生效。**本开关必须与 C1 安全基线解耦**：只改 frame 字段，不允许改 contextIsolation/nodeIntegration/sandbox。场景：① 老 Intel 核显用户报告 frame:false 整窗全黑（GPU 驱动 bug）；② Win10 某些 LTSC 版本 Aero Snap 失效。 | main.js BrowserWindow 创建段 + Settings.vue 本地配置 → 新增「开启系统标题栏（兼容性模式）」Switch 行 + 重启生效提示 |

***

## 1.4 不捆绑本地 Python 运行时：功能影响评估与边界（厚壳化 P1.5 配套约束）
> 对应 3 条不变约束中的「① 不捆绑本地 Python 运行时（studio-legacy/bridge.exe 仅作过渡期兜底，不作为新功能依赖）」。结合 Experience 345519（PyInstaller + Electron 打包 python 运行时的 5 种失败路径：产物形态混淆 / 资源路径不稳 / Electron 版本漂移 / 在线下载 TLS 失败 / CLI 参数报错） → 本工程**从 V3 厚壳化开始，所有新增功能不得以 "本地有 Python 解释器 + pip 依赖" 为前提**。以下清单逐条说明"没有本地 Python 时，哪些功能不可用 / 降级 / 不变 / 用 Node.js 替代"。

### 1.4.1 影响分类总表（5 大类 · 覆盖一级菜单与后端全部 13 命名空间，**A2 双模式新增分类**）
| 分类 | 数量 | 说明 |
|---|---|---|
| 🆕 **A2 本地可选能力（用户主动下载后本地启用，未下载自动降级服务端，不依赖 Python / pip）** | 6 项 + 1 个知识库模块 | **OCR 图片转文字 / 文本 embedding 向量计算 / 知识库向量 ANN 检索（sqlite-vss）/ 封面制作（sharp 图片合成）/ 文档切片入库 / 离线知识库问答**。默认安装包**不带任何模型 / 扩展 DLL**（安装包体积与 A1 方案持平 ~140MB）；用户在 Settings → 高级选项 → 本地推理卡片点「一键下载」后，从官方 CDN 增量下载约 140MB onnx 模型文件 + sqlite-vss / sharp 原生扩展 DLL 到 `userData/models/` + `userData/native-addons/`，下载完成 + SHA256 校验通过后，所有功能自动切本地；下载失败 / 取消 / 未联网时**自动走服务端 HTTP 路线（§2.1 API_ENDPOINTS）**，用户零感知。本条属于「A2 双模式的核心新增能力」。 |
| 🟢 **保持 100% 可用（不依赖本地 Python，客户端纯 Electron 能力实现）** | 18 项（大头） | 工作台聊天 / 浏览器采集（厚壳化 BrowserView） / 系统设置 UI / 下载管理 / 窗口控制 / 打包分发 / 自动更新 / Tray 托盘 / 开机自启 / 文件对话框 / shell 外链打开 / 网络代理 / 崩溃恢复 3 次 / bounds 响应式重算 / 平台 cookie 隔离 / DOM 抽取结构化错误 等 |
| 🟡 **降级可用（改为走服务端 HTTP API 实现，前提：必须能连上 §2.1 的远程或内网服务端 API_ENDPOINTS；断网不可用）** | 9 项（媒体工具 Tab3 重灾区） | 图像抠图 / 视频修复 / 视频转文字 / 声音克隆 / 字幕去水印 / 图片反推提示词 / 视频混剪 / 数据分析 等所有"V2 原本地 Python sidecar 跑推理/转码"的功能，在 V3 厚壳化中**一律走 server-api.ts 中已定义的远程 HTTP 命名空间**（对应 §4.2 已落地的 26 条 IPC server-proxy.js），**不能要求本地有 Python + requirements.txt 可 pip install**。 |
| 🟠 **过渡期兜底可用（依赖 resources/studio-legacy/bridge.exe，仅保留 V2 历史用户的「已安装本地 Python 环境 + bridge 已启动」兼容场景，不作为新安装默认路径）** | 2 项 | ① 原 V2 脚本批量导出本地的 `.bat / .ps1` 兼容；② V2 已跑任务的断点续传（老任务进度文件读取与状态还原）。**新安装用户默认不启动 bridge.exe**，并且不把 Python 安装列为安装前向导必填项（与 Experience 345519 Failure 4 一致：不做运行时在线下载 Python embeddable 包）。 |
| 🔴 **完全不可用（禁止在 V3 厚壳化后以「本地 Python」为前提新增或修复）** | 3 项 | ① 本地启动 whisper.cpp / ffmpeg 之外的 Python 推理脚本 sidecar；② 本地 pip 动态安装 u2net/isnet/birefnet 等模型权重；③ Settings → 环境维护页面的「一键安装 Python 3.11 + pip install requirements.txt」引导流程必须移除（保留「启动/停止本地服务端 bridge」功能即可，但默认隐藏在高级选项里，不写在安装向导首屏）。 |

### 1.4.2 按一级页 & 后端模块细分影响矩阵
| 模块 / 一级页 | 功能点 | 依赖分类（上一节 4 色） | 实现路径（P1.5 起必须遵守） |
|---|---|---|---|
| **Tab1 工作台** | AI 聊天 / 脚本生成 / 任务状态轮询 / 会话列表存储 / Shot 卡片显示 | 🟢 保持可用 | 聊天消息推 → `window.tintin.server.*` 走 server-proxy.js HTTP；会话/Shot 存本地 SQLite（`better-sqlite3` Node 原生模块，不依赖 Python）；进度轮询 = 已实现 `tasksStore.pollTaskStatus()` |
| **Tab2 浏览器（厚壳化核心）** | 5 平台 BrowserView 真嵌入 / 登录态隔离 / DOM 抽取 / 后退前进刷新地址栏真实动作 / 解析并导入跨 Tab 推送 | 🟢 保持可用 | 全部走 §1.3 A/B/C 规格 + C14 白名单 IPC；DOM 抽取 = Chromium `executeJavaScript` 直接跑 TypeScript 抽取脚本（extractors/*.ts 编译后注入 BrowserView 主进程直接调用），**完全不依赖本地 Python 环境** |
| **Tab3 媒体工具（10 卡）** | AI 脚本创作（文案 LLM 生成）、一键成片（任务编排 + 进度轮询）、产品库管理、素材生成（图片/文本）、直播切片 | 🟢 保持可用 | 纯前端 UI + server HTTP 调用（产品库、素材库、成片任务编排 对应 server-api.ts 已有的 task/material 命名空间），不依赖本地 Python |
| （接 Tab3 媒体工具） | 音频素材、封面制作（图片多图层合成 + 尺寸调整 + 批量） | 🆕 A2 本地可选（未下载走服务端 HTTP，用户下载 sharp 原生扩展后 100% 客户端本地） | **V3 厚壳化封面制作 = Node.js `sharp`（C++ 原生模块，4 维度落地摘要：① 分发形态：`asarUnpack: node_modules/sharp/**`，把 sharp-win32-x64.node + libvips.dll 打进 app.asar.unpacked，走 §2.1 单一链 C2 资源路径；② 兼容性：`electron-rebuild -f -w sharp` 匹配 Electron ABI，避免「Module did not self-register」（Recall 850755 经典失败）；③ 体积：Windows x64 净增 ≈30MB（sharp.node 2MB + libvips 28MB）；④ 暴露方式：和 ffmpeg-gate.js 一样走白名单 IPC `image:cover-compose / matte-blur-bg / export-jpg`，渲染层只能传参数，不能直接 require sharp（严格符合 C1 安全基线）**。A2 双模式：用户没下载 sharp DLL 时，封面制作自动走服务端 `/material/cover-compose` HTTP（用户零感知），下载后自动切本地 → 断网仍可用。完全不依赖 Python Pillow/PIP。**完全符合「你这个是客户端不是服务端」的定位**。 |
| （接 Tab3 媒体工具） | 视频修复、视频混剪、数据分析、视频转文字（Whisper）、声音克隆、字幕去水印、图片反推、图像抠图 | 🟡 降级走服务端 HTTP API | 全部走 server-api.ts 已有的 `/vsr /asr /tts /remove /reverse_prompt /matting` 13 个后端命名空间；**V3 厚壳化后不允许客户端要求本地有 Python + 对应 Python 包可 import**。断网时页面必须显示「当前需连接服务端才能使用该媒体工具」的 Luosiding tokens 风格空状态卡片（设计稿空状态样式复用），不允许显示 500。 |
| **Settings 系统设置** | 平台接入、本地配置（路径、窗口、默认 Tab）、扩展插件安装、任务队列查看 | 🟢 保持可用 | 配置写入 electron-store（Node 原生 JSON 存储）；任务队列查询 → server HTTP `task.list` |
| **Settings → 环境维护** | Python 环境一键安装、pip install requirements.txt、模型权重下载 10GB | 🔴 完全不可用（移除首屏引导；保留在「高级选项」但默认隐藏） | 环境维护页面首屏改为 3 个按钮：① 启动本地服务端（bridge.exe，若存在）→ 走 studio-legacy 兜底；② 打开服务端配置（IP/端口） → 已存在；③ 检查服务端连接 → 已实现。**删除「安装 Python / 安装 pip 依赖 / 下载模型权重」这三个 V2 时代按钮**，避免给用户"必须本地装 Python 才能用"的误解（符合不捆绑本地 Python 的顶层约束） |
| **资源路径与构建打包（§2.1 + §6）** | 随包携带 Python 嵌入式运行时 + pip 依赖目录 | 🔴 完全不可用（不允许再走 Experience 345519 的 embeddable 目录策略） | extraResources 仅允许 3 类（§2.1 单一链 C2）：resources/bin/{ffmpeg,ffprobe}.exe / resources/icons / resources/studio-legacy/bridge.exe（过渡期 bridge 兜底单文件 ≤30MB）。**严禁再新增 resources/python-3.11-embed-amd64.zip 或对应解压目录**（避免 Recall 345519 Failure 1/4：TLS 失败 / 产物形态混淆 / 资源路径不稳）。 |
| **启动流程（§2.3）** | 冷启动前检查：Python 版本 ≥ 3.11 / venv 是否存在 / pip 是否可用 | 🔴 完全不可用（删除 V2 原 pre-flight check） | V3 厚壳化后，冷启动前检查仅保留 3 项（§2.3 不变）：① ffmpeg/ffprobe 是否存在 + 可执行权限；② SQLite DB 文件是否可读写；③ 与服务端 API_ENDPOINTS 是否通（60s 轮询 health）。**不再检查 Python 版本 / venv / pip**，否则会给新安装用户一个"你缺少 Python 环境 → 无法启动软件"的硬阻塞，与 V3 「软件就是原生桌面软件、浏览器只是一个子 Tab」定位严重冲突。 |
| **工作台 / 媒体工具 / 全局（A2 双模式 OCR）** | 截图识别文字 / 产品图片 OCR 提取文案 / 上传图片自动提取关键字 | 🆕 A2 本地可选（未下载走服务端 `/ocr/image-to-text` HTTP） | A2 本地路线：onnxruntime-node（C++ 原生，无需 Python）+ PaddleOCR INT8 3 件套 onnx 模型（det + rec + cls ≈20MB），冷启动时主进程从 `app.getPath('userData')/models/onnx/` 加载；A2 双模式：用户未下载模型时，所有 OCR 调用**自动路由到服务端 HTTP API `/ocr/image-to-text`**（用户零感知）；下载完成后自动切本地 → 断网仍可用 + 隐私合规（图片不上传）。详细规格见 §1.5。 |
| **工作台 Shot 卡片 / 全局（A2 本地知识库向量检索 ← 你选的 B）** | 文档/脚本/聊天记录切片 → 生成 embedding 向量 → 本地 ANN 相似检索 → 离线知识库问答（RAG） | 🆕 A2 本地核心能力（100% 本地 better-sqlite3 + sqlite-vss，用户 B 选择） | **你选 B：知识库默认走本地 better-sqlite3**（不依赖服务端 Milvus/pgvector）。架构：① 切片文本 → 本地 onnxruntime-node 加载 bge-small-zh onnx（≈100MB）计算 768 维 FP16 向量；② 向量 + 元数据写入 `knowledge.db`（`app.getPath('userData')/db/knowledge.db`，SQLite 单文件，备份/迁移 = 拷贝 db 文件即可）；③ ANN 检索用 sqlite-vss 扩展（C 原生扩展≈5MB）的 `vss0` 虚拟表做余弦距离 Top K。A2 双模式：如果用户连 embedding 模型都没下载 → 向量计算/检索走服务端 `/embeddings/text-to-vector` + `/vector/search` HTTP（断网不可用）；下载完成后 100% 本地（隐私合规 + 离线可用）。**建表 SQL 作为唯一事实源（Recall 174008 失败教训：不能臆测字段）详见 §1.5.3。** |
| **全局（A2 双模式 知识库管理）** | 导入文件（PDF/DOCX/TXT/MD）→ 切片 → 入库；查看已入库文档列表；删除；手动重建向量索引 | 🆕 A2 本地核心能力（主进程 + Settings → 知识库管理卡片） | 100% 客户端本地：PDF 解析用 `pdf-parse`（JS 纯实现）、DOCX 用 `mammoth`（JS 纯实现），切片用 JS 滑动窗口；全部走主进程白名单 IPC `knowledge:import-file / list / delete / rebuild`；**完全不需要 Python 的 PyPDF2 / langchain**（符合 §1.4.3 P1 红线）。 |
| **Settings → 高级选项 → 本地推理卡片** | 一键下载 ~140MB onnx 模型 + sqlite-vss/sharp DLL；查看当前下载状态 / 已下载大小 / SHA256 校验状态；一键卸载释放空间；是否允许后台静默增量更新 | 🆕 A2 本地核心能力（渲染层卡片 + 主进程 model-download-manager.js） | 设计稿 Settings 左栏"扩展插件"分组下新增「本地推理能力」卡片（Luosiding tokens 视觉，不新增色号）：显示 ① 当前状态（未下载 / 下载中 / 已下载 / 校验失败）；② 总大小 ≈140MB（OCR 35MB + embedding 100MB + sqlite-vss 5MB）；③ 「一键下载 / 取消 / 卸载释放空间」按钮。下载器走 HTTP Range 断点续传 + 下载完成 SHA256 校验清单（防止下载损坏）+ 挂全局下载总线（与 Browser 下载徽章/列表合并，§3.3 Footer）。后台静默更新默认关闭，用户手动开。详细规格见 §1.5.4。 |
| **冷启动前检查（§2.3 追加，不覆盖现有 3 项）** | A2 本地推理能力检测：模型文件是否齐全 / SHA256 是否正确 / onnxruntime-node / sqlite-vss / sharp 原生 .node 是否能成功 require | 🆕 A2 非阻塞检查（失败不影响启动，自动降级服务端） | 冷启动第 4 项检查：`model-manager.js → verifyInstallation()` → 任何一项失败 → 自动写入 `electron-store('inference.mode': 'server-only')` → 所有 OCR/向量/封面调用走服务端 HTTP，**绝不阻塞用户启动软件**（与 §1.4.3 P1 红线一致：绝不因为缺少本地能力而让用户启动不了）。检查通过才写 `inference.mode: 'hybrid-auto'`（混合自动路由）。 |

### 1.4.3 红线：两条不可逾越（与 §1.3.3 C1/C2 同级）
| 编号 | 红线（不可违反） | 违反后果（对应 Experience 345519 Failure 根因） |
|---|---|---|
| P1 | 任何「V3 新功能」不得以「用户必须本地安装 Python 解释器 + pip 依赖」为启动或功能前置条件 | Recall 345519 Failure 4：你在用户机器上在线下载 Python embeddable → 大部分公司内网 / 家庭网络会 TLS 报错 / 403 被墙 → 软件安装完不能用，用户直接卸载；同时 Recall 345519 Failure 1/2：打包 123.exe 单文件时很容易把安装器和便携版搞混，用户双击就报错找不到 python.exe |
| P2 | 所有「V2 时代依赖本地 Python 推理/转码/抠图」的媒体工具，在 V3 中必须有**降级到服务端 HTTP API**的完整实现；断网时显示空状态卡片，不显示 500 / 报错堆栈 | 不降级会导致：用户一打开 Tab3 媒体工具 → 9 张卡片全报错 → 误以为软件"坏了"，而不是"服务端离线"；同时会给人一种"这软件必须本地装一堆 Python 依赖才能跑起来"的错觉（违反你要求的「不是浏览器外套、是本地软件」定位）。 |

***

## 1.5 双模式推理架构规格（A2：本地 + 服务端自动降级 + 本地知识库 better-sqlite3）
> 你选定的 A2（默认安装不带模型，用户主动一键下载 ≈140MB 后启用本地推理，不下载自动走服务端）+ B（知识库走本地 better-sqlite3 + sqlite-vss）的**完整落地规格**。所有能力均基于 Node.js C++ 原生模块（onnxruntime-node / sqlite-vss / sharp / better-sqlite3）+ onnx 模型文件，**完全符合 §1.4.3 P1 红线：不依赖任何 Python 解释器 / pip / venv**。本节与 §1.3 厚壳化规格平级。

---

### 1.5.1 双模式自动路由决策流程（A2 核心：用户零感知切换）
> 每次调用 OCR / Embedding / Cover Compose / Vector Search 前走一次下面的决策分支（主进程 `inference-router.js` 单例统一实现，渲染层不做决策，保持 C10 主渲染职责边界）。

```
  调用方（渲染层 Browser.vue / Workbench.vue / MediaTools.vue）
        │
        ▼  调 electronAPI.ocr.imageToText(buffer) 等白名单 IPC
  【主进程 inference-router.route() ← 单例总入口】
        │
        ├─ ① 查 electron-store('inference.mode') →
        │     ├─ = 'server-only'（默认新安装 / 冷启动检查失败）→ 走 HTTP 分支 ▼▼▼
        │     ├─ = 'force-local'（用户强制本地，失败直接返回 LOCAL_NOT_READY 错误卡片）→ 本地分支 ▲▲▲
        │     └─ = 'hybrid-auto'（A2 默认路由，检查通过才设为此值）→ 走下面两步判断 ▼
        │
        ├─ ② hybrid-auto 本地前置检查：
        │     ├─ onnxruntime-node / sqlite-vss / sharp 是否 require 成功？
        │     ├─ 对应模型文件是否齐全 + SHA256 校验通过？
        │     └─ 最近 1 次本地推理耗时 < 2s 阈值？（防止老机器本地太慢自动切回服务端）
        │
        ├─ ③ 三条全 YES → ────── 走【本地分支】──────
        │     │                  ├─ OCR → onnxruntime-node + PaddleOCR onnx（主进程内存已加载）
        │     │                  ├─ Embedding → onnxruntime-node + bge-small-zh onnx（主进程内存已加载）
        │     │                  ├─ Cover Compose → sharp libvips（app.asar.unpacked 已定位）
        │     │                  └─ Vector Search → better-sqlite3 + sqlite-vss vss0 虚拟表（单例连接）
        │     │
        │     └─ 本地执行【异常兜底】：抛错 / 耗时 >5s / 返回空结果 → 自动 fallback 到服务端 HTTP（用户零感知）→ 记录 fallbackReason 到日志
        │
        └─ 任意一条 NO → ────── 走【服务端 HTTP 分支】──────
                              ├─ OCR → server-proxy.js `POST /ocr/image-to-text`（已落地 server-api.ts 契约）
                              ├─ Embedding → server-proxy.js `POST /embeddings/text-to-vector`
                              ├─ Cover Compose → server-proxy.js `POST /material/cover-compose`
                              ├─ Vector Search → server-proxy.js `POST /vector/search`
                              └─ HTTP 分支异常兜底：超时 / 404 / 500 → 渲染层显示 Luosiding tokens 空状态卡片（§1.4 🟡 黄类降级规范）
```

---

### 1.5.2 本地 OCR 规格（PaddleOCR INT8 + onnxruntime-node）
#### 1.5.2.1 资源清单（全部下载到 userData，不打进安装包）
| 资源名 | 下载位置（§2.1 单一链 C2 路径：`app.getPath('userData')/models/onnx/`） | 文件大小 | SHA256（写死在 main/model-manifest.json 做校验） |
|---|---|---|---|
| PaddleOCR det 检测（INT8 量化） | `paddle_det_int8.onnx` | ≈4MB | 写死在 `model-manifest.json` |
| PaddleOCR rec 识别（INT8 量化 + 中文词典） | `paddle_rec_int8.onnx` + `paddle_rec_dict.txt` | ≈12MB + 200KB | 写死在 `model-manifest.json` |
| PaddleOCR cls 方向分类（INT8 量化） | `paddle_cls_int8.onnx` | ≈2MB | 写死在 `model-manifest.json` |
| onnxruntime-node 原生绑定（Electron ABI 匹配） | `onnxruntime-win32-x64.node` + `onnxruntime.dll`（从 npm 官方预编译包按平台选） | ≈15MB | DLL 随安装包 `asarUnpack: node_modules/onnxruntime-node/**` 一起携带（不下载，属于原生模块随包） |
| **合计 OCR 部分需要用户下载** | 模型 3 文件 + 词典 | ≈~18MB（OCR 模型部分，sqlite-vss / sharp / embedding 另算） | |

#### 1.5.2.2 调用规格（接口契约 + 返回格式）
```typescript
// electron/types/ocr.d.ts ← 单源类型契约（与 server-api.ts 同规范）
export interface OcrResultLine { bbox: [number, number, number, number]; text: string; confidence: number }
export interface OcrResult { success: boolean; durationMs: number; lines: OcrResultLine[]; error?: 'LOCAL_NOT_READY' | 'TIMEOUT' | 'EMPTY_RESULT' | 'HTTP_500' }

// 主进程调用伪代码（ocr.js）：
// 主进程冷启动时（只在 inference.mode !== 'server-only' 时）懒加载 3 个 InferenceSession，避免冷启动阻塞 1s+
const sessions = { det: lazy(() => ort.InferenceSession.create(userDataPath + '/models/onnx/paddle_det_int8.onnx')), ... };
```

---

### 1.5.3 本地知识库向量 & 存储规格（B 选择：better-sqlite3 + sqlite-vss）
> **Recall 174008 失败教训：任何 better-sqlite3 CRUD 必须以「建表 SQL」为唯一事实源，绝不臆测字段**。下面 4 条 SQL 为本模块的不可变事实源，所有代码只允许用这里的表名/列名。

#### 1.5.3.1 建表 SQL（唯一事实源 ← 实现必须严格遵守）
```sql
-- knowledge.db: app.getPath('userData')/db/knowledge.db（冷启动单例连接，Recall 174008 单例模式）
-- PRAGMA 必设（性能 + 数据安全）
PRAGMA journal_mode = WAL;       -- 多线程读写不锁表（sqlite-vss vss0 需要）
PRAGMA synchronous = NORMAL;
PRAGMA cache_size = -64000;      -- 64MB page cache（10 万条向量检索 <10ms）

-- 表 1：文档主表（Recall 174008 必须先写真实列名 ← 唯一事实源）
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,        -- 文档自增主键
  source_name TEXT NOT NULL,                   -- 文件名（xx.pdf / 导入时显示名）
  source_type TEXT NOT NULL CHECK (source_type IN ('pdf','docx','txt','md','manual','chat')), -- 来源类型
  source_path TEXT,                            -- 原始文件绝对路径（manual/chat 类型为空）
  total_chunks INTEGER NOT NULL DEFAULT 0,     -- 切片总数（用于 UI 显示进度）
  created_at INTEGER NOT NULL,                 -- 入库 Unix 毫秒（Date.now()）
  updated_at INTEGER NOT NULL,                 -- 最后修改毫秒
  metadata TEXT NOT NULL DEFAULT '{}'          -- 扩展字段（JSON.stringify）：作者、标签、来源平台等
);
CREATE INDEX IF NOT EXISTS idx_documents_source_name ON documents(source_name);
CREATE INDEX IF NOT EXISTS idx_documents_created_at ON documents(created_at DESC);

-- 表 2：文档切片表（每一条切片 = 一行）
CREATE TABLE IF NOT EXISTS doc_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,        -- 切片自增主键
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE, -- 关联文档主表（删除文档级联删所有切片）
  chunk_index INTEGER NOT NULL,                -- 第几个切片（0 起）
  content TEXT NOT NULL,                       -- 切片纯文本内容（UTF-8，≤512 tokens）
  char_start INTEGER NOT NULL,                 -- 在原文档中的字符起始位置（回显高亮用）
  char_end INTEGER NOT NULL,                   -- 在原文档中的字符结束位置
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_document_id ON doc_chunks(document_id);

-- 表 3：sqlite-vss 向量虚拟表（ANN 检索专用，Recall 174008 真实列名）
--   注意：sqlite-vss vss0 虚拟表固定格式：embedding（BLOB 向量）+ rowid（对应 doc_chunks.id）
.load sqlite_vss;  -- 主进程启动时从 userData/native-addons/sqlite-vss.dll 加载扩展
CREATE VIRTUAL TABLE IF NOT EXISTS vss_doc_chunks USING vss0(
  chunk_embedding(768)  -- bge-small-zh 768 维 FP16
);
-- 说明：插入向量时 INSERT INTO vss_doc_chunks(rowid, chunk_embedding) VALUES (@chunkId, @vectorBlob);
-- 检索时 SELECT rowid, distance FROM vss_doc_chunks WHERE chunk_embedding MATCH @queryVector AND k = @topK ORDER BY distance;

-- 表 4：知识库设置（单例表，只有 1 行，存 chunkSize/overlap 等切片参数）
CREATE TABLE IF NOT EXISTS knowledge_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),        -- 强制只有 1 行
  chunk_size_tokens INTEGER NOT NULL DEFAULT 512,
  overlap_tokens INTEGER NOT NULL DEFAULT 64,
  embedding_model TEXT NOT NULL DEFAULT 'bge-small-zh-v1.5-onnx-int8',
  updated_at INTEGER NOT NULL
);
```

#### 1.5.3.2 better-sqlite3 调用规范（对齐 Recall 174008 成功经验）
| 项目 | 规范（防止 Recall 174008 失败：臆测字段 / 连接泄漏） |
|---|---|
| **单例连接** | `electron/main/vector-store.js` 导出 `getKB(): Database` 单例，用 `app.getPath('userData')/db/knowledge.db` 作为唯一路径；冷启动检查失败（SQLITE_CANTOPEN）→ 自动降级服务端 HTTP，不报错。 |
| **统一返回格式** | 所有 CRUD 返回 `{ success: boolean; code: number; msg: string; data?: T; durationMs: number }`，对齐 Recall 174008 成功经验 1：「复用既有模块返回结构，保证调用方一致」。 |
| **字段映射（唯一事实源）** | 所有 SQL 的列名必须严格等于上面的建表 SQL（documents.id / source_name / source_type / total_chunks / created_at...；doc_chunks.id / document_id / chunk_index / content / char_start...）；禁止出现 `name / description / text` 这类臆测列名。 |
| **向量事务批量入库** | 导入一篇文档 = `BEGIN IMMEDIATE; INSERT documents; INSERT doc_chunks × N; INSERT vss_doc_chunks × N; COMMIT` 一个大事务；防止半入库（文档插了切片没插）。 |

---

### 1.5.4 模型下载 & 安装管理（A2 关键：断点续传 + SHA256 校验 + 下载总线）
#### 1.5.4.1 manifest 清单（`electron/main/model-manifest.json`，随包携带，不允许运行时修改）
> 下载/校验的唯一事实源。新增模型版本时必须改 manifest 的 version 字段 → 用户后台静默更新（默认关闭）。
```json
{
  "version": "2026.08.25",
  "cdnBase": "https://cdn.tintin-ai.com/models/v1/",
  "inferencePkgs": [
    { "id": "ocr-paddle-int8", "files": [
      {"name":"paddle_det_int8.onnx","sha256":"aaaaaaaaaaaaaaaaaaaaaaaa","size":4194304},
      {"name":"paddle_rec_int8.onnx","sha256":"bbbbbbbbbbbbbbbbbbbbbbbb","size":12582912},
      {"name":"paddle_cls_int8.onnx","sha256":"cccccccccccccccccccccccc","size":2097152},
      {"name":"paddle_rec_dict.txt", "sha256":"dddddddddddddddddddddddd","size":204800}
    ], "totalSize": 19079168 },
    { "id": "embedding-bge-small-zh", "files": [
      {"name":"bge_small_zh_v1.5_int8.onnx","sha256":"eeeeeeeeeeeeeeeeeeeeeeee","size":104857600}
    ], "totalSize": 104857600 },
    { "id": "native-addons-sqlitevss-sharp", "files": [
      {"name":"sqlite-vss-win32-x64.node","sha256":"ffffffffffffffffffffffff","size":4194304},
      {"name":"sqlite_vss.dll",             "sha256":"gggggggggggggggggggggggg","size":1048576}
    ], "totalSize": 5242880, "platformOnly": ["win32-x64"] }
  ],
  "totalDownloadSizeBytes": 129180032
}
```

#### 1.5.4.2 下载流程（断点续传 + 挂全局下载总线）
1. **HTTP Range 断点续传**：下载中途关闭软件 → 下次「继续下载」从 `downloads.store` 的已下载字节数开始发 `Range: bytes=xxx-`，不从头下。
2. **每文件 SHA256 校验**：文件下载完成 100% → 立刻 `crypto.createHash('sha256').update(fs.createReadStream(path)).digest('hex')` 校验；失败 → 删文件重试 2 次，仍失败 → 标记「校验失败，点击重试」。
3. **挂全局下载总线**：与 §3.3 浏览器 Tab 的下载徽章/列表 + Footer 的下载进度**完全合并**（复用 `electron/main/download-manager.js` EventBus）→ 用户在浏览器下载和模型下载之间不用切页面。

---

### 1.5.5 A2 红线 4 条（与 §1.3.3 C1~C14 同级，违反 = A2 双模式专项未通过）
| 编号 | 强约束 | 违反后果（根因） |
|---|---|---|
| Q1 | **绝不把 onnx 模型文件、sqlite-vss.dll、onnxruntime.dll 打进 NSIS 安装包**（默认安装包保持 ~140MB 小体积）；只有用户主动点 Settings → 「一键下载」后才从 CDN 下载到 userData | 违反 = 用户新安装包体积膨胀到 300MB+，与 A2 "默认轻量、按需下载" 的定位冲突；同时违反 345519 Failure 1/2：打包产物与安装器混淆、资源路径不稳 |
| Q2 | **inference-router 必须是主进程单例唯一入口**；渲染层不允许直接 require onnxruntime-node / better-sqlite3 / sharp；所有调用必须走 C14 扩展的 ocr/vector/image/model 7 条 IPC 白名单 | 违反 = C1 安全基线（contextIsolation:true / nodeIntegration:false）永久被破，渲染层能拿到全量 Node fs/process API → 安全审计 U9 不过 |
| Q3 | **hybrid-auto 本地推理失败必须自动 fallback 到服务端 HTTP，用户零感知**；绝不因为"本地模型损坏 / DLL 加载失败"让 OCR / 向量 / 封面制作功能直接报错。只有用户手动把 inference.mode 设置为 force-local 时才允许报错。 | 违反 = 软件一升级 / 一换机器 → 本地能力坏了，用户看到一堆错误 → 误以为软件"经常坏"，不符合"本地软件稳定可用"的预期 |
| Q4 | **知识库建表 SQL 是唯一事实源**：任何 documents / doc_chunks / vss_doc_chunks 的 CRUD，必须严格使用 §1.5.3.1 真实列名；新增列必须改 SQL + 写迁移脚本（`migrations/001_add_documents_tags_column.sql`），禁止在代码里「直接 INSERT 一个没建表的字段」。 | 违反 = Recall 174008 典型失败：开发时臆测 documents 表含 `tags` 字段 → 线上 SQLITE_ERROR: table documents has no column named tags → 工单一大堆。 |

***

## 2. 工程目录构造 & 启动脚本 & 构建

### 2.1 实际目录树（已落地 vs PRD §3.6 标准）

```
TinTin_Client_Electron/                          ← 项目根（start-dev.bat / docs / electron 并列）
├── docs/                                        ← 所有规格文档（PRD / DESIGN / 6 份 V2 接口 / 本文档）
│   ├── PRD_Electron_v3_SchemeA.md
│   ├── DESIGN_Electron_v3.md
│   ├── V2_模块调用流程与客户端服务端分工.md          ← 服务端接口总表 §2 模块调用流程
│   ├── V2_* 接口文档（共 6 份）
│   └── MIGRATION_V2_TO_V3_Full_Stack.md        ← 本文档
├── resources/                                   ← electron-builder extraResources 源目录（需准备）
│   ├── bin/   ffmpeg.exe, ffprobe.exe           ← 约 100MB
│   ├── icons/ icon.ico / tray-win.png           ← 托盘 + 窗口图标
│   └── studio-legacy/ bridge.exe                ← 过渡期 PySide6 HTTP 桥（PyInstaller 单文件 ≤30MB）
├── build/                                       ← electron-builder buildResources
└── electron/                                    ← Electron 工程根（package.json 主）
    ├── package.json                             ← scripts / dependencies / build.* 打包配置
    ├── tsconfig.json                            ← TS 编译 + 6 组路径别名
    ├── types/
    │   ├── global.d.ts                          ← interface TintinBridge（8 命名空间）+ TintinBridgeServer（29 业务方法）
    │   └── server-api.ts                        ← 单源契约：API_PATHS + 13 命名空间 Request/Response + Common 通用类型
    ├── main/                                    ← Electron Main Process（纯 JS，不经过 Vite）
    │   ├── main.js                              ← 单例锁 / 窗口创建 / 崩溃恢复 3 次 / IPC dialog/shell/app
    │   ├── tray.js                              ← 系统托盘 + 开机自启
    │   ├── updater.js                           ← electron-updater initUpdater
    │   ├── server-proxy.js                      ← HTTP 代理层：API_ENDPOINTS + resolveEndpoint + 26 业务 IPC handlers
    │   ├── download-manager.js                  ← 浏览器 + 媒体工具共用下载池（EventBus）
    │   └── ffmpeg-gate.js                       ← ffmpeg 白名单子命令（probe/concat/embedCover/extractThumb/extractAudio）
    ├── preload/                                 ← Context Isolation 预加载桥（contextBridge.exposeInMainWorld）
    │   ├── preload.js                           ← window.tintin.* 8 命名空间 + _withUploadProgress 上传进度
    │   └── browser-webview.js                   ← 浏览器 Tab webview content-script：抖音/B站/YouTube 元素嗅探
    └── renderer/                                ← Vue 3 渲染层（Vite 构建）
        ├── index.html
        ├── vite.config.ts                       ← root/base/server:127.0.0.1:5173 strictPort + webview 自定义元素 + vue 拆包
        ├── dist/                                ← build:renderer 产物（index.html + assets/ 24 JS + 14 CSS）
        └── src/
            ├── main.ts                          ← createApp + Pinia + VueRouter 注入
            ├── App.vue                          ← 三明治壳：顶栏 / 三 Tab 内容 keep-alive / 底栏
            ├── router/index.ts                  ← 三条一级路由（工作台 / 浏览器 / 媒体工具）+ 工作台子路由位
            ├── env.d.ts                         ← declare module '*.vue'
            ├── styles/
            │   ├── tokens.css                   ← Luosiding 设计 tokens + Cherry Studio 冷静中性层
            │   └── global.css                   ← 全局重置 + 排版 + 滚动条 + 骨架屏动画
            ├── stores/                          ← Pinia 4 个 store 拆分
            │   ├── app.ts                       ← 全局 UI 状态（activeTab / theme / serverPort…）
            │   ├── server.ts                    ← 服务端在线状态 + 12 能力开关 + capabilityDetail + registry + workbenchStats
            │   ├── downloads.ts                 ← 下载池（浏览器 + 媒体工具合并）
            │   └── tasks.ts                     ← 成片任务：分页筛选 + a_* 子任务树 + progress 轮询
            ├── views/                           ← 4 个一级页面（设计稿 1:1 对齐）
            │   ├── Workbench.vue                ← Tab1 工作台：260px 会话侧栏（今天/昨天/更早分组 + 新建会话 + 系统设置入口） + 聊天主区（消息气泡 + 脚本镜头卡 + 底部输入框）
            │   ├── Browser.vue                  ← Tab2 浏览器：48px 工具条（前进/后退/刷新 + 胶囊地址栏 + 锁 + 解析并导入 + 下载徽章） + 240px 左栏（浏览历史分组 + 下载管理进度卡） + 平台 Tabs + BrowserView 占位
            │   ├── MediaTools.vue               ← Tab3 媒体工具：10 张卡片无分组网格（AI脚本创作/一键成片/产品库管理/素材生成/音频素材/视频混剪/直播切片/数据分析/视频修复/封面设计），渐变图标 + HOT 徽章 + 5/4/3/2/1 列响应式
            │   └── Settings.vue                 ← 新页面 系统设置（一级路由 /settings）：240px 菜单（平台接入/本地配置/环境维护/扩展插件/任务队列/关于 + 返回工作台） + 右区分段控件 + 开关行 + 本地配置 + 环境维护按钮 + 关于卡
            └── components/                      ← 子组件
                ├── common/                      ← 自研基础组件（不引入任何 UI 库）
                │   ├── TButton.vue              ← 5 种变体：primary/secondary/ghost/danger/icon
                │   ├── TCard.vue                ← 卡片 + 可选 4px accent bar
                │   ├── TInput.vue / TSelect.vue ← 表单控件 + 错误态 + focus ring
                │   ├── TDialog.vue              ← 遮罩弹窗（960×640 ShotMaterialDialog 规格）
                │   ├── TNotification.vue        ← 右上角 toast：success/warning/error
                │   ├── TTable.vue               ← 12 列成片任务表格基类
                │   └── VideoPreview.vue         ← HTML5 视频弹窗预览
                └── media-tools/                 ← 8 个工具表单（V3 媒体工具 Tab3 实际渲染）
                    ├── CoverMaker.vue           ← 封面制作（多图层 / 尺寸 1:1 / 9:16 / 16:9 / 批量 1~16）
                    ├── ImageMatting.vue         ← 图像抠图 S1：u2net/isnet/birefnet + α 细化 + bg_color
                    ├── VideoRepair.vue          ← 视频修复 S2：mode + scale + fps + denoise + face_restoration + trim
                    ├── VideoTranscribe.vue      ← 视频转文字：whisper /asr（服务端版）
                    ├── VoiceClone.vue           ← 声音克隆 /tts/clone 上传参考音 + 文本 ≤20s
                    ├── SubtitleRemoval.vue      ← 视频去水印字幕 /vsr/remove（服务端版）
                    ├── ReversePromptImage.vue   ← 图片反推提示词 S3：count(1~8)/style/language=zh+en
                    └── ReversePromptVideo.vue   ← 视频反推提示词 S3：frame_count 抽帧 + 跨帧合并
```

### 2.2 开发启动：start-dev.bat 一键启动（ASCII-safe，全 Windows locale 兼容）

👉 文件：[start-dev.bat](file:///d:/Project/TinTin_Client_Electron/start-dev.bat)

流程（4 步，均有英文提示与失败修复 hint）：

```
1. 环境自检：where node / where npm；缺失直接 exit/b 1
2. 首次安装：若 electron/node_modules 不存在 → pushd 到 electron/ 执行 npm install
   - 提示国内镜像加速：
       npm config set registry https://registry.npmmirror.com
       set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
   - 失败修复：rmdir node_modules\electron 后重装 electron 包
3. 端口 5173 清理：netstat -ano 匹配 LISTENING PID → taskkill /F；ping 127.0.0.1 2 次 cooldown
4. 启动：set ELECTRON_MIRROR=cn 镜像 → npm run dev（concurrently 并行 Vite + wait-on + Electron）
   - Vite       ：http://127.0.0.1:5173（HMR）
   - wait-on    ：等 Vite 返回 200，再启动 Electron
   - Electron   ：NODE_ENV=development  loadURL http://127.0.0.1:5173
   - 停止       ：Ctrl+C 或关闭本 cmd 窗口
```

**Windows PowerShell 5 兼容性规则**（来自实践踩坑）：

- 批处理内部禁止 `&&`，任何脚本执行先 `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force`
- Vite dev server 严格绑定 `127.0.0.1:5173`（不是 `localhost`），避免 IPv6 解析导致 wait-on 长等
- **ASCII-only**：避免 `chcp 65001` 依赖；全英文注释与提示，中文机器的旧版 codepage 不会解析为命令

### 2.3 package.json：依赖版本 & 命令清单

👉 文件：[electron/package.json](file:///d:/Project/TinTin_Client_Electron/electron/package.json)

#### 运行时依赖（打进安装包）

| 包                 | 版本     | 用途                               |
| ----------------- | ------ | -------------------------------- |
| electron-updater  | 6.3.4  | 自动升级（增量 delta 包、update.json 轮询）  |
| systeminformation | 5.23.5 | 顶栏 CPU / 内存 / GPU / 显存指标采集（顶栏右区） |

#### 开发依赖（构建用）

| 包                  | 版本       | 用途                                            |
| ------------------ | -------- | --------------------------------------------- |
| electron           | 31.7.7   | 壳（Chromium 124 → 对应 Vite `target: chrome124`） |
| electron-builder   | 24.13.3  | NSIS 打包 / delta 升级包                           |
| vite               | 5.3.3    | 渲染层构建 & HMR                                   |
| @vitejs/plugin-vue | 5.0.5    | Vue SFC 编译 + `isCustomElement: webview`       |
| typescript         | 5.5.3    | tsc --noEmit 类型检查                             |
| @types/node        | 20.14.10 | Node 内置库类型                                    |
| vue                | 3.4.31   | 视图层框架                                         |
| vue-router         | 4.4.0    | 路由（三 Tab + 工作台子路由）                            |
| pinia              | 2.1.7    | 状态管理（4 store 拆分）                              |
| concurrently       | 8.2.2    | dev 并行 Vite + wait-on + Electron              |
| cross-env          | 7.0.3    | 设置 NODE\_ENV（跨 shell 兼容）                      |
| wait-on            | 7.2.0    | 等 Vite 就绪再启动 Electron（避免 loadURL 404）         |

#### npm scripts

| 命令                       | 行为                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `npm run dev`            | `concurrently -k "dev:renderer" "dev:electron"`（开发模式：Vite + Electron）                                           |
| `npm run dev:renderer`   | `vite --config ./renderer/vite.config.ts`（**关键**：必须显式指定 config，否则 Vite 默认 electron/ 为 root 找不到 index.html，此坑已踩） |
| `npm run dev:electron`   | `wait-on http://127.0.0.1:5173 && cross-env NODE_ENV=development electron .`                                    |
| `npm run build:renderer` | `vite build --config ./renderer/vite.config.ts`（构建前端，产物 electron/renderer/dist/）                                |
| `npm run build`          | 先 `build:renderer` 再 `electron-builder --win nsis --x64`（生产 NSIS 安装包）                                           |
| `npm run build:dir`      | 同上，最后一步改 `--dir`：只打解压目录不打 NSIS EXE（快速验证打包内容）                                                                    |
| `npm run typecheck`      | `tsc --noEmit -p renderer/tsconfig.json`（CI 门禁 1）                                                               |
| `npm run lint`           | eslint（CI 门禁 2，warn 以上失败）                                                                                       |
| `npm run postinstall`    | `electron-builder install-app-deps`（安装后自动对齐原生依赖版本与 Electron ABI）                                                |

### 2.4 TypeScript 配置（tsconfig.json）

👉 文件：[electron/tsconfig.json](file:///d:/Project/TinTin_Client_Electron/electron/tsconfig.json)

- **target**: ES2022 / **module**: ESNext / **moduleResolution**: bundler
- **strict**: true（严格模式，全部严格检查）
- **types**: `["node"]`（只引入 Node 类型，不引入 Browser 全局）
- **include**：`renderer/src/**/*.{ts,tsx,vue,d.ts}` + `types/**/*.d.ts`（types 全局声明全项目共享）
- **paths 别名**（与 Vite `resolve.alias` 双写保持一致）：
  ```
  @/*            → renderer/src/*
  @components/*  → renderer/src/components/*
  @stores/*      → renderer/src/stores/*
  @views/*       → renderer/src/views/*
  @styles/*      → renderer/src/styles/*
  ```

### 2.5 Vite 配置（renderer/vite.config.ts）

👉 文件：[renderer/vite.config.ts](file:///d:/Project/TinTin_Client_Electron/electron/renderer/vite.config.ts)

关键项（全部踩坑后验证通过）：

```ts
vue({ template: { compilerOptions: { isCustomElement: t => t === 'webview' } } })
```

- 必须：Electron `<webview>` 是非标准元素，Vue 编译器默认会报 "Unknown custom element"

```ts
root: renderer/   base: './'
```

- 必须：显式把 root 指到 renderer/，否则 electron/ 目录下 index.html 找不到
- base='./' 让打包后 index.html 里的资源用相对路径（Electron loadFile 协议下可正常加载）

```ts
server: { port: 5173, strictPort: true, host: '127.0.0.1' }
```

- strictPort=true：端口被占直接失败（不自动 5174 跳转，配合 start-dev.bat 主动清理）
- host=127.0.0.1：避免 IPv6 `::1` 导致 wait-on 超时

```ts
build: {
  target: 'chrome124',       // 对齐 Electron 31.x 内置 Chromium 版本，少 polyfill
  minify: 'esbuild',
  sourcemap: false,          // 生产关闭
  rollupOptions: {
    output: { manualChunks: { vue: ['vue','vue-router','pinia'] } }
  }
}
```

- **manualChunks vue**：把框架层单独拆成 vue-BV4IPJZm.js（105KB gzip 41KB），业务代码 24 个 chunk 平均 5\~12KB，首屏只加载 main + vue + 当前 Tab 视图

***

## 3. 界面层 3-Tab 完整规格

### 3.1 全局壳：自绘标题栏（36px，P1.5 厚壳化）+ 三明治结构（56px Header / 三 Tab / 44px Footer）

> P1.5 厚壳化后：**BrowserWindow frame:false（无系统标题栏）**，窗口顶部新增 36px 自绘 TitleBar（与 Cherry Studio 形态对齐），原三明治壳（Header / Content / Footer）视觉高度与设计稿 1:1 保持不变。详见规格 §1.3.1。

```
┌─ TitleBar 36px（-webkit-app-region: drag / 控制按钮 no-drag）────────────────────────────┐
│  [🐚 18×18 Icon] 螺丝钉-电商智能体矩阵 13px 600        空白拖拽区           [—] [ ] [×]   │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│  Header 56px：Logo | 三 Tab 胶囊 | 服务器灯💚 | CPU/内存/GPU/显存 | 🔔                  │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                          │
│  Content Area：<router-view v-slot> <keep-alive>（Tab1 工作台 / Tab2 浏览器 / Tab3 媒体）│
│                                                                                          │
├──────────────────────────────────────────────────────────────────────────────────────────┤
│  Footer 44px：[任务条×3] +N进行中 | [☐ 自动刷新] | 文件下载：进度% 速度                 │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

设计 tokens 对照（全部来自 tokens.css → DESIGN §二；**P1.5 新增自绘栏完全复用现有 tokens，不引入新色**）：

- TitleBar / Header / Footer 背景：`--surface` #161828，相邻区块之间 1px `--border-subtle` #1e2133
- 三 Tab 胶囊：激活态 `--surface-container-high` + 左侧 3px `--primary` 下划线；hover 有 150ms ease-out 过渡
- 服务器状态灯（PRD §3.1 右区）：💚success #10b981 / 💛warning #f59e0b / ❤️error #ef4444；**每 60s 轮询一次** `GET /health/capabilities`（解决 V2 高频 2s 超时噪声问题）
- TitleBar 关闭按钮 hover：背景 `--error` #ef4444 + 白字（150ms 默认动效）；最小化/还原 hover 背景 `--surface-container`

### 3.2 Tab1 工作台（Workbench.vue · 设计稿对齐版）

👉 [Workbench.vue](file:///d:/Project/TinTin_Client_Electron/electron/renderer/src/views/Workbench.vue)

**布局：260px 会话侧栏 + 聊天主区（消息流 + 输入区）**，与设计稿「工作台.html」结构 1:1 对齐；整体背景 `--background`，侧栏 `--surface`，`border-right: 1px solid var(--border)`。

**左侧 260px 会话侧栏（自上而下）**：

| 区域                               | 内容                                                                | 交互                                                                                               |
| -------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 顶部 `sidebar-top`                 | 「新建会话」按钮（secondary 填充 + 加号图标）                                     | 点击：`unshift` 新会话 today 组 + 切换激活 + 重置消息列表为欢迎消息 + autofocus 输入框                                    |
| 中部 `session-list`（自定义滚动条，宽度 6px） | 三段分组：今天 / 昨天 / 更早；每组含分组标签（大写字母间距）+ 会话行（图标 18 + 标题 + 副标题 ellipsis） | hover：`--surface-container` 背景 + foreground 字；active：`--primary` 背景 + primary-foreground 字（整行填充） |
| 底部 `sidebar-bottom`（border-top）  | 「系统设置」按钮（secondary 填充 + 齿轮图标）                                     | 点击：`router.push('/settings')` 跳转到设置页（顶栏 Tab 高亮保持 workbench，因为入口在工作台）                             |

**中间聊天主区（自上而下）**：

| 区域                                         | 内容                                                                                                                | 视觉规格                                                                                                                       |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `message-list`（max-width 48rem / gap 24px） | AI 消息：`--card` + 1px `--border` / 左下 6px 直角；用户消息：`--primary` 填充 / 右下 6px 直角；max-width 78%，padding 14/18           | 气泡圆角 `--radius-xl`；line-height 1.65                                                                                        |
| 脚本镜头附属卡（AI 消息内 `shots-card`）               | 每行：镜头编号（primary 粗体）+ 镜别/时长标签（muted）；下一行：描述（muted）                                                                 | 背景 `--surface-container`，border + `--radius-xl`，内边距 16                                                                     |
| `input-bar`（border-top）                    | 外层：112px 高度 textarea（上传按钮 secondary-ic 36×36 + 发送 primary 36×36 右下定位）+ 底部 hint 行（左 Enter/Shift+Enter，右 模型：GPT-4o） | textarea 背景 `--surface-container`，focus：primary border + 3px ring + card 背景；Enter 发送 / Shift+Enter 换行（`handleKeydown` 已实现） |

**已实现交互**：新建会话 / 会话切换 / 发送消息 + 自动滚底 + 模拟 AI 500ms 回显 / 脚本镜头卡结构化展示 / 跳转到设置页。

**响应式（小屏抽屉化）**：`@media (max-width: 768px)` 下侧栏 `position: absolute` + `translateX(-100%)`，主区 max-width 100%，消息气泡 max-width 90%。

#### 3.2.1 子页路由位说明（P2 后续）

工作台原本的 AiScript / Storyboard / VectorSearch / ScheduledTasks 4 个子页路由位仍保留在设计文档中（§3.2.1\~§3.2.4 规格不变），本轮作为后续迭代从「会话入口」进入分镜列表后再展开。

***

### 3.3 Tab2 浏览器（Browser.vue · 设计稿对齐版）

👉 [Browser.vue](file:///d:/Project/TinTin_Client_Electron/electron/renderer/src/views/Browser.vue)

合并 `apps/asset-browser/` 全部能力 + 与设计稿「浏览器.html」1:1 对齐：

**顶部工具条（background** **`--surface`** **+ border-bottom，高 \~61px）**：

```
[← 禁用态: 0.4 opacity] [→ 禁用] [⟳]   [🔒 胶囊地址栏 focus→primary+ring]   [🟣 解析并导入 primary 填充] [⬇ badge-dot 红点] [⚙ 设置]
```

- 地址栏：`border-radius: 999px`（胶囊），`height: 40px`，左侧 14px 锁图标（`--success`），focus-within：primary border + 3px ring + card 背景

**左侧 240px 侧栏（background** **`--surface`** **+ border-right）**：

- 浏览历史（两节：今天 / 昨天）：每行 28×28 圆形 icon + 标题/URL ellipsis + 右侧时间戳；hover → `--surface-container` 背景
- 下载管理卡片（card + border + `--radius-xl`）：标题行 + 3 条任务（下载中 / 已完成 / 排队中），每条 6px 进度条，渐变 primary → primary-hover

**中间主区**：

- 平台 Tabs 行：抖音 🎵 / 视频号 💚 / 快手 ⚡ / 小红书 📕 / B站 📺，active = card 背景 + primary 文字 + primary border + 3px ring
- **P1.5 厚壳化后（默认 BrowserView，正式规格）**：
  - 中间主区 UI 变为 **`<div class="browser-view-host">`（空容器，只作为 DOM 坐标锚点）**，不再有灰色 mock 块；真实网页内容是主进程 BrowserView（独立 WebContents + 独立进程 + 5 平台 `persist:tintin-{platform}` partition 隔离 cookie）通过 IPC 接收 Renderer 发的 DOMRect 后 `setBounds` 贴上来
  - 平台切换 / 路由 attach-detach / bounds 响应式重算 / 后退前进刷新地址栏真实动作 / 解析并导入 executeJavaScript 抽取 DOM 推送工作台 / 下载挂总线 —— 完整规格见 **§1.3.2 规格 B**
  - 崩溃隔离：某平台 WebContents 崩了，主窗口/工作台不崩；3 次内自动重建恢复（§1.3.5 U10）
  - **降级兜底（只有当 BrowserView setBounds 出现 150% 缩放漂移时才启用）**：Electron `<webview partition="persist:tintin-browser">`（保留 V2 单 partition 互通登录态作为回退，写入 `electron-store('embed-mode')` 可切换，见 §1.3.3 C4）

**响应式断点**：`≤900px` 侧栏抽屉化 + 解析按钮仅显示图标；`≤640px` 地址栏隐藏；BrowserView bounds 跟随 DOMRect 容器重算见 §1.3.2 B3/B6.6。

***

### 3.4 Tab3 媒体工具（MediaTools.vue · 设计稿对齐 10 卡版）

👉 [MediaTools.vue](file:///d:/Project/TinTin_Client_Electron/electron/renderer/src/views/MediaTools.vue)
👉 8 工具表单（仍保留在子组件中，进入卡片后可展开）：[electron/renderer/src/components/media-tools/](file:///d:/Project/TinTin_Client_Electron/electron/renderer/src/components/media-tools/)

**卡片导航首页（按设计稿改为 10 张无分组平铺网格，不再按图形/视频/提示词分组）**：

```
┌────📝 AI脚本创作───┐ ┌───🎬 一键成片(HOT)──┐ ┌──📦 产品库管理───┐ ┌──🖼️ 素材生成───┐
┌────🎵 音频素材────┐ ┌───✂️ 视频混剪──────┐ ┌──🎙️ 直播切片────┐ ┌──📊 数据分析───┐
┌────✨ 视频修复────┐ ┌───🎨 封面设计──────┐
```

卡片规格（与设计稿媒体工具.html 一致）：

- **圆角** **`--radius-xl`** / 背景 `--card` / 1px `--border` / padding 20px
- **图标 56×56，圆角 14px**，背景为每张卡片专属的 135° 双色渐变（紫/粉/蓝/青绿/橙红/红/青蓝…），配 emoji（📝🎬📦🖼️🎵✂️🎙️📊✨🎨）
- 右上角 `HOT` 徽章（渐变红橙 + 白字 + 700 粗 + letter-spacing）
- 标题 h3 15/18 700；描述 12/22 muted
- 底部：border-top 分隔 + 右下角 28×28 圆形 primary 容器 箭头 → hover 填充 primary + 右移 2px
- **hover**：`translateY(-2px)` + border `--primary-hover` + shadow-3 + card-hover 背景（150ms `--easing-default`）
- **active**：border primary + 3px ring

**响应式 5/4/3/2/1 列**：`≥1440px 五列` / `≥default 四列` / `≤1100px 三列` / `≤800px 两列` / `≤560px 单列`（比原设计稿多一档大屏 5 列 + 小屏单列，兼顾 4K 与 便携）

**工具表单页通用结构**：进入卡片后渲染的 8 份子组件表单（CoverMaker/ImageMatting/VideoRepair 等）规格保持不变，见原 §3.4 页末段 & 4.3.2 路由表；接口映射表（封面/抠图/修复/反推 8 工具 S1\~S3）完整沿用。

***

### 3.5 Tab → 设置页（Settings.vue · 新增，路由 `/settings`）

👉 [Settings.vue](file:///d:/Project/TinTin_Client_Electron/electron/renderer/src/views/Settings.vue)
👉 路由入口：工作台侧栏底部「系统设置」按钮 + `router/index.ts` 新增 `/settings` 一级路由（顶栏保持工作台 Tab 高亮，因为入口在工作台侧栏而非独立 Tab）。

**布局：左侧 240px 菜单 + 右区内容宽度 max 960px（居中）**，严格匹配设计稿「系统设置.html」：

**左侧菜单** **`settings-sidebar`（自上而下）**：

- 6 项菜单项（平台接入 / 本地配置 / 环境维护 / 扩展插件 / 任务队列 / 关于），每项：
  - 32×32 圆角 10 图标容器（surface-container 背景 + 对应 SVG icon 样式）
  - label 13px 600 + desc 11px muted（例：平台接入 → "抖音 · 视频号 · 快手"；关于 → "版本 v1.0.0-beta.2"）
  - active：primary 整行填充 + 图标容器 15% 白底
- 底部 `sidebar-foot`（border-top）：「返回工作台」按钮（ghost + 左箭头 + hover primary 边框）

**右区（content-inner padding 24 / gap 20）**：

| 区域（卡片） | 内容                                                                                               | 规格                                                                                                                                   |
| ------ | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| 页面标题   | h1 28/800 "系统设置" + p muted "配置平台连接、本地环境、扩展与版本信息。"                                                | 顶部无 card 直接输出                                                                                                                        |
| ① 平台接入 | 标题 + desc → 分段控件（全局/抖音/视频号/快手/小红书）→ 4 行开关（自动同步数据/登录态共享/失败重试/素材缓存）                                | 分段控件：4px padding surface-container + 每项 38px；active = card 背景 + primary 字 + shadow-1。开关：46×26，on 时 primary 背景 + knob translateX 20px |
| ② 本地配置 | 分段控件（数据目录/字体/代理）→ 路径选择行（3 列 grid：110px 标签 + 路径值 monospace + 浏览/打开按钮）                             | 路径值：15px 文件夹图标（primary） + C:\Users\… mono 字体 ellipsis                                                                                |
| ③ 环境维护 | 三个 42px 圆角按钮：清理缓存 / 重启后端进程（secondary） / 一键诊断（primary，右 1）                                        | hover：border primary + translateY -1px + shadow-2                                                                                    |
| ④ 关于   | 2×N 信息网格（客户端版本 / 组件版本 / 构建时间 / 更新频道 Stable 徽章） → border-top 分隔 + 按钮（检查更新 secondary / 开源许可 ghost） | 徽章：success-container 背景 + success 字 + 11/700                                                                                         |

**响应式**：`≤900px` 左栏抽屉化 + about 网格单列 + 路径行 单列；`≤560px` 分段控件换行 + 环境维护按钮 50% 两列。

***

### 3.6 设计系统 tokens（tokens.css / global.css）

👉 [tokens.css](file:///d:/Project/TinTin_Client_Electron/electron/renderer/src/styles/tokens.css) 👉 [global.css](file:///d:/Project/TinTin_Client_Electron/electron/renderer/src/styles/global.css)

色彩 / 字体 / 间距 / 圆角 / 阴影 / 动效的完整规格在 DESIGN §2 中，代码已完整落地，关键速查：

| 类别   | Token（暗）              | 值         | 用途                            |
| ---- | --------------------- | --------- | ----------------------------- |
| 主色   | `--primary`           | `#6d5dfc` | 按钮 / 激活态 / 链接 / 卡片 accent bar |
| 成功   | `--success`           | `#10b981` | 服务器在线 / 已完成                   |
| 警告   | `--warning`           | `#f59e0b` | 排队中 / 能力降级                    |
| 错误   | `--error`             | `#ef4444` | 离线 / 失败 / 删除                  |
| 背景   | `--background`        | `#0f1020` | 窗口底色                          |
| 卡片   | `--surface`           | `#161828` | 卡片 / 顶栏 / 底栏                  |
| 侧边栏  | `--surface-container` | `#1e2133` | 筛选面板 / 输入框背景                  |
| 分隔线  | `--border`            | `#262a45` | 卡片边框                          |
| 主文字  | `--foreground`        | `#f0f1f7` | Body                          |
| 次要文字 | `--muted-foreground`  | `#9ca1b1` | Caption / placeholder / 时间戳   |

字体栈：`"PingFang SC", "Microsoft YaHei", system-ui, sans-serif`（与 V2 一致，跨版本中文对齐）

关键尺寸：Button 36px / Input 34px / Header 56px / Footer 44px / Sidebar 264px / Card 圆角 12px / Button 圆角 8px。

组件规范（Button 5 变体 / Input error 红底 / Table 行高 48px / Badge 20×9999 / Dialog 圆角 14px / Toast 右上角 320px）见 DESIGN §七。

***

## 4. 模块层架构：主进程 / preload / 渲染层 / IPC / 状态 / 设计系统

### 4.1 主进程（Main Process）6 模块拆分

模块启动顺序（main.js `app.whenReady()` 内部串行）：

```
createServerProxy(ipcMain)          ← 先建：HTTP 基础能力
→ createDownloadManager(ipcMain, getWorkspacePath())
→ createFfmpegGate(ipcMain, getStudioRoot())
→ createTray()
→ initUpdater()
→ createMainWindow()
```

#### 4.1.1 main.js：单例锁 + 窗口创建 + 崩溃恢复 + 基础 IPC

👉 [main.js](file:///d:/Project/TinTin_Client_Electron/electron/main/main.js)

- **单例锁**：`app.requestSingleInstanceLock()`；重复启动 = restore + focus（避免多开）
- **路径解析规则**（getStudioRoot）：
  - 开发模式：project root 的 `studio/`（历史 V2 产物路径保持不变）
  - 打包后：`process.resourcesPath/studio-legacy/`（extraResources 里的 bridge.exe 和旧脚本）
  - **workspacePath = studioRoot/outputs/**：studio/outputs/{materials,voice\_clone,covers} 与 V2 1:1 不变
- **BrowserWindow 安全 + 厚壳化配置**（PRD §3.5 + P1.5 §1.3.1 A1 合并；**C1 红线：三安全开关不得回退**）：
  ```
  // ===== 厚壳化 P1.5 新增（无系统框架 + 自绘标题栏形态）=====
  frame: false,                                  // ★ 去掉系统标题栏（Windows 蓝色栏彻底消失）
  titleBarStyle: process.platform==='darwin' ? 'hidden' : undefined,   // macOS 交通灯，不画自绘三按钮
  trafficLightPosition: { x: 14, y: 10 },        // macOS 交通灯对齐 36px 自绘栏
  backgroundColor: '#0f1020',                    // = tokens --background，启动 200ms 不白闪
  minWidth: 1024, minHeight: 700,                // ★ 小于后停止 BrowserView.setBounds 计算（C5 防负坐标）
  show: false,                                   // 必须 ready-to-show 再 show()（C6 防白屏）
  // ===== 安全基线（不可变 C1 红线，来自 §4.1.1 原版）=====
  contextIsolation: true,                        // ★ 强制：渲染层拿不到 Node 全局（不得改为 false）
  nodeIntegration: false,                        // ★ 强制：禁止 require（不得改为 true）
  sandbox: true,                                 // ★ 加固：preload 只能用 contextBridge 白名单
  webviewTag: true,                              // 保留（作为 BrowserView 降级兜底 §1.3.3 C4）
  spellcheck: false                              // 中文不启用拼写
  ```
- **尺寸**：默认 1440×900；backgroundColor 与 tokens 一致；`mainWindow.once('ready-to-show')` 回调里才 `mainWindow.show()`（C6）；冷启动 bounds/状态记忆见 §1.3.1 A4
- **崩溃恢复**：① 主 renderer：`render-process-gone` → crashRecoveryCount++，最多 3 次自动 `reload()`；超过 = `dialog.showErrorBox` 提示重启。② BrowserView 池（P1.5 新增）：`pool[i].view.webContents.on('render-process-gone', ...)` → pool.delete + 重建（最多 3 次，见 U10）——BrowserView 独立进程崩溃不带走主窗口和其他 Tab（Tab 是同一 renderer 的 Vue keep-alive）

**基础 IPC（4 类，3 层白名单）**：

- `app:get-version / get-path(home|userData|temp|workspace) / quit / relaunch`
- `dialog:openFile / openFiles / openDir / saveFile`（都带 filters，文件必须走 Electron 原生对话框，不能让渲染层任意 fs 路径）
- `shell:openExternal / openItem / revealInFolder / showNotification`（Notification 支持 click 回传：`notification:clicked`）

#### 4.1.2 tray.js / updater.js / download-manager.js / ffmpeg-gate.js（配套模块）

- tray.js：系统托盘 + 菜单（显示主窗口 / 退出）+ 开机自启（沿用 V2 注册表位置）
- updater.js：electron-updater initUpdater（update.json URL = 继承 V2 studio/config），下载完成=通知顶栏
- **download-manager.js**：统一下载总线（global.downloadBus EventEmitter），浏览器 webview、媒体工具结果、封面工作流 ZIP 都走这一个；进度事件广播到底栏
- **ffmpeg-gate.js**：`child_process.spawn` 白名单子命令（**不得暴露任意命令 exec，防 RCE**）：
  ```
  probe(file)            → {duration, width, height, fps, codec, audio_bitrate}
  extractThumb(v, t, w)  → 输出 PNG 绝对路径
  embedCover(v, c, o, d) → 封面嵌入
  concatSegments(paths[],out) → 智能混剪拼接
  extractAudio(v,out,f)  → 音轨剥离
  ```

#### 4.1.3 server-proxy.js（主进程 HTTP 代理层）

👉 [server-proxy.js](file:///d:/Project/TinTin_Client_Electron/electron/main/server-proxy.js)

这是"接口契约 → IPC handler → HTTP 请求"的枢纽，详见 §5。核心机制：

- 统一 HTTP 封装（httpRequest）：自动注入 `X-Machine-ID`、`Authorization`（ai\_config.json 登录态）、统一超时、统一错误处理
- `isExpectedOfflineError`：离线 / ECONNREFUSED / ETIMEDOUT / 404 返回 **`null`（静默，不打堆栈）**——解决 V2 离线时 Electron handler 红字刷屏
- `API_ENDPOINTS` + `resolveEndpoint`：把 17 域路径集中常量/函数化，string 直接用，函数调用传 params，query 自动拼接
- **26 个业务级 IPC handlers**（命名 `域:动作`），每 handler 内部：必填校验 → 调用 httpRequest → 离线 null → 业务错误 `{error: msg}`

### 4.2 预加载安全桥（preload.js / browser-webview\.js）

👉 [preload.js](file:///d:/Project/TinTin_Client_Electron/electron/preload/preload.js) 👉 [global.d.ts](file:///d:/Project/TinTin_Client_Electron/electron/types/global.d.ts)

#### 4.2.1 安全原则（PRD §3.5，必须评审）

- 渲染进程拿不到 `require` / `process` / `child_process.exec` / `fs.*`
- 所有能力 = 8 大命名空间只读白名单；每个方法有类型签名（global.d.ts），参数在主进程再做一次校验
- **绝对禁止暴露**：`child_process.exec` / `fs.writeFile` / `path.resolve`（ffmpeg gate 只传结构化参数，不传任意 CLI）

#### 4.2.2 window\.tintin.\* 8 命名空间总览（实际落地）

| 命名空间                                | 作用                | 典型方法                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `app`                               | 系统信息              | `getVersion / getPath('workspace') / quit / relaunch / onUpdateAvailable`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `dialog`                            | 文件对话框             | `openFile / openFiles / openDir / saveFile`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `downloads`                         | 下载池（浏览器 + 媒体工具共用） | `start / pause / resume / cancel / onProgress / onDone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **`server`**（最大的一块，7 通用兜底 + 29 业务级） | 服务端 HTTP 代理       | **通用兜底**：`get/post/put/delete/upload/sse/downloadResult`**业务级**：`healthCapabilities / statsWorkbench / agentRegistry / agentSubmitTask / agentTaskAction / agentRegisterArtifact / tasksUnifiedList / tasksUnifiedItem / tasksProgress / tasksDownloadResult / tasksDelete / rembgSubmit / vsrSubmit / vsrRemoveSubmit / visionReversePrompt / asrTranscribe / ttsGenerate / ttsCloneVoice / llmChat / llmAdjustCopywriting / materialList / materialStockSearch / materialOcr / montageConcat / montageBeatSync / storyboardListScripts / storyboardSaveScript / systemLicenseVerify`（29） |
| `ffmpeg`                            | ffmpeg 白名单子命令     | `probe / extractThumb / embedCover / concatSegments / extractAudio`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `shell`                             | 外部打开 & 通知         | `openExternal / openItem / revealInFolder / showNotification`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `bridge`                            | 过渡期 bridge.exe 控制 | `getStatus / navigate`（bridge-mgr.js 启动后使用）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `browser`（在浏览器 Tab webview 中暴露子集）   | 解析下载              | `assetBrowser / downloadAsset / cancelDownloadAsset`（V2 apps/asset-browser 的 preload-app.js 合并进来）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

#### 4.2.3 上传进度通道封装（\_withUploadProgress）

上传类（rembgSubmit / vsrSubmit / ttsCloneVoice / asrTranscribe / visionReversePrompt / materialOcr）共用：

```
progressChannel = `up:${handlerName}:${timestamp}`
```

主进程 server-proxy.js 里 `form.on('data')` → 计算 percent → `event.sender.send(progressChannel, {percent, loaded, total})`；preload.js 监听一次，回调 `onProgress(percent)`，完成后自动 off 防止内存泄漏。

### 4.3 渲染层：Vue 3 + Pinia + Vue Router（Composition API）

#### 4.3.1 App.vue 三明治壳

👉 [App.vue](file:///d:/Project/TinTin_Client_Electron/electron/renderer/src/App.vue)

- TopBar：Logo + 产品名 + 三 Tab 胶囊 + 服务器状态灯（60s 轮询）+ CPU/内存/GPU/显存 4 条小柱 + 🔔 通知
- ContentArea：`<router-view v-slot="{ Component }">` → `<keep-alive>` → 三 Tab 切换不丢上下文（浏览器前进后退历史、工作台脚本草稿、媒体工具上传进度都保留）
- BottomBar：任务执行条×3 + "+N 进行中"折叠、下载进度池、自动刷新勾选框（只在 ScheduledTasks 路由时启用）

#### 4.3.2 Router（router/index.ts）

一级路由 4 条（hash mode，Electron file:// 兼容）：

- `/` → redirect `/workbench`
- `/workbench` → Workbench.vue（本轮按设计稿改为「会话入口 + 聊天」，子路由 `/workbench/ai-script / storyboard / vector-search / scheduled-tasks / bridge/*` 过渡桥页的路由位仍保留给 P2 后续）
- `/browser` → Browser.vue（本轮按设计稿重构为「顶栏工具条 + 240px 左栏历史/下载 + 平台 Tabs」）
- `/media-tools` → MediaTools.vue（本轮按设计稿改为 10 张卡片无分组网格；子路由 `/media-tools/cover-maker / image-matting / video-repair / ...` 8 工具表单保留在子组件中）
- `/settings` → Settings.vue（本轮新增，6 菜单项系统设置；入口 = 工作台侧栏底部按钮）

**Tab 高亮规则（App.vue currentTab computed）**：若 `route.meta.tab === 'settings'`，顶栏保持 `workbench` Tab 激活（因为设置页从工作台侧栏进入，不是独立顶 Tab）。为此 `stores/app.ts` 的 `TabKey` 联合类型已从 3 项扩展为 4 项：`'workbench' | 'browser' | 'media-tools' | 'settings'`。

#### 4.3.3 Pinia 四 Store 拆分（单一职责）

| Store          | 作用域                  | 典型 state                                                                                                                                    | 典型 actions                                                                |
| -------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `app.ts`       | **全局 UI**            | activeTab / theme / notificationList / lastBridgePort                                                                                       | setActiveTab / pushNotification                                           |
| `server.ts`    | **服务端能力探测**          | online(server\_time) / capabilities 12 开关 / capabilityDetail 12 项(models,modes,engines,url) / registry\[] / queueLoad / workbenchStats 4 卡片 | checkCapabilities(60s) / fetchRegistry / fetchStatsWorkbench              |
| `downloads.ts` | **下载池**              | items = `{id,url,savePath,state,percent,speed,size,received}`                                                                               | start / pause / resume / cancel                                           |
| `tasks.ts`     | **成片任务**（子任务树 a\_\*） | items / detailById / filters(types,statuses,search,page,page\_size,created\_from/to) / total / hasMore                                      | fetchUnifiedList / fetchDetail / fetchProgress (就地更新列表行) / delete / retry |

所有 store 都 import 类型自 `types/server-api.ts`，不用 any。

### 4.4 IPC 业务级机制设计

```
渲染层  Vue 组件 / store
  ↓  window.tintin.server.rembgSubmit(payload, onProgress)
preload  _withUploadProgress(onProgress, 'rembg:submit', payload)
  ↓  ipcRenderer.invoke('rembg:submit', payload, progressChannel)
主进程  ipcMain.handle('rembg:submit')
         → 必填校验（image 必填，model 枚举）
         → resolveEndpoint(API_ENDPOINTS.rembg.submit)
         → buildRequest 注入签名头 / machine_id
         → form.on('data') 算 percent，event.sender.send(progressChannel)
         → httpRequest('POST', url, { multipart: form })
         → try-catch，离线返回 null，错误返回 {error}
  ↓  response
preload  resolve(response)（上传自动 removeListener 清进度通道）
  ↓
渲染层  store / 组件 更新进度条 / 任务卡 / toast
```

IPC 命名规范（防止 handler 冲突）：

- 业务级 = `域:动作` 蛇形；例 `tasks:unifiedList` / `rembg:submit`
- 基础级 = `域:动作`；例 `app:get-path` / `dialog:openFile`
- 事件推送（主→渲）= `域:动词-past`；例 `download:progress` / `notification:clicked`

### 4.5 设计系统代码落地分层

```
设计系统分层：
tokens.css（变量层，CSS 变量）      ← 所有颜色/间距/圆角/字号，单一真源
  ↓
global.css（重置 + 排版 + 骨架屏）  ← * { box-sizing: border-box }；body 字体；滚动条样式；skeleton pulse 动画
  ↓
components/common/T*.vue（UI 原语）← TButton / TInput / TCard / TTable / TBadge / TDialog / TNotification
  ↓
业务组件（views/ + components/media-tools + components/workbench）
```

约束：**业务组件不得硬编码颜色 / 字号 / 圆角**，一律用 `var(--xxx)` 或公共 T\* 组件。

***

## 5. 接口契约 & 服务端通信机制

### 5.1 契约单源：electron/types/server-api.ts

👉 [server-api.ts](file:///d:/Project/TinTin_Client_Electron/electron/types/server-api.ts)

**唯一真源原则**：所有跨层（store → global.d.ts → preload → server-proxy → 业务代码）的 Request 类型 / Response 类型 / 接口路径，全部 import 自此文件。任何字段调整只改本文件，然后连锁调整 4 层实现。

分层结构：

```
1. Common（通用类型，跨域共享）
   TaskIdPrefix            'c_' | 'a_' | 't_'   （c=计算型成片/ a=agent 父任务下子任务/ t=定时）
   TaskStatus              7 态 queued/processing/done/failed/waiting_user_input/canceled/retrying
   UnifiedTaskType         8 类 rembg_matting/vsr_enhance/editor_render/digital_human/storyboard_export/script_generate/tts/asr
   PaginatedResponse<T>    {items,total,page,page_size,has_more}
   ArtifactItem            {id,path,url,thumb,media_type,size,created_at}
   CapabilityRegistryItem  Orchestrator 能力注册表 schema（capability_key/version/health/queue_size）
   CapabilitySwitch        {enabled:boolean; models?:string[]; modes?:string[]; engines?:string[]; url?:string}

2. API_PATHS：17 域嵌套常量（string 或 (params)=>string 函数）
   health / stats / llm / asr / tts / material / montage / vsr / rembg / vision
   / digital_human / agent / tasks / prompt / scheduled / storyboard / editor / system

3. 13 命名空间 Request/Response（每域至少一对；如 HealthAPI.CapabilitiesResponse，AgentAPI.TaskNode...）
```

**API\_PATHS 亮点**：参数化路径用函数，如 `tasks: { progress: (id: string) => ` /tasks/\${id}/progress ` }`；query 调用层统一用 `Record<string, any>` 拼，和 server-proxy.js 的 resolveEndpoint 语义一致。

### 5.2 server-proxy.js 与 API\_PATHS 双写同步

`server-proxy.js` 第 66-126 行有 **JS 版** **`API_ENDPOINTS`** **常量**，与 server-api.ts 的 `API_PATHS` 字段结构 1:1 对齐（但因为 main 是 .js 所以不 import TS）。双写规则：改 `API_PATHS` → 必须同步改 `API_ENDPOINTS`；CI 里可以加简单校验：两者 JSON key 深度一致。

### 5.3 26 业务 IPC handlers ↔ HTTP 接口 ↔ TintinBridgeServer 方法总映射表

这是本文档核心：**把文档里的接口路径和请求体 schema 全部落到代码**的总表（26 条）。

> 命名规范：
>
> - IPC handler = `域:动作`（蛇形 + 冒号）
> - Bridge 方法 = `域+动作` 小驼峰
> - 所有 Bridge 方法的泛型实参都来自 `types/server-api.ts` 的对应命名空间

| #    | 域           | IPC handler              | Bridge 方法               | HTTP 接口                                          | 必填校验                                                                        | 进度                |   |
| ---- | ----------- | ------------------------ | ----------------------- | ------------------------------------------------ | --------------------------------------------------------------------------- | ----------------- | - |
| H-1  | health      | `health:capabilities`    | `healthCapabilities`    | `GET /health/capabilities` (S4)                  | —                                                                           | —                 |   |
| H-2  | stats       | `stats:workbench`        | `statsWorkbench`        | `GET /stats/workbench`                           | —                                                                           | —                 |   |
| H-3  | agent       | `agent:registry`         | `agentRegistry`         | `GET /agent/registry`                            | —                                                                           | —                 |   |
| H-4  | agent       | `agent:submitTask`       | `agentSubmitTask`       | `POST /agent/submit`                             | goal 必填                                                                     | —                 |   |
| H-5  | agent       | `agent:taskAction`       | `agentTaskAction`       | `POST /agent/tasks/{id}/action`                  | id 必填；action 枚举 5 项校验                                                       | —                 |   |
| H-6  | agent       | `agent:registerArtifact` | `agentRegisterArtifact` | `POST /agent/artifacts/register`                 | task\_id + name 必填                                                          | —                 |   |
| H-7  | tasks       | `tasks:unifiedList`      | `tasksUnifiedList`      | `GET /tasks/unified`（分页）                         | —                                                                           | —                 |   |
| H-8  | tasks       | `tasks:unifiedItem`      | `tasksUnifiedItem`      | `GET /tasks/unified/{id}`                        | id 必填                                                                       | —                 |   |
| H-9  | tasks       | `tasks:progress`         | `tasksProgress`         | `GET /tasks/{id}/progress`                       | id 必填                                                                       | —                 |   |
| H-10 | tasks       | `tasks:downloadResult`   | `tasksDownloadResult`   | `GET /tasks/{id}/result` → 写本地文件                 | id + savePath 必填（必须 workspace 子目录）                                          | onProgress 文件流    |   |
| H-11 | tasks       | `tasks:delete`           | `tasksDelete`           | `DELETE /tasks/{id}`                             | id 必填                                                                       | —                 |   |
| H-12 | rembg（S1）   | `rembg:submit`           | `rembgSubmit`           | **`POST /rembg/matting`**（multipart）             | image 必填                                                                    | ✔ upload progress |   |
| H-13 | vsr（S2）     | `vsr:submit`             | `vsrSubmit`             | **`POST /vsr/enhance`**（multipart）               | video + mode 必填                                                             | ✔ upload progress |   |
| H-14 | vsr\_remove | `vsr:remove`             | `vsrRemoveSubmit`       | `POST /vsr/remove`（multipart）                    | video 必填 + 选区矩形                                                             | ✔ upload progress |   |
| H-15 | vision（S3）  | `vision:reverse-prompt`  | `visionReversePrompt`   | **`POST /vision/reverse-prompt`**（multipart）     | file + count∈\[1,8] + language 枚举                                           | ✔ upload progress |   |
| H-16 | asr         | `asr:transcribe`         | `asrTranscribe`         | `POST /whisper/transcribe`（服务端版，multipart）       | audio 必填                                                                    | ✔ upload progress |   |
| H-17 | tts         | `tts:generate`           | `ttsGenerate`           | `POST /tts/generate`（multipart 或 JSON 自动切换）      | text 必填；有 clone\_ref\_file→multipart，否则 JSON                                | multipart 时进度     |   |
| H-18 | tts         | `tts:cloneVoice`         | `ttsCloneVoice`         | `POST /tts/clone`（multipart）                     | name + ref\_audio 必填                                                        | ✔ upload progress |   |
| H-19 | llm         | `llm:chat`               | `llmChat`               | `POST /llm/chat`（JSON）                           | model 必填 + messages 数组非空                                                    | —                 |   |
| H-20 | llm         | `llm:adjustCopywriting`  | `llmAdjustCopywriting`  | `POST /script/adjust-copywriting`（JSON）          | script\_id XOR text 有一                                                      | —                 |   |
| H-21 | material    | `material:list`          | `materialList`          | `GET /material/list`（分页 + 8 项筛选条件）               | —                                                                           | —                 |   |
| H-22 | material    | `material:stockSearch`   | `materialStockSearch`   | `GET /material/stock/search?query=&kind=`        | query 必填                                                                    | —                 |   |
| H-23 | material    | `material:ocr`           | `materialOcr`           | `POST /material/ocr`（multipart）                  | image 必填                                                                    | ✔ upload progress |   |
| H-24 | montage     | `montage:concat`         | `montageConcat`         | `POST /montage/concat`（JSON）                     | paths.length ≥2                                                             | —                 |   |
| H-25 | montage     | `montage:beatSync`       | `montageBeatSync`       | `POST /montage/beat-sync`（multipart：video+audio） | video + audio 必填                                                            | ✔ upload progress |   |
| H-26 | storyboard  | `storyboard:listScripts` | `storyboardListScripts` | `GET /storyboard/list`                           | —                                                                           | —                 |   |
| H-27 | storyboard  | `storyboard:saveScript`  | `storyboardSaveScript`  | \`POST                                           | PUT /storyboard/scripts\`（无 id=新建 POST；有 id=更新 PUT）                         | title + shots 必填  | — |
| H-28 | system      | `system:licenseVerify`   | `systemLicenseVerify`   | `POST /system/license/verify`（JSON）              | activation\_code 必填；**自动注入 machine\_id 字段**（由主进程本地采集加密，渲染层拿不到裸 machine\_id） | —                 |   |

### 5.4 返回体统一：IpcError<T> 类型

global.d.ts 中所有 29 业务方法的 Promise 返回类型都是 `IpcError<T>`：

```ts
type IpcError<T> = T | null | { error: string }
```

三态含义：

- `T`：成功，直接用
- `null`：服务端离线（ECONNREFUSED / ETIMEDOUT / EHOSTUNREACH）——静默降级，UI 走"灰态 / 无数据 / 不弹错误"路径（见 §5.7 离线容错）
- `{ error: string }`：服务端返回 4xx / 5xx 业务错误；UI 走 toast 提示 "请求失败：{error}"

这套设计让业务层不用写 `try {} catch {}` 到处处理离线，`await` 后用 `?? null` 和 `if ('error' in resp)` 两种分支即可。

### 5.5 stores/server.ts 状态消费链（S4 能力 → UI 卡片灰态）

启动顺序：

```
App.vue onMounted
  → serverStore.checkCapabilities()   // 首次立即 + setInterval 60s
    → window.tintin.server.healthCapabilities()
      → IPC health:capabilities
        → GET /health/capabilities (S4)
```

解析：

```ts
resp = HealthAPI.CapabilitiesResponse = { server_time, capabilities:{ 12 项 }, queue_load }
// 双写同步：
// 1) capabilities.rembg = resp.capabilities.rembg?.enabled ?? false  // 布尔开关
// 2) capabilityDetail.rembg = { models, modes, ... }                  // 详细 models/modes 给表单下拉用
// 3) queueLoad = { rembg: 2, vsr: 0 }                                 // 顶栏排队 tooltip
// 4) online = true ；serverTime 同步                                   // 服务器状态灯变绿
```

UI 层用法（已正确对接）：

```ts
const disabled = !serverStore.capabilities.rembg        // 图像抠图卡片灰态
const modelOptions = serverStore.capabilityDetail.rembg.models  // 表单下拉：u2net / isnet-general-use / birefnet
```

另外两个 store server action：

- `fetchRegistry()` → `agentRegistry` → CapabilityRegistryItem\[]：工作台 Orchestrator 能力注册表
- `fetchStatsWorkbench()` → `statsWorkbench` → {tasks\_done\_24h, queue\_depth, ...} 四张统计卡片

### 5.6 stores/tasks.ts 任务消费链（成片任务列表 + a\_\* 父子子树）

```
ScheduledTasksPage onMounted
  → tasksStore.fetchUnifiedList(filters)
    → tasksUnifiedList(params): TasksAPI.UnifiedListResponse
      → PaginatedResponse<UnifiedTaskItem>
        → items 入 store.items[]
        → detailById 缓存每个 a_* / c_* 项的 children[]（a_ 前缀 = agent 父任务的子步骤）
  → setInterval 15s（autoRefresh 勾选时）
    → tasksStore.fetchProgress(id) for each in-progress 项
      → tasksProgress(id) : {status, progress, stage, error_message}
      → store 就地更新 items[i].status/progress/stage
      → 表格行 & 底栏任务条 同步刷新（UI 实时）
```

类型对齐 V2 子任务树 schema（`AgentAPI.TaskNode`）：

```ts
interface TaskNode {
  id: string                           // a_xxx 父任务；c_xxx = 计算/渲染子任务
  parent_task_id: string | null        // 树结构用
  title: string
  capability_key: string
  status: TaskStatus                   // 包含 waiting_user_input 人工挂起
  progress: number
  stage?: string
  children_progress: Record<string, number>  // 子步骤进度，V3 UI 可展示树状展开
  requires_approval?: boolean
  waiting_reason?: string              // 人工挂起原因
  children: TaskNode[]
}
```

### 5.7 离线容错与降级设计

| 场景                                  | 旧行为（V2 / 初版）               | V3 新行为                                                                 | 代码位置                                                       |
| ----------------------------------- | -------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------- |
| 服务端未启动（127.0.0.1:8766 ECONNREFUSED） | console.error 红字刷屏 + 堆栈    | 静默降级，handler 返回 **`null`**；UI 直接走"卡片灰态 / 空数据"                          | `server-proxy.js` `isExpectedOfflineError`（§4.1.3）         |
| 单个业务 HTTP 4xx / 5xx                 | 抛异常到 Electron handler 框架日志 | 返回 `{ error: 'HTTP 403: capability not deployed' }`；业务层 toast 提示 + 不崩溃 | `server-proxy.js` httpRequest try/catch                    |
| S4 能力某一项未部署（enabled=false）          | 卡片仍可点击，提交时报错               | 启动/刷新 S4 后立即把对应卡片 opacity:0.45 + grayscale + tooltip；提交按钮 disabled     | `stores/server.ts` checkCapabilities → `capabilities[xxx]` |
| 轮询 tasks/progress 失败                | 报错到控制台                     | 跳过本轮，不更新进度；15s 后再试                                                     | `stores/tasks.ts` fetchProgress catch 吞                    |
| bridge.exe 未启动（过渡期）                 | 工作台 12 子页白屏                | 侧边栏项 disabled；webview 区域显示"桥接启动中…"骨架屏                                  | `bridge-mgr.js` 待接入                                        |

***

## 6. 打包 & 安装包产物规格

### 6.1 electron-builder 配置（package.json `build.*` 段）

👉 [electron/package.json #L37-L71](file:///d:/Project/TinTin_Client_Electron/electron/package.json#L37-L71)

```json
"build": {
  "appId": "com.tintin.electron.v3",
  "productName": "螺丝钉-电商智能体矩阵",
  "directories": {
    "output": "../dist",              // 最终 EXE 输出到 项目根/dist（不在 electron/ 内部）
    "buildResources": "build"         // 图标资源（build/icon.ico / setup banner）
  },
  "extraResources": [
    // 第 1 档：ffmpeg 双 exe（约 100MB）
    { "from": "../resources/bin",    "to": "bin",            "filter": ["ffmpeg.exe","ffprobe.exe"] },
    // 第 2 档：图标资源（tray / notification）
    { "from": "../resources/icons",  "to": "icons" },
    // 第 3 档：过渡期 bridge.exe（PyInstaller 单文件，≤30MB；V3.1 删除）
    { "from": "../resources/studio-legacy", "to": "studio-legacy", "filter": ["bridge.exe"] }
  ],
  "files": [
    "main/**/*",             // 主进程 JS（main.js / tray.js / ...）
    "preload/**/*",          // 预加载桥 JS
    "renderer/dist/**/*",    // Vite 构建后的渲染层（24 JS + 14 CSS + index.html）
    "!node_modules/**/*"     // 明确排除 node_modules（主进程 dependencies 只 electron-updater & systeminformation，它们会被 electron-builder 正确打包）
  ]
}
```

**运行时实际目录（安装后）**：

```
C:\Program Files\螺丝钉-电商智能体矩阵\
├── resources\
│   ├── app\                      ← files 段产物
│   │   ├── main\*  preload\*  renderer\dist\*  package.json
│   │   └── node_modules\{electron-updater, systeminformation}
│   ├── bin\ffmpeg.exe, ffprobe.exe       ← extraResources[0]（V2 目录在 studio/bin/win，V3 仍可通过 getStudioRoot 兼容）
│   ├── icons\*                           ← extraResources[1]
│   └── studio-legacy\bridge.exe          ← extraResources[2]（V2 12 页过渡桥）
└── 螺丝钉-电商智能体矩阵.exe  Uninstall.exe（NSIS）
```

### 6.2 打包命令链

```
# 开发者（快速验证，不打 NSIS）
cd electron
npm run build:dir
# → 输出到 ../dist/win-unpacked/ （解压目录版，可直接运行 exe 调试）

# CI / 发版（正式安装包 + delta 升级）
cd electron
npm run build
# → build:renderer（Vite build）
# → electron-builder --win nsis --x64
# → 输出到 ../dist/螺丝钉-电商智能体矩阵 Setup V3.x.exe（≈ 280~420MB，硬指标 ≤450MB）
# → 同目录 *.blockmap / latest.yml（electron-updater 自动升级所需）
```

### 6.3 安装包硬指标验证（PRD §4.1 不可变约束）

| 验证项              | 方法                        | 预期结果                                                                                                                                              |                                                                                                                     |
| ---------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **无 Python**（U1） | \`dir /s /b               | findstr python\` 在安装目录下执行                                                                                                                         | 不得出现 `python*.exe / python*.dll / site-packages / __pycache__ / *.pyc`；bridge.exe 是 PyInstaller 打包的独立 exe，不包含可提取解释器 |
| **包大小**（CI 门禁）   | \`Get-Item ../dist/\*.exe | % Length\`                                                                                                                                        | **≤ 450 MB**（ffmpeg 约 100MB + bridge 约 25MB + Electron 约 130MB + Vue 构建产物 ≈ 0.5MB）                                  |
| **文件产物路径不变**     | 打开任一素材结果                  | 绝对路径 = `studio/outputs/materials/` / `voice_clone/` / `covers/`，与 V2 1:1                                                                          |                                                                                                                     |
| **V2 升级后保留配置**   | 覆盖安装后启动                   | `studio/config/ai_config.json` / `studio/assets/playwright/`（Cookie）/ `studio/outputs/` 都 100% 保留；首次启动自动迁移旧配置 → Pinia server store + localStorage |                                                                                                                     |

### 6.4 自动升级（electron-updater）

initUpdater（main/updater.js）行为：

- 启动时读取 V2 同款 `studio/config/update.json` 中的 `latest.version` + `update_url`
- 下载 delta 包 → 完成时弹 Notification："新版本已下载，点击立即重启升级"
- **升级兼容**：保留 UserData、studio/config、studio/assets、studio/outputs；仅替换 resources/app/ 和新 bridge.exe（若有）
- V2→V3 首次启动迁移（main.js `app.on('ready')` 尾部加脚本）：
  ```
  1. 读 ai_config.json → 转写到 Pinia server.serverBaseUrl / asrUrl / ttsUrl / voiceCloneUrl
  2. 备份 product_library.json / hotspots.json → *.bak.v2
  3. 迁移完成 = localStorage['v3.migrated'] = true，下次跳过
  ```

***

## 7. 迁移检查清单 & 验收标准

### 7.1 工程构造 CI 门禁（5 项，任一失败不发版）

| 门禁                | 命令                               | 阈值                                                     |     |
| ----------------- | -------------------------------- | ------------------------------------------------------ | --- |
| TypeScript 严格类型检查 | `cd electron; npm run typecheck` | 0 errors                                               |     |
| ESLint            | `cd electron; npm run lint`      | 0 warn 以上                                              |     |
| 安装包大小             | `Get-Item ../dist/*.exe`         | **≤ 450 MB**                                           |     |
| 安装目录无 Python      | 安装后 \`dir /s /b                  | findstr /i python\`                                    | 0 行 |
| Playwright E2E 冒烟 | `npm run e2e`                    | ① 启动到工作台 ≤ 2.5s；② 三 Tab 无白屏；③ 浏览器可解析抖音示例；④ 媒体工具 8 卡可点开 |     |

### 7.2 界面层验收对照 DESIGN（视觉走查项）

- [ ] 顶栏 / 底栏尺寸严格 56px / 44px，`--surface` 背景 + `--border-subtle` 1px 分割
- [ ] 三 Tab 胶囊切换无整页刷新（keep-alive 生效）；切换回来不丢浏览器前进后退历史 / 工作台草稿 / 媒体工具表单内容
- [ ] 工作台侧边栏 264px `--surface-container` 背景；激活项 3px primary 竖线
- [ ] 媒体工具 8 卡片响应式 4/3/2/1 列；禁用态 opacity 0.45 grayscale + tooltip
- [ ] 工具表单通用结构：返回按钮 / 居中标题 / 右侧主 CTA；上传区 dashed 虚线框
- [ ] 所有按钮变体（primary / secondary / ghost / danger / icon）tokens 对齐；focus ring `--ring`；36px 默认高度

### 7.3 接口层验收：字段字节级一致（V2/V3 互通硬指标）

针对 6 份 V2 文档的复用接口（A 类 / A2 类，不含 S1\~S4 新接口）：

| 验收项                                        | 方法                                                                                                         |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 飞书脚本 list / save / adjust-copywriting      | 用 V2 账号保存 10 条脚本 → V3 下拉读取 → 10 条 1:1 相同字节                                                                 |
| 分镜脚本 list / save                           | 同上，镜头 shots\[] 字段顺序一致                                                                                      |
| 成片任务 unifiedList / detail / downloadResult | 同一账号下 V2 提交 editor\_render → V3 成片任务 12 列全部一致显示；总分列算法相同优先级                                                 |
| 素材 stock\_search（联网素材）                     | 同 query 返回排序一致；写入镜头 materials\[] 的 9 字段顺序完全一致（path/thumb/stock\_id/media\_type/w/h/duration/author/source） |

**代码侧自检方法**：`types/server-api.ts` 中的 Request 字段顺序按文档定义声明；`server-proxy.js` 中 buildRequest 的 `new FormData` append 顺序与 V2 `requests.request(files=[...])` 顺序一致；JSON body 字段 `Object.keys()` 排序一致。

### 7.4 UAT 一级阻断项（6 项，Fail 任一不发版）

| 编号 | 操作路径                                | 预期结果                                                       |
| -- | ----------------------------------- | ---------------------------------------------------------- |
| U1 | 双击安装包 → 全默认下一步 → 启动 → 安装目录 dir /s   | **不得出现 python.exe / python3x.dll / site-packages**（方案一硬指标） |
| U2 | 启动后三 Tab 顺序切换 + 打开 DevTools Console | **零红色 error**（warn 可）                                      |
| U3 | 干净 Win11 SSD 机器，冷启动 5 次取平均          | **到工作台可见 ≤ 2.5 s**                                         |
| U4 | 服务端 S1\~S4 验收 SA1\~SA5（见 PRD §2.3）  | **100% 通过**（后端先提交）                                         |
| U5 | 同一账号 V2 保存脚本，V3 读取                  | 10 条脚本字节级完全一致                                              |
| U6 | V2 → V3 覆盖升级后重启                     | 飞书登录态保留 / AI 服务地址保留 / 音色库保留 / 素材库索引保留（肉眼 + 文件 diff 对比）     |

### 7.5 UAT 二级功能验收（11 项，P0）

| 编号  | 操作路径                                                            | 预期结果                                                                                    |    |    |      |                       |
| --- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -- | -- | ---- | --------------------- |
| W1  | 飞书脚本创作 → 选 JBL CHARGE6 → 生成 → 任意镜头点「引用素材」→ 打开素材库 Tab / 联网素材 Tab | 筛选条件 + query 前缀 = "JBL CHARGE6"；本地素材结果中 JBL CHARGE6 占比 ≥ 60%                            |    |    |      |                       |
| W2  | 引用素材 Dialog → MG动画 Tab → 跳转按钮                                   | 切回工作台 → 打开素材生成页 → 内部 Tab2 MG动画                                                          |    |    |      |                       |
| W3  | 引用素材 Dialog → 联网素材 → 搜"音箱"→ 勾选 3 → 确认                           | 写入镜头 materials\[3]，type="web\_stock"，9 字段齐全                                             |    |    |      |                       |
| W4  | 成片任务 → 刷新 / 勾选自动刷新 / 全选 10 → 下载所选 → 打包所选                        | 顶行按钮顺序 = \[全选                                                                           | 下载 | 打包 | 自动刷新 | 刷新]；下载 100% + 打包 100% |
| W5  | 成片任务总分列 → 打开带深度评审任务行                                            | 显示 ev.total，<5 红色 / ≥7 绿色；优先级 ev.total > qs.total > variants\[0].score > task.\*\_score |    |    |      |                       |
| W6  | 成片任务操作列日志按钮 → 分别点有/无日志行                                         | 有日志：弹窗显示 logs + error\_msg；无日志：灰态 disabled 禁点                                           |    |    |      |                       |
| W7  | 浏览器 → 打开抖音已登录账号页 → 解析并导入素材库                                     | 底栏下载进度更新；完成后系统通知；素材检索页中出现（无需刷新）                                                         |    |    |      |                       |
| W8  | 媒体工具 → 图像抠图 S1 → 上传产品图 / 默认 u2net / 开始                          | 轮询直到成功；成片任务列表 type=rembg\_matting；下载 PNG α 通道非零 ≈ 本地 rembg ±3%                          |    |    |      |                       |
| W9  | 媒体工具 → 视频修复 S2 → 720p / superres 4x → 开始                        | 成片任务列表 type=vsr\_enhance；stage 显示 抽帧/推理/编码；完成后可播放 4K                                    |    |    |      |                       |
| W10 | 媒体工具 → 图片反推 S3 → 上传含品牌产品图 / zh+en / count=4                     | 返回 4 条中英 prompt；含品牌/型号名召回率 ≥ 90%                                                        |    |    |      |                       |
| W11 | 顶栏服务器状态灯 → 关闭服务端 → 等待                                           | 60s 内变红；tooltip"无法连接服务端"；**1 分钟内仅 1 次离线事件（≤1 次/分）**，不再高频报错刷屏                            |    |    |      |                       |

### 7.6 非功能验收（4 项）

| 项                         | 指标                                                                                          | 测量方法                                           |
| ------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 空载内存（三 Tab 各打开一次后）        | **≤ 600 MB**（Chromium 开销合理）                                                                 | 任务管理器→详细信息→electron 进程组求和                      |
| Tab 切换内存泄漏（切 50 次后回归空载）   | **增长 ≤ 80 MB**                                                                              | Chrome DevTools Memory → heap snapshot diff    |
| 崩溃恢复（手动 kill renderer 进程） | 主进程 3s 内自动 reload 恢复，不影响其他 Tab / webview 子页                                                 | Task Manager → 结束对应 renderer PID               |
| 隐私 Cookie 隔离              | 浏览器 partition `persist:tintin-browser`，其他 Tab 读不到；路径写入 `studio/assets/playwright/`（与 V2 一致） | DevTools → Application → Cookies 检查 session 隔离 |

***

## 附：落地代码文件索引表（点击直接跳转）

| 类别           | 文件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 规格文档         | [PRD\_Electron\_v3\_SchemeA.md](file:///d:/Project/TinTin_Client_Electron/docs/PRD_Electron_v3_SchemeA.md) · [DESIGN\_Electron\_v3.md](file:///d:/Project/TinTin_Client_Electron/docs/DESIGN_Electron_v3.md) · 6 份 V2 接口（docs/V2\_\*.md）                                                                                                                                                                                                                                                                                                                              |
| 类型契约单源       | [types/server-api.ts](file:///d:/Project/TinTin_Client_Electron/electron/types/server-api.ts) · [types/global.d.ts](file:///d:/Project/TinTin_Client_Electron/electron/types/global.d.ts)                                                                                                                                                                                                                                                                                                                                                                             |
| 主进程模块        | [main/main.js](file:///d:/Project/TinTin_Client_Electron/electron/main/main.js) · [main/server-proxy.js](file:///d:/Project/TinTin_Client_Electron/electron/main/server-proxy.js) · [main/download-manager.js](file:///d:/Project/TinTin_Client_Electron/electron/main/download-manager.js) · [main/ffmpeg-gate.js](file:///d:/Project/TinTin_Client_Electron/electron/main/ffmpeg-gate.js) · [main/tray.js](file:///d:/Project/TinTin_Client_Electron/electron/main/tray.js) · [main/updater.js](file:///d:/Project/TinTin_Client_Electron/electron/main/updater.js) |
| 预加载桥         | [preload/preload.js](file:///d:/Project/TinTin_Client_Electron/electron/preload/preload.js) · [preload/browser-webview.js](file:///d:/Project/TinTin_Client_Electron/electron/preload/browser-webview.js)                                                                                                                                                                                                                                                                                                                                                             |
| 渲染层根         | [renderer/src/App.vue](file:///d:/Project/TinTin_Client_Electron/electron/renderer/src/App.vue) · [main.ts](file:///d:/Project/TinTin_Client_Electron/electron/renderer/src/main.ts) · [router/index.ts](file:///d:/Project/TinTin_Client_Electron/electron/renderer/src/router/index.ts)                                                                                                                                                                                                                                                                             |
| Pinia Stores | [stores/app.ts](file:///d:/Project/TinTin_Client_Electron/electron/renderer/src/stores/app.ts) · [stores/server.ts](file:///d:/Project/TinTin_Client_Electron/electron/renderer/src/stores/server.ts) · [stores/downloads.ts](file:///d:/Project/TinTin_Client_Electron/electron/renderer/src/stores/downloads.ts) · [stores/tasks.ts](file:///d:/Project/TinTin_Client_Electron/electron/renderer/src/stores/tasks.ts)                                                                                                                                               |
| 三 Tab 视图     | [views/Workbench.vue](file:///d:/Project/TinTin_Client_Electron/electron/renderer/src/views/Workbench.vue) · [views/Browser.vue](file:///d:/Project/TinTin_Client_Electron/electron/renderer/src/views/Browser.vue) · [views/MediaTools.vue](file:///d:/Project/TinTin_Client_Electron/electron/renderer/src/views/MediaTools.vue)                                                                                                                                                                                                                                    |
| 基础组件         | [components/common/](file:///d:/Project/TinTin_Client_Electron/electron/renderer/src/components/common/)（TButton/TCard/TInput/TSelect/TDialog/TNotification/TTable/VideoPreview）                                                                                                                                                                                                                                                                                                                                                                                      |
| 媒体工具表单       | [components/media-tools/](file:///d:/Project/TinTin_Client_Electron/electron/renderer/src/components/media-tools/)（8 张表单 CoverMaker / ImageMatting / VideoRepair / VideoTranscribe / VoiceClone / SubtitleRemoval / ReversePromptImage / ReversePromptVideo）                                                                                                                                                                                                                                                                                                          |
| 设计系统         | [styles/tokens.css](file:///d:/Project/TinTin_Client_Electron/electron/renderer/src/styles/tokens.css) · [styles/global.css](file:///d:/Project/TinTin_Client_Electron/electron/renderer/src/styles/global.css)                                                                                                                                                                                                                                                                                                                                                       |
| 工程配置         | [electron/package.json](file:///d:/Project/TinTin_Client_Electron/electron/package.json) · [tsconfig.json](file:///d:/Project/TinTin_Client_Electron/electron/tsconfig.json) · [renderer/vite.config.ts](file:///d:/Project/TinTin_Client_Electron/electron/renderer/vite.config.ts)                                                                                                                                                                                                                                                                                  |
| 一键启动脚本       | [start-dev.bat](file:///d:/Project/TinTin_Client_Electron/start-dev.bat)（ASCII-safe，全 locale 兼容）                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

