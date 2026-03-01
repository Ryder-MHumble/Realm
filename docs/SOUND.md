# 音效系统

本文档介绍 Realm 的音频架构，包括合成音效和空间音频定位。

## 概述

Realm 使用 **Tone.js** 进行程序化音效合成。无需音频文件——所有音效通过 Web Audio API 实时生成。

```
事件（工具使用、停止等）
    ↓
EventBus 处理器 (soundHandlers.ts)
    ↓
soundManager.play(name, { zoneId })
    ↓
计算空间参数（如为定位音效）
    ↓
通过 Tone.Panner 路由
    ↓
播放合成音效
```

## 文件

| 文件 | 用途 |
|------|------|
| `src/audio/SoundManager.ts` | 音效定义、播放、空间集成 |
| `src/audio/SpatialAudioContext.ts` | 监听器追踪、距离/声像计算 |
| `src/audio/index.ts` | 导出聚合 |
| `src/events/handlers/soundHandlers.ts` | 事件到音效的映射 |

## 音效目录

### 工具音效（10 个）

| 音效 | 触发条件 | 描述 |
|------|---------|------|
| `read` | Read 工具 | 双音正弦波 (A4→C5) |
| `write` | Write 工具 | 三声方波哔声 (E5, E5, G5) |
| `edit` | Edit 工具 | 双声三角波敲击 (E4→G4) |
| `bash` | Bash 工具 | 数据突发 - 5 个快速锯齿波哔声 (C5) |
| `grep` | Grep 工具 | 扫频 + "找到了" 哔声 |
| `glob` | Glob 工具 | grep 的别名 |
| `webfetch` | WebFetch 工具 | 上升琶音 (C5→E5→G5→C6) |
| `websearch` | WebSearch 工具 | webfetch 的别名 |
| `task` | Task 工具 | FM 合成扫频 (C3→C4) |
| `todo` | TodoWrite 工具 | 三声方波勾选 (E4, E4, G4) |

### 工具结果（2 个）

| 音效 | 触发条件 | 描述 |
|------|---------|------|
| `success` | post_tool_use (success=true) | 上升钟声 (C5→G5) |
| `error` | post_tool_use (success=false) | 下降嗡鸣 (A2→F2) |

### 会话事件（4 个）

| 音效 | 触发条件 | 描述 |
|------|---------|------|
| `prompt` | user_prompt_submit | 柔和确认音 (G4→D5) |
| `stop` | stop 事件 | 完成和弦 (E4→G4→C5) |
| `thinking` | Claude 思考状态 | 环境双音 (D4, F4) |
| `notification` | notification 事件 | 双声叮响 (A4, A4) |

### 区域（2 个）

| 音效 | 触发条件 | 描述 |
|------|---------|------|
| `zone_create` | 创建新区域 | 上升交错和弦 (C4→E4→G4→C5) |
| `zone_delete` | 删除区域 | 下降小调 (G4→Eb4→C4→G3) |

### 子代理（2 个）

| 音效 | 触发条件 | 描述 |
|------|---------|------|
| `spawn` | Task 工具启动 | 空灵上升 (C4→G5) |
| `despawn` | Task 工具完成 | 空灵下降 (G4→C3) |

### 角色（1 个）

| 音效 | 触发条件 | 描述 |
|------|---------|------|
| `walking` | Claude 移动到工作站 | 柔和双脚步声 (D4, D4) |

### UI 交互（6 个）

| 音效 | 触发条件 | 描述 |
|------|---------|------|
| `click` | 点击地面 | 柔和弹声 |
| `modal_open` | 弹窗出现 | 柔和上升呼啸 |
| `modal_cancel` | 弹窗关闭 | 下降音 |
| `modal_confirm` | 弹窗确认 | 上升三和弦 |
| `hover` | 六角格悬停 | 基于距离的音调滴答 |
| `focus` | 镜头切换 | 快速呼啸/缩放 |

### 特殊音效（4 个）

| 音效 | 触发条件 | 描述 |
|------|---------|------|
| `git_commit` | Bash 执行 `git commit` | 令人满足的号角 (G→B→D→G + 闪光) |
| `intro` | 应用启动 | 爵士 Cmaj9 和弦绽放 |
| `voice_start` | 开始语音录制 | 上升哔声 (C5→E5) |
| `voice_stop` | 停止语音录制 | 下降哔声 (E5→C5) |

### 绘制模式（1 个）

| 音效 | 触发条件 | 描述 |
|------|---------|------|
| `clear` | 清除所有绘制的六角格 | 下降扫频 |

## 空间音频

音效可以根据其来源区域相对于摄像头的位置在 3D 空间中定位。

### 空间模式

每个音效有一个空间模式：

| 模式 | 行为 | 使用场景 |
|------|------|---------|
| `positional` | 音量/声像受与摄像头距离影响 | 区域特定事件（工具、结果） |
| `global` | 始终居中，满音量 | 庆祝、UI、系统事件 |

### 模式分配

**定位音效**（受距离/声像影响）：
- 所有工具音效：`read`、`write`、`edit`、`bash`、`grep`、`glob`、`webfetch`、`websearch`、`task`、`todo`
- 工具结果：`success`、`error`
- 会话事件：`prompt`、`stop`、`thinking`
- 区域事件：`zone_create`、`zone_delete`
- 子代理：`spawn`、`despawn`
- 角色：`walking`

**全局音效**（始终居中）：
- 特殊：`git_commit`、`intro`
- 系统：`notification`
- UI：`click`、`modal_open`、`modal_cancel`、`modal_confirm`、`hover`、`focus`
- 语音：`voice_start`、`voice_stop`
- 绘制：`clear`

### 空间定位原理

```
1. 触发音效并带有 { zoneId: 'session-123' }
2. 通过 scene.getZoneWorldPosition(zoneId) 解析区域位置
3. 计算与摄像头/监听器的距离
4. 计算相对于摄像头朝向的角度
5. 应用音量衰减和立体声声像
6. 通过 Tone.Panner 节点播放
```

### 音量计算

```javascript
volume = 1 / (1 + distance × 0.025)
volume = max(0.3, volume)  // 不低于 30%

// 聚焦的区域获得增益
if (isFocusedZone) volume × 1.25
```

| 距离 | 音量 |
|------|------|
| 0 | 100% |
| 20 | ~67% |
| 40 | ~50% |
| 100 | ~33% |
| 200+ | ~30%（最低值） |

### 声像计算

```javascript
angle = atan2(dx, dz) - cameraRotation
pan = sin(angle)
pan = clamp(pan, -0.7, 0.7)  // 不完全偏左/偏右
```

### 监听器更新

监听器（摄像头）位置每 100ms 更新一次：

```typescript
// 在 main.ts 中
setInterval(() => {
  soundManager.updateListener(camera.position.x, camera.position.z, camera.rotation.y)
}, 100)
```

### 设置

- **开关**：设置弹窗中的"Spatial Audio"复选框
- **存储**：`localStorage.getItem('realm-spatial-audio')`
- **默认**：启用
- **禁用时**：所有音效以居中方式满音量播放

## 使用方法

### 基本播放

```typescript
import { soundManager } from './audio'

// 初始化（必须由用户操作触发）
await soundManager.init()

// 按名称播放（全局）
soundManager.play('git_commit')

// 带空间定位播放
soundManager.play('bash', { zoneId: 'session-123' })

// 播放工具音效
soundManager.playTool('Read', { zoneId })

// 播放结果音效
soundManager.playResult(success, { zoneId })
```

### 事件处理器集成

```typescript
// 在 soundHandlers.ts 中
eventBus.on('pre_tool_use', (event, ctx) => {
  if (!ctx.soundEnabled) return
  const spatial = ctx.session?.id ? { zoneId: ctx.session.id } : undefined
  soundManager.playTool(event.tool, spatial)
})
```

### 空间音频配置

```typescript
// 连接区域解析器（启动时设置一次）
soundManager.setZonePositionResolver((zoneId) => {
  return scene.getZoneWorldPosition(zoneId)
})

// 连接聚焦区域解析器
soundManager.setFocusedZoneResolver(() => {
  return scene.focusedZoneId
})

// 切换空间音频
soundManager.setSpatialEnabled(false)
```

## 音量级别

音效使用一致的分贝级别：

| 级别 | dB | 使用场景 |
|------|-----|---------|
| `QUIET` | -20 | 背景/环境音 |
| `SOFT` | -16 | 微妙反馈（行走） |
| `NORMAL` | -12 | 标准 UI 反馈 |
| `PROMINENT` | -10 | 重要事件 |
| `LOUD` | -8 | 重大事件 |

## 添加新音效

1. 在 `SoundManager.ts` 中添加音效名到 `SoundName` 类型
2. 在 `SOUND_SPATIAL_MODE` 映射中添加空间模式
3. 在 `TOOL_SOUND_MAP` 中添加工具映射（如果是工具音效）
4. 在 `sounds` 对象中添加音效定义
5. 从对应的事件处理器中调用

示例：

```typescript
// 1. 添加到 SoundName 类型
export type SoundName = ... | 'my_new_sound'

// 2. 添加空间模式
const SOUND_SPATIAL_MODE: Record<SoundName, SpatialMode> = {
  ...
  my_new_sound: 'positional',  // 或 'global'
}

// 3. 添加音效定义
private sounds: Record<SoundName, () => void> = {
  ...
  my_new_sound: () => {
    const synth = this.createDisposableSynth(
      { type: 'sine', attack: 0.01, decay: 0.1, sustain: 0, release: 0.1 },
      VOL.NORMAL
    )
    synth.triggerAttackRelease('C5', '8n')
  },
}
```

## 测试

运行开发服务器时可在 `/test-spatial.html` 访问测试页面。提供：

- 音频上下文初始化按钮
- 空间音频开关
- 位置网格用于测试方向性音频
- 全局音效与定位音效对比

## 设计理念

- **数字主题**：清脆的合成音，快速响应
- **不打扰**：音效是补充，而非干扰
- **始终可闻**：远处的音效较安静（最低 30%），但不会静音
- **微妙声像**：最大 ±0.7，避免刺耳的完全偏左/偏右
- **用户控制**：设置中可切换开关，音量滑块可调
