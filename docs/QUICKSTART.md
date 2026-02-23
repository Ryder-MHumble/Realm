# Vibecraft 快速开始

## 太长不看版

```bash
# 安装依赖（macOS）
brew install jq tmux

# 配置 hook（仅需一次）
npx vibecraft setup

# 运行
npx vibecraft
```

打开 http://localhost:4003，然后正常使用 Claude 即可。

---

## 遇到问题？

| 问题 | 解决方案 |
|------|---------|
| "jq not found" | `brew install jq` 或 `apt install jq` |
| "Agent Not Connected" | `npx vibecraft` 是否在运行？是否已执行 `setup`？ |
| 没有事件显示 | 配置完成后重启 Claude Code |
| 端口错误 | 默认端口为 4003，检查你的 URL |

## 完整指南

请查看 [SETUP.md](./SETUP.md)
