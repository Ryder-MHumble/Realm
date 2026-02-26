const en = {
  // Common actions
  common: {
    send: "Send",
    stop: "Stop",
    cancel: "Cancel",
    close: "Close",
    save: "Save",
    create: "Create",
    delete: "Delete",
    rename: "Rename",
    restart: "Restart",
    all: "All",
    skip: "Skip",
  },

  // Command bar / prompt
  commandBar: {
    placeholder: "Prompt...",
    allSessions: "all sessions",
    noZones: "No zones yet",
    noSession: "No session",
    newZone: "New Zone",
    selectSessionHint: "Select a session to send prompts",
  },

  // Activity feed
  feed: {
    title: "Activity",
    you: "You",
    claude: "Claude",
    thinking: "Claude is thinking",
    stopped: "Stopped",
    showContent: "Show content",
    hideContent: "Hide content",
    showMore: "... [show more - Alt+E]",
    jumpToLatest: "Jump to latest",
    emptyTitle: "Waiting for activity",
    emptyDesc: "Start using Claude Code to see events here",
    emptyHint: "Create a zone to get started",
    pattern: "Pattern: {pattern}",
    query: "Query: {query}",
    moreTools: "{n} more tools",
    showDetails: "Show more",
    hideDetails: "Show less",
    noDetails: "No details",
  },

  // Time formatting
  time: {
    justNow: "just now",
    secondsAgo: "{n}s ago",
    minutesAgo: "{n}m ago",
    hoursAgo: "{n}h ago",
    daysAgo: "{n}d ago",
    tokM: "{n}M tok",
    tokK: "{n}k tok",
    tok: "{n} tok",
  },

  // Voice
  voice: {
    listening: "Listening...",
    transcript: "Transcript:",
    error: "Error",
    noSpeech: "No speech detected",
    notSupported: "Voice input not supported in this browser",
    micDenied: "Microphone access denied",
    connectionFailed: "Speech recognition failed",
    sendHint: "to send",
    startVoice: "Start voice input",
    switchLang: "Switch voice language",
    switchToChinese: "Switch to Chinese recognition",
    switchToEnglish: "Switch to English recognition",
  },

  // Modes
  mode: {
    autoEdit: "Auto-edit",
    plan: "Plan",
    askBeforeEdit: "Ask before edit",
    autoEditDesc: "Edits files automatically",
    planDesc: "Plans before making changes",
    askBeforeEditDesc: "Confirms each file change",
    switchMode: "Switch Claude Code mode",
  },

  // New Zone modal
  newZone: {
    title: "New Zone",
    directory: "Directory",
    name: "Name",
    description: "Description",
    descriptionPlaceholder: "What does this zone do? (optional)",
    descriptionHint: "Helps route prompts to the right zone automatically",
    options: "Options",
    namePlaceholder: "Auto-filled from directory...",
    dirPlaceholder: "e.g. /home/user/my-project",
    defaultHint: "Default: ",
    optContinue: "Continue",
    optSkipPerms: "Skip permissions",
    optChrome: "Chrome",
    // Agent type & launch mode
    agentType: "Agent Type",
    launchMode: "Launch Mode",
    localProcess: "Local Process",
    docker: "Docker / Container",
    gateway: "Remote Gateway",
    binaryPath: "Binary / Project Path",
    dockerImage: "Docker Image",
    appleContainer: "Use Apple Container",
    gatewayUrl: "Gateway URL",
    gatewayToken: "Auth Token",
    llmProvider: "LLM Provider",
    useDefault: "Use Default",
    notifications: "Notifications",
  },

  // Settings modal
  settings: {
    title: "Settings",
    tabGeneral: "General",
    tabWorld: "World",
    tabClaw: "Claw",
    tabNotifications: "Notifications",
    tabShortcuts: "Shortcuts",
    clawHint:
      "Configure LLM providers for Claw agents (OpenClaw, NanoClaw, ZeroClaw). Claude Code uses its own API key and does not need this.",
    audio: "Audio",
    volume: "Volume",
    spatialAudio: "Spatial Audio",
    spatialHint: "Volume/pan based on zone position",
    privacy: "Privacy",
    streamingMode: "Streaming Mode",
    streamingHint: "Hide username for privacy",
    world: "World",
    gridSize: "Grid Size",
    gridHint:
      "Number of hex rings from center. Larger = more space, may impact performance.",
    agentConnection: "Agent Connection",
    portHint:
      "Port where the Vibecraft agent is running. Changes require refresh.",
    sessions: "Sessions",
    refreshSessions: "Refresh Sessions",
    keyboardShortcuts: "Keyboard Shortcuts",
    keybindHint:
      "Click a keybind to change it. Press the new key combination, or Escape to cancel.",
    language: "Language",
    // LLM Providers
    llmProviders: "LLM Providers",
    addProvider: "Add Provider",
    providerName: "Name",
    providerType: "Provider",
    providerModel: "Model",
    providerApiKey: "API Key",
    providerBaseUrl: "Base URL",
    providerConfigured: "configured",
    providerNone: "No LLM providers configured",
    // Notification Channels
    notificationChannels: "Notification Channels",
    addChannel: "Add Channel",
    channelPlatform: "Platform",
    channelWebhookUrl: "Webhook URL",
    channelBotToken: "Bot Token",
    channelChatId: "Chat ID",
    channelSecret: "Secret",
    channelTest: "Test",
    channelTestSuccess: "Test message sent!",
    channelTestFailed: "Test failed",
    channelNone: "No notification channels configured",
  },

  // About modal
  about: {
    title: "Vibecraft",
    description: "Vibecraft is a 3D visualization app for Claude Code.",
    subtitle:
      "Watch and manage your claudes in real-time - now featuring hexagonal grids!",
    privacyNote:
      "Vibecraft syncs with claude code instances running on your own machine. No files or code are sent to the web server.",
    commands: "Commands",
    startServer: "Start server",
    diagnoseIssues: "Diagnose issues",
    reinstallHooks: "Reinstall hooks",
    removeHooks: "Remove hooks",
    troubleshooting: "Troubleshooting",
    troubleshootingHelp:
      "If a zone gets stuck, Claude Code may be waiting for input or in an unknown state. Attach to the tmux session to see what's happening:",
    listSessions: "List sessions",
    attachToSession: "Attach to session",
    voiceInput: "Voice Input",
    voiceHelp:
      "Press <kbd>Ctrl+M</kbd> or click the mic button to start voice input. Supports English and Chinese.",
  },

  // Question modal
  question: {
    badge: "Question",
    header: "Claude needs input",
    otherLabel: "Or type your own response:",
    otherPlaceholder: "Type here...",
  },

  // Permission modal
  permission: {
    badge: "Permission Required",
    header: "Allow {tool}?",
  },

  // Zone info modal
  zoneInfo: {
    title: "Zone Info",
    directory: "Directory",
    tmuxSession: "tmux Session",
    created: "Created",
    lastActivity: "Last Activity",
    currentTool: "Current Tool",
    statistics: "Statistics",
    toolsUsed: "Tools Used",
    filesTouched: "Files Touched",
    subagents: "Subagents",
    tokenUsage: "Token Usage",
    currentConversation: "Current Conversation",
    cumulative: "Cumulative (Session)",
    gitStatus: "Git Status",
    notGitRepo: "Not a git repository",
    staged: "Staged",
    unstaged: "Unstaged",
    untracked: "Untracked",
    cleanTree: "Working tree clean",
    lines: "lines",
    identifiers: "Identifiers",
    managedId: "Managed ID",
    claudeSession: "Claude Session",
    andMore: "... and {n} more",
  },

  // Text label modal
  textLabel: {
    title: "Add Label",
    placeholder: "Enter your text here...",
    hint: "Enter to save, Shift+Enter for newline",
  },

  // Zone timeout modal
  zoneTimeout: {
    title: "Zone Not Responding",
    description:
      "The zone is taking longer than expected to start. Claude Code may be stuck or waiting for input.",
    updateHint: "Also ensure your Claude Code is up to date.",
  },

  // Offline / not connected
  offline: {
    banner: "Not connected to local server",
    title: "Vibecraft!",
    description:
      "Vibecraft is a 3D app to watch and manage Claude Code instances.",
    privacyNote:
      "Vibecraft syncs with CC instances running on your local machine. Vibecraft is an interface - no files or code are sent to this server.",
    getStarted: "Get started:",
    reconnect: "Reconnect",
    explore: "Explore",
  },

  // Status messages
  status: {
    restarting: "Restarting {name}...",
    restartedOk: "{name} restarted!",
    restartFailed: "Failed: {error}",
    stopping: "Stopping...",
    stopped: "Stopped!",
    stopFailed: "Stop failed",
    sentTo: "Sent to {name}!",
    sentToClaude: "Sent to Claude!",
    savedTo: "Saved to {path}",
    connectionError: "Connection error",
    sending: "Sending to Claude...",
    failedToSend: "Failed to send",
    usingTool: "Using {tool}...",
    toolComplete: "{tool} complete",
    toolFailed: "{tool} failed",
    processingPrompt: "Processing prompt...",
    idle: "Idle",
    ready: "Ready",
    thinking: "Thinking",
    working: "Working",
    sessionStarted: "Session started",
  },

  // Context menu
  contextMenu: {
    createZone: "Create zone",
    command: "Command",
    mode: "Mode",
    info: "Info",
    renameDepartment: "Rename department",
    removeFromDepartment: "Remove from department",
    addToDepartment: "Add to department...",
    department: "Department {n}",
    deleteZone: "Delete",
    addLabel: "Add label",
    editLabel: "Edit label",
    deleteLabel: "Delete label",
    enterNewName: "Enter new name:",
    confirmDelete: 'Delete session "{name}"?',
  },

  // HUD
  hud: {
    keybindSessions: "sessions",
    keybindAll: "all",
    keybindFocus: "focus",
    keybindDraw: "draw",
    tokensUsed: "Tokens used this session",
  },

  // Draw mode
  draw: {
    label: "DRAW MODE",
    exit: "exit",
    clear: "clear",
    brush: "brush",
    threeD: "3D",
    cyan: "Cyan",
    sky: "Sky",
    blue: "Blue",
    indigo: "Indigo",
    purple: "Purple",
    teal: "Teal",
  },

  // Timeline tooltips
  timeline: {
    finished: "Finished",
    sessionStart: "Session Start",
    prompt: "Prompt",
    notification: "Notification",
  },

  // Station panel names
  station: {
    center: "CENTER",
    bookshelf: "LIBRARY",
    desk: "DESK",
    workbench: "WORKBENCH",
    terminal: "TERMINAL",
    scanner: "SCANNER",
    antenna: "ANTENNA",
    portal: "PORTAL",
    taskboard: "TASKBOARD",
  },

  // File upload
  fileUpload: {
    attach: "Attach files",
    uploading: "Uploading files...",
    uploadFailed: "File upload failed",
  },

  // Tooltips
  tooltip: {
    newZone: "New Zone",
    settings: "Settings",
    aboutVibecraft: "About Vibecraft",
    closeFeed: "Close (Tab)",
    toggleFeed: "Toggle Activity Feed (Tab)",
  },
};

export default en;
