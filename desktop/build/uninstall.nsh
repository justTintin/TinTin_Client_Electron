; ═══════════════════════════════════════════════════════════════
; uninstall.nsh — 卸载时清理 Windows 任务计划程序中的 TinTinAI_* 任务
; electron-builder NSIS include 脚本（package.json nsis.include 引用）
; ══════════════════════════════════════════════════════════════

!macro customUnInstall
  ; 卸载时清理本地定时任务（schtasks）
  DetailPrint "清理定时任务..."
  
  ; 删除所有 TinTinAI_ 前缀的任务
  nsExec::ExecToLog 'schtasks /delete /tn "TinTinAI_*" /f'
  Pop $0  ; 退出码
  
  ; 也尝试删除可能的具体任务名（防止通配符不生效）
  nsExec::ExecToLog 'schtasks /delete /tn "TinTinAI_热点采集" /f'
  Pop $0
  nsExec::ExecToLog 'schtasks /delete /tn "TinTinAI_智能体任务" /f'
  Pop $0
  
  DetailPrint "定时任务清理完成"
!macroend
