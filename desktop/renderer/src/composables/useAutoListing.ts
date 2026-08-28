// ═══════════════════════════════════════════════════════════════
// useAutoListing — 浏览器·自动上架面板域（P3 迁移）
// 对照基准：V2 PRD 第十四章自动上架 + 原系统设置扩展卡 shopKeyword。
// 本期为「入口 + 配置 + 打开抖店分区」深度（2026-08-27 裁决）：
//   · 店铺关键词沿用 ext.shopKeyword 配置键，无缝继承原扩展卡已存值；
//   · 「打开抖店工作台」由容器接 selectFxg()（nav 域）attach
//     persist:tintin-fxg 分区，复用内置浏览器已登录会话；
//   · 完整自动化链路（数据包校验/商品填写/草稿/截图/断点续跑）后续排期。
// ═══════════════════════════════════════════════════════════════

import { ref } from 'vue'
import { readCfg, writeCfg } from './useSettingsConfig'

export function useAutoListing() {
  const shopKeyword = ref<string>('桔柚')
  const saving = ref(false)
  const saved = ref(false)

  async function loadCfg() {
    shopKeyword.value = String(await readCfg('ext.shopKeyword', shopKeyword.value))
  }

  async function saveCfg() {
    if (saving.value) return
    saving.value = true
    try {
      await writeCfg('ext.shopKeyword', shopKeyword.value)
      saved.value = true
      setTimeout(() => { saved.value = false }, 1500)
    } finally {
      saving.value = false
    }
  }

  return { shopKeyword, saving, saved, loadCfg, saveCfg }
}
