<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// OtProductLibrary.vue — 产品资料（运营工具 · P1 实装）
// 2026-08-30 落地：对齐原客户端 product_library_page.py 完整链路——
//   从仓库同步（服务端 ERP 同步+轮询）/ 关键词搜索（300ms 防抖）/
//   品类→品牌→型号 树 / 表单增删改（仓库条目 8 字段只读）/
//   智能挖掘（单条，挖掘即持久化）/ 全量挖掘（再点停止）。
// Excel 导入导出：待引入 SheetJS 单独批次（原版 openpyxl）。
// 分层（IRON-06）：业务全在 useOpsProductLibrary（HTTP 编排/轮询）+
// opsProductLibraryLogic（纯函数，有单测）；本组件只绘制 + 事件转发。
// ═══════════════════════════════════════════════════════════════

import { onMounted, ref } from 'vue'
import {
  BASIC_FIELDS,
  PRODUCT_FIELDS,
} from '../../composables/opsProductLibraryLogic'
import { useOpsProductLibrary } from '../../composables/useOpsProductLibrary'
import OtCopywritingPanel from './OtCopywritingPanel.vue'

const P = useOpsProductLibrary()

/* ── 大类折叠（2026-09-04 用户裁决：平铺过长，默认全折叠，点击展开/收起） ── */
const collapsedCats = ref<Set<string>>(new Set())
function toggleCat(label: string): void {
  const next = new Set(collapsedCats.value)
  if (next.has(label)) next.delete(label)
  else next.add(label)
  collapsedCats.value = next
}
/** 大类产品总数（各品牌叶子数求和，折叠时提示规模） */
function catCount(cat: { children: Array<{ children: unknown[] }> }): number {
  return cat.children.reduce((n, b) => n + b.children.length, 0)
}

/** 表单字段双列渲染（基本资料 11 字段；locked 只读，对齐 _apply_field_locks） */
const basicRows = BASIC_FIELDS

onMounted(() => { void P.loadTree() })

/** 删除确认（对齐原 QMessageBox.question 默认 No） */
function onDelete() {
  if (!P.editingId.value) { P.formStatus.value = '当前为新增模式，无可删除条目。'; return }
  const name = `${P.form.value.brand ?? ''} ${P.form.value.model ?? ''}`.trim()
  if (window.confirm(`确定删除「${name}」吗？此操作不可撤销。`)) void P.remove()
}
</script>

<template>
  <section class="opl">
    <!-- ═══ 顶条：仓库同步 + 全量挖掘 + 状态 ═══ -->
    <div class="opl-toolbar">
      <button class="btn primary" :disabled="P.syncing.value" @click="P.startSync">
        {{ P.syncing.value ? '同步中…' : '⟳ 从仓库同步' }}
      </button>
      <button
        class="btn"
        :class="{ danger: P.bulkMining.value }"
        :title="P.bulkMining.value ? '点击停止批量挖掘' : '批量为所有产品自动挖掘性能参数和核心卖点'"
        @click="P.mineAll"
      >
        {{ P.bulkMining.value ? '⏹ 停止挖掘' : '⚡ 全量挖掘' }}
      </button>
      <span class="toolbar-status">{{ P.syncing.value || P.syncStatus ? P.syncStatus : P.mineStatus }}</span>
    </div>

    <div class="opl-main">
      <!-- ═══ 左卡：搜索 + 树 ═══ -->
      <div class="opl-left">
        <div class="card-title">产品库</div>
        <input
          class="input search"
          type="text"
          placeholder="搜索 品牌 / 型号 / 编码 / 条码 ..."
          :value="P.keyword.value"
          @input="P.onKeywordInput(($event.target as HTMLInputElement).value)"
        />
        <div class="tree custom-scroll">
          <template v-if="P.treeLoading.value">加载中…</template>
          <template v-else-if="P.treeError.value">加载失败：{{ P.treeError.value }}</template>
          <template v-else-if="P.keyword.value.trim()">
            <!-- 搜索结果平铺（对齐原 search 分支） -->
            <div v-if="!P.searchHits.value.length" class="tree-empty">无匹配产品</div>
            <button
              v-for="hit in P.searchHits.value"
              :key="hit.id"
              class="tree-leaf"
              @click="P.selectNode(hit.id)"
            >{{ hit.label }}</button>
          </template>
          <template v-else-if="!P.nodes.value.length">暂无产品，请先「从仓库同步」</template>
          <template v-else>
            <div v-for="cat in P.nodes.value" :key="cat.label" class="tree-cat">
              <button
                class="tree-cat-label"
                type="button"
                :title="collapsedCats.has(cat.label) ? '展开' : '收起'"
                @click="toggleCat(cat.label)"
              >
                <span class="tree-cat-arrow" :class="{ collapsed: collapsedCats.has(cat.label) }">▾</span>
                {{ cat.label }}
                <span class="tree-cat-count">{{ catCount(cat) }}</span>
              </button>
              <template v-if="!collapsedCats.has(cat.label)">
                <div v-for="brand in cat.children" :key="brand.label" class="tree-brand">
                  <div class="tree-brand-label">{{ brand.label }}</div>
                  <button
                    v-for="leaf in brand.children"
                    :key="leaf.id"
                    class="tree-leaf"
                    :class="{ active: P.editingId.value === leaf.id }"
                    @click="P.selectNode(leaf.id)"
                  >{{ leaf.label }}</button>
                </div>
              </template>
            </div>
          </template>
        </div>
        <!-- 2026-09-05 用户裁决：删除「新增型号（清空表单）」——与右侧操作栏「清空」按钮
             重复（同为 P.clearForm），且仅清空表单不创建数据，无独立价值 -->
      </div>

      <!-- ═══ 右侧：基本资料 + 智能挖掘 ═══ -->
      <div class="opl-right">
        <div class="opl-card">
          <div class="card-title">产品基本资料</div>
          <p class="card-tip">
            仓库同步的产品：仅「商品名称/型号、品类、备注」可改，其余为仓库只读数据；所有修改仅保存在本地，不会回写仓库。
          </p>
          <div class="form-grid">
            <label v-for="f in basicRows" :key="f.key" class="form-field">
              <span class="form-label">{{ f.label }}<i v-if="f.key === 'brand' || f.key === 'model'" class="req"> *</i></span>
              <input
                class="input"
                type="text"
                :readonly="P.lockedFields.value[f.key]"
                :class="{ readonly: P.lockedFields.value[f.key] }"
                v-model="P.form.value[f.key]"
              />
            </label>
          </div>
        </div>

        <div class="opl-card">
          <div class="card-title-row">
            <div class="card-title">智能挖掘（性能参数 &amp; 核心卖点）</div>
            <button class="btn primary" :disabled="P.mining.value" @click="P.mineSingle">
              {{ P.mining.value ? '⏳ 正在挖掘...' : '🪄 智能挖掘' }}
            </button>
          </div>
          <div class="mine-grid">
            <label class="mine-field">
              <span class="form-label">性能参数</span>
              <textarea
                class="input ta"
                :placeholder="P.mining.value ? '挖掘中…' : '点击【智能挖掘】自动从大模型获取性能参数，或在此手动输入...'"
                v-model="P.form.value.features"
              ></textarea>
            </label>
            <label class="mine-field">
              <span class="form-label">核心卖点</span>
              <textarea
                class="input ta"
                :placeholder="P.mining.value ? '挖掘中…' : '点击【智能挖掘】自动从大模型获取核心卖点，或在此手动输入...'"
                v-model="P.form.value.selling_points"
              ></textarea>
            </label>
          </div>
          <div v-if="P.mineStatus.value" class="mine-status">{{ P.mineStatus.value }}</div>
        </div>

        <!-- 底部操作条（2026-09-05 用户裁决：按钮靠右，保存最右；状态占位左侧） -->
        <div class="opl-actions">
          <span class="form-status">{{ P.formStatus.value }}</span>
          <button class="btn" @click="P.clearForm">清空</button>
          <button class="btn" @click="onDelete">🗑 删除</button>
          <button class="btn primary" :disabled="P.saving.value" @click="P.save">
            {{ P.saving.value ? '保存中…' : (P.editingId.value ? '💾 保存修改' : '💾 保存（新增）') }}
          </button>
        </div>

        <!-- ═══ 文案生成（2026-09-05 用户裁决：自媒体工具·产品知识页迁入） ═══
             产品上下文 = 当前树选中条目（editingId/form）；性能参数/核心卖点
             直接读上方智能挖掘表单，新增模式（editingId 空）时生成被拦截 -->
        <OtCopywritingPanel
          :product-id="P.editingId.value ?? ''"
          :features="String(P.form.value.features ?? '')"
          :selling-points="String(P.form.value.selling_points ?? '')"
          :product="P.form.value"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
.opl { display: flex; flex-direction: column; gap: var(--space-4); height: 100%; }
.btn {
  height: 32px; padding: 0 14px; border-radius: var(--radius-md);
  border: 1px solid var(--border); background: var(--surface-container);
  color: var(--foreground); font-size: 13px; font-weight: 500; cursor: pointer;
  transition: all var(--duration-fast); white-space: nowrap;
}
.btn:hover { border-color: var(--primary); color: var(--primary); }
.btn.primary { background: var(--primary); border-color: var(--primary); color: var(--primary-foreground); }
.btn.primary:hover { opacity: 0.9; }
.btn.danger { background: var(--error, #EF4444); border-color: var(--error, #EF4444); color: #fff; }
.btn:disabled { opacity: 0.55; cursor: not-allowed; }
.input {
  height: 32px; padding: 0 10px; border-radius: var(--radius-md);
  border: 1px solid var(--border); background: var(--background);
  color: var(--foreground); font-size: 13px; width: 100%; box-sizing: border-box;
}
.input.readonly { opacity: 0.6; cursor: not-allowed; }

/* 顶条 */
.opl-toolbar { display: flex; align-items: center; gap: var(--space-3); }
.toolbar-status {
  flex: 1; min-width: 0; font-size: 12px; color: var(--muted-foreground);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

/* 主区 */
.opl-main { display: grid; grid-template-columns: minmax(240px, 1fr) 2fr; gap: var(--space-4); flex: 1; min-height: 0; }
.opl-left, .opl-card {
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius-lg); padding: var(--space-4);
  display: flex; flex-direction: column; gap: var(--space-3);
}
.card-title { font-size: 14px; font-weight: 700; color: var(--foreground); }
.card-title-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.card-tip { margin: 0; font-size: 12px; line-height: 1.5; color: var(--muted-foreground); }

/* 树 */
.tree { flex: 1; min-height: 160px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; }
.tree-empty { font-size: 12px; color: var(--muted-foreground); padding: var(--space-2); }
.tree-cat-label {
  display: flex; align-items: center; gap: 6px; width: 100%;
  font-size: 13px; font-weight: 700; color: var(--foreground);
  padding: var(--space-1) 4px; border: none; background: transparent;
  cursor: pointer; text-align: left; border-radius: var(--radius-sm);
  font-family: inherit;
}
.tree-cat-label:hover { background: var(--surface-container); }
.tree-cat-arrow {
  font-size: 10px; color: var(--muted-foreground);
  transition: transform var(--duration-fast);
}
.tree-cat-arrow.collapsed { transform: rotate(-90deg); }
.tree-cat-count {
  margin-left: auto; font-size: 11px; font-weight: 500;
  color: var(--muted-foreground);
}
.tree-brand-label { font-size: 12px; font-weight: 600; color: var(--muted-foreground); padding: 2px 4px 2px 18px; }
.tree-leaf {
  text-align: left; border: none; background: transparent; cursor: pointer;
  font-size: 13px; color: var(--foreground); padding: 4px 4px 4px 34px;
  border-radius: var(--radius-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.tree-leaf:hover { background: var(--surface-container); }
.tree-leaf.active { background: var(--primary); color: var(--primary-foreground); }

/* 右侧布局 */
.opl-right { display: flex; flex-direction: column; gap: var(--space-4); min-height: 0; overflow-y: auto; }
.form-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-2) var(--space-3); }
.form-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.form-label { font-size: 12px; color: var(--muted-foreground); }
.req { color: var(--error, #EF4444); font-style: normal; }
.mine-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }
.mine-field { display: flex; flex-direction: column; gap: 4px; }
.ta { height: 192px; padding: 8px 10px; resize: vertical; line-height: 1.5; } /* 2026-09-05 用户裁决：96→192px，参数/卖点篇幅加倍 */
.mine-status { font-size: 12px; color: var(--muted-foreground); }

/* 底部操作条 */
.opl-actions { display: flex; align-items: center; gap: var(--space-3); }
.form-status { flex: 1; min-width: 0; font-size: 12px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

@media (max-width: 1000px) {
  .opl-main { grid-template-columns: 1fr; }
  .form-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .mine-grid { grid-template-columns: 1fr; }
}
</style>
