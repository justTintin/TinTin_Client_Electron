// ═══════════════════════════════════════════════════════════════
// offline-page.js — E2 离线兜底页 + 结构化抽取错误（从 thickShell-ipc.js 原样拆出，无逻辑改动）
// ═══════════════════════════════════════════════════════════════

// ── E2 离线兜底页：Luosiding 风格（支持 light/dark 双主题，避免与用户主题强烈反差） ──
function offlinePageHTML(details, platformName, theme) {
  const isDark = theme === 'dark'
  const errCode = details?.errorCode ?? 'UNKNOWN'
  const errDesc = details?.errorDescription ?? '未连接到网络'
  const scheme = isDark
    ? `:root{ color-scheme: dark }
  html,body{ margin:0;padding:0;height:100%;width:100%;
    background: radial-gradient(1200px 600px at 20% -10%, #17193a 0%, transparent 60%), #0b0c1a;
    color:#e3e4f0; font-family: -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
    display:flex; align-items:center; justify-content:center; }
  .card{ background:rgba(255,255,255,0.04); border:1px solid rgba(255,255,255,0.08);
    border-radius:16px; padding:18px 20px; margin:0 0 24px; text-align:left; }
  .tag{ background:rgba(99,102,241,0.18); color:#a5a8ff; }
  .kbd{ color:#b9bcd1; }
  button{ background:linear-gradient(180deg,#6366f1,#4f46e5); color:#fff; box-shadow:0 2px 8px rgba(79,70,229,0.35); }`
    : `:root{ color-scheme: light }
  html,body{ margin:0;padding:0;height:100%;width:100%;
    background:
      radial-gradient(1200px 600px at 20% -10%, rgba(99,102,241,0.14) 0%, transparent 60%),
      linear-gradient(180deg, #f7f8fc 0%, #eef1fb 100%);
    color:#1a1d2e; font-family: -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
    display:flex; align-items:center; justify-content:center; }
  .card{ background:#ffffff; border:1px solid rgba(99,102,241,0.14);
    border-radius:16px; padding:18px 20px; margin:0 0 24px; text-align:left;
    box-shadow: 0 1px 2px rgba(15,23,42,0.04), 0 10px 30px rgba(99,102,241,0.06); }
  .tag{ background:rgba(99,102,241,0.10); color:#4f46e5; }
  .kbd{ color:#475569; }
  button{ background:linear-gradient(180deg,#6366f1,#4f46e5); color:#fff; box-shadow:0 2px 8px rgba(79,70,229,0.30); }`
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>无网络 — 螺丝钉</title>
<style>
  ${scheme}
  .c{ max-width:520px; padding:40px 32px; text-align:center; }
  .icon{ width:64px; height:64px; margin:0 auto 20px; border-radius:18px;
    background:linear-gradient(135deg,#6366f1,#8b5cf6); display:flex; align-items:center; justify-content:center;
    box-shadow: 0 12px 32px rgba(99,102,241,0.35); }
  .icon svg{ width:30px; height:30px; stroke:#fff; stroke-width:1.8; fill:none; stroke-linecap:round; stroke-linejoin:round }
  h1{ margin:0 0 8px; font-size:20px; font-weight:700; letter-spacing:0.2px }
  p.sub{ margin:0 0 24px; color:${isDark ? '#9ca1b2' : '#64748b'}; font-size:13px; line-height:1.6 }
  .row{ display:flex; align-items:center; gap:12px; margin:8px 0 }
  .row:first-child{ margin-top:0 } .row:last-child{ margin-bottom:0 }
  .tag{ font-size:11px; padding:2px 8px; border-radius:999px; }
  .kbd{ font-variant-numeric: tabular-nums; font-size:13px; }
  button{ appearance:none; border:0; padding:10px 18px; border-radius:999px;
    font-weight:600; cursor:pointer; font-size:13px; }
  button:hover{ filter:brightness(1.05) }
</style></head><body>
  <div class="c">
    <div class="icon" aria-hidden="true">
      <svg viewBox="0 0 24 24"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>
    </div>
    <h1>${platformName || '网页'}暂时加载失败</h1>
    <p class="sub">请检查网络连接后重试。若平台需要登录或有风控验证，请在恢复网络后通过地址栏重新进入。</p>
    <div class="card">
      <div class="row"><span class="tag">错误码</span><span class="kbd">${String(errCode)}</span></div>
      <div class="row"><span class="tag">说明</span>  <span class="kbd">${String(errDesc)}</span></div>
    </div>
    <button onclick="location.reload()">重试</button>
  </div>
</body></html>`
}

// 结构化抽取返回（E3 要求）
function extractionError(type, message, hint) {
  return { ok: false, error: { type: type || 'EXTRACTOR_ERROR', message: message || '抽取失败', hint: hint || '' } }
}

module.exports = { offlinePageHTML, extractionError }
