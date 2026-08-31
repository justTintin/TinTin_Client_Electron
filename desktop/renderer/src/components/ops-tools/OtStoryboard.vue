<script setup lang="ts">
// ═══════════════════════════════════════════════════════════════
// OtStoryboard.vue — 分镜脚本创作（媒体工具卡 · P1 实装）
// 2026-08-30 裁决：自原「方案脚本」组划归媒体工具 Tab。
// 对照 storyboard_page.py：文案输入 → 生成分镜（每镜头 镜别/时长/
// 画面/旁白/音效）→ 镜头引用素材（语义搜索）→ 保存脚本库
// （POST /api/storyboard/scripts，同 topic 覆盖更新，保存后工作台可选）。
// 飞书脚本创作不移植（2026-08-30 裁决）；即梦/联网素材生成先占位（§七）。
// 分层：本组件只绘制 + 事件转发，业务在 useOpsStoryboard。
// ═══════════════════════════════════════════════════════════════

import { RATIO_OPTIONS, ratioToOrient, totalDuration } from '../../composables/opsStoryboardLogic'
import { useOpsStoryboard } from '../../composables/useOpsStoryboard'

const S = useOpsStoryboard()
</script>

<template>
  <section class="osb">
    <!-- ═══ 文案 + 画幅 + 生成 ═══ -->
    <div class="card">
      <div class="head-row">
        <div class="card-title">视频文案（可编辑）</div>
        <div class="head-tools">
          <label class="field inline">
            <span class="lbl">画幅</span>
            <select class="input narrow" v-model="S.ratio.value">
              <option v-for="r in RATIO_OPTIONS" :key="r" :value="r">{{ r }}（{{ ratioToOrient(r) }}）</option>
            </select>
          </label>
          <button class="btn primary" :disabled="S.generating.value" @click="S.generate">
            {{ S.generating.value ? 'AI 正在拆解分镜…' : '生成分镜脚本' }}
          </button>
        </div>
      </div>
      <textarea
        class="input ta"
        placeholder="粘贴或输入视频文案；也可从「产品文案创作」卡点「前往分镜脚本设计」自动带入。"
        v-model="S.copyText.value"
      ></textarea>
      <div v-if="S.status.value" class="status">{{ S.status.value }}</div>
    </div>

    <!-- ═══ 镜头卡列表（竖向） ═══ -->
    <template v-if="S.shots.value.length">
      <div class="sb-info">总时长：{{ Math.round(totalDuration(S.shots.value.map((s) => s.duration))) }} s ｜ {{ S.shots.value.length }} 镜（{{ ratioToOrient(S.ratio.value) }}）</div>

      <div v-for="(shot, i) in S.shots.value" :key="i" class="card shot-card">
        <div class="shot-head">
          <span class="shot-no">#{{ shot.index }}</span>
          <label class="field inline">
            <span class="lbl">镜别</span>
            <input class="input narrow" type="text" v-model="shot.shot_type" />
          </label>
          <label class="field inline">
            <span class="lbl">时长（秒）</span>
            <input class="input narrow" type="number" min="1" step="1" v-model.number="shot.duration" />
          </label>
          <span class="spacer"></span>
          <button class="btn" @click="S.openMaterialPicker(i)">引用素材</button>
          <button class="btn danger" @click="S.removeShot(i)">删除</button>
        </div>

        <div v-if="shot.material_path" class="mat-bind">
          已绑定：<b>{{ shot.material_name || shot.material_path }}</b>
          <button class="btn tiny" @click="S.unbindMaterial(i)">解绑</button>
        </div>

        <label class="field">
          <span class="lbl">画面描述（可作即梦出图提示词）</span>
          <textarea class="input ta sm" v-model="shot.visual"></textarea>
        </label>
        <div class="shot-grid">
          <label class="field">
            <span class="lbl">旁白 / 台词</span>
            <textarea class="input ta sm" v-model="shot.audio"></textarea>
          </label>
          <label class="field">
            <span class="lbl">音效建议</span>
            <textarea class="input ta sm" v-model="shot.sfx"></textarea>
          </label>
        </div>
      </div>

      <div class="btn-row left">
        <button class="btn" @click="S.addShot">＋ 添加镜头</button>
        <button class="btn" @click="S.clearShots">清空分镜</button>
        <span class="hint">即梦 / 联网素材生成待素材批次迁移，当前可先语义检索本地素材库。</span>
      </div>
    </template>

    <!-- ═══ 保存条 ═══ -->
    <div class="card save-bar">
      <label class="field grow">
        <span class="lbl">选题 / 文件名（同选题重复保存视为更新）</span>
        <input class="input" type="text" v-model="S.topic.value" placeholder="分镜脚本_YYYYMMDD_HHMM" />
      </label>
      <button class="btn primary" :disabled="S.saving.value" @click="S.save">
        {{ S.saving.value ? '保存中…' : '保存到服务端脚本库' }}
      </button>
    </div>

    <!-- ═══ 素材引用弹层 ═══ -->
    <Teleport to="body">
      <div v-if="S.matTargetIndex.value >= 0" class="mat-mask" @click.self="S.closeMaterialPicker">
        <div class="mat-panel">
          <div class="mat-head">
            <b>为镜头 #{{ S.shots.value[S.matTargetIndex.value]?.index ?? '' }} 引用素材</b>
            <button class="btn tiny" @click="S.closeMaterialPicker">关闭</button>
          </div>
          <p class="hint">按画面描述 + 产品上下文语义检索本地素材库（POST /material/search）。</p>
          <button class="btn primary" :disabled="S.matSearching.value" @click="S.searchMaterials">
            {{ S.matSearching.value ? '检索中…' : '开始检索' }}
          </button>
          <div class="mat-list custom-scroll">
            <div v-if="!S.matHits.value.length && !S.matSearching.value" class="hint">尚无结果，点击「开始检索」。</div>
            <button
              v-for="hit in S.matHits.value"
              :key="hit.id + hit.path"
              class="mat-item"
              :title="`${hit.path}\n相似度 ${(hit.score * 100).toFixed(1)}%`"
              @click="S.bindMaterial(hit)"
            >
              <span class="mat-name">{{ hit.name || hit.path }}</span>
              <span class="mat-score">{{ (hit.score * 100).toFixed(0) }}%</span>
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.osb { display: flex; flex-direction: column; gap: var(--space-4); }

.card {
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius-lg); padding: var(--space-4);
  display: flex; flex-direction: column; gap: var(--space-3);
}
.card-title { font-size: 14px; font-weight: 700; color: var(--foreground); }
.head-row { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.head-tools { display: flex; align-items: center; gap: var(--space-3); }
.sb-info { font-size: 12px; color: var(--muted-foreground); }
.hint { font-size: 12px; color: var(--muted-foreground); }

.input {
  height: 32px; padding: 0 10px; border-radius: var(--radius-md);
  border: 1px solid var(--border); background: var(--background);
  color: var(--foreground); font-size: 13px; width: 100%; box-sizing: border-box;
}
.input.narrow { width: 110px; }
.ta { padding: 8px 10px; resize: vertical; line-height: 1.5; }
textarea.input { height: 110px; width: 100%; }
.ta.sm { height: 72px; }

.field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.field.inline { flex-direction: row; align-items: center; gap: 8px; }
.field.grow { flex: 1 1 auto; }
.lbl { font-size: 12px; color: var(--muted-foreground); white-space: nowrap; }
.shot-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3); }

.shot-card { gap: var(--space-2); }
.shot-head { display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap; }
.shot-no { font-weight: 700; color: var(--primary); }
.spacer { flex: 1 1 auto; }
.mat-bind { font-size: 12px; color: var(--muted-foreground); display: flex; align-items: center; gap: 8px; }

.btn {
  height: 32px; padding: 0 14px; border-radius: var(--radius-md);
  border: 1px solid var(--border); background: var(--surface-container);
  color: var(--foreground); font-size: 13px; font-weight: 500; cursor: pointer;
  transition: all var(--duration-fast); white-space: nowrap;
}
.btn:hover { border-color: var(--primary); color: var(--primary); }
.btn.primary { background: var(--primary); border-color: var(--primary); color: var(--primary-foreground); }
.btn.primary:hover { opacity: 0.9; }
.btn.danger { color: var(--error, #EF4444); border-color: var(--error, #EF4444); }
.btn.tiny { height: 24px; padding: 0 10px; font-size: 12px; }
.btn:disabled { opacity: 0.55; cursor: not-allowed; }

.btn-row { display: flex; align-items: center; gap: var(--space-3); }
.btn-row.left { justify-content: flex-start; flex-wrap: wrap; }

.save-bar { flex-direction: row; align-items: flex-end; gap: var(--space-3); }

.status { font-size: 12px; color: var(--muted-foreground); line-height: 1.5; word-break: break-all; }

/* 素材弹层 */
.mat-mask {
  position: fixed; inset: 0; z-index: 1000;
  background: rgba(0, 0, 0, 0.4);
  display: flex; align-items: center; justify-content: center;
}
.mat-panel {
  width: min(560px, 92vw); max-height: 70vh; overflow: hidden;
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius-lg); padding: var(--space-4);
  display: flex; flex-direction: column; gap: var(--space-3);
}
.mat-head { display: flex; align-items: center; justify-content: space-between; }
.mat-list { overflow-y: auto; display: flex; flex-direction: column; gap: 6px; min-height: 120px; }
.mat-item {
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);
  padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-md);
  background: var(--background); cursor: pointer; text-align: left;
}
.mat-item:hover { border-color: var(--primary); }
.mat-name { font-size: 13px; color: var(--foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mat-score { font-size: 12px; color: var(--primary); font-weight: 600; }

@media (max-width: 800px) { .shot-grid { grid-template-columns: 1fr; } }
</style>
