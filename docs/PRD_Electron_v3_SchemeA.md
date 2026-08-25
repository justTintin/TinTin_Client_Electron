# PRD V3 — 客户端全面 Electron 化（方案一：纯服务端推理，零本地 Python runtime）

> 版本：**V3 正式版（已锁定）** | 日期：2026-08-25 | 状态：✅ 已确认
> 决策结论（已由业务方确认锁定）：
> - **迁移方式：方案一**（客户端 UI 全 Electron 重写 + 原 C 类本地推理能力服务端化，客户端彻底不保留 Python runtime / PySide6 / python_embeded）
> - UI 重写策略：渐进（优先 4 个高频页，剩余低频页第一阶段内嵌 `<webview>` 指向 PySide6 localhost 桥）
> - 前端技术栈：**Vue 3 + Vite + Pinia + Vue Router**（原因：`apps/asset-browser` 已有原生 JS 基础，Vue 学习曲线低、打包体积小、生态在 Electron 场景成熟）
> 适用范围：本文档 = 服务端新增接口需求 + 客户端 Electron 新工程需求 + 验收标准，三部分同时生效。
> 非目标：不修改任何服务端现有接口的字段和行为（除新增的 4 个 AI 推理接口）。客户端 PySide6 代码**冻结**（不新增功能，只修阻断性 Bug），到 V3.1 GA 版本才从打包中移除。

---

## 一、背景 & 目标

### 1.1 为什么要迁移

- **现状**：客户端当前基于 PySide6 (Qt for Python) 实现，绑定 CPython 解释器 + `python_embeded/` 整套运行时，打包体积 +400MB，启动时间 >8s；UI 定制能力弱（QSS 类 CSS，但动画、拖拽、视频预览等交互效果远弱于 Web）。
- **新增诉求**：集成「工作台 + 浏览器 + 媒体工具」到同一个多 Tab 窗口壳里；PySide6 很难支持 BrowserView（隔离 Cookie/Profile 的浏览器子页）与 Web 卡片媒体工具在同一窗口无缝切换。
- **运维成本**：本地 Python worker（rembg/VSR/whisper 等）在不同机器上依赖路径、显卡驱动、CUDA 版本，排障成本远高于集中在服务端运维。

### 1.2 迁移目标（S.M.A.R.T）

| 指标 | V2.x PySide6（当前） | V3 Electron（目标） |
|---|---|---|
| 首次冷启动到工作台可见 | ≤ 8 s | **≤ 2.5 s** |
| Windows 安装包大小（nsis exe） | ~ 900 MB（主要是 python_embeded） | **≤ 450 MB**（无 python_embeded，只有 ffmpeg.exe + onnxruntime 可选） |
| UI 帧渲染技术 | QWidget 软件光栅化 | Chromium GPU 合成（60 FPS） |
| 本地 Python 依赖 | 必须（PySide6 + rembg/VSR） | **不保留**（全部 AI 推理走服务端，ffmpeg 走独立 exe） |
| 三模块（工作台/浏览器/媒体工具）窗口形态 | 3 个独立进程/窗口 | **同窗口 3 个 Tab**，无闪烁切换 |
| 崩溃恢复 | PySide6 崩溃 = 全应用丢失上下文 | 单 Tab 崩溃不影响其他 Tab；主进程守护自动重连 |

### 1.3 不可变约束（Must）

1. **不得改变服务端现有 API 的字段名、路径、返回结构**。所有客户端→服务端的调用必须与当前 PySide6 客户端字节级一致（以 `server/API-GUIDE.md` 为准）。
2. **AI 生成、任务提交、脚本保存等产出必须可在 V2.x PySide6 客户端与 V3 Electron 客户端之间互通**（同一用户登录，两边看到同一个脚本列表/同一个成片任务）。
3. **本地文件产物路径不变**：`studio/outputs/materials/`、`studio/outputs/voice_clone/`、`studio/outputs/covers/` 等，方便 V2 升级 V3 后历史作品无缝可见。
4. **不引入任何需要本地 Python 的功能**。V3 发布后安装目录里不得出现 `python.exe`、`python3x.dll`、`site-packages/`。

---

## 二、服务端新增需求（前置依赖，先于客户端开工）

> C 类本地 AI 推理（rembg 抠图 / VSR 视频修复）现在由客户端本地执行（[image_matting_page.py](file:///d:/Project/TinTin_AI_Agent_Main/studio/gui/image_matting_page.py)、`apps/vsr-v1.4.0/`），方案一要求全部服务端 API 化。加上反推提示词也统一走服务端 Ollama vision，**共新增 4 组接口**。

### 2.1 服务端新增接口清单（后端同学负责实现）

| # | Method + 路径 | 用途 | 对应客户端功能 | 必须同步实现的客户端字段 |
|---|---|---|---|---|
| S1 | `POST /rembg/matting` | 上传图片 → 返回抠图透明背景 PNG | 图形 → 图像抠图 / 封面制作的「抠图图层」 | `model`、`alpha_matting`、`return_mask`、进度 |
| S2 | `POST /vsr/enhance` | 上传视频 → 返回超分/修复/去噪结果 MP4 | 视频 → 视频修复 | `scale(2x/3x/4x)`、`denoise_strength`、`face_restoration`、进度 |
| S3 | `POST /vision/reverse-prompt` | 上传图片 / 视频帧 → 返回 Midjourney/SD 风格提示词（英文 + 中文） | 提示词 → 图片反推提示词 / 视频反推提示词 | `count(生成几条)`、`language`、`style` |
| S4 | `GET /health/capabilities` | 返回服务端开启了哪些能力（rembg / vsr / whisper / voice_clone / stock_search） | V3 客户端启动时决定哪些卡片禁用灰态 | 无 |

#### S1. `POST /rembg/matting`

**Request**（`multipart/form-data`，与当前 `rembg.remove()` 参数口径一致，避免切换语义）：

```
image:        File             # 必填。jpg/png/webp，单张 ≤ 20MB
model:        String = "u2net" # u2net / isnet-general-use / birefnet-portrait / sam（按服务端实际部署）
alpha_matting:Bool   = false   # 开启 alpha 细化（发丝级，慢）
return_mask:  Bool   = false   # true 时同时返回 mask
bg_color:     String = null    # "#RRGGBB" 填背景色（不传=透明）
```

**Response**（`application/json`）：

```json
{
  "task_id": "rmbg_20260825_abc123",
  "status": "queued"   // queued / processing / done / failed
}
```

**进度 & 结果**：复用现有成片任务轮询模式（避免引入新技术栈）：
- `GET /tasks/{task_id}` → 返回 `progress 0-100`、`status`
- `GET /tasks/{task_id}/result` → `application/octet-stream`（抠出的 PNG；若 `return_mask=true` 则 ZIP 打包原图+mask）

**SLA**：首包响应 ≤ 30s；5MB 图片 u2net 模型 ≤ 20s/张（RTX 4090 × 1 基准）。

---

#### S2. `POST /vsr/enhance`

**Request**（`multipart/form-data`，兼容现有视频修复的全部参数）：

```
video:              File            # 必填。mp4/mov/webm，单段 ≤ 2GB
mode:               Enum = "repair"# repair(去噪修复) / superres(超分) / both(同时)
scale:              Enum = "2x"     # 2x / 3x / 4x。仅超分模式生效
fps:                Int  = 0        # 0=保原帧率；24/30/60=补帧到目标（可选）
denoise_strength:   Int  = 20       # 0-100。mode 含 repair 生效
face_restoration:   Bool = false    # 打开 GFPGAN/CodeFormer（可选）
trim_start_sec:     Float = 0       # 只处理片段（可选，避免传超长）
trim_end_sec:       Float = 0
```

**Response**：

```json
{
  "task_id": "vsr_20260825_xyz789",
  "estimated_wait_sec": 360
}
```

**进度 & 结果**：同 S1。
- `GET /tasks/{task_id}` → 返回 `stage: "抽帧/推理/编码/合并"` + 进度
- `GET /tasks/{task_id}/result` → `application/octet-stream`（修复后的 mp4）

**SLA**：10 分钟 1080p 视频 4x 超分，单卡 4090 ≤ 15 分钟；长视频建议分批（Trim 模式）。

---

#### S3. `POST /vision/reverse-prompt`

**Request**：

```
file:        File                         # jpg/png/webp/mp4（视频自动取关键帧）
count:       Int    = 4                   # 1~8 条
style:       String = "general"           # general / midjourney / stable-diffusion / product-photo
language:    Enum   = "zh+en"             # zh / en / zh+en
frame_count: Int    = 1                   # 视频时取多少关键帧，>1 会做跨帧 prompt 合并
```

**Response**（200 OK 同步返回，SSE 也可以；优先同步，延迟 < 30s）：

```json
{
  "model": "ollama:qwen2-vl:72b",
  "elapsed_ms": 12340,
  "prompts": [
    {
      "zh":    "电商产品图，一只手拿 JBL CHARGE6 晴空蓝音箱放在白色花岗岩桌面上，柔光、高对比、8K、特写镜头",
      "en":    "ecommerce product photo, a hand holding JBL CHARGE6 sky-blue speaker on white granite tabletop, soft studio lighting, high contrast, 8K close-up",
      "style_tags": ["close-up", "product-shot", "soft-lighting"]
    }
    // ... count 条
  ]
}
```

---

#### S4. `GET /health/capabilities`（V3 启动时必查，决定卡片是否可用）

**Response**：

```json
{
  "server_time": "2026-08-25T10:00:00+08:00",
  "capabilities": {
    "rembg":        {"enabled": true,  "models": ["u2net","isnet-general-use","birefnet-portrait"]},
    "vsr":          {"enabled": true,  "modes": ["repair","superres","both"]},
    "whisper":      {"enabled": true,  "url": "http://192.168.111.31:9000/asr"},
    "voice_clone":  {"enabled": true,  "url": "http://192.168.111.31:7860"},
    "stock_search": {"enabled": true,  "engines": ["pexels","pixabay","unsplash","videvo"]},
    "vsr_remove":   {"enabled": true},
    "reverse_prompt":{"enabled": true}
  },
  "queue_load": {"rembg": 2, "vsr": 0, "whisper": 1}
}
```

### 2.2 服务端任务体系复用规则

S1/S2 的 `task_id` 必须：
1. 复用现有 `/tasks` 列表的前缀 `c_`（不要新增独立前缀，客户端成片任务列表必须能看到）
2. 与现有 `editor_render`、`digital_human` 等任务类型的**过滤条件一致**：S1 `type="rembg_matting"`，S2 `type="vsr_enhance"`，客户端成片任务列表增加这两个类型的显示/筛选
3. 失败后保留 7 天可重试（与现有任务策略一致）

### 2.3 服务端验收标准（交付 V3 前必须全部通过）

| 编号 | 验收项 | 判据 |
|---|---|---|
| SA1 | `/rembg/matting` u2net 上传 3 种典型尺寸的产品图，α 通道非零像素和 ≈ 当前本地 rembg 结果的 ±3% | 自动测试脚本跑 100 张，通过率 ≥ 98% |
| SA2 | `/vsr/enhance` 2x/3x/4x 各 5 条视频，PSNR 相对输入 ≥ 2dB（主观验收：无明显块效应/伪影） | 人工盲审 10 条，有效率 ≥ 90% |
| SA3 | `/vision/reverse-prompt` 中文 prompt 中必须包含输入图的品牌/型号（若在画面中可识别） | 50 张产品图抽查，品牌/型号召回率 ≥ 90% |
| SA4 | 4 组接口的 503 / 429 必须带标准 `Retry-After` 头 + 统一错误体 `{error, retry_after_sec}` | 压测到并发超阈值时 100% 符合 |
| SA5 | `/health/capabilities` 与实际启动服务一致 | 改任一服务开关后 5 秒内 capability 变 |

---

## 三、客户端 Electron 工程（需求主体）

> 新工程目录：`electron/`（与 `apps/asset-browser/` 并列，后者停止维护，功能并入）。
> 安装包名不变：**「螺丝钉-电商智能体矩阵 Setup V3.x.exe」**，用户升级时覆盖安装。

### 3.1 客户端窗口 & Tab 架构

| Tab | 模块 | 第一阶段 V3 MVP 实现方式 | V3.1 目标（2 个月后） |
|---|---|---|---|
| **Tab1：工作台** | 方案脚本 / 分镜脚本 / 一键成片 / 成片任务 / 成片任务队列 / 飞书脚本创作 / 产品库 / 素材检索 / 素材生成 / 音频素材 / 智能混剪 / 直播切片 | **优先重写 4 个高频页**（飞书脚本创作、分镜脚本、素材检索、成片任务），其余 12 个用 `<webview src="http://127.0.0.1:8766/...">` 内嵌** PySide6 精简的本地 HTTP 页面桥**。桥进程 `bridge.exe` 从 PyInstaller 打包成独立 exe，随 Electron 主进程启动/退出，**不进安装包的 `python_embeded/`（大小约 25MB，单文件）**。 | 所有 16 页 100% Vue 重写，移除 bridge.exe |
| **Tab2：浏览器** | URL 输入 / 侧边栏历史 / 下载器 / 独立 Cookie Profile / 抖音/B 站/YouTube 解析下载 | **合并 `apps/asset-browser/`** 的全部逻辑：BrowserView、preload、download manager；进度条同步到底部全局状态栏 | 增加「采集素材一键导入工作台素材库」快捷按钮 |
| **Tab3：媒体工具** | 图形：封面制作 / 图像抠图；视频：视频修复 / 视频转文字 / 声音克隆 / 视频去水印字幕；提示词：图片反推 / 视频反推 | **Vue 100% 重写卡片导航 + 每个工具的表单**；调用路径全部走服务端 API（A 类/A2 类）或 S1/S2/S3（新接口） | 工具结果可直接发送到智能混剪/分镜/工作台素材库 |

**全局顶栏（横跨 3 Tab 固定显示）**：

| 控件 | 说明 | 接口 |
|---|---|---|
| 左侧：Logo + 产品名 + 版本号 | 螺丝钉-电商智能体矩阵 V3.x | — |
| 右侧：服务器状态灯 | 💚/💛/❤️ 调用 `GET /health/capabilities` 每 60s 轮询一次（从 2s 改长，消除你日志里「Read timed out. (read timeout=2)」高频噪声） | S4 |
| 右侧：CPU / 内存 / GPU / 显存百分比 | 主进程 `systeminformation` 包采集 | — |
| 右侧：消息通知 🔔 | 下载完成、成片完成、服务端错误 | Electron `Notification` + 历史下拉 |

**全局底部状态栏（横跨 3 Tab）**：
- 左侧：当前任务执行条（最多显示 3 条，多的折叠进 `+N 个任务进行中`），每条可暂停/取消/查看日志
- 中间：自动刷新勾选框（只在「成片任务」Tab 显示）
- 右侧：下载进度条（来自浏览器 Tab 和媒体工具结果下载，统一合并显示）

### 3.2 Tab1 工作台 — 4 个高频页重写规格（第一阶段 MVP 必须过）

#### 3.2.1 飞书脚本创作（参考 [ai_script_page.py](file:///d:/Project/TinTin_AI_Agent_Main/studio/gui/ai_script_page.py)）

- **左侧区域**（从上到下）：
  - 「已有脚本」下拉 + 继续创作按钮（GET `/script/list?source=feishu`）
  - 风格化下拉 + 重置 + 风格画像 `QPlainTextEdit`（vue：`textarea style=fixed`）
  - 附加提示词文本框 + 大模型调整文案按钮（POST `/script/adjust-copywriting`）
  - 视频文案编辑器（富文本可编辑，与 PySide6 `_build_prompt_from_cur_row()` 输出格式严格一致）
  - 生成脚本按钮 → 跳转分镜脚本创作页（带产品信息，参见本次修复的 638-654 行）
- **右侧脚本卡片列表**：每行 = 镜头编号 + 镜别 + 时长 + 音效 + 画面描述 + 旁白台词；卡片右下角有小齿轮（直接编辑）和「引用素材」按钮（打开 ShotMaterialDialog 的 Vue 版，见 3.2.2b）
- **必带字段传递**：`product = {brand, model, category, name}` 必须写入每个镜头的上下文，「引用素材」对话框打开时本地素材 Tab 的筛选条件和联网素材 Tab 的 `stock_search` query 前缀要自动拼上 `brand + model`（例如搜索「特写 手 音箱」自动扩展成「JBL CHARGE6 特写 手 音箱」）

#### 3.2.2 分镜脚本（参考 [storyboard_page.py](file:///d:/Project/TinTin_AI_Agent_Main/studio/gui/storyboard_page.py)）

- 顶部标题行：相似度自动绑定按钮 + 画幅下拉（9:16/16:9/1:1）+ 保存分镜脚本按钮（保存到服务端时，立即刷新一键成片的脚本列表；与本次 storyboard_page.py 1607 行修复口径一致）
- 镜头卡片（与 V2.2 完全同字段）：镜别下拉 + 时长输入 + 音效文本框 + 画面描述 + 旁白台词 + **引用素材按钮** + **风格画像预览缩略图**
- **引用素材对话框（ShotMaterialDialog Vue 版）三 Tab 规格**：
  1. **Tab1 素材库**：本地素材缩略图网格（与 vector_search 一致：角标多选、右键预览、左下品牌/型号徽章）。筛选条件 = 当前镜头 product brand/model/category
  2. **Tab2 MG动画**：仅显示跳转提示 + 「跳转到 MG动画页」按钮 → 行为：切到工作台 Tab + 打开素材生成页（素材生成内部 Tab2，对应本次修复的 `switch_dreamina_tab(2)` 行为）
  3. **Tab3 联网素材**：类型下拉（图片/视频/全部）+ 搜索框 → 调 `material_client.stock_search(query, kind)`（本次修复的联网素材接口）→ 缩略图网格多选。确认时按勾选写入镜头的 `materials[]` 字段，`type = "web_stock"`（字段顺序：`path(url)/thumb/stock_id/media_type/width/height/duration/author/source`）
- 底部操作行：同步到多维表格 / 创建飞书文档 / 飞书关联标签（对应现有飞书集成）

#### 3.2.3 素材检索（参考 `studio/gui/vector_search/` 拆分后的 5 个文件）

- 左侧筛选面板：文件类型、横纵比、分辨率下限、时长范围、品牌、型号、产品分类、Tag 云
- 右侧缩略图网格：必须复现「第一页/第二页 item 间隔一致」的修复 — gridSize 动态计算、关闭 uniformItemSizes 后再调整、数据填充后强制 doItemsLayout（Vue 版对应：CSS Grid `grid-auto-rows` 固定，item 尺寸统一 aspect-ratio，不再有 Qt 的原生缓存坑）
- 双击预览：图片=大图预览，视频=原生 HTML5 `<video controls>` 流式预览（支持点击跳转播放位置，与现有 VideoPreviewDialog 行为对齐）
- 顶部搜索框：回车触发 `material_client.search(...)`；空 keyword 时显示最近导入

#### 3.2.4 成片任务（参考 [scheduled_tasks_page.py](file:///d:/Project/TinTin_AI_Agent_Main/studio/gui/scheduled_tasks_page.py)）

- **顶部标题行**：左侧「成片任务列表（来自服务端）」；右侧按顺序依次是：
  1. 全选复选框（列头那个复选框）
  2. 📥 下载所选
  3. 📦 打包所选
  4. ➕ 自动刷新
  5. 🔄 刷新
- **表格列（共 12 列）**：
  1. 多选勾选框
  2. TASK_ID
  3. 标题
  4. 类型（editor_render / digital_human / rembg_matting / vsr_enhance / workflow_exec）
  5. 状态（排队/进行中/已完成/失败）
  6. 进度（%）
  7. **总分**（重点：优先级 `evaluation.total > quality_score.total > variants[0].score > task.*_score`；≥7 绿色，<5 红色；空值显示空字符串）
  8. 播放（仅已完成）
  9. 下载（仅已完成）
  10. 创建时间
  11. 操作：**📜 日志按钮**（从详情底部移到每行；无日志行灰态禁用） + 🗑️ 删除
- **详情区（任务详情 / 参数 / 结果）**：点击行展开；显示服务端返回的完整 JSON（折叠展示 audio/video/image/project 各个子项）
- **自动刷新**：复选框勾选时 15s 轮询一次；后台运行时，任务进度更新通过 SSE（优先）或长轮询（兼容）推送至顶栏通知

### 3.3 Tab2 浏览器 — 合并 apps/asset-browser 规格

- **合并范围**：
  - `main.js`：窗口创建、单例锁、Cookie 持久化路径（`session.fromPartition('persist:tintin-browser')`）
  - `preload-app.js`：`window.tintin.downloads.start / cancel / pause` → 合并进 `electron/preload/preload.js`，加命名空间 `window.tintin.browser.*`
  - `preload-webview.js`：`pageonload.js` 注入、解析抖音/B站/YouTube 元素 → 不改功能，合并到 `electron/preload/browser-webview.js`
  - `renderer/app.js`：地址栏、刷新/前进/后退、侧边栏下载、视频预览 → 重构为 Vue 组件
- **浏览器 Cookie/缓存位置不变**：`studio/assets/playwright/` 目录（V2 用户升级后历史登录态无缝继承）
- **下载进度统一**：浏览器发起的下载必须广播到主进程 `global.downloadBus`，工作台 Tab 和媒体工具 Tab 底部状态栏都能看到（同一个进度池）
- **新增快捷操作**：浏览到抖音/B站视频页时，地址栏右侧显示「⚡ 解析并导入素材库」按钮，点击 = 解析 → 下载 → 写入 `studio/outputs/materials/` → 发系统通知 → 素材检索 Tab1 中立即可见
- **多账号隔离（规划进 V3.1）**：支持最多 5 套 profile（抖音大号/小号/员工号…），每个 profile 独立 Cookie 分区，互不干扰

### 3.4 Tab3 媒体工具 — 卡片导航 + 表单规格

卡片导航 8 张卡（删除了 OCR 两张卡，与本次 media_tools_page.py 删除口径一致）：

| 分组 | 卡片 | 前端表单 | 后端接口 | 进度方式 |
|---|---|---|---|---|
| 图形 | 封面制作 | 多图层编辑器（背景层/产品图/文字层/Logo层），尺寸下拉（1:1 / 9:16 / 16:9），数量 1-16 | `POST /workflow/run`（封面工作流 JSON） + 图层上传 multipart | SSE |
| 图形 | 图像抠图 | 上传 → 模型下拉（u2net/isnet/birefnet）→ α 细化开关 → 可选 bg_color | **S1. `/rembg/matting`** | 轮询 `/tasks/{id}` |
| 视频 | 视频修复 | 上传 / 选已下载素材 → mode → scale → fps → denoise → face_restoration | **S2. `/vsr/enhance`** | 轮询 `/tasks/{id}` + stage 显示 |
| 视频 | 视频转文字 | 上传 / 链接 → 语言 → 输出格式（srt/txt/json） | 现有 `/whisper/transcribe`（服务端，不是本地 faster-whisper） | 同步返回 |
| 视频 | 声音克隆 | 参考音频上传 / 音色选择 → 文本输入（≤20s/段）→ 批量提交 | 现有 VoxCPM 服务端 `/clone` | 轮询任务状态 |
| 视频 | 视频去水印字幕 | 视频上传 + 选区标注（轴对齐矩形）/ 水印文字辅助 | 现有 `/vsr/remove`（已服务端化） | 轮询任务状态 |
| 提示词 | 图片反推 | 图片上传 → count / style / language | **S3. `/vision/reverse-prompt`** | 同步返回 ≤ 30s |
| 提示词 | 视频反推 | 视频上传 → frame_count / count / style / language | **S3. `/vision/reverse-prompt`**（自动抽帧） | 同步返回 ≤ 60s |

**卡片级可用性**：V3 启动时查询 `S4 /health/capabilities`，对应 `capabilities[xxx].enabled === false` 的卡片置灰 + tooltip 显示「当前服务端未部署此能力，联系管理员开启」。

### 3.5 预加载安全桥（preload.js，核心设计，必须评审）

**原则**：渲染进程绝不允许 `require('node:')`、绝不允许 `nodeIntegration: true`、绝不允许 `remote`。所有原生能力走上下文隔离的 preload 白名单：

```js
// window.tintin.* API 契约（渲染进程只看到这些，字段都是只读 Function 或 Object）
interface TintinBridge {
  // ===== 系统 =====
  app: {
    getVersion(): string;
    getPath(name: 'home'|'userData'|'temp'|'workspace'): string;
    quit(): void;
    relaunch(): void;
    onUpdateAvailable(cb: (ver:string, url:string) => void): () => void;
  }
  // ===== 文件对话框 =====
  dialog: {
    openFile(params: {title?, filters?}): Promise<string|null>;
    openFiles(params: {title?, filters?, multi: true}): Promise<string[]|null>;
    openDir(params: {title?}): Promise<string|null>;
    saveFile(params: {title?, defaultPath?, filters?}): Promise<string|null>;
  }
  // ===== 下载（浏览器+媒体工具共用）=====
  downloads: {
    start(params: {url, savePath, referer?, headers?}): Promise<string>; // taskId
    pause(taskId): void;
    resume(taskId): void;
    cancel(taskId): void;
    onProgress(taskId, cb: (p:{speed, percent, downloaded, total}) => void): () => void;
    onDone(taskId, cb: (p:{finalPath, size}) => void): () => void;
  }
  // ===== 服务端 HTTP 代理（避免 CORS + 统一加 machine_id 签名头）=====
  server: {
    get(path: string, params?: Record<string, any>): Promise<any>;
    post(path: string, body?: any, headers?: Record<string,string>): Promise<any>;
    upload(path: string, fields: Record<string, Blob|string>, onProgress?) : Promise<any>;
    // 流式/任务进度
    sse(path: string, onEvent, onError): () => void;
  }
  // ===== 媒体工具本地 ffmpeg（纯 exe，无 Python）=====
  ffmpeg: {
    // 只开放白名单命令：probe / concat / 封面嵌入 / 抽帧 / 转码（参数级校验，防止 RCE）
    probe(file: string): Promise<{duration, width, height, fps, codec, audio_bitrate}>;
    extractThumb(video: string, atSec: number, w?: number): Promise<string>; // 缩略图返回绝对路径 PNG
    embedCover(video: string, cover: string, outPath: string, durationSec=2): Promise<string>;
    concatSegments(paths: string[], outPath: string): Promise<string>;
    extractAudio(video: string, outPath: string, format='aac'): Promise<string>;
  }
  // ===== 通知 & 外开 =====
  shell: {
    openExternal(url: string): void;
    showNotification(title: string, body: string, icon?, onClick?: () => void): void;
    openItem(path: string): void; // 资源管理器定位文件
    revealInFolder(path: string): void;
  }
  // ===== 工作台 bridge.exe（过渡期用，V3.1 移除）=====
  bridge: {
    getStatus(): Promise<{ready: boolean, port: number}>;
    navigate(path: string): Promise<void>; // webview 导航到指定 PySide6 页面
  }
}
```

**绝对禁止**：preload 中不得暴露 `child_process.exec` / `fs.writeFile` 等危险底层 API。所有调用必须参数级校验（例如下载目录必须在 workspace 白名单内、ffmpeg 的命令不能传任意参数，只能传预定义的几个子命令对应的结构化参数）。

### 3.6 工程结构（交付物标准）

```
TinTin_AI_Agent_Main/
├── electron/
│   ├── package.json              # electron 31.x / vue 3.4.x / vite 5.x / pinia
│   ├── electron-builder.yml      # nsis 打包，extraResources = [studio/bin/win, studio/assets/icons]
│   ├── main/
│   │   ├── main.js               # 单例锁 / 窗口创建 / 崩溃恢复
│   │   ├── tray.js               # 托盘 + 开机自启（沿用 V2 注册表位置）
│   │   ├── updater.js            # electron-updater，沿用 config/update.json 地址
│   │   ├── ffmpeg-gate.js        # 3.5 节 ffmpeg 白名单子命令实现（child_process.spawn）
│   │   ├── server-proxy.js       # 3.5 节 server.* 的实际请求发出（统一 headers，machine_id 签名）
│   │   ├── download-manager.js   # 下载统一事件总线（BrowserWindow + BrowserView 合并）
│   │   └── bridge-mgr.js         # bridge.exe 生命周期（启动/保活/退出清理）
│   ├── preload/
│   │   ├── preload.js            # window.tintin.* 全部暴露
│   │   └── browser-webview.js    # 浏览器 Tab 的 content-script 注入（解析抖音/B站 DOM）
│   ├── renderer/                 # Vue 工程
│   │   ├── src/
│   │   │   ├── App.vue
│   │   │   ├── main.ts           # TS（严格模式）
│   │   │   ├── router/index.ts   # 三个 Tab + 工作台子路由
│   │   │   ├── stores/           # Pinia：app / server / downloads / tasks / products
│   │   │   ├── views/
│   │   │   │   ├── Workbench.vue      # Tab1 容器 + 侧边导航
│   │   │   │   ├── Browser.vue        # Tab2 容器
│   │   │   │   └── MediaTools.vue     # Tab3 卡片导航
│   │   │   ├── components/workbench/   # 4 个高频页
│   │   │   │   ├── AiScriptPage.vue
│   │   │   │   ├── StoryboardPage.vue
│   │   │   │   ├── ShotMaterialDialog.vue  # 引用素材对话框（三 Tab）
│   │   │   │   ├── VectorSearchPage.vue
│   │   │   │   └── ScheduledTasksPage.vue
│   │   │   ├── components/media-tools/ # 8 个工具表单
│   │   │   │   ├── CoverMaker.vue
│   │   │   │   ├── ImageMatting.vue
│   │   │   │   ├── VideoRepair.vue
│   │   │   │   ├── VideoTranscribe.vue
│   │   │   │   ├── VoiceClone.vue
│   │   │   │   ├── SubtitleRemoval.vue
│   │   │   │   ├── ReversePromptImage.vue
│   │   │   │   └── ReversePromptVideo.vue
│   │   │   ├── components/common/    # Table / Pagination / TagCloud / VideoPreviewDialog / Card
│   │   │   └── styles/               # 沿用 .design_library/Luosiding tokens（暗色主题默认）
│   │   ├── index.html
│   │   └── vite.config.ts
│   └── types/global.d.ts         # 声明 interface TintinBridge
```

### 3.7 主题 & UI 规范（和 V2.x 视觉对齐）

- 必须与现有 `.design_library/Luosiding/` tokens 完全一致：
  - 主色 `#6d5dfc`（紫色）、成功色 `#10b981`、警告色 `#f59e0b`、错误色 `#ef4444`
  - 暗色背景 `#0f1020`、卡片面 `#161828`、分隔线 `#262a45`
  - 圆角 12px（卡片）、8px（按钮/输入）、按钮高度 36px
  - 字体 `font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`，正文 14px/20px
- **不允许引入任何新的 UI 库（Element Plus / Ant Design Vue 都禁止）**，全部走 `.design_library/Luosiding/components/` 的组件规范封装

---

## 四、工程 & 打包需求

### 4.1 包结构对比（验证无 Python runtime 的硬指标）

| 目录/文件 | V2.x（必须消失） | V3（必须存在） |
|---|---|---|
| `python_embeded/`（~300MB） | ✅ **必须从安装包移除** | ❌ |
| `studio/*.pyc / __pycache__/` | ✅ 移除 | ❌ |
| `studio/gui/**（PySide6 QWidget）` | 过渡期保留在 `resources/studio-legacy/` 里由 bridge.exe 调用，V3.1 GA 包移除 | V3 过渡期保留，V3.1 删除 |
| `studio/bin/win/ffmpeg.exe` + ffprobe.exe | — | ✅ 必须存在（约 100MB，在 `resources/bin/`） |
| `studio/assets/icons/` + `playwright/` + `voice_samples/` | — | ✅ 保留（Cookie/音色/图标跨版本兼容） |
| `studio/config/*.json.example` | — | ✅ 保留（默认配置） |
| `studio/outputs/` 目录结构 | — | ✅ 1:1 不变 |
| `bridge.exe`（PyInstaller 单文件） | 新产物，过渡期必须（≤ 30MB） | V3 必须，V3.1 删除 |

### 4.2 打包流水线（CI 必须配置）

**命令链**（写进 `build_electron.ps1`，双击即出安装包）：

```powershell
# 1. 构建 bridge.exe（只在过渡期）
cd studio-legacy-bridge ; pyinstaller --onefile --noconsole --name bridge bridge_server.py ; cd ..
# 2. 构建前端
cd electron ; npm run build ; cd ..
# 3. 生成 NSIS 安装包
electron-builder --win nsis --x64
#    产物：dist/螺丝钉-电商智能体矩阵 Setup V3.x.exe
# 4. 生成 delta 升级包（electron-updater 需要）
# 5. 同步写 studio/config/update.json 的 latest 字段
```

**CI 门禁**（任一失败不发版）：
- Vue `tsc --noEmit`（无 TS 错误）
- ESLint（rule 等级 ≥ warn 全部过）
- 端到端 Playwright 冒烟（启动 → 工作台四高频页可打开 → 浏览器可解析抖音示例 → 媒体工具 8 卡可打开）
- 安装包大小 ≤ 450MB（不含 Python runtime 的硬指标）
- 安装后用 `where python` 在安装目录子树检查，不得出现任何 `python*.exe` / `python*.dll`

### 4.3 自动升级（沿用 V2 机制，必须无缝）

- 升级包签名证书与 V2 一致
- 升级时保留 `studio/config/ai_config.json`、`studio/assets/playwright/`、`studio/outputs/`
- 大版本升级 V2→V3：首次启动迁移脚本，把旧 `ai_config.json` 的 server/whisper/voice_clone 地址字段转写到新的 Pinia store + localStorage；对 product_library.json、hotspots.json 做备份

---

## 五、验收标准（UAT 通过 = 可上线）

### 5.1 一级阻断项（Fail 任一不发版）

| 编号 | 操作路径 | 预期结果 |
|---|---|---|
| U1 | 双击新安装包 → 全默认下一步 → 启动 → 检查安装目录 | **不得出现 python.exe / python311.dll / site-packages 目录**（方案一硬指标） |
| U2 | 启动后三个 Tab 无白屏/无控制台 error | 必须 100% 通过（控制台打开零红色） |
| U3 | 首次冷启动到工作台可见 ≤ 2.5s（干净 Windows 11 SSD 机器） | 重复 5 次，平均值 ≤ 2.5s |
| U4 | 服务端新增 4 个接口（S1~S4）用例 100% 通过（2.3 节 SA1~SA5） | 必须 100% |
| U5 | V2 已保存到服务端的脚本列表，在 V3 一键成片脚本下拉 100% 一致 | 对比 10 个脚本，字节级相同 |
| U6 | V2 安装 V3 覆盖升级后：飞书登录态、AI 服务地址、音色库、素材库索引 100% 保留 | 肉眼对比 + 文件 diff |

### 5.2 二级功能验收（每个功能 P0）

| 编号 | 模块 | 操作 | 预期 |
|---|---|---|---|
| W1 | 飞书脚本创作 → 分镜脚本 | 选产品（JBL CHARGE6）→ 生成脚本 → 任意镜头点「引用素材」→ 本地素材 Tab 筛选条件 + 联网素材 query | 品牌/型号自动带入；素材筛选后结果中 JBL CHARGE6 占比 ≥ 60% |
| W2 | 分镜脚本 → MG动画 | 引用素材对话框 → MG动画 Tab → 跳转按钮 | 跳回工作台 → 素材生成页 → 内部 Tab2（MG动画） |
| W3 | 分镜脚本 → 联网素材 | 引用素材对话框 → 联网素材 Tab → 搜索 → 勾选 3 条 → 确认选择 | 3 条结果写入镜头 materials，type="web_stock"，thumb/stock_id/url 完整 |
| W4 | 成片任务列表 | 刷新 + 自动刷新勾选；全选 10 行 → 下载所选 → 打包所选 | 按钮顺序正确（全选/下载/打包/自动刷新/刷新）；下载 & 打包 100% 成功 |
| W5 | 成片任务总分 | 查看带深度评审的任务行 → 总分列 | 显示 `ev.total` 对应分（如 2.51），<5 红色，≥7 绿色 |
| W6 | 成片任务操作列日志 | 点击「日志」按钮 | 弹窗显示对应任务 logs + error_msg；无日志行按钮灰态 |
| W7 | 浏览器 Tab | 打开抖音已登录账号页面 → 解析下载 → 进度条在底部状态栏可见 → 完成后素材检索页中出现 | 全流程无报错，100% 成功 |
| W8 | 媒体工具 → 图像抠图 | 上传产品图 → 模型默认 → 开始 | 进度轮询直到成功；下载 PNG α 通道正确（透明背景） |
| W9 | 媒体工具 → 视频修复 | 上传 720p 视频 → mode=superres scale=4x → 开始 | 任务出现在成片任务列表，type="vsr_enhance"，完成后可播放 4K |
| W10 | 媒体工具 → 图片反推 | 上传产品图 → language=zh+en → count=4 | 返回 4 条中英 prompt，含品牌/型号名（如可识别）≥90% |
| W11 | 顶栏服务器状态灯 | 关闭服务端 → 等 60s | 状态灯变红；鼠标悬浮 tooltip 显示"无法连接服务端"；1 分钟内不再高频报错（≤1 次/分） |

### 5.3 非功能验收

| 项 | 指标 |
|---|---|
| 内存占用（空载，三 Tab 都打开过一次） | ≤ 600MB（Chromium 固有开销；对比 V2.x PySide6 空载 ≤ 350MB 是可接受的 2x 范围） |
| 内存泄漏（反复切 Tab 50 次后回到空载状态） | 增长 ≤ 80MB（JS 堆快照对比） |
| 崩溃恢复（手动 kill renderer 进程） | 主进程 3s 内自动重启对应 Tab，不影响其他 Tab |
| 隐私合规（Cookie 隔离） | 浏览器 profile 路径写入 `studio/assets/playwright/`，其他 Tab 读不到该 session 的 Cookie |

---

## 六、交付排期（建议，可调整）

| 阶段 | 内容 | 负责方 | 工期 | 完成标志 |
|---|---|---|---|---|
| P0（基建 & 依赖） | 服务端实现 S1~S4 + 客户端 electron/ 脚手架 + bridge.exe 雏形 | 服务端团队 + 客户端团队并行 | **1 周** | 健康检查接口 + Electron 开发模式可启动到三 Tab 空壳 |
| P1（浏览器 & 媒体工具） | 合并浏览器 Tab + 8 张媒体工具卡片表单 + 对接 S1~S3 | 客户端团队 | **2 周** | W7~W10 验收通过 |
| P2（4 个高频工作台页） | AiScript / Storyboard（含引用素材 Dialog）/ VectorSearch / ScheduledTasks Vue 重写 | 客户端团队 | **3 周** | W1~W6 验收通过 |
| P3（打包 & 升级 & 回归） | electron-builder 配置、nsis 安装包、自动升级迁移、回归 V2→V3 | 客户端 + 测试 | **1 周** | U1~U11 100% 通过、安装包 ≤450MB |
| **合计** | | | **7 周** | V3.0 RC 可发灰度 |

---

## 七、风险 & 缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| 服务端 S1/S2 接口 GPU 资源不足，排队时间长 | 中 | 用户体感慢 | 客户端显示 S4 返回的 `queue_load`；排队 > 阈值时 tooltip 提示"当前排队 N 人，建议稍后重试" |
| 过渡期 bridge.exe 启动失败 / 崩溃 | 中 | 12 个低频页不可用 | 主进程守护 + 自动重启 2 次；仍失败则降级为卡片提示"该模块正在升级中，稍候可用" |
| 服务端 API 与 PySide6 客户端字段不一致（历史技术债） | 高 | V2/V3 互操作失败 | 写统一 `client-api-contract.test.ts`（TS 侧）+ `tests/unit/test_api_contract.py`（Python 侧），两端 CI 强制对齐 |
| ffmpeg 白名单命令枚举不全，智能混剪后期阶段无法实现 | 中 | 无法按计划去 bridge.exe | 在 P1 阶段把智能混剪需要的 ffmpeg 子命令清单（12 条）一次性列完，全部预实现 |
| Cookie / 登录态跨版本迁移失败 | 低 | 用户要重新登录 | 首次启动双重写：先写新 profile，失败时回退读旧路径 `studio/assets/playwright/`，并发送错误日志上报 |

---

## 八、变更记录

| 日期 | 版本 | 变更 | 作者 |
|---|---|---|---|
| 2026-08-25 | V3 草案 | 初始需求：方案一（纯 Electron + 服务端化 rembg/vsr/reverse-prompt），无本地 Python runtime | — |
| 2026-08-25 | **V3 正式锁定** | 业务方确认方案一 + 版本号 V3；全文档 V2.x/V3/V3.1 → 统一 V2.x/V3/V3.1 命名 | — |
