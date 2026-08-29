// ═══════════════════════════════════════════════════════════════
// vsrQuadCanvas — quad 框选·canvas 绘制辅助（M4，UI 职责）
// 绘制语义对齐原客户端 update_preview L1166-1207：
//   · 激活框 #00ff00 线宽 3 / 非激活 #00ffff 线宽 2
//   · 去水印（可旋转）：四边形 + 顶点方块手柄 + 右下角黄色圆环旋转把手
//   · 去字幕（轴对齐）：AABB 矩形 + 四角方块手柄
// 本模块只做绘制（无状态、无业务），命中测试在 vsrQuadLogic.ts。
// ═══════════════════════════════════════════════════════════════

import type { Quad, VsrDisplayMapping, VsrFrameSize } from '@/composables/vsrQuadLogic'
import { quadAabb, rotateHandleIndex } from '@/composables/vsrQuadLogic'

const COLOR_ACTIVE = '#00ff00'
const COLOR_INACTIVE = '#00ffff'
const COLOR_ROTATE = '#ffd400'
const HANDLE_HALF = 5 // 顶点方块手柄半边长（widget 像素，原版 hs=5）

/** 帧坐标 → widget 坐标（帧图与画布显示区完全重合，offset 默认 0） */
function toWidget(p: [number, number], display: VsrDisplayMapping, frame: VsrFrameSize): [number, number] {
  return [
    display.offsetX + (p[0] * display.w) / frame.w,
    display.offsetY + (p[1] * display.h) / frame.h,
  ]
}

function drawHandleSquare(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillStyle = COLOR_ACTIVE
  ctx.fillRect(x - HANDLE_HALF, y - HANDLE_HALF, HANDLE_HALF * 2, HANDLE_HALF * 2)
  ctx.strokeStyle = '#ffffff'
  ctx.lineWidth = 1
  ctx.strokeRect(x - HANDLE_HALF, y - HANDLE_HALF, HANDLE_HALF * 2, HANDLE_HALF * 2)
}

/** 旋转把手：黄色圆环 + 斜向箭头（对照原 L1184-1191） */
function drawRotateHandle(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.strokeStyle = COLOR_ROTATE
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(x, y, 7, 0, Math.PI * 2)
  ctx.stroke()
  // 斜向箭头示意旋转
  const ax0 = x + 3
  const ay0 = y - 8
  const ax1 = x + 10
  const ay1 = y - 14
  ctx.beginPath()
  ctx.moveTo(ax0, ay0)
  ctx.lineTo(ax1, ay1)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(ax1, ay1 - 4)
  ctx.lineTo(ax1 + 4, ay1)
  ctx.lineTo(ax1 - 2, ay1 + 2)
  ctx.closePath()
  ctx.fillStyle = COLOR_ROTATE
  ctx.fill()
}

function strokePolyline(ctx: CanvasRenderingContext2D, pts: Array<[number, number]>, color: string, width: number): void {
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.beginPath()
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])))
  ctx.closePath()
  ctx.stroke()
}

export interface DrawQuadsOptions {
  boxes: Quad[]
  activeIndex: number
  display: VsrDisplayMapping
  frame: VsrFrameSize
  /** 去水印=true（可旋转四边形）；去字幕=false（轴对齐矩形） */
  allowRotation: boolean
  /** 正在拖拽中的实时四边形（帧坐标），优先于 boxes[activeIndex] 绘制 */
  draggingQuad?: Quad | null
}

/** 绘制全部选区（调用方需先自行 clearRect） */
export function drawQuads(ctx: CanvasRenderingContext2D, opts: DrawQuadsOptions): void {
  const { boxes, activeIndex, display, frame, allowRotation, draggingQuad } = opts
  boxes.forEach((quad, idx) => {
    const isActive = idx === activeIndex
    const pts = quad.map((p) => toWidget(p, display, frame))
    const color = isActive ? COLOR_ACTIVE : COLOR_INACTIVE
    const width = isActive ? 3 : 2

    if (allowRotation) {
      // 去水印：可旋转四边形 + 顶点手柄 + 旋转把手
      strokePolyline(ctx, pts, color, width)
      if (isActive) {
        const rotIdx = rotateHandleIndex(quad, true)
        pts.forEach((p, vi) => {
          if (vi === rotIdx) drawRotateHandle(ctx, p[0], p[1])
          else drawHandleSquare(ctx, p[0], p[1])
        })
      }
    } else {
      // 去字幕：轴对齐矩形（无旋转把手）
      const [x0, y0, w, h] = quadAabb(quad)
      const [ax, ay] = toWidget([x0, y0], display, frame)
      const [bx, by] = toWidget([x0 + w, y0 + h], display, frame)
      ctx.strokeStyle = color
      ctx.lineWidth = width
      ctx.strokeRect(ax, ay, bx - ax, by - ay)
      if (isActive) {
        ;([ax, bx] as const).forEach((x) => ([ay, by] as const).forEach((y) => drawHandleSquare(ctx, x, y)))
      }
    }
  })

  // 拖拽中的实时预览框（覆盖激活框原位，视觉跟随指针）
  if (draggingQuad && activeIndex >= 0 && activeIndex < boxes.length) {
    const pts = draggingQuad.map((p) => toWidget(p, display, frame))
    if (allowRotation) {
      strokePolyline(ctx, pts, COLOR_ACTIVE, 3)
      const rotIdx = rotateHandleIndex(draggingQuad, true)
      pts.forEach((p, vi) => {
        if (vi === rotIdx) drawRotateHandle(ctx, p[0], p[1])
        else drawHandleSquare(ctx, p[0], p[1])
      })
    } else {
      const [x0, y0, w, h] = quadAabb(draggingQuad)
      const [ax, ay] = toWidget([x0, y0], display, frame)
      const [bx, by] = toWidget([x0 + w, y0 + h], display, frame)
      ctx.strokeStyle = COLOR_ACTIVE
      ctx.lineWidth = 3
      ctx.strokeRect(ax, ay, bx - ax, by - ay)
      ;([ax, bx] as const).forEach((x) => ([ay, by] as const).forEach((y) => drawHandleSquare(ctx, x, y)))
    }
  }
}
