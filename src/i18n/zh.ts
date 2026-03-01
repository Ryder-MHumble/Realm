const zh = {
  // Common actions
  common: {
    send: "发送",
    stop: "停止",
    cancel: "取消",
    close: "关闭",
    save: "保存",
    create: "创建",
    delete: "删除",
    rename: "重命名",
    restart: "重启",
    all: "全部",
    skip: "跳过",
  },

  // Command bar / prompt
  commandBar: {
    placeholder: "输入提示...",
    allSessions: "所有会话",
    noZones: "暂无区域",
    noSession: "未选择会话",
    newZone: "新建区域",
    selectSessionHint: "选择会话以发送提示",
  },

  // Activity feed
  feed: {
    title: "活动",
    you: "你",
    claude: "Claude",
    thinking: "Claude 正在思考",
    stopped: "已停止",
    showContent: "显示内容",
    hideContent: "隐藏内容",
    showMore: "... [展开更多 - Alt+E]",
    jumpToLatest: "跳转到最新",
    emptyTitle: "等待活动",
    emptyDesc: "开始使用 Claude Code 后事件会显示在这里",
    emptyHint: "创建一个区域以开始",
    pattern: "匹配: {pattern}",
    query: "查询: {query}",
    moreTools: "另有 {n} 个工具",
    showDetails: "展开更多",
    hideDetails: "收起",
    noDetails: "无详情",
    // 生命周期事件
    sessionCleared: "会话已清除",
    sessionLogout: "已登出",
    sessionExited: "会话已退出",
    sessionEnded: "会话已结束",
    sessionStarted: "会话已启动",
    sessionResumed: "会话已恢复",
    sessionRestarted: "会话已重启",
    sessionCompacted: "上下文已压缩",
    compactAuto: "正在自动压缩上下文...",
    compactManual: "正在压缩上下文...",
    autoContinue: "正在自动继续...",
    autoContinueMax: "自动继续已达上限",
  },

  // Time formatting
  time: {
    justNow: "刚刚",
    secondsAgo: "{n}秒前",
    minutesAgo: "{n}分钟前",
    hoursAgo: "{n}小时前",
    daysAgo: "{n}天前",
    tokM: "{n}M tok",
    tokK: "{n}k tok",
    tok: "{n} tok",
  },

  // Voice
  voice: {
    listening: "正在收听...",
    transcript: "转录:",
    error: "错误",
    noSpeech: "未检测到语音",
    notSupported: "此浏览器不支持语音输入",
    micDenied: "麦克风权限被拒绝",
    connectionFailed: "语音识别失败",
    sendHint: "发送",
    startVoice: "开始语音输入",
    switchLang: "切换语音识别语言",
    switchToChinese: "切换为中文识别",
    switchToEnglish: "切换为英文识别",
  },

  // Modes
  mode: {
    autoEdit: "自动编辑",
    plan: "规划",
    askBeforeEdit: "编辑前确认",
    autoEditDesc: "自动编辑文件",
    planDesc: "先规划再修改",
    askBeforeEditDesc: "每次修改前确认",
    switchMode: "切换 Claude Code 模式",
  },

  // New Zone modal
  newZone: {
    title: "新建区域",
    directory: "目录",
    name: "名称",
    description: "描述",
    descriptionPlaceholder: "这个区域做什么？（可选）",
    descriptionHint: "帮助自动将提示路由到正确的区域",
    options: "选项",
    namePlaceholder: "根据目录自动填充...",
    dirPlaceholder: "例如 /home/user/my-project",
    defaultHint: "默认: ",
    optContinue: "继续上次对话",
    optSkipPerms: "跳过权限确认",
    optChrome: "Chrome 浏览器",
    // Agent 类型和启动模式
    agentType: "Agent 类型",
    launchMode: "启动模式",
    localProcess: "本地进程",
    docker: "Docker / 容器",
    gateway: "远程网关",
    binaryPath: "二进制 / 项目路径",
    dockerImage: "Docker 镜像",
    appleContainer: "使用 Apple Container",
    gatewayUrl: "网关地址",
    gatewayToken: "认证令牌",
    llmProvider: "LLM 供应商",
    useDefault: "使用默认",
    notifications: "通知",
  },

  // Settings modal
  settings: {
    title: "设置",
    tabGeneral: "通用",
    tabWorld: "世界",
    tabClaw: "Claw",
    tabShortcuts: "快捷键",
    clawHint:
      "为 Claw 代理（OpenClaw、NanoClaw、ZeroClaw）配置 LLM 供应商。Claude Code 使用自带的 API 密钥，无需此配置。",
    audio: "音频",
    volume: "音量",
    spatialAudio: "空间音效",
    spatialHint: "基于区域位置的音量和声道",
    privacy: "隐私",
    streamingMode: "直播模式",
    streamingHint: "隐藏用户名以保护隐私",
    world: "世界",
    gridSize: "网格大小",
    gridHint: "从中心算起的六角环数。越大空间越多，可能影响性能。",
    agentConnection: "代理连接",
    portHint: "Realm 代理运行的端口。更改后需刷新页面。",
    sessions: "会话",
    refreshSessions: "刷新会话",
    keyboardShortcuts: "快捷键",
    keybindHint: "点击快捷键进行更改。按下新的组合键，或按 Escape 取消。",
    language: "语言",
    // LLM 供应商
    llmProviders: "LLM 供应商",
    addProvider: "添加供应商",
    providerName: "名称",
    providerType: "供应商",
    providerModel: "模型",
    providerApiKey: "API 密钥",
    providerBaseUrl: "API 地址",
    providerConfigured: "已配置",
    providerNone: "暂未配置 LLM 供应商",
  },

  // About modal
  about: {
    title: "Realm",
    description: "Realm 是一个 Claude Code 的 3D 可视化应用。",
    subtitle: "实时观察和管理你的 Claude — 现已支持六角网格！",
    privacyNote:
      "Realm 与你本机上运行的 Claude Code 实例同步。不会将任何文件或代码发送到服务器。",
    commands: "命令",
    startServer: "启动服务器",
    diagnoseIssues: "诊断问题",
    reinstallHooks: "重新安装钩子",
    removeHooks: "移除钩子",
    troubleshooting: "故障排除",
    troubleshootingHelp:
      "如果区域卡住，Claude Code 可能正在等待输入或处于未知状态。连接到 tmux 会话查看情况：",
    listSessions: "列出会话",
    attachToSession: "连接到会话",
    voiceInput: "语音输入",
    voiceHelp:
      "按 <kbd>Ctrl+M</kbd> 或点击麦克风按钮开始语音输入。支持中文和英文。",
  },

  // Question modal
  question: {
    badge: "提问",
    header: "Claude 需要输入",
    otherLabel: "或输入你的回复：",
    otherPlaceholder: "在此输入...",
  },

  // Permission modal
  permission: {
    badge: "需要权限",
    header: "允许 {tool}？",
  },

  // Zone info modal
  zoneInfo: {
    title: "区域信息",
    directory: "目录",
    tmuxSession: "tmux 会话",
    created: "创建时间",
    lastActivity: "最后活动",
    currentTool: "当前工具",
    statistics: "统计",
    toolsUsed: "工具使用次数",
    filesTouched: "涉及文件数",
    subagents: "子代理",
    tokenUsage: "Token 用量",
    currentConversation: "当前对话",
    cumulative: "累计（会话）",
    gitStatus: "Git 状态",
    notGitRepo: "非 Git 仓库",
    staged: "已暂存",
    unstaged: "未暂存",
    untracked: "未跟踪",
    cleanTree: "工作树干净",
    lines: "行",
    identifiers: "标识符",
    managedId: "管理 ID",
    claudeSession: "Claude 会话",
    andMore: "... 以及其他 {n} 个",
  },

  // Text label modal
  textLabel: {
    title: "添加标签",
    placeholder: "在此输入文字...",
    hint: "Enter 保存，Shift+Enter 换行",
  },

  // Zone timeout modal
  zoneTimeout: {
    title: "区域无响应",
    description: "区域启动时间超出预期。Claude Code 可能卡住或正在等待输入。",
    updateHint: "请确保你的 Claude Code 是最新版本。",
  },

  // Offline / not connected
  offline: {
    banner: "未连接到本地服务器",
    title: "Realm!",
    description: "Realm 是一个用于观察和管理 Claude Code 实例的 3D 应用。",
    privacyNote:
      "Realm 与你本机上运行的 CC 实例同步。Realm 只是一个界面 — 不会向服务器发送任何文件或代码。",
    getStarted: "开始使用：",
    reconnect: "重新连接",
    explore: "探索",
  },

  // Status messages
  status: {
    restarting: "正在重启 {name}...",
    restartedOk: "{name} 已重启！",
    restartFailed: "失败: {error}",
    stopping: "正在停止...",
    stopped: "已停止！",
    stopFailed: "停止失败",
    sentTo: "已发送到 {name}！",
    sentToClaude: "已发送到 Claude！",
    savedTo: "已保存到 {path}",
    connectionError: "连接错误",
    sending: "正在发送到 Claude...",
    failedToSend: "发送失败",
    usingTool: "正在使用 {tool}...",
    toolComplete: "{tool} 完成",
    toolFailed: "{tool} 失败",
    processingPrompt: "正在处理提示...",
    idle: "空闲",
    ready: "就绪",
    thinking: "思考中",
    working: "工作中",
    sessionStarted: "会话已开始",
  },

  // Context menu
  contextMenu: {
    createZone: "创建区域",
    command: "命令",
    mode: "模式",
    info: "信息",
    renameDepartment: "重命名部门",
    removeFromDepartment: "从部门中移除",
    addToDepartment: "添加到部门...",
    department: "部门 {n}",
    deleteZone: "删除",
    addLabel: "添加标签",
    editLabel: "编辑标签",
    deleteLabel: "删除标签",
    enterNewName: "输入新名称：",
    confirmDelete: '删除会话 "{name}"？',
  },

  // HUD
  hud: {
    keybindSessions: "会话",
    keybindAll: "全部",
    keybindFocus: "聚焦",
    keybindDraw: "绘制",
    tokensUsed: "本次会话使用的 Token",
  },

  // Draw mode
  draw: {
    label: "绘制模式",
    exit: "退出",
    clear: "清除",
    brush: "画笔",
    threeD: "3D",
    cyan: "青色",
    sky: "天蓝",
    blue: "蓝色",
    indigo: "靛蓝",
    purple: "紫色",
    teal: "蓝绿",
  },

  // Timeline tooltips
  timeline: {
    finished: "已完成",
    sessionStart: "会话开始",
    prompt: "提示",
    notification: "通知",
  },

  // Station panel names
  station: {
    center: "中心",
    bookshelf: "书架",
    desk: "书桌",
    workbench: "工作台",
    terminal: "终端",
    scanner: "扫描仪",
    antenna: "天线",
    portal: "传送门",
    taskboard: "任务板",
  },

  // File upload
  fileUpload: {
    attach: "附加文件",
    uploading: "正在上传文件...",
    uploadFailed: "文件上传失败",
  },

  // Tooltips
  tooltip: {
    newZone: "新建区域",
    settings: "设置",
    aboutRealm: "关于 Realm",
    closeFeed: "关闭 (Tab)",
    toggleFeed: "切换活动面板 (Tab)",
  },
};

export default zh;
