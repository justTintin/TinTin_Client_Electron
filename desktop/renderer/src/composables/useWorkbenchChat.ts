import { ref } from 'vue'
import { useRouter } from 'vue-router'

/* ── 消息数据 ──────────────────────────────────────────────── */
export type Role = 'user' | 'ai'

export interface ChatMessage {
  id: string
  role: Role
  content: string
  shots?: Array<{ index: number; label: string; desc: string }>
}

/**
 * 工作台消息域：消息流数据 / 底部输入文本 / 发送与快捷键 / 设置页跳转。
 *
 * DOM 归属拆分说明：
 * - 原messageListRef留在他所属的 WbMessages 组件内部自持，「发送后 nextTick 滚动」
 *   与「初始滚动」的 nextTick 时序由该组件 expose 的 scrollToBottom 实现；
 *   本 composable 通过 options.scrollToBottom 由容器桥接调用（原 handleSend 中两处
 *   scrollToBottom() 调用点位不变）。
 * - 原inputRef位于输入区 textarea，归属 WbComposer 自持并 expose focus()，
 *   由容器桥接给 useWorkbenchSessions 的 onSessionFocus 钩子。
 */
export function useWorkbenchChat(options?: {
  scrollToBottom?: () => void
}) {
  const router = useRouter()

  const messages = ref<ChatMessage[]>([
    {
      id: 'm1',
      role: 'ai',
      content: '你好，我是螺丝钉电商智能体。今天需要我帮你做什么？可以输入产品名、上传参考图，或直接让我生成脚本。'
    },
    {
      id: 'm2',
      role: 'user',
      content: '帮我为 JBL CHARGE6 写一条 15 秒电商短视频脚本，风格年轻化，突出户外便携。'
    },
    {
      id: 'm3',
      role: 'ai',
      content: '已为你生成脚本，分为 3 个镜头：',
      shots: [
        { index: 1, label: '特写 · 3s', desc: 'JBL CHARGE6 置于背包侧袋，阳光掠过。' },
        { index: 2, label: '近景 · 5s', desc: '手指一键播放，节奏灯随鼓点跳动。' },
        { index: 3, label: '中景 · 7s', desc: '露营场景，好友围坐，音乐响起。' }
      ]
    }
  ])

  const inputText = ref<string>('')

  /** 原 createSession 内逐字保留的「新会话欢迎消息」重置逻辑 */
  function resetToWelcome() {
    messages.value = [
      {
        id: 'm-welcome',
        role: 'ai',
        content: '你好，我是螺丝钉电商智能体。告诉我你的产品信息，我来帮你创作脚本。'
      }
    ]
  }

  function handleSend() {
    const text = inputText.value.trim()
    if (!text) return
    // 用户消息
    messages.value.push({
      id: 'u' + Date.now(),
      role: 'user',
      content: text
    })
    inputText.value = ''
    options?.scrollToBottom?.()
    // 模拟 AI 回复（占位）
    setTimeout(() => {
      messages.value.push({
        id: 'a' + Date.now(),
        role: 'ai',
        content: '收到你的需求，正在分析产品卖点并生成脚本大纲…'
      })
      options?.scrollToBottom?.()
    }, 500)
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  function openSettings() {
    router.push('/settings')
  }

  return {
    messages,
    inputText,
    resetToWelcome,
    handleSend,
    handleKeydown,
    openSettings
  }
}
