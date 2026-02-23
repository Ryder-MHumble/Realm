# 存储架构

本文档介绍 Vibecraft 的数据存储位置及设计原因。

## 概述

Vibecraft 使用两个存储位置：

1. **localStorage**（浏览器端）— 用户偏好设置和离线可用内容
2. **服务器文件**（`~/.vibecraft/data/`）— 共享状态和服务器管理的数据

## localStorage（浏览器端）

| 键名 | 数据 | 类型 |
|------|------|------|
| `vibecraft-selected-session` | 当前选中的会话 ID | UI 状态 |
| `vibecraft-volume` | 音量 (0-100) | 用户偏好 |
| `vibecraft-spatial-audio` | 空间音频是否启用 (true/false) | 用户偏好 |
| `vibecraft-grid-size` | 世界网格大小 (5-80 六角环) | 用户偏好 |
| `vibecraft-agent-port` | 自定义服务器端口覆盖 | 用户配置 |
| `vibecraft-keybinds` | 自定义键盘绑定 | 用户偏好 |
| `vibecraft-hexart` | 绘制的六角格数据 `[{q, r, color, height}]` | 创意内容 |
| `vibecraft-collapsed-groups` | 折叠的部门 ID 列表 `["group-1", ...]` | UI 状态 |

### 优点
- **即时** — 无网络延迟
- **离线可用** — 无需服务器
- **无需服务端代码** — 实现简单
- **浏览器隔离** — 适合个人偏好设置

### 缺点
- **清除即丢失** — 浏览器数据清除会删除它
- **不能同步** — 不能跨设备/浏览器传输
- **5MB 限制** — 通常够用，但有上限

### 数据格式

**六角格艺术（`vibecraft-hexart`）：**
```json
[
  { "q": 0, "r": 0, "color": 2281966, "height": 0.5 },
  { "q": 1, "r": -1, "color": 3718647, "height": 1.0 }
]
```

**键盘绑定（`vibecraft-keybinds`）：**
```json
{
  "focus-toggle": { "key": "Tab", "alt": false, "ctrl": false, "shift": false }
}
```

## 服务器文件（`~/.vibecraft/data/`）

| 文件 | 数据 | 管理者 |
|------|------|--------|
| `events.jsonl` | Claude Code 事件日志（追加写入） | Hook 脚本 |
| `sessions.json` | 托管会话（tmux、目录、关联） | `server/index.ts` |
| `tiles.json` | 文本标签瓷砖 | `server/index.ts` |
| `groups.json` | 部门分组（成员、颜色、名称） | `server/index.ts` |
| `pending-prompt.txt` | 排队中的 prompt（可选） | `server/index.ts` |

### 优点
- **跨浏览器持久化** — 从任何浏览器打开，数据相同
- **共享状态** — 多个标签页看到相同数据
- **不受清除影响** — 浏览器数据清除不影响它
- **服务器可操作** — 服务器管理 tmux 进程，广播更新

### 缺点
- **依赖服务器** — 必须有 vibecraft 服务器运行
- **网络延迟** — 比 localStorage 稍慢
- **更多代码** — 需要 API 端点、WebSocket 同步

### 数据格式

**会话（`sessions.json`）：**
```json
{
  "sessions": [
    {
      "id": "managed-1",
      "name": "frontend",
      "directory": "/home/user/project",
      "tmuxName": "claude-1",
      "claudeSessionId": "abc123",
      "status": "idle"
    }
  ],
  "claudeToManagedMap": {
    "abc123": "managed-1"
  },
  "sessionCounter": 1
}
```

**文本标签瓷砖（`tiles.json`）：**
```json
[
  {
    "id": "uuid-here",
    "text": "My Label",
    "position": { "q": 0, "r": 0 },
    "color": "#22d3ee",
    "createdAt": 1705123456789
  }
]
```

**事件（`events.jsonl`）：**
```jsonl
{"type":"pre_tool_use","tool":"Read","toolUseId":"123","timestamp":1705123456789,"sessionId":"abc"}
{"type":"post_tool_use","tool":"Read","toolUseId":"123","success":true,"duration":150,"timestamp":1705123456939,"sessionId":"abc"}
```

**部门分组（`groups.json`）：**

```json
[
  {
    "id": "group-uuid",
    "name": "Frontend Team",
    "memberSessionIds": ["managed-1", "managed-3", "managed-5"],
    "color": "#60a5fa",
    "createdAt": 1705123456789
  }
]
```

## 选择指南

| 如果数据... | 使用 | 示例 |
|------------|------|------|
| 是用户个人偏好 | localStorage | 音量、键盘绑定 |
| 需要离线可用 | localStorage | 六角格艺术 |
| 必须跨浏览器标签页同步 | 服务器文件 | 文本标签瓷砖 |
| 服务器需要操作它 | 服务器文件 | 会话（tmux） |
| 由外部进程生成 | 服务器文件 | 事件（来自 hook） |

## 未来：账户系统迁移

添加用户账户时：

1. **localStorage 保持不变**用于离线/访客模式
2. **服务器文件变为按账户存储**在数据库或云存储中
3. **登录时**：将 localStorage 数据上传作为初始账户状态
4. **登录后**：服务器成为数据源，localStorage 作为缓存

当前数据格式设计为 API 就绪：
- 六角格艺术：`POST /api/hexart`，数据格式 `[{q, r, color, height}]`
- 文本瓷砖已有服务器 API：`GET/POST/PUT/DELETE /tiles`

## 相关文件

- `src/main.ts` — localStorage 读写（六角格艺术、音量、会话选择）
- `src/ui/KeybindConfig.ts` — localStorage 存储键盘绑定
- `server/index.ts` — 服务器文件管理、API 端点
- `shared/types.ts` — 所有数据结构的 TypeScript 类型
