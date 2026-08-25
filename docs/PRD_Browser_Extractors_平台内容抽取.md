# PRD — 浏览器平台内容结构化抽取（extractors/ 多场景方案）

> 版本：**V1（待评审）** | 日期：2026-08-25 | 状态：📝 待确认
> 关联文档：[PRD_Electron_v3_SchemeA.md](./PRD_Electron_v3_SchemeA.md)（厚壳架构总纲）、[DESIGN_Electron_v3.md](./DESIGN_Electron_v3.md)
> 实现载体：`electron/main/extractors/`（_common.ts + 5 平台脚本）

---

## 一、背景 & 问题

### 1.1 现状

厚壳浏览器（BrowserView 嵌入）已完成：5 平台 Tab（抖音/视频号/快手/小红书/B站）、partition Cookie 隔离、bounds 实时校验。Browser.vue 已有「解析并导入」按钮（`onExtract()` → `browser:extractDOM` → `appStore.pushBrowserExtract` → 切到工作台消费），但**点击后无数据可抽**——extractor 脚本此前是空位。

### 1.2 核心问题

用户在内嵌浏览器里打开的不是一个抽象"网页"，而是**具体的业务对象页**：某个达人的主页、某条视频、某个直播间、某个商品详情、某篇笔记。如果抽取只做"整页正文+链接+图片"的通用摘要（W1 通用 Web 方案），会丢失业务字段（粉丝数/价格/播放量/互动数），工作台拿到的是无法直接用于内容创作与数据分析的"文本糊"。

### 1.3 决策

采用 **W2 平台感知多场景抽取**：每个平台脚本先识别当前页面场景（scene），再按场景抽取结构化字段；无法识别或字段缺失时降级为通用摘要（fallback），保证任何页面点「解析并导入」都有产出。

---

## 二、目标 & 非目标

### 2.1 目标（S.M.A.R.T）

| # | 目标 | 度量 |
|---|---|---|
| G1 | 5 平台 × 17 个场景全部产出结构化 JSON | 场景覆盖率 100%（识别不出的页面走 fallback，不报错） |
| G2 | 登录态/风控/DOM 变更三类失败给出**可操作的**结构化错误 | 错误必须含 type + message + hint，禁止裸抛 |
| G3 | 单次抽取在页面内执行耗时 | ≤ 200ms（纯 DOM 同步，不发网络请求） |
| G4 | 抽取结果直接可被工作台会话消费 | `source/meta/content` 三段式，字段见 §5 |
| G5 | 平台改版时的修复成本 | 只改对应平台脚本单文件，公共契约不动 |

### 2.2 非目标（明确不做）

1. **不做**：翻页、滚动加载、批量抓取（抽取仅针对"当前视口内已渲染的这一页"）。
2. **不做**：模拟请求/破解签名/绕过风控（只用页面自身注入的 state + DOM，不触发平台反爬）。
3. **不做**：视频/图片文件下载（只抽取 URL，下载走既有的媒体工具链路）。
4. **不做**：评论区全量拉取（每场景最多带 30 条首屏评论做上下文参考）。
5. 不替代服务端解析：DOM 抽取是**客户端本地路径**，服务端 `/parse` 接口仍是兜底与深抓路径。

---

## 三、总体架构

### 3.1 注入模型（关键运行时约束）

```
主进程 browser:extractDOM(platformId)
  ├─ 校验 view 存在 / URL 非 data: 离线页
  ├─ fs.readFileSync  extractors/_common.ts      ← 公共契约（prepend）
  ├─ fs.readFileSync  extractors/<platform>.ts   ← 平台脚本（append）
  ├─ 拼接 = common + '\n' + platform
  └─ wc.executeJavaScript(`(function(){ try{ <拼接结果> }catch(e){...} })()`)
        → 页面上下文执行 → 返回 { ok, data | error } 给主进程 → 回传渲染层
```

- 脚本是**纯文本 ES2020**：不参与 TS 编译、不用 Node API，`.ts` 后缀仅为编辑器语法提示。
- `_common.ts` 被主进程自动 prepend，平台脚本内直接 `window.__TIN_EX_COMMON__` 取工具。
- 抽取是**同步一次执行**：读页面已有的 state/DOM，不 await、不发请求，天然满足 G3。

### 3.2 数据流（与既有代码对齐）

```
[BrowserView 平台页] --extractDOM--> 主进程 → 注入脚本 → { ok, data }
      ↓
Browser.vue onExtract() 封装 BrowserExtractPayload
      ↓
appStore.pushBrowserExtract()  →  切 Tab（先 detach，C6 防泄漏）→ 工作台消费
```

---

## 四、统一契约（E3 结构化错误 + 三段式数据）

### 4.1 返回结构

```jsonc
// 成功
{ "ok": true, "data": { "source": {...}, "meta": {...}, "content": {...} } }
// 失败
{ "ok": false, "error": { "type": "...", "message": "...", "hint": "..." } }
```

### 4.2 错误类型（穷举）

| type | 触发条件 | 用户动作 |
|---|---|---|
| `NEED_LOGIN` | 命中登录 URL / 登录弹层 / 登录文案 | 先扫码或手机号登录再抽取 |
| `RISK_CAPTCHA` | 命中滑块/验证码/风控文案或容器 | 手动完成验证，等 30s 重试 |
| `DOM_MISMATCH` | 脚本异常 / 平台改版 / 页面未加载完 | 用「解析并导入(服务端)」兜底 |
| `NETWORK_ERROR` | 离线兜底页 / webContents 未就绪 | 恢复网络后重试 |

### 4.3 三段式数据

| 段 | 内容 | 提供方 |
|---|---|---|
| `source` | platformId、url、title、viewport、extractedAt、**scene** | `_common.makeSource` |
| `meta` | og:*、description、keywords、canonical 等 | `_common.makeMeta` |
| `content` | **按场景变化的业务对象**（见 §5） | 平台脚本 |

### 4.4 降级策略（三级瀑布）

1. **全局 state 挖掘**：优先解析平台 SSR 注入的 `__INITIAL_STATE__` / `RENDER_DATA` / `__NEXT_DATA__` / JSON script 标签（字段最全、最稳）。
2. **DOM 兜底填充**：state 拿不到的字段用选择器补（语义化 class + `data-e2e` 优先）。
3. **通用摘要 fallback**：场景未知或关键对象全空时，返回 `makeFallbackContent()`（links/images/excerpts），**仍然 ok=true**——保证"点了按钮就有东西进工作台"。

---

## 五、场景定义（5 平台 × 17 场景）

> 每场景字段以"业务上可直接用"为标准命名；`_fallback: true` 标记 state 缺失、仅 DOM/摘要级数据。

### 5.1 抖音 douyin.ts（4 场景）

| 场景 | URL 模式 | 核心字段（content） |
|---|---|---|
| profile 用户主页 | `/user/:secUid` | secUid、nickname、uniqueId、avatar、signature、followers/following/likes/worksCount、verified、worksSample[]（前 20 作品预览） |
| video 视频详情 | `/video/:id` | awemeId、desc、cover、playAddr、duration、author{}、music{}、statistics{digg/comment/share/play/collect}、tags[]、poi{}、images[]（图文） |
| live 直播间 | `live.douyin.com/:roomId` | roomId、title、status(live/replay/offline)、viewers、totalViewers、anchor{}、productList[]（带货商品） |
| product 商品详情 | `/product/:id`、haohuo 域 | productId、title、price、originPrice、sales、stock、shop{}、skuList[]、detailHTML、params[] |

### 5.2 视频号 weixin.ts（3 场景）

| 场景 | URL 模式 | 核心字段 |
|---|---|---|
| profile 视频号主页 | `/pages/profile?username=` | finderUserName、nickname、avatar、signature、followers、worksCount、latestFeeds[] |
| video 视频详情 | `/pages/videodetail?vid=` | objectId、desc、coverUrl、mp4Url/hlsUrl、duration、finder{}、statistics{like/comment/share/favorite/watch}、comments[] |
| live 直播 | `/pages/live?roomid=` | liveId、title、status、viewers、anchor{}、productList[] |

### 5.3 快手 kuaishou.ts（3 场景）

| 场景 | URL 模式 | 核心字段 |
|---|---|---|
| profile 用户主页 | `/profile/:userId`、`/u/:id` | userId、principalId、nickname、avatar、signature、followers、worksCount、worksSample[] |
| video 视频详情 | `/short-video/:photoId` | photoId、caption、cover、videoUrl/hlsUrl、author{}、stats{view/like/comment/share/collect}、products[]、comments[] |
| product 商品详情 | `/goods/:id`、shop 子域 | goodsId、title、price、originPrice、sales、shop{}、skus[]、descImages[] |

### 5.4 小红书 xiaohongshu.ts（3 场景）

| 场景 | URL 模式 | 核心字段 |
|---|---|---|
| note 笔记详情 | `/explore/:noteId`、`/discovery/item/:id` | noteId、title、desc、type(normal/video)、images[]、videoUrl、user{}、interact{like/collect/comment/share}、ipLocation、comments[]（含 subComments） |
| profile 用户主页 | `/user/profile/:userId` | userId、nickname、avatar、desc、fans/follows/interaction、tabFeedList[] |
| search 搜索结果 | `/search_result?keyword=` | keyword、notes[]（noteId/title/cover/nickname/likeCount）、users[]、relatedSearches[] |

### 5.5 B站 bilibili.ts（4 场景，待实现）

| 场景 | URL 模式 | 核心字段 |
|---|---|---|
| video 视频详情 | `/video/BVxxx` | bvid、title、desc、owner{}、stat{view/like/coin/favorite/share/danmaku/reply}、duration、pages[]、tags[] |
| profile UP 主页 | `/space/:mid` | mid、name、avatar、sign、level、fans/archiveCount、videos[] |
| bangumi 番剧 | `/bangumi/play/epxxx` | epId、ssId、title、cover、rating、episodes[]、staff[] |
| article 专栏 | `/read/cvxxx`、`opus` | cvId、title、author{}、contentHTML、readCount、likeCount |

---

## 六、可维护性设计（应对平台改版）

1. **单文件责任**：某平台改版只改该平台脚本；`_common.ts` 契约冻结（只增不改删）。
2. **选择器弱依赖**：优先 SSR state（改版影响小），DOM 选择器用 `[class*="语义"]` 模糊匹配而非精确 hash class。
3. **永不抛裸异常**：脚本顶层 catch 后走 fallback 摘要 + `errorMessage` 标注，主进程永不因抽取崩溃。
4. **字段命名跨平台对齐**：同一语义（粉丝数/标题/封面/互动数）在不同平台用相同字段名，工作台消费端不需要 per-platform 判断。

## 七、验收标准

- [ ] 5 平台脚本文件存在且语法合法（node --check 通过拼接产物）
- [ ] 每平台任意页面点「解析并导入」：要么 ok=true 进工作台，要么结构化错误提示（不允许无响应/白屏/主进程报错）
- [ ] 未登录打开抖音视频页 → 返回 NEED_LOGIN + 中文提示
- [ ] 打开平台首页（无场景）→ 返回 ok=true + fallback 摘要 + `scene: unknown`
- [ ] 抽取结果在工作台会话卡片可见 source.scene 与关键字段
- [ ] bilibili.ts 4 场景补齐后回归以上各项

## 八、遗留问题（评审时确认）

1. 工作台侧 `pushBrowserExtract` 消费端目前只 console——需要定义结构化卡片渲染（分场景展示）。
2. content 大小上限（当前 images/comments 截断为 30~60 条）是否需要在推送前再做体积裁剪（防 IPC 大对象卡顿）。
3. 是否需要把 `scene` 写入知识库入料元数据，便于本地 SQLite 检索时按场景过滤。
