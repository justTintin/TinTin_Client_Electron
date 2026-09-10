# 客户端花字接入指南 — 选择设置 + 上传模板（服务端模板管理与渲染）

> 版本：CLIENT-FANCY-1 ｜ 状态：⏳ 待客户端实现（2026-09-08）｜ 归属：客户端接入（V2-4 配套）
> 关联：`server/api/fancy.py`（模板库）· `server/api/montage.py`（烧制字段）· `server/editor/textfx/`（渲染引擎）· `docs/服务端花字烧制需求.md`
> 架构：**花字模板管理与渲染在服务端；客户端只做「选择设置 + 上传模板」**（客户端轻量，服务端复用）。

---

## 1. 架构分工（已定）

```
客户端                         服务端
─────────────                 ─────────────
① 花字选择设置  ──fancy参数──▶  /montage/concat（烧制）
② 花字模板上传  ──templates+sound──▶  /fancy/templates（模板库）
③ 拉模板列表    ◀──GET────────  /fancy/templates（渲染用 textfx）
```

- **服务端**：模板管理（`/fancy/templates`）+ 渲染（`textfx` HTML+CSS 动画 → Playwright → WebM）+ 烧制（montage 花字段）
- **客户端**：只做「选择设置」（选模板/文字/样式/位置/时机）+「上传模板」（剪映导入 → 服务端共用）

## 2. 服务端已提供（客户端调用条件，2026-09-08 核实 ✅）

| 能力 | 接口 | 说明 |
|------|------|------|
| **模板列表** | `GET /fancy/templates` | `{"items", "total"}`，item 含 `template_id`（增量同步比对）|
| **模板导入** | `POST /fancy/templates` | `templates`(JSON数组) + `sound_map`(template_id→文件名) + multipart `sound_files`(音效，文件名`<template_id>__<原名>`) → `{"imported", "templates"}`, 幂等 upsert |
| **模板下架** | `DELETE /fancy/templates/{id}` | 连带清理音效 |
| **烧制参数** | `/montage/concat` 花字段 | `fancy_enabled/words/style/position/timing/font_size_scale/template/template_id`（三级回退）|
| **渲染引擎** | `editor/textfx/` | HTML+CSS 动画 → Playwright 逐帧 → VP9 alpha WebM（10 模板：bounce/fade_title/flip_in/gradient_text/neon_glow/pop_in/shimmer/slide_in_left/typewriter/zoom_pulse）+ ASS 降级 |

## 3. 客户端要实现的（两个功能）

### 3.1 花字选择设置（成片/剪辑设置面板）

**UI 字段**（`/montage/concat` 花字参数，服务端 `API-GUIDE.md:1489-1496`）：

| UI | 参数 | 枚举/说明 |
|----|------|----------|
| 启用花字开关 | `fancy_enabled` | true/false |
| 花字文字 | `fancy_words` | JSON 数组 `["快充","199元"]`；subtitle_sync 可空（服务端从字幕自动提取卖点）|
| **花字模板** | `fancy_template_id` | 从 `GET /fancy/templates` 拉取，选服务端共用模板 |
| 样式（模板缺 style 时回退） | `fancy_style` | gold/red/blue/purple/neon_green/white_outline/yellow_red |
| 位置 | `fancy_position` | upper_middle/top/center/bottom/top_left/top_right/bottom_left/bottom_right |
| 时机 | `fancy_timing` | subtitle_sync（随字幕行）/ uniform（均匀轮换）|
| 字号 | `fancy_font_size_scale` | 0.02~0.3（默认 0.08）=画布高×比例 |

**调用**：成片时 `/montage/concat` 传上述 fancy 参数 → 服务端三级回退渲染（template_id 查库 → 内联 template → 枚举 style）。

### 3.2 花字模板上传（剪映/本地导入 → 服务端共用）

**操作**：客户端把剪映花字固化为模板包，导入服务端。

| 步骤 | 内容 |
|------|------|
| ① 组装模板 | 每个模板 `{template_id, name, category, description, variables, style, ...}`（schema 见 `/fancy/templates` GET 返回结构）|
| ② 上传 | `POST /fancy/templates`：`templates`=JSON数组, `sound_map`=JSON(template_id→文件名), `sound_files`=multipart（音效，文件名`<template_id>__<原名>`）|
| ③ 结果 | `{"imported": N, "templates": [...]}`（幂等，同 template_id 覆盖）|
| ④ 共用 | 上传后所有客户端可从 `GET /fancy/templates` 拉到该模板 |

**注意**：音效文件名必须 `<template_id>__<原名>`（否则服务端忽略 `__` 前缀校验）。

## 4. 服务端接口契约（客户端参考）

### 4.1 `GET /fancy/templates`
```json
{ "items": [{ "template_id": "t1", "name": "弹跳", "category": "title",
              "description": "上下弹跳动画", "variables": {"text": {...},
              "color": {...}, "fontSize": {...}, "jumpColor": {...}},
              "style": "...", "sound": {"file": "...", "gain_db": 0} }],
  "total": 10 }
```

### 4.2 `POST /fancy/templates`
```
form:
  templates: [{"template_id":"t1","name":"弹跳",...}, ...]   # JSON 数组
  sound_map: {"t1":"bounce.mp3"}                              # JSON 对象
  sound_files: 音效文件（文件名 t1__bounce.mp3）              # multipart
→ {"imported": N, "templates": [...]}
```

### 4.3 `/montage/concat` 花字烧制
```
fancy_enabled=true
fancy_words=["快充","199元"]
fancy_template_id="t1"         # 或 fancy_style="gold" / fancy_template='{...}'
fancy_position="upper_middle"
fancy_timing="subtitle_sync"
fancy_font_size_scale=0.08
```
三级回退：`fancy_template_id`(查库) → `fancy_template`(内联) → `fancy_style`(枚举)；模板非法/缺 style 回退枚举不报错。

## 5. 验收标准（客户端接入）

- [ ] 客户端成片/剪辑设置有**花字面板**（选模板/文字/样式/位置/时机）
- [ ] 客户端调 `GET /fancy/templates` 拉模板列表供选择
- [ ] `/montage/concat` 传花字参数，服务端烧制成功
- [ ] 客户端能**上传花字模板 + 音效**（`POST /fancy/templates`），上传后可从列表拉到（共用）
- [ ] 花字渲染（textfx 动画）在成片中出现

## 6. 不做 / 注意

- **不做**：客户端自行渲染花字（渲染在服务端 textfx）
- **注意**：花字模板 schema 以服务端 `GET /fancy/templates` 返回结构为准（客户端不对模板 schema 硬编码）

---

**文档已立**（客户端花字接入指南）。登记到 INVENTORY 花字行 + 客户端接入相关。要一起登记吗？
