# 螺丝钉 V3 Electron 客户端 UI 设计文档

> 版本：V3.0 设计稿 | 日期：2026-08-25 | 对应需求：`PRD_Electron_v3_SchemeA.md`
>
> 设计目标：在保留 Luosiding 品牌资产的前提下，借鉴 Cherry Studio 的侧边栏 + 内容区布局、卡片式导航、冷静中性的暗色界面语言，为「螺丝钉-电商智能体矩阵」重写一套面向生产效率的 Electron 三 Tab 工作台。

---

## 一、设计总则

### 1.1 设计语言定位

本次 V3 采用 **「冷静工具型暗色界面」**：

- 界面本身尽量后退，让脚本、素材、任务状态等生产内容成为视觉焦点。
- 参考 Cherry Studio 的窄侧边栏、顶部全局状态条、卡片式功能入口、柔和的分割线与 hover 反馈。
- 沿用 Luosiding 现有设计系统 tokens（主色 `#6d5dfc`、暗色背景 `#0f1020`、卡片面 `#161828`），保证 V2→V3 视觉连续性。
- 不引入 Element Plus / Ant Design Vue 等第三方 UI 库，所有组件基于 Luosiding tokens 自研。

### 1.2 关键体验指标

| 指标 | 设计策略 |
|---|---|
| 冷启动 ≤ 2.5s | 首屏只渲染顶栏 + Tab 壳 + 默认工作台页；其余 Tab 与 webview 按需挂载。 |
| 同窗口三 Tab 无闪烁 | 顶部 Tab 切换使用 Vue `keep-alive` + 全局状态栏常驻，避免整页刷新。 |
| 崩溃不影响其他 Tab | 每个 Tab 内容区独立 renderer 容器或 webview，视觉壳保持完整。 |
| 信息密度高但不过载 | 工作台使用 264px 侧边栏 + 弹性内容区；媒体工具使用 4 列响应式卡片。 |

### 1.3 不可变约束（来自 PRD）

1. 必须复用 `.design_library/Luosiding` 的 color / typography / spacing / radius / shadow tokens。
2. 三个主 Tab 固定不变：**工作台 / 浏览器 / 媒体工具**。
3. 不允许本地 Python runtime；所有 AI 能力走服务端 API（S1~S4）。
4. 文件产物路径不变：`studio/outputs/materials/`、`studio/outputs/voice_clone/`、`studio/outputs/covers/`。

---

## 二、设计系统

### 2.1 色彩体系

在 Luosiding 现有 tokens 基础上，增加 Cherry Studio 风格的「冷静中性层」，保持主色不变。

#### 品牌与语义色

| Token | 暗色值 | 用途 |
|---|---|---|
| `--primary` | `#6d5dfc` | 主按钮、激活态、焦点环、链接、关键数据强调。 |
| `--primary-hover` | `#7c6dfd` | 主按钮 hover。 |
| `--primary-foreground` | `#ffffff` | 主色上的文字。 |
| `--accent` | `#a78bfa` | 选中素材角标、进度条高光、AI 生成提示。 |
| `--success` | `#10b981` | 成功状态、服务器在线灯。 |
| `--warning` | `#f59e0b` | 警告、排队中。 |
| `--error` | `#ef4444` | 失败、离线、删除操作。 |
| `--info` | `#3b82f6` | 提示、下载进度、日志。 |

#### 中性表面

| Token | 暗色值 | 用途 |
|---|---|---|
| `--background` | `#0f1020` | 窗口背景。 |
| `--surface` | `#161828` | 卡片、面板、表格区。 |
| `--surface-container` | `#1e2133` | 侧边栏、筛选面板、输入框背景。 |
| `--surface-container-high` | `#262a45` | 悬停、次级面板、展开详情。 |
| `--border` | `#262a45` | 卡片边框、分隔线。 |
| `--border-subtle` | `#1e2133` | 极细分割线。 |
| `--foreground` | `#f0f1f7` | 主文字。 |
| `--muted-foreground` | `#9ca1b1` | 次要文字、placeholder、时间戳。 |

> 注：light 模式保持 PRD 要求，通过 `:root.light` 翻转，这里不展开。

### 2.2 字体与排版

沿用 PRD 字体栈：

```css
font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
```

| 层级 | 字号 | 字重 | 行高 | 用途 |
|---|---|---|---|---|
| Page Title | 20px | 600 | 1.3 | 页面标题、Tab 标题。 |
| Section Title | 16px | 600 | 1.4 | 分组标题、卡片标题。 |
| Body | 14px | 400 | 1.6 | 正文、表格内容。 |
| Caption | 12px | 400 | 1.5 | 辅助说明、时间戳、版本号。 |
| Eyebrow | 11px | 600 | 1.4 | 分组标签、状态小标。 |
| Mono | 13px | 400 | 1.6 | Task ID、日志、JSON 详情。 |

### 2.3 间距与尺寸

| Token | 值 | 用途 |
|---|---|---|
| `--space-1` | 4px | 图标与文字间距。 |
| `--space-2` | 8px | 紧凑内边距。 |
| `--space-3` | 12px | 按钮内边距、卡片内部元素间距。 |
| `--space-4` | 16px | 标准卡片内边距。 |
| `--space-5` | 20px | 面板之间间距。 |
| `--space-6` | 24px | 页面内容区外边距。 |

控件高度：

- 按钮默认 36px，小按钮 28px。
- 输入框 34px，搜索框 36px。
- 顶栏 56px，底栏 44px，侧边栏 264px。

### 2.4 圆角与阴影

| Token | 值 | 用途 |
|---|---|---|
| `--radius-sm` | 6px | 标签、小按钮。 |
| `--radius-md` | 8px | 按钮、输入框、导航项。 |
| `--radius-lg` | 10px | 大容器。 |
| `--radius-xl` | 12px | 卡片、媒体工具卡片。 |
| `--radius-full` | 9999px | 状态徽章、头像。 |

阴影保持 Luosiding 5 级体系，卡片 hover 使用 shadow-2。

### 2.5 动效

| 场景 | 时长 | 缓动 |
|---|---|---|
| 按钮/输入框状态变化 | 150ms | ease-out |
| Tab 切换、面板展开 | 200ms | cubic-bezier(0.4, 0, 0.2, 1) |
| 卡片 hover 抬升 | 150ms | ease-out |
| 进度条/加载 | 300ms | linear |

---

## 三、全局布局架构

### 3.1 窗口框架

整个 Electron 窗口采用 **「顶栏 + 内容区 + 底栏」** 三明治结构：

```
┌─────────────────────────────────────────────────────────────┐
│  顶栏（56px）：Logo | 产品名 | 三 Tab | 系统状态 | 通知        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  内容区（动态）：                                             │
│  Tab1 工作台  /  Tab2 浏览器  /  Tab3 媒体工具               │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  底栏（44px）：任务执行条 | 自动刷新 | 下载进度              │
└─────────────────────────────────────────────────────────────┘
```

- 顶栏横跨三 Tab，左侧放产品身份，中间放 Tab 切换，右侧放系统指标。
- 底栏横跨三 Tab，左侧最多显示 3 条任务执行条，右侧显示全局下载进度。
- Tab 切换采用 **胶囊按钮组**，参考 Cherry Studio 顶栏风格。

### 3.2 顶栏（Header）

| 区域 | 元素 | 说明 |
|---|---|---|
| 左 | Logo 20px + 产品名「螺丝钉-电商智能体矩阵」+ 版本号 caption | 版本号用 muted-foreground。 |
| 中 | Tab 胶囊：工作台 / 浏览器 / 媒体工具 | 当前 Tab 使用 `--surface-container-high` 填充 + primary 下划线。 |
| 右 | 服务器状态灯（绿/黄/红）+ CPU/内存/GPU/显存小条 + 通知铃铛 | 状态灯每 60s 刷新；hover 显示 tooltip。 |

顶栏视觉：

- 背景使用 `--surface`。
- 底部 1px `--border-subtle` 分割线。
- 图标统一 20px，状态文字 caption。

### 3.3 底栏（Footer）

| 区域 | 元素 | 说明 |
|---|---|---|
| 左 | 任务执行条：最多 3 条，每条含名称 + 进度条 + 暂停/取消/日志 | 超过 3 条折叠为「+N 个任务进行中」。 |
| 中 | 自动刷新复选框（仅在「成片任务」子页显示） | 其他子页隐藏或置灰。 |
| 右 | 下载进度条：文件名 + 百分比 + 速度 | 浏览器和媒体工具共用同一进度池。 |

底栏视觉：

- 高度 44px，背景 `--surface`。
- 顶部 1px `--border-subtle` 分割线。
- 进度条高度 4px，圆角 2px，主色填充。

### 3.4 Tab 内容区通用模式

每个 Tab 内部采用 **「可选侧边栏 + 主内容区」** 布局：

- **工作台 Tab**：左侧 264px 侧边栏（工作台子导航），右侧主内容区。
- **浏览器 Tab**：无侧边栏，全宽地址栏 + BrowserView 区域。
- **媒体工具 Tab**：无侧边栏，顶部返回按钮 + 卡片网格 / 工具表单。

---

## 四、Tab1：工作台

### 4.1 工作台侧边栏

侧边栏宽度 264px，背景 `--surface-container`。

分组：

1. **高频重写页**（V3 MVP 必须）
   - 飞书脚本创作
   - 分镜脚本
   - 素材检索
   - 成片任务
2. **过渡期桥接页**（webview 指向 bridge.exe）【🚫 方案作废，2026-08-27：依赖 PySide6/Python，违反移植基本要求「不依赖 python」】
   - 方案脚本、一键成片、成片任务队列、产品库、素材生成、音频素材、智能混剪、直播切片…
   - 这些页面**不再移植**：其内容已由会话智能体（agent 工具调用）承载，不走菜单页形式。

> **2026-08-27 移植基本要求定稿**：移植范围收敛为四部分（工作台 / 浏览器 / 媒体工具 / 系统配置），全部 Electron+Vue+TS 原生实现，**不依赖 Python**。4.2～4.6 降级为「待定」（能力由会话智能体承载，按需评估）；**「过渡期桥接页（webview→bridge.exe）」方案作废**（依赖 PySide6，违反基本要求），原侧边栏其余页面不再移植。工作台仅新增「定时任务管理」原生页（scheduled_tasks_mgmt_page.py）+ 侧边栏渐进式挂载。详见 [GAP_Report_实施差距报告_2026-08-27.md](./GAP_Report_实施差距报告_2026-08-27.md)。

侧边栏项状态：

- 默认：文字 + 图标 20px，hover 背景 `--surface-container-high`。
- 激活：左侧 3px primary 竖线 + `--primary-container` 背景 + primary 图标色。
- 禁用（桥接未就绪）：opacity 0.5，cursor not-allowed。

### 4.2 飞书脚本创作页【⏸ 待定】

参考 `ai_script_page.py`，采用 **左右分栏**。

```
┌──────────────────────────────┬──────────────────────────────┐
│  左侧面板（360px）            │  右侧脚本卡片列表             │
│  ─────────────────────────   │  ─────────────────────────   │
│  已有脚本下拉 + 继续创作        │  ┌──────────────────────┐   │
│  风格化下拉 + 重置             │  │ 镜头 1 | 特写 | 3s     │   │
│  风格画像 textarea            │  │ 画面描述...           │   │
│  附加提示词 + 大模型调整文案    │  │ 旁白台词...           │   │
│  视频文案编辑器               │  │ [⚙] [引用素材]         │   │
│  [生成脚本] primary           │  └──────────────────────┘   │
└──────────────────────────────┴──────────────────────────────┘
```

设计细节：

- 左侧面板背景 `--surface`，圆角 12px，内边距 16px。
- 每个表单分组用 12px eyebrow 标题 + 8px 间距。
- 「生成脚本」按钮固定在左侧面板底部，宽度 100%。
- 右侧卡片：
  - 每张卡片背景 `--surface`，border 1px `--border`，圆角 12px。
  - 头部：镜头编号 badge + 镜别下拉 + 时长输入。
  - 中部：画面描述、旁白台词两个 textarea。
  - 底部：小齿轮（编辑）+「引用素材」按钮（secondary）。
  - 卡片间距 12px，hover border 变 primary。

### 4.3 分镜脚本页【⏸ 待定】

参考 `storyboard_page.py`。

顶部操作行：

```
[相似度自动绑定] [画幅 ▼ 9:16]                              [保存分镜脚本]
```

- 左侧放辅助功能按钮（ghost 风格）。
- 右侧放主要操作「保存分镜脚本」（primary）。
- 中间显示当前产品名（如「JBL CHARGE6」）作为面包屑。

镜头卡片与飞书脚本页类似，但增加：

- 风格画像预览缩略图（每个镜头右上角小图 64×64）。
- 「引用素材」按钮打开 ShotMaterialDialog。

底部操作行：

```
[同步到多维表格] [创建飞书文档] [飞书关联标签]
```

### 4.4 引用素材对话框（ShotMaterialDialog）【⏸ 待定】

对话框尺寸：960×640px，圆角 14px，顶部 Tab 切换。

| Tab | 内容 |
|---|---|
| 素材库 | 本地素材缩略图网格；默认按当前镜头 brand/model/category 筛选；角标多选；右键预览。 |
| MG动画 | 仅显示提示「MG 动画需要在素材生成页制作」+ [跳转到 MG动画] 按钮。 |
| 联网素材 | 类型下拉（图片/视频/全部）+ 搜索框；搜索结果网格；勾选后确认写入 `materials[]`。 |

网格规范：

- 缩略图固定宽高比（图片 1:1，视频 16:9）。
- 卡片圆角 8px，hover 显示勾选框。
- 左下角 brand/model 小徽章（tag badge）。
- 选中态：2px primary border + 左上角勾选图标。

### 4.5 素材检索页【⏸ 待定】

参考 `vector_search_page.py` / `gui/vector_search/`。

布局：

```
┌──────────────┬──────────────────────────────────────┐
│  筛选面板     │  顶部搜索 + 缩略图网格                │
│  264px       │                                      │
│              │                                      │
│  文件类型     │                                      │
│  横纵比       │                                      │
│  分辨率       │                                      │
│  时长范围     │                                      │
│  品牌/型号    │                                      │
│  产品分类     │                                      │
│  Tag 云      │                                      │
└──────────────┴──────────────────────────────────────┘
```

设计细节：

- 左侧面板背景 `--surface-container`，圆角 0（贴边），内边距 16px。
- 每个筛选分组用可折叠面板（accordion），默认展开前 3 个。
- Tag 云使用 pill badge，选中态 primary container。
- 右侧顶部搜索框：左侧搜索图标 + 圆角输入框 + 右侧「筛选」按钮。
- 缩略图网格：CSS Grid，最小 160px，gap 12px，统一 aspect-ratio，避免 Qt 缓存问题。
- 空 keyword 时显示「最近导入」占位区，带最近 8 张缩略图。
- 双击图片：大图预览遮罩；双击视频：HTML5 video 弹窗，可拖拽进度。

### 4.6 成片任务页【⏸ 待定】

参考 `scheduled_tasks_page.py`。

顶部操作行（严格按 PRD 顺序）：

```
成片任务列表（来自服务端）           [☐ 全选] [下载所选] [打包所选] [自动刷新] [刷新]
```

- 「全选」是列头复选框文字标签。
- 操作按钮使用 secondary + icon 组合。

表格：

- 12 列：多选 / TASK_ID / 标题 / 类型 / 状态 / 进度 / 总分 / 播放 / 下载 / 创建时间 / 操作（日志/删除）。
- 行高 48px，表头背景 `--surface-container-high`，文字 `--muted-foreground`。
- 行 hover 背景 `--surface-container-high`。
- 选中行背景 `--primary-container`，文字 `--primary-foreground`。
- 状态列使用 badge：排队中（info）、进行中（primary）、已完成（success）、失败（error）。
- 总分列：≥7 绿色，<5 红色，空值空白。
- 进度列：迷你进度条 80×4px，圆角 2px。
- 操作列：日志按钮（无日志时 disabled），删除图标按钮 danger。

详情展开区：

- 点击行下方展开，背景 `--surface-container`。
- 使用折叠面板展示 audio / video / image / project 各子项 JSON。
- Mono 字体，可一键复制。

---

## 五、Tab2：浏览器

> 2026-08-27 按实际实现同步（BrowserToolbar.vue / BrowserRightPanel.vue / SniffTab.vue / downloads-panel.html）。

### 5.1 浏览器工具栏

```
┌───────────────────────────────────────────────────────────────────────┐
│ [☰ 侧栏] [←] [→] [⟳] [🔒 平台图标 地址栏 https://...] [🧩 扩展] [🕘] [⬇] [⚙] │
└───────────────────────────────────────────────────────────────────────┘
```

- 地址栏高度 36px，圆角 8px，背景 `--surface-container`，focus 时 primary ring；🔒 图标区分「平台固定地址 / 可编辑」态，地址栏内嵌当前平台扩展入口图标与「扩展管理」「历史记录」快捷按钮。
- 前进/后退/刷新/侧栏为 icon 按钮。
- ⬇ 下载管理按钮 → 唤起**置顶下载浮窗**（400×480，跟随按钮位置弹出，不被 BrowserView 遮盖），不跳转右栏。
- ⚙ 设置按钮 → 打开设置 Tab。
- （已废弃：~~「⚡ 解析并导入素材库」按钮~~，见 PRD §3.3）

### 5.2 右侧面板（替代原「左侧历史/下载侧边栏」）

左缘 ☰ 可折叠侧栏保留「快速标签与历史记录」；功能主体为**右侧面板**（BrowserRightPanel）：

- **媒体嗅探 Tab（SniffTab）**：嗅探到的音/视频卡片列表（名称/体积/含音频标识）；B站详情页优先展示扩展解析出的「合并下载」单条目（画质+体积）；**点击下载后进度条内嵌在该卡片上**（视频 x% · 音频 y% / 已完成 / 失败）。
- **页面下载**：当前页面 URL 直下。
- 下载历史统一在 ⬇ 浮窗（打开文件 / 打开位置 / 删除 / 清除已完成），浮窗头部 📁 可改保存路径。

### 5.3 主浏览区

- BrowserView 真嵌入，**每平台独立 session partition `persist:tintin-<platform>`**（共 8 个，Cookie/登录态互不干扰；`persist:tintin-browser` 仅网页浏览器 Tab 使用）。
- 内容区与工具栏之间 1px `--border-subtle` 分隔。
- did-fail-load 注入亮/暗主题跟随的离线兜底页；崩溃自动重建 ≤3 次。
- 下载进度不再走底栏全局池：嗅探卡片内嵌 + ⬇ 浮窗为准。

---

## 六、Tab3：媒体工具

### 6.1 卡片导航首页

8 张卡片，分三组：

```
图形
┌────────────┐ ┌────────────┐
│ 封面制作    │ │ 图像抠图    │
└────────────┘ └────────────┘

视频
┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐
│ 视频修复    │ │ 视频转文字  │ │ 声音克隆    │ │ 视频去水印字幕│
└────────────┘ └────────────┘ └────────────┘ └────────────┘

提示词
┌────────────┐ ┌────────────┐
│ 图片反推    │ │ 视频反推    │
└────────────┘ └────────────┘
```

卡片规范：

- 圆角 12px，背景 `--surface`，border 1px `--border`。
- 顶部 4px primary accent bar（参考 Luosiding Feature Card）。
- 图标 44px，居中，使用 accent 色或 primary 色。
- 标题 15px bold，说明 12px `--muted-foreground`。
- hover：border 变 primary，背景 `--surface-container-high`，shadow-2。
- 禁用态（服务端未部署）：opacity 0.45，grayscale，tooltip「当前服务端未部署此能力」。

响应式网格：

- ≥1280px：4 列。
- 1024~1279px：3 列。
- 768~1023px：2 列。
- <768px：1 列。

### 6.2 工具表单页通用结构

进入单个工具后：

```
┌─────────────────────────────────────────────────┐
│ [← 返回媒体工具]        [工具标题]      [开始]  │
├─────────────────────────────────────────────────┤
│                                                 │
│  上传区 / 参数表单 / 预览区 / 结果区             │
│                                                 │
└─────────────────────────────────────────────────┘
```

- 顶部返回为 ghost 按钮 + 左箭头。
- 标题居中，开始按钮 primary。
- 表单使用两列或单列布局，间距 16px。
- 上传区使用虚线拖拽区域：border dashed `--border`，hover 背景 `--surface-container-high`。
- 结果区显示缩略图/视频播放器 + 下载按钮。

### 6.3 图像抠图页示例

参数表单：

- 模型下拉：u2net / isnet-general-use / birefnet-portrait
- α 细化开关
- 背景色可选（默认透明）
- [开始抠图] primary

进度：

- 提交后显示任务卡片，含 progress bar + stage 文字。
- 完成后显示原图/结果图对比，[下载 PNG] 按钮。

---

## 七、组件规范

### 7.1 Button

| 变体 | 背景 | 文字 | 边框 | Hover |
|---|---|---|---|---|
| primary | `--primary` | `--primary-foreground` | none | `--primary-hover` |
| secondary | `--surface-container` | `--foreground` | `--border` | `--surface-container-high` |
| ghost | transparent | `--foreground` | `--border` | `--surface-container-high` |
| danger | `--error` | white | none | brightness 1.08 |
| icon | `--surface` | `--muted-foreground` | `--border` | `--surface-container-high` |

### 7.2 Input

- 高度 34px，圆角 8px，背景 `--surface-container`，border `--border`。
- focus：border `--primary` + 0 0 0 2px `--ring`。
- error：border `--error` + 背景 `--error-container` 10%。
- search 变体左侧 20px 搜索图标。

### 7.3 Card

- 背景 `--surface`，border 1px `--border`，圆角 12px，shadow-1。
- hover：border primary，shadow-2。
- 顶部可选 4px primary accent bar。

### 7.4 Table

- 表头高 40px，背景 `--surface-container-high`。
- 行高 48px，border-bottom 1px `--border`。
- 选中行 `--primary-container`。
- 空状态：居中图标 + 「暂无数据」caption。

### 7.5 Badge

- 状态 badge：height 20px，padding 0 8px，圆角 9999px。
- tag badge：height 22px，圆角 6px，背景 `--secondary`。

### 7.6 Dialog

- 背景 `--surface`，圆角 14px，shadow-4。
- 遮罩 `rgba(0,0,0,0.55)`。
- 标题 16px bold，底部 1px `--border-subtle`。
- 内容区最大高度 70vh，可滚动。

### 7.7 Toast / Notification

- 右上角滑入，宽度 320px。
- 成功/警告/错误三种背景色。
- 自动消失 4s，hover 暂停。

---

## 八、交互与状态

### 8.1 服务器状态

| 状态 | 颜色 | 图标 | Tooltip |
|---|---|---|---|
| 在线 | success | 圆点 | 服务端正常 |
| 降级/排队 | warning | 圆点 | 部分能力排队 |
| 离线 | error | 圆点 | 无法连接服务端 |

### 8.2 任务状态

| 状态 | Badge 颜色 | 说明 |
|---|---|---|
| 排队中 | info | 等待 GPU/队列。 |
| 进行中 | primary | 显示进度与 stage。 |
| 已完成 | success | 可播放/下载。 |
| 失败 | error | 显示日志按钮。 |

### 8.3 加载与空状态

- 按钮 loading：左侧 spinner + 文字，opacity 0.7。
- 卡片网格骨架屏：4~8 张灰色脉冲块。
- 空状态：大图标 + 标题 + 辅助文字 + 可选操作按钮。

### 8.4 键盘与无障碍

- Tab 顺序遵循视觉顺序。
- 所有按钮/输入框支持 focus ring。
- 表格支持 Shift 多选、Ctrl 单选。
- 快捷键：
  - `Ctrl+R`：刷新当前页。
  - `Ctrl+F`：聚焦搜索框。
  - `Esc`：关闭弹窗/退出全屏预览。

---

## 九、图标与插图

- 使用 Lucide 图标（CDN 或本地 sprite），保持线框风格，统一 1.5px stroke。
- 图标尺寸：导航 20px，按钮 16px，卡片 44px，空状态 48px。
- 不直接使用 Emoji；状态使用彩色圆点 + 文字替代。

---

## 十、实现路径

### 10.1 文件组织

```
electron/renderer/src/
├── styles/
│   ├── tokens.css          # 继承 Luosiding variables
│   ├── base.css            # 全局 reset + 滚动条
│   ├── components.css      # button/input/card/table/badge/dialog
│   └── pages.css           # 页面级布局覆盖
├── components/common/      # Button, Input, Card, Table, Badge, Dialog, Toast
├── components/workbench/   # AiScriptPage, StoryboardPage, ShotMaterialDialog, VectorSearchPage, ScheduledTasksPage
├── components/browser/     # BrowserToolbar, DownloadSidebar
├── components/media-tools/ # 8 个工具表单
├── views/
│   ├── Workbench.vue
│   ├── Browser.vue
│   └── MediaTools.vue
├── App.vue                 # 顶栏 + Tab 路由 + 底栏
└── router/index.ts         # 三 Tab + 工作台子路由
```

### 10.2 关键 Vue 组件清单

| 组件 | 文件 | 说明 |
|---|---|---|
| AppShell | `App.vue` | 顶栏、底栏、Tab 容器。 |
| Workbench | `views/Workbench.vue` | 侧边栏 + `<router-view>`。 |
| Browser | `views/Browser.vue` | 工具栏 + webview 容器。 |
| MediaTools | `views/MediaTools.vue` | 卡片网格 + 子工具路由。 |
| AiScriptPage | `components/workbench/AiScriptPage.vue` | 飞书脚本创作。 |
| StoryboardPage | `components/workbench/StoryboardPage.vue` | 分镜脚本。 |
| ShotMaterialDialog | `components/workbench/ShotMaterialDialog.vue` | 引用素材三 Tab 弹窗。 |
| VectorSearchPage | `components/workbench/VectorSearchPage.vue` | 素材检索。 |
| ScheduledTasksPage | `components/workbench/ScheduledTasksPage.vue` | 成片任务表格。 |

### 10.3 与现有 Luosiding 设计系统对齐

- 将 `TinTin_AI_Agent_Main/.design_library/Luosiding/colors_and_type.css` 与 `components.css` 复制/链接到 `electron/renderer/src/styles/`。
- 如需扩展 Cherry Studio 风格变量，在 `tokens.css` 中新增，不覆盖原有 token 名。
- 组件 class 命名沿用 Luosiding 前缀：`luo-btn`、`luo-input`、`luo-card`、`luo-table` 等。

### 10.4 过渡期桥接页样式

- webview 加载 bridge.exe 页面时，在壳内显示「加载中」覆盖层。
- bridge 崩溃时，内容区显示错误卡片：
  - 图标：warning
  - 标题：该模块正在升级中
  - 说明：bridge 进程未响应，请稍后重试或联系管理员
  - 按钮：[重试]

---

## 十一、验收检查清单（设计侧）

| 编号 | 检查项 | 标准 |
|---|---|---|
| D1 | 三 Tab 切换 | 无白屏、无整页刷新、动画 200ms。 |
| D2 | 顶栏/底栏常驻 | 切换 Tab 时保持可见，状态实时更新。 |
| D3 | 工作台侧边栏 | 264px 宽度，激活态明确，桥接项有标签。 |
| D4 | 媒体工具卡片 | 8 张卡片完整，禁用态有 tooltip。 |
| D5 | 表格交互 | 行 hover、选中、展开详情、操作按钮状态正确。 |
| D6 | 弹窗 | ShotMaterialDialog 三 Tab、网格选中、确认回写。 |
| D7 | 暗色主题 | 所有页面在默认暗色主题下无 hard-coded 浅色。 |
| D8 | 无第三方 UI 库 | 仅使用自研组件 + Luosiding tokens。 |

---

## 十二、参考来源

1. `PRD_Electron_v3_SchemeA.md` — 业务需求与验收标准。
2. `TinTin_AI_Agent_Main/.design_library/Luosiding/` — 品牌色彩、字体、组件 tokens。
3. Cherry Studio（CherryHQ/cherry-studio）— 侧边栏布局、卡片式导航、冷静中性暗色 UI 语言参考。
4. 原 PySide6 实现：`ai_script_page.py`、`storyboard_page.py`、`vector_search/`、`scheduled_tasks_page.py`、`media_tools_page.py`。

---

## 十三、变更记录

| 日期 | 版本 | 变更 | 作者 |
|---|---|---|---|
| 2026-08-25 | 1.0 | 初始设计文档：布局、三 Tab、组件规范、实现路径 | — |
| 2026-08-27 | 1.1 | **§五 浏览器按实际实现重写**：工具栏（☰/←/→/⟳/🔒地址栏含扩展·历史/🧩/⬇/⚙）；左历史侧栏 → 右侧嗅探面板（卡片内嵌进度）；下载管理 → ⬇ 置顶浮窗（📁 可改路径）；分区 8 平台独立；废弃「⚡解析并导入」按钮与底部全局进度池 | — |
