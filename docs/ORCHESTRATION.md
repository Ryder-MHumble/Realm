# Vibecraft 编排系统

编排系统让你可以从一个 Web 界面运行多个 Claude Code 实例，并向每个实例分配工作。

## 快速开始

1. 启动 vibecraft 服务器：`npm run server`
2. 打开 Web 界面
3. 在会话面板中点击 **"+ New"** 来创建一个 Claude 实例
4. 点击某个会话将其设为当前 prompt 目标
5. 输入 prompt 并发送——它会被发送到选中的会话

## 核心概念

### 托管会话（Managed Sessions）

**托管会话**是 vibecraft 创建并管理的 Claude Code 实例：

- 拥有用户友好的名称（"Frontend"、"Tests" 等）
- 跟踪状态：`idle`（空闲）、`working`（工作中）、`offline`（离线）
- 工作时显示当前使用的工具
- 可以从 Web 界面接收 prompt

### 传统模式（Legacy Mode）

如果你在名为 `claude` 的 tmux 会话中运行 Claude Code（默认行为），vibecraft 可以观察并向其发送 prompt，但它不会出现在托管会话列表中。这就是"传统模式"——可以正常工作，但不属于编排系统的一部分。

## 系统架构

```
┌──────────────────────────────────────────────────────────────┐
│                      Vibecraft 服务器                          │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐          │
│  │   会话 1    │  │   会话 2    │  │   会话 3    │  ...     │
│  │ "Frontend"  │  │   "Tests"   │  │  "Refactor" │          │
│  │             │  │             │  │             │          │
│  │ tmux:       │  │ tmux:       │  │ tmux:       │          │
│  │ vibecraft-   │  │ vibecraft-   │  │ vibecraft-   │          │
│  │ a1b2c3d4    │  │ e5f6g7h8    │  │ i9j0k1l2    │          │
│  └─────────────┘  └─────────────┘  └─────────────┘          │
│                                                              │
│  WebSocket：向 UI 广播会话更新                                 │
│  REST API：创建、列出、更新、删除会话                           │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────┐
│                       Web 界面                                │
│                                                              │
│  ┌─────────────────────────────────┐                         │
│  │ 会话列表              [+ 新建]  │                         │
│  │ ┌─────────────────────────────┐ │                         │
│  │ │ ● Frontend        ✏️ 🗑️     │ │  ← 点击选择             │
│  │ │   就绪                      │ │                         │
│  │ ├─────────────────────────────┤ │                         │
│  │ │ ◐ Tests           ✏️ 🗑️     │ │  ← 工作中               │
│  │ │   正在使用 Bash              │ │                         │
│  │ └─────────────────────────────┘ │                         │
│  └─────────────────────────────────┘                         │
│                                                              │
│  Prompt: [________________________] [发送]                   │
│          → Frontend                                          │
└──────────────────────────────────────────────────────────────┘
```

## REST API

### 获取会话列表
```bash
GET /sessions

# 响应
{
  "ok": true,
  "sessions": [
    {
      "id": "uuid",
      "name": "Frontend",
      "tmuxSession": "vibecraft-a1b2c3d4",
      "status": "idle",
      "createdAt": 1234567890,
      "lastActivity": 1234567890,
      "cwd": "/path/to/project"
    }
  ]
}
```

### 创建会话
```bash
POST /sessions
Content-Type: application/json

{"name": "Frontend"}  # name 可选，默认为 "Claude N"

# 响应
{
  "ok": true,
  "session": { ... }
}
```

### 重命名会话
```bash
PATCH /sessions/:id
Content-Type: application/json

{"name": "新名称"}

# 响应
{
  "ok": true,
  "session": { ... }
}
```

### 删除会话
```bash
DELETE /sessions/:id

# 响应
{"ok": true}
```

### 向会话发送 Prompt
```bash
POST /sessions/:id/prompt
Content-Type: application/json

{"prompt": "为登录功能编写测试"}

# 响应
{"ok": true}
```

### 取消会话（Ctrl+C）
```bash
POST /sessions/:id/cancel

# 响应
{"ok": true}
```

## WebSocket 消息

服务器通过 WebSocket 广播会话更新：

```typescript
// 完整会话列表（连接时和变更后发送）
{ type: 'sessions', payload: ManagedSession[] }

// 单个会话更新
{ type: 'session_update', payload: ManagedSession }
```

## 会话状态

| 状态 | 含义 |
|------|------|
| `idle` | 就绪，可接收 prompt，当前未在工作 |
| `working` | 正在执行工具（显示具体工具名称） |
| `offline` | tmux 会话已终止或被外部关闭 |

## Hook 集成

为了让托管会话能将事件上报给 vibecraft，需要全局配置 Claude Code 的 hook。Hook 会将事件发送到 vibecraft 服务器，服务器随后：

1. 更新会话的 `status`（状态）和 `currentTool`（当前工具）
2. 向所有已连接的 UI 客户端广播更新
3. 在 3D 可视化场景中展示活动

## 部门分组（Department Grouping）

多个会话可以组成"部门"，类似于《文明6》中的军团编组机制。

### 创建部门
- **拖拽**：在 3D 场景中将一个 zone 拖到另一个上方
- **右键菜单**：对未分组的 zone 右键 → "Add to department..." → 选择现有部门
- **自动合并**：如果拖拽的 zone 已属于某个部门，新 zone 会自动加入该部门

### 管理部门
- **重命名**：右键 zone → "Rename department" 或侧边栏部门标题 ✏️ 按钮
- **移除成员**：右键 zone → "Remove from department"（仅移除该 zone，部门保留）
- **解散部门**：侧边栏部门标题 🗑️ 按钮（所有成员变为未分组）
- **折叠/展开**：点击侧边栏部门标题切换成员显示
- **聚焦视角**：双击侧边栏部门标题，镜头飞到部门质心

### API

| 方法 | 端点 | 说明 |
|------|------|------|
| GET | `/groups` | 获取所有部门 |
| POST | `/groups` | 创建部门（自动合并已有部门） |
| PATCH | `/groups/:id` | 更新部门（添加/移除成员、重命名、改色） |
| DELETE | `/groups/:id` | 解散部门 |

### 3D 可视化
- 部门边界以凸包（convex hull）轮廓线呈现
- 半透明地面染色标识部门领地
- 部门名称标签悬浮于质心上方

## 未来规划

- **模板**：预配置的会话类型（"测试运行器"、"代码审查员"）
- **工作流**：跨多个会话串联 prompt
- **自动扩展**：根据工作负载自动创建会话
