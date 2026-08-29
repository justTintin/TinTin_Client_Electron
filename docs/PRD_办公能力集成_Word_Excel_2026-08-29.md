# 办公能力集成 PRD（Word / Excel 输出 · 预览 · 保存）v1.1

> 版本：v1.1 ｜ 日期：2026-08-29 ｜ 状态：待评审（细化版）
> 所属：新增需求线 ｜ 客户端：TinTin_Client_Electron（Electron + Vue3 + TS）
> 方案定稿：内嵌预览（不依赖系统 Office）+ 导出为主（对话/清单/报告 → docx/xlsx）

---

## 1. 背景与目标

工程现有能力产出均为数据/文件，无法直接形成可交付的 Word/Excel 文档。本需求为工程集成**办公能力基础设施**：

1. **输出 Word/Excel**：对话、采集清单、入库清单、转写文本、任务报告可导出为 `.docx` / `.xlsx`
2. **内嵌预览**：docx 转 HTML、xlsx 转表格，客户端内渲染，不依赖系统 Office/WPS
3. **保存**：系统保存对话框落盘；另提供「用系统程序打开」备选

办公能力定位为**基础设施**：`office-ipc` + 编组纯函数 + 预览组件一经就位，工程内任何功能（含后续自动上架结果报告、定时任务报告等）均可复用「导出 Word/Excel → 预览 → 保存」链路。

### 非目标
- 不做独立文档编辑器（富文本/表格编辑画布）
- 不做格式互转（docx↔xlsx）、不做服务端生成/渲染
- 不做打印/PDF 导出（后置）

---

## 2. 能力总览

```
[编组纯函数] → [docx 生成 docx 包 / exceljs 生成 xlsx] → [office:saveFile 保存]
       ↑                                                      ↓
[各功能入口]                                            保存成功 → 预览 / 打开所在位置
                                                            ↓
                                             [office:previewDocx / readXlsx] → OfficePreview 弹窗
```

| 能力 | 说明 | 复用点 |
|---|---|---|
| 导出 Word | 对话/转写文本 → .docx | WbMessages 气泡、VideoTranscribe |
| 导出 Excel | 清单/报告 → .xlsx | 达人库/每日素材/入库清单/任务队列 |
| 内嵌预览 | docx→HTML（mammoth）、xlsx→表格（exceljs 读） | OfficePreview 弹窗 |
| 系统打开 | shell.openPath 默认程序打开 | 预览弹窗/导出成功反馈 |

---

## 3. 功能需求（字段级）

### 3.1 对话生成文档（工作台）

**入口**：AI 回复气泡 hover 操作栏「导出 Word」「导出 Excel」图标（导出**当前会话**全部消息；空会话按钮禁用）。

**docx 结构（对话 → Word）**：

| 节 | 内容 | 样式规格 |
|---|---|---|
| 标题 | 会话标题（默认 `会话 <智能体名> <YYYY-MM-DD>`；重命名后取重命名标题） | Heading1，居中，18pt，加粗 |
| 元信息 | 智能体/模式 · 会话 ID · 导出时间 | 段落，9pt，灰 |
| 分隔线 | — | 水平线 |
| 消息 | 逐条：`【用户】2026-08-29 09:12`（标头 11pt 加粗）→ 内容（11pt，行距 1.5） | 每条消息一个段落组 |
| Markdown 处理 | `- ` 列表 → Word 列表段；`> ` 引用 → 缩进段落（左缩进 0.5cm 灰字）；`**加粗**` → 加粗 run | 段落级 |
| 分页 | 每 40 条消息后插入分页符 | 页 |

**xlsx 结构（对话摘要表）**：

| 列 | 宽度 | 格式 |
|---|---|---|
| 序号 | 8 | 数字 |
| 角色 | 10 | 用户/助手 |
| 内容 | 60 | 文本换行，顶部对齐 |
| 时间 | 20 | `YYYY-MM-DD HH:mm` |

Sheet 名 `对话记录`；表头加粗灰底冻结首行；行上限 5000（超出截断并提示）。

### 3.2 现有产物导出（五入口，字段级）

**① 达人采集清单 → Excel**（达人库顶部「导出 Excel」）

| 列 | 来源字段 | 宽度 | 说明 |
|---|---|---|---|
| 平台 | platform | 14 | douyin/xiaohongshu 等 |
| 达人 | creatorName | 20 | |
| 标题 | title | 40 | 截断 80 字 |
| 链接 | url | 40 | 超链接文本 |
| 日期 | date | 12 | |
| 采集时间 | collectedAt | 20 | |
| 入库状态 | importStatus | 14 | 待处理/已入库/失败 |

**② 每日素材 → Excel**（每日素材顶部「导出 Excel」）

| 列 | 来源 | 宽度 |
|---|---|---|
| 文件名 | name | 30 |
| 类型 | kind | 10 |
| 日期 | date | 12 |
| 路径 | path | 50 |
| 大小 | sizeText | 12 |

**③ 入库清单 → Excel**（素材采集「导出 Excel」）

| 列 | 来源 | 宽度 |
|---|---|---|
| URL | url | 40 |
| 标题 | title | 30 |
| 来源 | source | 14 |
| 状态 | importStatus | 14 |
| 提交时间 | submittedAt | 20 |
| 任务ID | importTaskId | 24 |

**④ 转写文本 → Word**（视频转写「导出 Word」）

| 节 | 内容 | 说明 |
|---|---|---|
| 标题 | `转写 <文件名> <YYYY-MM-DD>` | Heading1 |
| 元信息 | 源文件/时长/转写时间 | 9pt 灰 |
| 正文 | SRT 源带时间轴：`[00:00:03] 文本`；纯文本源逐段 | 段落 11pt |
| 分页 | 每 80 段分页 | |

**⑤ 任务报告 → Excel**（任务队列抽屉「导出 Excel」）

| 列 | 来源 | 宽度 |
|---|---|---|
| 任务ID | id | 24 |
| 标题 | title | 30 |
| 类型 | type | 16 |
| 状态 | statusText | 12 |
| 进度 | progress | 10 |
| 创建时间 | createdAt | 20 |
| 结果 | resultTarget | 40 |

### 3.3 内嵌预览（OfficePreview 弹窗）

| 类型 | 渲染 | 细节 |
|---|---|---|
| docx | mammoth 主进程转换 → HTML → iframe（sandbox） | 标题/段落/列表/表格/内嵌图片(base64)；样式注入（正文 14px/行距 1.6/页边距） |
| xlsx | exceljs 读 → 表格渲染 | 多 Sheet Tab 切换；列宽按内容 max 估算；表头灰底；只读 |
| 兜底 | 转换失败 → 错误态 + 「用系统程序打开」按钮 | |

**弹窗行为**：标题（文件名）+ 工具栏（用系统程序打开 / 关闭）；Esc/遮罩关闭；不自动弹出（导出成功后 toast 提供「预览」入口）。

### 3.4 保存

`office:saveFile`：`dialog.showSaveDialog`（默认文件名 + 过滤器 `Word 文档 (*.docx)` / `Excel 工作簿 (*.xlsx)`）→ 写入 → 返回 `{saved:true, path}`。用户取消返回 `{saved:false}`（静默）。成功后反馈：toast「已保存」+ 操作「预览」「打开所在位置」。

---

## 4. 技术方案

### 4.1 依赖（新增 2 个，均纯 JS 无原生编译）

| 依赖 | 版本 | 用途 | 环境 |
|---|---|---|---|
| `docx` | ^8.x | 生成 .docx Buffer | 渲染层纯函数 |
| `mammoth` | ^1.x | docx→HTML | 主进程 |

`exceljs`（^4.4.0）已在依赖：生成 + 读取。打包 `build.files` 显式补 `node_modules/docx/**/*`、`node_modules/mammoth/**/*`（及其依赖树）。

### 4.2 主进程 `office-ipc.js`（新增，≤800 行）

| IPC | 入参 | 出参 | 说明 |
|---|---|---|---|
| `office:saveFile` | `{ filename, ext:'docx'\|'xlsx', data:ArrayBuffer }` | `{saved, path?}` | saveDialog + fs.writeFile |
| `office:openPath` | `path` | `{ok}` | shell.openPath |
| `office:previewDocx` | `path` | `{html}\|{error}` | mammoth.convertToHtml |
| `office:readXlsx` | `path` | `{sheets:[{name, rows:any[][]}], error?}` | exceljs read + 首 200 行截断 |

`main.js` 接线（超行先压缩既有区段归位 ≤800）；`preload.js` 暴露 `tintin.office.*`；`global.d.ts` 同步。

### 4.3 渲染层（分层铁律）

| 模块 | 职责 |
|---|---|
| `composables/officeDocLogic.ts` | 纯函数：对话→docx 结构、转写→docx 结构（标题/元信息/段落/列表/引用/分页规则） |
| `composables/officeSheetLogic.ts` | 纯函数：五类清单/报告→`{columns, rows}`（表头/宽度/格式化） |
| `composables/useOfficeExport.ts` | 编排：编组→docx/exceljs 生成 Buffer→office:saveFile→反馈（导出中/成功/取消/失败态） |
| `composables/useOfficePreview.ts` | 编排：预览状态（docx html / xlsx sheets / 错误）、打开系统程序 |
| `components/OfficePreview.vue` | 预览弹窗纯展示（iframe/表格/工具条/关闭） |

### 4.4 入口接线

- 工作台：`WbMessages.vue` 气泡操作栏 +「导出 Word/Excel」图标 → `Workbench.vue` → `useOfficeExport`
- 达人库/每日素材/素材采集：`CreatorsView.vue`/`DailyAssetsView.vue` 顶部「导出 Excel」→ `useBrowserCreators`/`useBrowserDailyAssets` 数据 → `useOfficeExport`
- 视频转写：`VideoTranscribe.vue` 工具条「导出 Word」
- 任务队列：`WbTaskDrawer.vue` 顶部「导出 Excel」

---

## 5. 异常分支

| # | 场景 | 行为 |
|---|---|---|
| E1 | 空会话/空清单 | 按钮禁用（无数据时）或点击提示「暂无内容可导出」 |
| E2 | 保存对话框取消 | 静默返回，无报错 |
| E3 | 保存失败（权限/磁盘） | 提示「保存失败：{原因}」 |
| E4 | 预览转换失败（损坏/非预期） | 弹窗错误态 + 「用系统程序打开」兜底 |
| E5 | xlsx 超 5000 行 / docx 超 5000 段 | 截断并提示「超出部分未导出」 |
| E6 | 导出中重复点击 | 导出中禁用，完成/失败后恢复 |

离线不适用（纯本地生成/预览，无服务端依赖）。

---

## 6. 验收标准（用例化）

| 用例 | 操作 | 预期 |
|---|---|---|
| UC-01 | 有消息会话 → 导出 Word | 文件可被 Word/WPS 打开，标题/元信息/角色标头/内容完整，Markdown 列表转 Word 列表 |
| UC-02 | 有消息会话 → 导出 Excel | 摘要表列/行正确，时间格式 `YYYY-MM-DD HH:mm`，冻结首行 |
| UC-03 | 达人采集清单 → 导出 Excel | 七列数据正确，入库状态字段映射正确 |
| UC-04 | 每日素材 → 导出 Excel | 五行列正确，大小格式化 |
| UC-05 | 入库清单 → 导出 Excel | 六列正确 |
| UC-06 | 视频转写 → 导出 Word | SRT 源含时间轴段落，分页正确 |
| UC-07 | 任务报告 → 导出 Excel | 七列正确 |
| UC-08 | 导出的 docx → 内嵌预览 | 标题/列表/表格渲染正确 |
| UC-09 | 导出的 xlsx → 内嵌预览 | 多 Sheet 切换、单元格值正确 |
| UC-10 | 预览弹窗「用系统程序打开」 | 系统默认程序打开文件 |
| UC-11 | E1-E6 异常 | 行为符合 §5 |
| UC-12 | 门禁 | node --check / typecheck / 单测（新增 office 编组用例）/ ≤800 行 / build:renderer 双入口全过 |

---

## 7. 排期

| 阶段 | 内容 | 产出 |
|---|---|---|
| P1 | 依赖引入 + office-ipc（saveFile/openPath/previewDocx/readXlsx）+ preload/类型 + OfficePreview 弹窗 + office 编组纯函数 + 单测 | 基础设施就绪 |
| P2 | 六入口接线（对话 Word/Excel、五类产物导出） | 全入口可用 |
| P3 | 全量门禁 + 出包验证（asar 特征串 + 时间差）+ 手工验证 | 交付包 |

---

## 8. 遗留 / 后置登记

- docx 预览的 Markdown 渲染覆盖：首版 段落/列表/引用，代码块/表格/图片后置
- xlsx 预览单元格样式（合并/列宽精确）：首版文本渲染，样式后置
- 打印/PDF 导出：后置
- 独立文档编辑器（富文本/表格编辑）：非本需求范围，另行评估
