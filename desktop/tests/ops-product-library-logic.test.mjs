// ═══════════════════════════════════════════════════════════════
// ops-product-library-logic.test.mjs — 产品资料·纯逻辑单测（TDD 先行）
// 被测：renderer/src/composables/opsProductLibraryLogic.ts（纯函数，无 vue 依赖）
// 对照原客户端：
//   · utils/product_library_manager.py：FIELDS/REQUIRED_FIELDS/WAREHOUSE_FIELDS
//     L22-43、_normalize L211-214、search 本地降级 L317-331、grouped 本地降级
//     L333-344、to_prompt_text L382-391
//   · gui/product_library_page.py：_on_tree_data_ready L636-662（树排序/叶子标签）、
//     LOCKABLE_FIELDS L601-602、is_warehouse L678、_on_import_excel 校验 L904
// 运行：node --test "tests/*.test.mjs"
// ═══════════════════════════════════════════════════════════════

import { test } from 'node:test'
import assert from 'node:assert/strict'

const M = await import('../renderer/src/composables/opsProductLibraryLogic.ts')

/* ── 字段常量（对齐原 FIELDS / REQUIRED_FIELDS） ─────────────── */

test('PRODUCT_FIELDS：13 字段与中文标签对齐原 manager.FIELDS', () => {
  assert.equal(M.PRODUCT_FIELDS.length, 13)
  const keys = M.PRODUCT_FIELDS.map((f) => f.key)
  assert.deepEqual(keys, [
    'category', 'brand', 'model', 'goods_no', 'spec_no', 'spec_name',
    'barcode', 'stock_num', 'available_num', 'warehouse', 'notes',
    'features', 'selling_points'
  ])
  const byKey = Object.fromEntries(M.PRODUCT_FIELDS.map((f) => [f.key, f.label]))
  assert.equal(byKey.category, '品类')
  assert.equal(byKey.model, '型号/货品名称')
  assert.equal(byKey.selling_points, '核心卖点')
})

test('REQUIRED_PRODUCT_FIELDS = brand、model（原 L38）', () => {
  assert.deepEqual([...M.REQUIRED_PRODUCT_FIELDS].sort(), ['brand', 'model'])
})

test('LOCKABLE_PRODUCT_FIELDS：仓库只读 8 字段（原 page L601-602）', () => {
  assert.deepEqual([...M.LOCKABLE_PRODUCT_FIELDS].sort(), [
    'available_num', 'barcode', 'brand', 'goods_no', 'spec_name', 'spec_no', 'stock_num', 'warehouse'
  ].sort())
})

/* ── normalizeItem（对齐 _normalize：仅已知字段、缺省补空串） ── */

test('normalizeItem：多余字段剔除、缺失补空串、数值转字符串去空白', () => {
  const r = M.normalizeItem({
    category: ' 鼠标 ', brand: '罗技', model: 'G502', extra: 'x',
    stock_num: 12, features: null
  })
  assert.equal(Object.keys(r).length, 13)
  assert.equal(r.category, '鼠标')
  assert.equal(r.stock_num, '12')
  assert.equal(r.features, '')
  assert.equal('extra' in r, false)
})

/* ── validateItem（对齐 add_item/update_item 必填校验文案） ──── */

test('validateItem：brand/model 缺失 → 中文标签提示（原「必填项不能为空：品牌、型号/货品名称」）', () => {
  const r = M.validateItem({ brand: '', model: '' })
  assert.equal(r.ok, false)
  assert.equal(r.message, '必填项不能为空：品牌、型号/货品名称')
})

test('validateItem：必填齐 → ok', () => {
  assert.deepEqual(M.validateItem({ brand: '罗技', model: 'G502' }), { ok: true, message: '' })
})

/* ── buildProductTree（对齐 grouped 本地降级 L333-344） ───────── */

test('buildProductTree：品类/品牌缺省归「未归类/未知品牌」，同组聚合', () => {
  const tree = M.buildProductTree([
    { id: '1', category: '鼠标', brand: '罗技', model: 'G502' },
    { id: '2', category: '鼠标', brand: '罗技', model: 'G304' },
    { id: '3', category: '', brand: '', model: '神秘产品' },
    { id: '4', category: '键盘', brand: '罗技', model: 'K845' }
  ])
  assert.deepEqual(Object.keys(tree).sort(), ['未归类', '键盘', '鼠标'])
  assert.deepEqual(tree['鼠标']['罗技'].map((x) => x.id), ['1', '2'])
  assert.deepEqual(tree['未归类']['未知品牌'].map((x) => x.id), ['3'])
})

/* ── treeToNodes（对齐 _on_tree_data_ready L636-662 排序与标签） */

test('treeToNodes：品类/品牌字典序、叶子按 model 排序、叶子标签取 model→goods_no→(未命名)', () => {
  const tree = {
    键盘: { 罗技: [{ id: 'k1', model: 'K845', goods_no: 'GD1' }] },
    鼠标: {
      罗技: [{ id: 'm2', model: 'G304' }, { id: 'm1', model: 'G502' }],
      雷蛇: [{ id: 'r1', model: '', goods_no: 'GD9' }]
    }
  }
  const nodes = M.treeToNodes(tree)
  assert.deepEqual(nodes.map((n) => n.label), ['键盘', '鼠标'])
  const mouse = nodes[1]
  assert.deepEqual(mouse.children.map((b) => b.label), ['罗技', '雷蛇'])
  const logitech = mouse.children[0]
  assert.deepEqual(logitech.children.map((l) => l.label), ['G304', 'G502'])
  // 品类/品牌节点无 id（点击不进表单）
  assert.equal(nodes[0].id, null)
  assert.equal(mouse.children[0].id, null)
  // 叶子 r1：model 空 → 回退 goods_no
  assert.equal(mouse.children[1].children[0].label, 'GD9')
  assert.equal(mouse.children[1].children[0].id, 'r1')
})

/* ── 搜索结果标签（对齐 L642：brand+model 或 (未命名)） ───────── */

test('searchResultLabel：brand+model 拼接；全空 → (未命名)', () => {
  assert.equal(M.searchResultLabel({ brand: '罗技', model: 'G502' }), '罗技 G502')
  assert.equal(M.searchResultLabel({ brand: '', model: '' }), '(未命名)')
})

/* ── isWarehouseItem（对齐 L678：goods_no 或 spec_no 非空） ───── */

test('isWarehouseItem：goods_no/spec_no 任一非空即仓库产品', () => {
  assert.equal(M.isWarehouseItem({ goods_no: 'GD1', spec_no: '' }), true)
  assert.equal(M.isWarehouseItem({ goods_no: '', spec_no: 'SP1' }), true)
  assert.equal(M.isWarehouseItem({ goods_no: '', spec_no: '' }), false)
  assert.equal(M.isWarehouseItem({}), false)
})

/* ── fieldLockMap（对齐 _apply_field_locks：warehouse → 8 字段只读） */

test('fieldLockMap：仓库产品锁 8 字段；手工条目全可编辑', () => {
  const locked = M.fieldLockMap(true)
  assert.equal(locked.brand, true)
  assert.equal(locked.category, false)
  assert.equal(locked.notes, false)
  const open = M.fieldLockMap(false)
  assert.equal(Object.values(open).some(Boolean), false)
})

/* ── productToPromptText（对齐 to_prompt_text L382-391） ──────── */

test('productToPromptText：非空字段逐行「label：value」；空条目 → 空串', () => {
  const txt = M.productToPromptText({ category: '鼠标', brand: '罗技', model: 'G502', features: '', notes: ' ' })
  assert.equal(txt, '品类：鼠标\n品牌：罗技\n型号/货品名称：G502')
  assert.equal(M.productToPromptText(null), '')
  assert.equal(M.productToPromptText({}), '')
})

/* ── parseSyncStatus（对齐 StockSyncWorker 轮询分支 L70-86） ──── */

test('parseSyncStatus：running → 进行中文案；error → 抛出文案；完成 → 新增/更新汇总', () => {
  assert.deepEqual(
    M.parseSyncStatus({ running: true, phase: '拉取中', fetched: 10, total: 30 }),
    { state: 'running', text: '拉取中（10/30）' }
  )
  assert.deepEqual(
    M.parseSyncStatus({ running: true, phase: '', fetched: 0, total: 0 }),
    { state: 'running', text: '同步中...' }
  )
  assert.deepEqual(
    M.parseSyncStatus({ running: false, error: 'ERP 凭据失效' }),
    { state: 'error', text: '服务端同步出错: ERP 凭据失效' }
  )
  assert.deepEqual(
    M.parseSyncStatus({ running: false, added: 5, updated: 12 }),
    { state: 'done', text: '服务端同步完成（新增 5、更新 12）', added: 5, updated: 12 }
  )
})

/* ── parseMineStatus（对齐 SingleMineWorker/BulkMineWorker 轮询） */

test('parseMineStatus：running/完成/出错 三分支', () => {
  assert.deepEqual(
    M.parseMineStatus({ running: true, done: 2, total: 9 }),
    { state: 'running', text: '服务端挖掘中 2/9', done: 2, total: 9 }
  )
  assert.deepEqual(
    M.parseMineStatus({ running: false, done: 9, total: 9 }),
    { state: 'done', done: 9, total: 9 }
  )
  assert.deepEqual(
    parseMineErr(),
    { state: 'error', text: '服务端挖掘出错: boom' }
  )
  function parseMineErr() {
    return M.parseMineStatus({ running: false, error: 'boom' })
  }
})

/* ── parseExcelRows（对齐 _on_import_excel 行校验 L897-907） ──── */

test('parseImportRows：category/brand 缺失行报错、空行跳过、字段裁剪', () => {
  const r = M.parseImportRows([
    { category: '鼠标', brand: '罗技', model: ' G502 ' },
    { category: '', brand: 'X', model: 'm' },
    { category: '键盘', brand: '', model: 'K' },
    { category: ' ', brand: '  ', model: '' } // 全空白 = 空行（原版 L898 同口径跳过）
  ])
  assert.equal(r.valid.length, 1)
  assert.equal(r.valid[0].model, 'G502')
  assert.equal(r.errors.length, 2)
  assert.match(r.errors[0], /品类和品牌不能为空/)
})

// ── firstSellingPoint：选择产品弹窗行内卖点摘要（2026-09-01 用户反馈：
//    原 slice(60) 直接截断整段 markdown，带 ** 星号且多行混杂——取第一条卖点
//    并剥离 markdown 标记） ──

test('firstSellingPoint：多行 markdown 列表 → 取第一条并剥离 ** 加粗与列表符', () => {
  const raw = '- **极致轻量化，仅60克**：采用薄壁外壳与镂空骨架，长时间游戏无负担。\n- **HERO 2 旗舰传感器**：精准追踪细微移动。'
  assert.equal(M.firstSellingPoint(raw), '极致轻量化，仅60克：采用薄壁外壳与镂空骨架，长时间游戏无负担。')
})

test('firstSellingPoint：无标记纯列表行 → 原样取第一条；单行裸文本直接返回', () => {
  assert.equal(M.firstSellingPoint('- 280W 大功率输出\n- 19.5V 稳定供电'), '280W 大功率输出')
  assert.equal(M.firstSellingPoint('续航持久'), '续航持久')
})

test('firstSellingPoint：空数据返回空串', () => {
  assert.equal(M.firstSellingPoint(''), '')
  assert.equal(M.firstSellingPoint(undefined), '')
  assert.equal(M.firstSellingPoint(null), '')
})

// ── firstMarkdownLine：产品弹窗两块布局（2026-09-01 用户裁决：左型号 /
//    右参数+卖点）——性能参数 features 与卖点同格式，取首行剥标记的通用化 ──

test('firstMarkdownLine：features 多行参数列表 → 取首行剥 ** 加粗与列表符', () => {
  const raw = '- **材质**：高品质硅胶\n- **厚度**：约0.5mm\n- 适配型号：罗技G502 HERO'
  assert.equal(M.firstMarkdownLine(raw), '材质：高品质硅胶')
  assert.equal(M.firstMarkdownLine(raw, 4), '材质：高…')
})

test('firstMarkdownLine：与 firstSellingPoint 同口径（单行裸文本/空值）', () => {
  assert.equal(M.firstMarkdownLine('280W 大功率输出'), '280W 大功率输出')
  assert.equal(M.firstMarkdownLine(''), '')
  assert.equal(M.firstMarkdownLine(undefined), '')
  assert.equal(M.firstSellingPoint('- **卖点A**：描述一\n- **卖点B**：描述二'), M.firstMarkdownLine('- **卖点A**：描述一\n- **卖点B**：描述二'))
})
