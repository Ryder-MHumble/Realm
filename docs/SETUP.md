# Realm 安装指南

完整的安装和故障排除指南。

## 什么是 Realm？

Realm 将 Claude Code 的活动实时可视化为 3D 工作坊。当 Claude 使用工具（Read、Edit、Bash 等）时，角色会移动到对应的工作站。

**两个组成部分：**
1. **Hook** — 捕获 Claude Code 的事件
2. **服务器** — WebSocket 服务器 + 3D 浏览器可视化

```
┌─────────────────┐      hooks       ┌─────────────────┐
│  Claude Code    │ ───────────────→ │  Realm      │
│  （你的 CLI）    │                  │  服务器 (:4003)  │
└─────────────────┘                  └────────┬────────┘
                                              │
                                              ↓ WebSocket
                                     ┌─────────────────┐
                                     │  浏览器          │
                                     │  （3D 场景）      │
                                     └─────────────────┘
```

---

## 快速开始（3 步）

### 第 1 步：安装依赖

```bash
# macOS
brew install jq tmux

# Ubuntu/Debian
sudo apt install jq tmux

# Arch
pacman -S jq tmux
```

### 第 2 步：配置 Hook

```bash
npx realm setup
```

这会自动将 hook 添加到 `~/.claude/settings.json`。

### 第 3 步：启动服务器并使用 Claude

```bash
# 终端 1：启动 Realm 服务器
npx realm

# 终端 2：正常使用 Claude Code
claude
```

在浏览器中打开 http://localhost:4003。

**搞定！** 每当 Claude 使用工具时，你都会在 3D 可视化中看到它。

---

## 前置依赖说明

| 依赖 | 是否必需？ | 用途 |
|------|-----------|------|
| **Node.js 18+** | 是 | 运行服务器 |
| **jq** | 是 | Hook 脚本中的 JSON 处理 |
| **tmux** | 可选 | 会话管理，浏览器→Claude 发送 prompt |

**检查是否已安装：**
```bash
node --version   # 应该是 18+
jq --version     # 应该输出版本号
tmux -V          # 应该输出版本号（可选）
```

---

## Hook 配置选项

### 方式 A：自动配置（推荐）

```bash
npx realm setup
```

这会：
- 将 hook 脚本复制到 `~/.realm/hooks/realm-hook.sh`
- 创建 `~/.realm/data/` 目录
- 在 `~/.claude/settings.json` 中配置全部 8 个 hook
- 备份现有配置
- 检查 jq/tmux 是否已安装

**配置完成后，重启 Claude Code 使 hook 生效。**

### 方式 B：手动配置

如果你偏好手动配置 hook，在 `~/.claude/settings.json` 中添加：

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "*", "hooks": [{"type": "command", "command": "HOOK_PATH", "timeout": 5}] }
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [{"type": "command", "command": "HOOK_PATH", "timeout": 5}] }
    ],
    "Stop": [
      { "hooks": [{"type": "command", "command": "HOOK_PATH", "timeout": 5}] }
    ],
    "SubagentStop": [
      { "hooks": [{"type": "command", "command": "HOOK_PATH", "timeout": 5}] }
    ],
    "SessionStart": [
      { "hooks": [{"type": "command", "command": "HOOK_PATH", "timeout": 5}] }
    ],
    "SessionEnd": [
      { "hooks": [{"type": "command", "command": "HOOK_PATH", "timeout": 5}] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{"type": "command", "command": "HOOK_PATH", "timeout": 5}] }
    ],
    "Notification": [
      { "hooks": [{"type": "command", "command": "HOOK_PATH", "timeout": 5}] }
    ]
  }
}
```

将 `HOOK_PATH` 替换为以下命令的输出：
```bash
npx realm --hook-path
```

**注意：** 你还需要将 hook 脚本复制到一个稳定位置，并确保 `~/.realm/data/` 目录存在。

---

## "Agent Not Connected" 的含义

如果你在浏览器中看到此提示：

```
┌──────────────────────────────────┐
│                                  │
│     🔌 Agent Not Connected       │
│                                  │
│  Realm 需要本地 agent        │
│  运行以接收事件。                 │
│                                  │
│       [ npx realm ]          │
│                                  │
└──────────────────────────────────┘
```

**这意味着以下情况之一：**

| 问题 | 解决方案 |
|------|---------|
| 服务器未运行 | 在终端中运行 `npx realm` |
| 端口错误 | 检查 URL 是否匹配服务器端口（默认：4003） |
| Hook 未配置 | 运行 `npx realm setup` |

**快速测试：**
```bash
# 检查服务器是否在运行
curl http://localhost:4003/health
# 应该返回：{"ok":true,...}
```

---

## 从浏览器发送 Prompt

要从 Realm UI 向 Claude 发送 prompt：

### 第 1 步：在 tmux 中运行 Claude

```bash
# 创建命名的 tmux 会话
tmux new -s claude

# 在 tmux 中启动 Claude
claude
```

### 第 2 步：正常使用 Realm

```bash
# 在另一个终端中
npx realm
```

### 第 3 步：发送 prompt

在浏览器中，在 prompt 输入框中输入内容，勾选"Send to tmux"后点击"Send"。

**注意：** 如果你的 tmux 会话名称不是 `claude`：
```bash
REALM_TMUX_SESSION=myname npx realm
```

---

## 常见问题

### "jq: command not found"

```bash
# macOS
brew install jq

# Ubuntu/Debian
sudo apt install jq

# Arch
pacman -S jq
```

### Hook 脚本"Permission denied"

```bash
chmod +x $(npx realm --hook-path)
```

### 事件不显示

**1. 检查服务器是否在运行：**
```bash
curl http://localhost:4003/health
```

**2. 检查 hook 是否已配置：**
```bash
cat ~/.claude/settings.json | grep realm
```

**3. 重启 Claude Code**（hook 在启动时加载）

### "Can't connect to tmux session"

```bash
# 列出会话
tmux list-sessions

# 默认会话名称是 'claude'
# 如果不同，设置环境变量：
REALM_TMUX_SESSION=yourname npx realm
```

### 事件重复出现

你可能配置了重复的 hook。检查 `~/.claude/settings.json` 中是否有重复的 realm-hook 条目并删除多余的。然后运行 `npx realm setup` 确保配置正确。

### 浏览器显示"Disconnected"

- 刷新页面
- 检查服务器是否仍在运行
- 查看浏览器控制台的错误信息

---

## 语音输入（可选）

如需语音转文字 prompt 功能：

1. 在 [deepgram.com](https://deepgram.com) 注册
2. 创建 API 密钥
3. 添加到你的 `.env` 文件：
   ```bash
   DEEPGRAM_API_KEY=your_api_key_here
   ```
4. 重启服务器
5. 按 `Alt+S` 或点击麦克风图标

---

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `REALM_PORT` | `4003` | 服务器端口 |
| `REALM_TMUX_SESSION` | `claude` | 用于发送 prompt 的 tmux 会话 |
| `REALM_DEBUG` | `false` | 详细日志 |
| `DEEPGRAM_API_KEY` | （无） | Deepgram 语音输入 API 密钥 |

示例：
```bash
REALM_PORT=4005 REALM_DEBUG=true npx realm
```

---

## 开发环境搭建

如需贡献代码或修改：

```bash
# 克隆
git clone https://github.com/nearcyan/realm
cd realm

# 安装依赖
npm install

# 启动开发服务器（前端 :4002，API :4003）
npm run dev

# 打开浏览器
open http://localhost:4002
```

**注意：** 开发模式下，前端和 API 运行在不同端口。生产环境（`npx realm`）一切都在 4003 端口运行。

---

## 卸载

移除 Realm hook（保留事件数据）：

```bash
npx realm uninstall
```

这会：
- 从 `~/.claude/settings.json` 中移除 realm hook
- 从 `~/.realm/hooks/` 中移除 hook 脚本
- **保留**你在 `~/.realm/data/` 中的数据
- 不影响你可能配置的其他 hook

要完全删除所有数据：

```bash
rm -rf ~/.realm
```

**卸载后重启 Claude Code 使更改生效。**

---

## 获取帮助

- **GitHub Issues:** https://github.com/nearcyan/realm/issues
- **技术文档：** 参见 [CLAUDE.md](../CLAUDE.md)
- **编排系统：** 参见 [ORCHESTRATION.md](./ORCHESTRATION.md)
