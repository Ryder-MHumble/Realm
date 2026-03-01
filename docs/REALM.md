# Realm — AI Workforce for Small Teams

> "Your AI team, always working."

## 产品定位

Realm 基于 Realm 迭代，将 3D 可视化能力从「观察一个 Claude Code」扩展为「管理一个 AI 团队」。面向 2-10 人的小型创业团队，用虚拟办公室的产品形态让用户像老板一样管理多个 AI 员工。

**核心赌注**：AI agent 的管理界面比 agent 能力本身更具产品化价值。

## 产品决策

| 决策项 | 选择 |
|--------|------|
| 产品名 | Realm |
| Slogan | "Your AI team, always working." |
| 目标用户 | 小型创业团队 (2-10 人) |
| 技术路径 | 基于 Realm 迭代 |
| 3D 风格 | 虚拟办公室 |
| 商业化 | 先做爆款 demo 视频 → waitlist → 内测 → 公开发布 |
| 汇报系统 | IM 频道（日常交互）+ 3D 晨会（仪式感 + demo 亮点）|
| AI 角色 | Engineer, Marketer, Designer, Analyst |

## AI 角色体系

| 角色 | 专长 | 颜色 | MVP 优先级 |
|------|------|------|-----------|
| AI Engineer | 写代码、调试、部署 | 蓝色 (#60a5fa) | P0 |
| AI Marketer | 竞品分析、文案、SEO | 琥珀色 (#fbbf24) | P1 |
| AI Designer | UI 方案、素材生成 | 紫色 (#c084fc) | P2 |
| AI Analyst | 数据处理、报告生成 | 绿色 (#34d399) | P1 |

## 技术架构

### 从 Realm 到 Realm 的演进

```
Realm (当前):
  Claude Code → Hook → WS Server (本地) → Browser 3D

Realm (目标):
  Browser 3D (托管, 虚拟办公室场景)
       ↕ WebSocket
  Realm Server (云端)
       ├── Agent Orchestrator (多 agent 生命周期管理)
       ├── Task Decomposer (目标拆解 + 分配)
       ├── Report Generator (定时汇总 + 晨会内容)
       ├── IM System (频道消息管理)
       ├── Event Stream → 3D visualization
       └── Progress DB (PostgreSQL)
```

### Realm 组件复用

**直接复用**：
- `src/scene/WorkshopScene.ts` — 3D 场景基础
- `src/entities/ClaudeMon.ts` — Agent 角色渲染（已添加视觉变体）
- `src/events/EventBus.ts` — 事件分发架构
- `src/audio/SoundManager.ts` — 音效系统
- `src/ui/FeedManager.ts` — 可改造为 IM 频道
- `src/events/EventClient.ts` — WebSocket 客户端
- `shared/types.ts` — 事件类型（已扩展）

**新增模块**：
- `src/ui/IMChannel.ts` — IM 频道 UI 组件
- `src/demo/DemoOrchestrator.ts` — Demo 场景编排器
- `src/demo/TaskDecomposition.ts` — 任务拆解动画

## 已完成的实现

### 1. 角色变体系统

**修改文件**：
- `shared/types.ts` — 新增 `RealmRole`, `RoleConfig`, `REALM_ROLES`
- `src/entities/ICharacter.ts` — 添加 `role`, `displayName`, `taskLabel` 到 `CharacterOptions`
- `src/entities/ClaudeMon.ts` — 角色感知的颜色系统、名字标签、任务标签
- `src/entities/Claude.ts` — 兼容性修复

**功能**：
- 4 种角色各有独立配色（身体、眼睛、天线、光环、思考气泡）
- Canvas 精灵渲染的头顶名字标签（圆角矩形 + 角色色彩边框）
- 动态任务标签，可通过 `setTaskLabel()` 实时更新

### 2. IM 频道 UI

**新增文件**：
- `src/ui/IMChannel.ts` — 团队聊天组件
- `src/styles/im-channel.css` — 聊天样式

**修改文件**：
- `index.html` — 添加 `#panel-tabs` 和 `#im-channel-wrapper`
- `src/styles/index.css` — 导入 im-channel.css
- `src/main.ts` — 初始化 IMChannel + 面板切换逻辑

**功能**：
- 5 个频道: #general, #engineering, #marketing, #design, #analytics
- 消息类型: 更新、交付物（绿色徽章）、提问（黄色徽章）、系统消息
- 附件芯片（文件、图片、链接）
- 自动滚动 + 未读指示器
- `runDemoSequence()` — 12 条脚本消息演示 v2.0 发布流程

### 3. 虚拟办公室场景

**新增文件**：
- `src/demo/DemoOrchestrator.ts` — 场景编排器

**功能**：
- 4 个角色工位（2×2 网格排列，每个 zone 用角色色彩标识）
- 中央会议室（会议桌 + 白板 + 落地支架 + 地面标记环 + 标签）
- `setupOffice()` — 创建完整办公室场景
- `gatherForMeeting()` — 角色聚集到会议室
- `dismissMeeting()` — 角色返回工位
- `agentWorkAt(role, station)` — 角色移动到指定工位
- `setAgentTask(role, text)` — 设置角色头顶任务标签

### 4. 任务拆解动画

**新增文件**：
- `src/demo/TaskDecomposition.ts` — 卡片飞行动画

**功能**：
- Canvas 渲染的任务卡片（角色色彩边框 + 角色 emoji + 任务文字）
- 弧形飞行路径（ease-out-cubic 插值）
- 交错启动（每张卡延迟 150ms）
- 到达后淡出 + 上浮消失
- 12 张预设 demo 任务（涵盖 4 个角色）

### 5. 晨会场景

集成在 `DemoOrchestrator.ts` 中：
- 角色依次走到会议室围坐
- 每个角色轮流「汇报」（切换到 working 状态 + 任务标签显示汇报主题）
- 汇报完毕后全员回到 thinking 状态

## Demo 使用方式

在浏览器控制台中：

```javascript
// 创建办公室（4 个角色 + 会议室）
demo.setupOffice()

// 运行完整 demo 序列
demo.runDemoSequence()

// 单独触发任务拆解动画
demo.decomposeTask()

// 单独触发晨会
demo.gatherForMeeting()

// 打散会议
demo.dismissMeeting()

// 控制单个角色
demo.agentWorkAt('engineer', 'terminal')
demo.setAgentTask('marketer', 'Writing press release')
```

## Demo 视频脚本

```
[0:00-0:05] 黑屏: "You have a 3-person startup."
[0:05-0:10] "You need a marketer, a designer, and a data analyst."
[0:10-0:13] "You can't afford them."
[0:13-0:15] "Until now."

[0:15-0:25] 3D 虚拟办公室渐入，4 个角色在各自工位
            → demo.setupOffice()

[0:25-0:35] 用户输入: "Prepare everything for our v2.0 launch next Tuesday"
            → demo.decomposeTask() (卡片飞向角色)

[0:35-0:50] 快镜头: 各角色在办公室忙碌 + IM 频道消息滚动
            → phaseStartWorking + phaseAgentsWorking + IM messages

[0:50-0:55] 时钟快转 → "8 hours later..."

[0:55-1:05] 3D 晨会场景: 角色聚在会议室
            → demo.gatherForMeeting() + 依次汇报

[1:05-1:10] IM 频道: 用户点 "Approve" 批准 Marketer 的文案

[1:10-1:15] 回到 3D 办公室全景

[1:15-1:20] "Realm" logo + "Your AI team, always working."
[1:20-1:25] "Join the waitlist → getrealm.ai"
```

## 市场策略

### Phase 1: Demo → Waitlist
1. 制作 60-90 秒 demo 视频
2. 发布: Twitter/X, HN, Reddit, Product Hunt, 即刻
3. Waitlist 落地页: getrealm.ai
4. 目标: 10K+ signups

### Phase 2: Invite-only 内测
1. 100 个小团队内测
2. 至少 2 个可用 agent（Engineer + Marketer）
3. Discord 社区 + 反馈收集

### Phase 3: Public Launch
1. Product Hunt launch
2. 订阅制: Free ($0, 1 agent) / Starter ($49, 3 agents) / Team ($149, 6 agents)
3. 按角色数 × 任务数计费（不按 token）

## 风险

| 风险 | 缓解 |
|------|------|
| LLM 成本高 | 模型分级 + 缓存 + 休眠 |
| Agent 可靠性 | 关键任务需审批 + 重试机制 |
| 竞品 (Lindy 等) | 3D 可视化 + 晨会是独有差异化 |
| 3D 被视为 gimmick | demo 必须展示实际效率提升 |
| 本地到云端迁移复杂 | 分步：先 demo → 再云端 MVP |

## 下一步

- [ ] 录制 demo 视频（使用控制台命令编排场景）
- [ ] Waitlist 落地页 (getrealm.ai)
- [ ] Agent 后端（Claude API + Agent SDK）
- [ ] 真实任务执行沙箱
- [ ] 用户认证系统
- [ ] 云端部署
