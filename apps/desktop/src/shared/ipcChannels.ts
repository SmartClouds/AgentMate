export const IPC = {
  app: {
    getVersion: 'app:getVersion',
    checkForUpdates: 'app:checkForUpdates',
    downloadUpdate: 'app:downloadUpdate',
    pauseDownload: 'app:pauseDownload',
    quitAndInstall: 'app:quitAndInstall',
    onUpdateStatus: 'app:onUpdateStatus',
    relaunch: 'app:relaunch',
    /** main -> the app window: show this route (a deep link from the pet or a tray click). */
    onNavigate: 'app:navigate',
    /** The renderer collecting a route that arrived while the window was still loading. */
    pendingNavigate: 'app:pendingNavigate',
    /** The app window reporting the page it is on, so the next launch can open there. */
    setLastRoute: 'app:setLastRoute',
    /** main -> the app window: sessions are still open, ask before closing the app. */
    onConfirmQuit: 'app:confirmQuit',
    /** The renderer's answer to onConfirmQuit. */
    answerQuit: 'app:answerQuit',
    /** The app window saying its first page has loaded, so the splash can hand over. */
    rendererReady: 'app:rendererReady',
  },
  backup: {
    export: 'backup:export',
    open: 'backup:open',
    restore: 'backup:restore',
  },
  blueprints: {
    get: 'blueprints:get',
    updateSection: 'blueprints:updateSection',
    setFinalPrompt: 'blueprints:setFinalPrompt',
    setDocsFolder: 'blueprints:setDocsFolder',
    setConfirmBeforeWriting: 'blueprints:setConfirmBeforeWriting',
    pickAttachments: 'blueprints:pickAttachments',
    addAttachment: 'blueprints:addAttachment',
    renameAttachment: 'blueprints:renameAttachment',
    removeAttachment: 'blueprints:removeAttachment',
    attachmentPath: 'blueprints:attachmentPath',
    listRevisions: 'blueprints:listRevisions',
    agentFileTarget: 'blueprints:agentFileTarget',
    syncAgentFile: 'blueprints:syncAgentFile',
    listPresets: 'blueprints:listPresets',
    savePreset: 'blueprints:savePreset',
    deletePreset: 'blueprints:deletePreset',
  },
  cli: {
    detectAll: 'cli:detectAll',
    getInstallCommand: 'cli:getInstallCommand',
    checkForUpdate: 'cli:checkForUpdate',
    getUpdateCommand: 'cli:getUpdateCommand',
    checkCommandPrerequisite: 'cli:checkCommandPrerequisite',
  },
  terminal: {
    create: 'terminal:create',
    write: 'terminal:write',
    resize: 'terminal:resize',
    kill: 'terminal:kill',
    usage: 'terminal:usage',
    runStatus: 'terminal:runStatus',
    pause: 'terminal:pause',
    resume: 'terminal:resume',
    onData: 'terminal:onData',
    onExit: 'terminal:onExit',
    onPauseChange: 'terminal:onPauseChange',
  },
  ssh: {
    listServers: 'ssh:listServers',
    saveServer: 'ssh:saveServer',
    removeServer: 'ssh:removeServer',
    pickPrivateKeyFile: 'ssh:pickPrivateKeyFile',
    vaultStatus: 'ssh:vaultStatus',
    unlockVault: 'ssh:unlockVault',
    setPasskey: 'ssh:setPasskey',
    create: 'ssh:create',
    write: 'ssh:write',
    resize: 'ssh:resize',
    kill: 'ssh:kill',
    // (serverId) -> SshHostKeyStatus: the stored key and the one the server presents now
    hostKeyStatus: 'ssh:hostKeyStatus',
    // (serverId, fingerprint): trusts the presented key, provided it is still that fingerprint
    trustHostKey: 'ssh:trustHostKey',
    // (serverId) -> SshConversationsResult: every supported CLI conversation on the server
    conversations: 'ssh:conversations',
    onData: 'ssh:onData',
    onExit: 'ssh:onExit',
  },
  environments: {
    list: 'environments:list',
    save: 'environments:save',
    remove: 'environments:remove',
    reorder: 'environments:reorder',
    saveFile: 'environments:saveFile',
    removeFile: 'environments:removeFile',
    readFile: 'environments:readFile',
    copyFile: 'environments:copyFile',
    saveCredential: 'environments:saveCredential',
    removeCredential: 'environments:removeCredential',
    revealCredential: 'environments:revealCredential',
    copyCredentialSecret: 'environments:copyCredentialSecret',
    scanFolder: 'environments:scanFolder',
    importFromFolder: 'environments:importFromFolder',
    writeToFolder: 'environments:writeToFolder',
  },
  vault: {
    status: 'vault:status',
    create: 'vault:create',
    unlock: 'vault:unlock',
    lock: 'vault:lock',
    changePassword: 'vault:changePassword',
    reset: 'vault:reset',
    list: 'vault:list',
    getForEdit: 'vault:getForEdit',
    reveal: 'vault:reveal',
    copy: 'vault:copy',
    save: 'vault:save',
    remove: 'vault:remove',
    patch: 'vault:patch',
    duplicate: 'vault:duplicate',
    touch: 'vault:touch',
    importOpen: 'vault:importOpen',
    importPreview: 'vault:importPreview',
    importCommit: 'vault:importCommit',
    importCancel: 'vault:importCancel',
    exportCsv: 'vault:exportCsv',
    fetchIcon: 'vault:fetchIcon',
    // main -> renderer
    onStateChanged: 'vault:onStateChanged',
    onEntriesChanged: 'vault:onEntriesChanged',
    onClipboardSettled: 'vault:onClipboardSettled',
  },
  rdp: {
    listServers: 'rdp:listServers',
    saveServer: 'rdp:saveServer',
    removeServer: 'rdp:removeServer',
    openSession: 'rdp:openSession',
    getTicket: 'rdp:getTicket',
    respondCertificate: 'rdp:respondCertificate',
    checkCertificate: 'rdp:checkCertificate',
    trustCertificate: 'rdp:trustCertificate',
    forgetCertificate: 'rdp:forgetCertificate',
    readClipboardFiles: 'rdp:readClipboardFiles',
    readClipboardFile: 'rdp:readClipboardFile',
    beginDownload: 'rdp:beginDownload',
    prepareDownloadEntry: 'rdp:prepareDownloadEntry',
    writeDownloadChunk: 'rdp:writeDownloadChunk',
    finishDownloadFile: 'rdp:finishDownloadFile',
    openDownloadFolder: 'rdp:openDownloadFolder',
    onCertificatePrompt: 'rdp:onCertificatePrompt',
    onProxyError: 'rdp:onProxyError',
  },
  rdpWindow: {
    minimize: 'rdpWindow:minimize',
    maximizeToggle: 'rdpWindow:maximizeToggle',
    fullscreenToggle: 'rdpWindow:fullscreenToggle',
    close: 'rdpWindow:close',
    getState: 'rdpWindow:getState',
    onStateChange: 'rdpWindow:onStateChange',
  },
  sshAgent: {
    start: 'sshAgent:start',
    approveCommand: 'sshAgent:approveCommand',
    skipCommand: 'sshAgent:skipCommand',
    answerNeedsInput: 'sshAgent:answerNeedsInput',
    sendMessage: 'sshAgent:sendMessage',
    answerPassword: 'sshAgent:answerPassword',
    stop: 'sshAgent:stop',
    continue: 'sshAgent:continue',
    history: 'sshAgent:history',
    serverHistory: 'sshAgent:serverHistory',
    notifyWaiting: 'sshAgent:notifyWaiting',
    // main -> renderer: the task's status changed (thinking, proposed a command, running it, ...)
    onProgress: 'sshAgent:onProgress',
  },
  rdpAgent: {
    start: 'rdpAgent:start',
    approveAction: 'rdpAgent:approveAction',
    skipAction: 'rdpAgent:skipAction',
    answerNeedsInput: 'rdpAgent:answerNeedsInput',
    sendMessage: 'rdpAgent:sendMessage',
    stop: 'rdpAgent:stop',
    continue: 'rdpAgent:continue',
    history: 'rdpAgent:history',
    notifyWaiting: 'rdpAgent:notifyWaiting',
    // Remote Desktop window -> main: the answer to an onRequest (a screenshot, or input applied)
    respond: 'rdpAgent:respond',
    // main -> Remote Desktop window: capture the screen, or apply mouse and keyboard input
    onRequest: 'rdpAgent:onRequest',
    // main -> Remote Desktop window: the task's status changed (thinking, proposed an action, ...)
    onProgress: 'rdpAgent:onProgress',
  },
  runProposals: {
    list: 'runProposals:list',
    decide: 'runProposals:decide',
    getEnabled: 'runProposals:getEnabled',
    setEnabled: 'runProposals:setEnabled',
    startGuided: 'runProposals:startGuided',
    /** Main tells every window the pending run command suggestions changed. */
    onChanged: 'runProposals:onChanged',
  },
  projects: {
    list: 'projects:list',
    create: 'projects:create',
    update: 'projects:update',
    delete: 'projects:delete',
    reorder: 'projects:reorder',
    setPinned: 'projects:setPinned',
    setArchived: 'projects:setArchived',
    bootstrap: 'projects:bootstrap',
    bootstrapPlan: 'projects:bootstrapPlan',
    pickFolder: 'projects:pickFolder',
    pickIcon: 'projects:pickIcon',
    normalizeIcon: 'projects:normalizeIcon',
    fetchFavicon: 'projects:fetchFavicon',
    updateNotifications: 'projects:updateNotifications',
    listClaudeHooks: 'projects:listClaudeHooks',
    updateClaudeHook: 'projects:updateClaudeHook',
    deleteClaudeHook: 'projects:deleteClaudeHook',
  },
  notifications: {
    sendTest: 'notifications:sendTest',
    /** Shows a message on the desktop companion, the way the pet hook does. */
    sendPetTest: 'notifications:sendPetTest',
    detectChatId: 'notifications:detectChatId',
    onConfirmationForwarded: 'notifications:onConfirmationForwarded',
  },
  skills: {
    listRepositories: 'skills:listRepositories',
    addRepository: 'skills:addRepository',
    removeRepository: 'skills:removeRepository',
    refreshRepository: 'skills:refreshRepository',
    getRepositoryIndex: 'skills:getRepositoryIndex',
    pickLocalRepository: 'skills:pickLocalRepository',
    previewLocalRepository: 'skills:previewLocalRepository',
    install: 'skills:install',
    remove: 'skills:remove',
    listInstalled: 'skills:listInstalled',
    checkForUpdates: 'skills:checkForUpdates',
    searchSkillsSh: 'skills:searchSkillsSh',
    getSkillsShDetail: 'skills:getSkillsShDetail',
    recordSkillsShInstall: 'skills:recordSkillsShInstall',
    checkUiProPrerequisites: 'skills:checkUiProPrerequisites',
    checkUiProUpdate: 'skills:checkUiProUpdate',
    recordUiProInstall: 'skills:recordUiProInstall',
    // Favorites
    listFavorites: 'skills:listFavorites',
    addFavorite: 'skills:addFavorite',
    removeFavorite: 'skills:removeFavorite',
    // Usage
    /** Aggregated Skill invocations read out of the local agent session transcripts. */
    getUsage: 'skills:getUsage',
    /** Same, after throwing away the incremental scan cache and re-reading every transcript. */
    rescanUsage: 'skills:rescanUsage',
    /** Where a used skill's files live, and which projects already have a copy. */
    inspectUsedSkill: 'skills:inspectUsedSkill',
    /** Copies a used skill's folder into other projects' skills dirs. */
    addUsedSkillToProjects: 'skills:addUsedSkillToProjects',
    // Security audit
    runAudit: 'skills:runAudit',
    cancelAudit: 'skills:cancelAudit',
    /** Reports what a pasted folder path or GitHub address holds, before anything is scanned. */
    previewAuditSource: 'skills:previewAuditSource',
    /** Skills sitting in a scope's agent dirs, whether or not AgentMate installed them. */
    listOnDiskSkills: 'skills:listOnDiskSkills',
    listAudits: 'skills:listAudits',
    latestAuditPerSkill: 'skills:latestAuditPerSkill',
    getAudit: 'skills:getAudit',
    removeAudit: 'skills:removeAudit',
    clearAudits: 'skills:clearAudits',
    // main -> renderer events
    /** A watched local-folder repository changed on disk; payload is the repository id. */
    onRepositoryChanged: 'skills:onRepositoryChanged',
  },
  mcp: {
    listRepositories: 'mcp:listRepositories',
    addRepository: 'mcp:addRepository',
    removeRepository: 'mcp:removeRepository',
    refreshRepository: 'mcp:refreshRepository',
    getRepositoryIndex: 'mcp:getRepositoryIndex',
    pickLocalRepository: 'mcp:pickLocalRepository',
    install: 'mcp:install',
    remove: 'mcp:remove',
    listInstalled: 'mcp:listInstalled',
  },
  fs: {
    readFile: 'fs:readFile',
    readImage: 'fs:readImage',
    writeFile: 'fs:writeFile',
    listDirectory: 'fs:listDirectory',
    writeScratchFile: 'fs:writeScratchFile',
    saveFileAs: 'fs:saveFileAs',
  },
  explorer: {
    createFile: 'explorer:createFile',
    createFolder: 'explorer:createFolder',
    rename: 'explorer:rename',
    delete: 'explorer:delete',
    copy: 'explorer:copy',
    move: 'explorer:move',
    pasteExternal: 'explorer:pasteExternal',
    osClipboardPaths: 'explorer:osClipboardPaths',
    revealInOs: 'explorer:revealInOs',
    addToGitignore: 'explorer:addToGitignore',
    untrack: 'explorer:untrack',
    ignoredPaths: 'explorer:ignoredPaths',
    listFiles: 'explorer:listFiles',
  },
  workspaceSearch: {
    text: 'workspaceSearch:text',
    cancel: 'workspaceSearch:cancel',
    symbols: 'workspaceSearch:symbols',
    onTextResults: 'workspaceSearch:textResults',
  },
  settings: {
    get: 'settings:get',
    update: 'settings:update',
  },
  templates: {
    list: 'templates:list',
    save: 'templates:save',
    delete: 'templates:delete',
  },
  activity: {
    list: 'activity:list',
  },
  system: {
    sample: 'system:sample',
    topApps: 'system:topApps',
    killProcess: 'system:killProcess',
  },
  ipGeo: {
    lookup: 'ipGeo:lookup',
  },
  shell: {
    openExternal: 'shell:openExternal',
    openPath: 'shell:openPath',
    openInEditor: 'shell:openInEditor',
  },
  promptHistory: {
    list: 'promptHistory:list',
    search: 'promptHistory:search',
    add: 'promptHistory:add',
    remove: 'promptHistory:remove',
    setTags: 'promptHistory:setTags',
    setProject: 'promptHistory:setProject',
  },
  translate: {
    text: 'translate:text',
    cancel: 'translate:cancel',
  },
  speech: {
    transcribe: 'speech:transcribe',
    getModelState: 'speech:getModelState',
    // main -> renderer: first-run model download progress
    onModelProgress: 'speech:onModelProgress',
  },
  ai: {
    ask: 'ai:ask',
    cancel: 'ai:cancel',
    listOllamaModels: 'ai:listOllamaModels',
    testOllama: 'ai:testOllama',
    listGeminiModels: 'ai:listGeminiModels',
    assessRun: 'ai:assessRun',
    cancelAssessRun: 'ai:cancelAssessRun',
    askCli: 'ai:askCli',
    cancelAskCli: 'ai:cancelAskCli',
  },
  help: {
    ask: 'help:ask',
    cancel: 'help:cancel',
    status: 'help:status',
    reindex: 'help:reindex',
    cancelReindex: 'help:cancelReindex',
    embeddingModels: 'help:embeddingModels',
    onIndexProgress: 'help:onIndexProgress',
  },
  projectDrafts: {
    listByProject: 'projectDrafts:listByProject',
    create: 'projectDrafts:create',
    updateStatus: 'projectDrafts:updateStatus',
    update: 'projectDrafts:update',
    promoteToScheduled: 'projectDrafts:promoteToScheduled',
    remove: 'projectDrafts:remove',
  },
  promptBuildWidget: {
    listWidgets: 'promptBuildWidget:listWidgets',
    getWidget: 'promptBuildWidget:getWidget',
    openWidget: 'promptBuildWidget:openWidget',
    closeWidget: 'promptBuildWidget:closeWidget',
  },
  scheduledTasks: {
    list: 'scheduledTasks:list',
    listByProject: 'scheduledTasks:listByProject',
    createMany: 'scheduledTasks:createMany',
    updateStatus: 'scheduledTasks:updateStatus',
    update: 'scheduledTasks:update',
    markRan: 'scheduledTasks:markRan',
    remove: 'scheduledTasks:remove',
    // main -> renderer: an automatic task is due, open it in a terminal
    onDue: 'scheduledTasks:due',
    // main -> renderer: tasks changed outside the renderer (fired or missed)
    onChanged: 'scheduledTasks:changed',
  },
  spellcheck: {
    // main -> renderer: an editable field was right-clicked, open the writing menu
    onShowMenu: 'spellcheck:showMenu',
    addToDictionary: 'spellcheck:addToDictionary',
    // Cut, copy, paste or select all in the field that has focus. Main runs it on the calling
    // window, so it works on every input type, number and email boxes included.
    runEditCommand: 'spellcheck:runEditCommand',
  },
  splash: {
    // main -> splash window: what startup is busy with right now
    onStatus: 'splash:status',
    // main -> splash window: the app window is up, fade out
    onClose: 'splash:close',
  },
  grammar: {
    check: 'grammar:check',
    /** Where the local LanguageTool lives, whether Java is there, and what the server is doing. */
    localStatus: 'grammar:localStatus',
    startLocal: 'grammar:startLocal',
    stopLocal: 'grammar:stopLocal',
    /** Opens the tools folder in the OS file manager, creating it first if needed. */
    openToolsFolder: 'grammar:openToolsFolder',
    // main -> renderer: the local server changed state (starting, up, failed)
    onLocalStatus: 'grammar:onLocalStatus',
  },
  proxy: {
    /** Where requests are going right now, plus what this machine itself is set to. */
    status: 'proxy:status',
    /** Sends one probe request through a candidate server without saving it. */
    test: 'proxy:test',
  },
  window: {
    minimize: 'window:minimize',
    maximizeToggle: 'window:maximizeToggle',
    close: 'window:close',
    isMaximized: 'window:isMaximized',
    onMaximizedChange: 'window:onMaximizedChange',
    /** Whether the main window is the active window, so the glass chrome can follow it. */
    isFocused: 'window:isFocused',
    onFocusChange: 'window:onFocusChange',
  },
  /** Same shape as `window`, but scoped to the standalone remote session window. */
  remoteSessionWindow: {
    minimize: 'remoteSessionWindow:minimize',
    maximizeToggle: 'remoteSessionWindow:maximizeToggle',
    close: 'remoteSessionWindow:close',
    isMaximized: 'remoteSessionWindow:isMaximized',
    onMaximizedChange: 'remoteSessionWindow:onMaximizedChange',
  },
  remote: {
    getState: 'remote:getState',
    listInterfaces: 'remote:listInterfaces',
    startHost: 'remote:startHost',
    stopHost: 'remote:stopHost',
    generatePairingCode: 'remote:generatePairingCode',
    connect: 'remote:connect',
    /** Same as `connect`, but the resulting session skips capture/WebRTC entirely: file transfer and file-manager browsing only. */
    connectFiles: 'remote:connectFiles',
    disconnect: 'remote:disconnect',
    listSavedServers: 'remote:listSavedServers',
    connectSaved: 'remote:connectSaved',
    connectSavedFiles: 'remote:connectSavedFiles',
    renameSavedServer: 'remote:renameSavedServer',
    removeSavedServer: 'remote:removeSavedServer',
    /** Opens (or focuses) the standalone, resizable session window. */
    openSessionWindow: 'remote:openSessionWindow',
    sendInput: 'remote:sendInput',
    hostTile: 'remote:hostTile',
    setScreenInfo: 'remote:setScreenInfo',
    /** Controller role: reports the video display box's physical-pixel size, debounced on resize. */
    setDisplaySize: 'remote:setDisplaySize',
    sendClipboard: 'remote:sendClipboard',
    sendFile: 'remote:sendFile',
    getFileProgress: 'remote:getFileProgress',
    // Remote file manager: browse/mkdir/delete/rename/upload/download on the peer's filesystem.
    fmRoots: 'remote:fmRoots',
    fmList: 'remote:fmList',
    fmMkdir: 'remote:fmMkdir',
    fmDelete: 'remote:fmDelete',
    fmRename: 'remote:fmRename',
    fmUploadTo: 'remote:fmUploadTo',
    fmDownload: 'remote:fmDownload',
    rtcSignal: 'remote:rtcSignal',
    rtcPeerState: 'remote:rtcPeerState',
    /** Controller role: renderer -> main -> host, WebRTC signaling. */
    clientRtcSignal: 'remote:clientRtcSignal',
    /** Host role: an input event that arrived over the input DataChannel. */
    rtcInput: 'remote:rtcInput',
    /** Host role: renderer asks main to start/stop sampling the OS cursor. */
    setCursorTracking: 'remote:setCursorTracking',
    /** Benchmarking: main-process CPU/memory sample. */
    benchSample: 'remote:benchSample',
    // main -> renderer events
    onState: 'remote:onState',
    onRtcSignal: 'remote:onRtcSignal',
    onRtcPeerGone: 'remote:onRtcPeerGone',
    /** Controller role: WebRTC signaling arriving from the host. */
    onClientRtcSignal: 'remote:onClientRtcSignal',
    /** Host role: sampled OS cursor position, for the cursor DataChannel. */
    onHostCursor: 'remote:onHostCursor',
    onCaptureRefresh: 'remote:onCaptureRefresh',
    onTileDemand: 'remote:onTileDemand',
    onCaptureStart: 'remote:onCaptureStart',
    onCaptureStop: 'remote:onCaptureStop',
    onFrameTile: 'remote:onFrameTile',
    onScreenInfo: 'remote:onScreenInfo',
    /** Host role: a connected peer reported (or updated) its display box size. */
    onPeerDisplaySize: 'remote:onPeerDisplaySize',
    onFileProgress: 'remote:onFileProgress',
    onLog: 'remote:onLog',
  },
  security: {
    preflight: 'security:preflight',
    runScan: 'security:runScan',
    cancelScan: 'security:cancelScan',
    activeScan: 'security:activeScan',
    history: 'security:history',
    getScan: 'security:getScan',
    latest: 'security:latest',
    deleteScan: 'security:deleteScan',
    getConfig: 'security:getConfig',
    setConfig: 'security:setConfig',
    suggestCodeqlLanguage: 'security:suggestCodeqlLanguage',
    codeqlStatus: 'security:codeqlStatus',
    installCodeql: 'security:installCodeql',
    cancelCodeqlInstall: 'security:cancelCodeqlInstall',
    removeCodeql: 'security:removeCodeql',
    openCodeqlFolder: 'security:openCodeqlFolder',
    onCodeqlProgress: 'security:onCodeqlProgress',
    onScanProgress: 'security:onScanProgress',
  },
  tools: {
    detectAll: 'tools:detectAll',
    getInstallCommand: 'tools:getInstallCommand',
    checkForUpdate: 'tools:checkForUpdate',
    getUpdateCommand: 'tools:getUpdateCommand',
    getUninstallCommand: 'tools:getUninstallCommand',
    getInteractiveLaunchCommand: 'tools:getInteractiveLaunchCommand',
    getDockerCommand: 'tools:getDockerCommand',
  },
  docker: {
    availability: 'docker:availability',
    list: 'docker:list',
    listForProject: 'docker:listForProject',
    /** What a project still has running, without usage stats, for the prompt after a run stops. */
    runningForProject: 'docker:runningForProject',
    start: 'docker:start',
    stop: 'docker:stop',
    restart: 'docker:restart',
    remove: 'docker:remove',
  },
  /** The Dashboard's Docker and emulator usage chart, and the list of idle ones. */
  resourceActivity: {
    snapshot: 'resourceActivity:snapshot',
    stop: 'resourceActivity:stop',
  },
  /** Agent Tools > Dev Setup: what developer tools are installed and how to get the rest. */
  devSetup: {
    environment: 'devSetup:environment',
    detect: 'devSetup:detect',
    peek: 'devSetup:peek',
    install: 'devSetup:install',
    cancel: 'devSetup:cancel',
    /** Puts the folder of a tool that is installed but off PATH on the user PATH. */
    addToPath: 'devSetup:addToPath',
    jobState: 'devSetup:jobState',
    /** Main to renderer: one step of an install run, as it happens. */
    onEvent: 'devSetup:onEvent',
  },
  /** Project health checks (E22): targets, their probes and incidents. Secrets stay in main. */
  health: {
    // ({ projectId? }) -> HealthTargetSummary[]
    list: 'health:list',
    // (targetId) -> HealthTargetDetail | null
    get: 'health:get',
    // (HealthTargetInput) -> HealthCreateResult, with the new key shown once
    create: 'health:create',
    // (targetId, Partial<HealthTargetInput>) -> HealthTargetSummary
    update: 'health:update',
    remove: 'health:remove',
    // (targetId, paused) -> HealthTargetSummary
    setPaused: 'health:setPaused',
    // (targetId) -> HealthTargetDetail, after a probe that runs right away
    checkNow: 'health:checkNow',
    // (targetId) -> HealthSecretReveal: a new key or password, the old one stops working
    rotateSecret: 'health:rotateSecret',
    // (targetId) -> HealthSetupPrompt for the agent that implements the endpoint
    setupPrompt: 'health:setupPrompt',
    // () -> string: the protocol document
    spec: 'health:spec',
    // (targetId) -> string | null: the redacted "fix this" prompt for the last report
    fixPrompt: 'health:fixPrompt',
    // (targetId) -> void: runs the read-only AI analysis for the open incident now
    diagnoseNow: 'health:diagnoseNow',
    cancelDiagnose: 'health:cancelDiagnose',
    // main -> renderer: HealthChangedEvent
    onChanged: 'health:changed',
  },
  /** The Android page: the SDK behind it, AVDs, emulators and adb devices. */
  android: {
    sdk: 'android:sdk',
    setSdkPath: 'android:setSdkPath',
    pickSdkPath: 'android:pickSdkPath',
    refresh: 'android:refresh',
    start: 'android:start',
    stop: 'android:stop',
    cancelBoot: 'android:cancelBoot',
    watchUsage: 'android:watchUsage',
    rotate: 'android:rotate',
    screenshot: 'android:screenshot',
    startRecording: 'android:startRecording',
    stopRecording: 'android:stopRecording',
    installApk: 'android:installApk',
    pickApk: 'android:pickApk',
    adbPath: 'android:adbPath',
    revealCapture: 'android:revealCapture',
    openCapturesFolder: 'android:openCapturesFolder',
    createAvd: 'android:createAvd',
    deleteAvd: 'android:deleteAvd',
    editAvd: 'android:editAvd',
    avdConfig: 'android:avdConfig',
    wipeData: 'android:wipeData',
    listSystemImages: 'android:listSystemImages',
    availableSystemImages: 'android:availableSystemImages',
    installSystemImage: 'android:installSystemImage',
    listDeviceProfiles: 'android:listDeviceProfiles',
    pair: 'android:pair',
    connect: 'android:connect',
    disconnect: 'android:disconnect',
    enableWireless: 'android:enableWireless',
    /** main -> every renderer: device list, emulator state, usage and SDK changes. */
    onEvent: 'android:event',
  },
  usage: {
    list: 'usage:list',
    get: 'usage:get',
    refresh: 'usage:refresh',
    refreshProvider: 'usage:refreshProvider',
    setProviderConfig: 'usage:setProviderConfig',
    listWidgets: 'usage:listWidgets',
    getWidget: 'usage:getWidget',
    openWidget: 'usage:openWidget',
    closeWidget: 'usage:closeWidget',
    setWidgetStyle: 'usage:setWidgetStyle',
    setWidgetSize: 'usage:setWidgetSize',
    setWidgetMode: 'usage:setWidgetMode',
    configureWidget: 'usage:configureWidget',
    setResetAlerts: 'usage:setResetAlerts',
    testResetAlert: 'usage:testResetAlert',
    setThresholdAlerts: 'usage:setThresholdAlerts',
    testThresholdAlert: 'usage:testThresholdAlert',
    // main -> renderer: threshold alert fired but the OS has no notification
    // centre to show it, so the renderer shows a toast instead.
    onThresholdAlert: 'usage:onThresholdAlert',
    // main -> widget window: instance changed, re-read it
    onWidgetUpdated: 'usage:widgetUpdated',
  },
  pet: {
    setClickThrough: 'pet:setClickThrough',
    /**
     * app -> main: a native drag started (or ended) in the app window, so the
     * companion overlay has to step out of the way until it is over.
     */
    setDragGuard: 'pet:setDragGuard',
    getWorkArea: 'pet:getWorkArea',
    onDisplayChanged: 'pet:displayChanged',
    onSettingsChanged: 'pet:settingsChanged',
    onPipelineMessage: 'pet:pipelineMessage',
    importCustom: 'pet:importCustom',
    removeCustom: 'pet:removeCustom',
    customDataUrls: 'pet:customDataUrls',
    /** Hide the companion for N minutes; it comes back on its own. */
    snooze: 'pet:snooze',
    cancelSnooze: 'pet:cancelSnooze',
    getSnooze: 'pet:getSnooze',
    /** main -> every renderer: the hide started, was cancelled, or ran out. */
    onSnoozeChanged: 'pet:snoozeChanged',
    /**
     * Brings the app window back to the front. Takes an optional route, so the
     * failure the pet just announced can open on the Pipelines page.
     */
    showMainWindow: 'pet:showMainWindow',
  },
  /** The workspace Tests panel: discover a project's tests, run them, and follow the run. */
  tests: {
    discover: 'tests:discover',
    run: 'tests:run',
    cancel: 'tests:cancel',
    lastRun: 'tests:lastRun',
    command: 'tests:command',
    /** main -> every renderer: TestRunEvent as a run starts, prints, reports results and ends. */
    onRunEvent: 'tests:onRunEvent',
  },
  pipelines: {
    status: 'pipelines:status',
    setMuted: 'pipelines:setMuted',
    dashboardActivity: 'pipelines:dashboardActivity',
    runError: 'pipelines:runError',
    runAnnotations: 'pipelines:runAnnotations',
    refs: 'pipelines:refs',
    dispatch: 'pipelines:dispatch',
    cancelRun: 'pipelines:cancelRun',
    runners: 'pipelines:runners',
  },
  /** The Deploy section: saved servers, installing the server core, and its health. */
  deploy: {
    listServers: 'deploy:listServers',
    preflight: 'deploy:preflight',
    install: 'deploy:install',
    uninstall: 'deploy:uninstall',
    health: 'deploy:health',
    access: 'deploy:access',
    enroll: 'deploy:enroll',
    signIn: 'deploy:signIn',
    signOut: 'deploy:signOut',
    account: 'deploy:account',
    stepUp: 'deploy:stepUp',
    beginTotp: 'deploy:beginTotp',
    confirmTotp: 'deploy:confirmTotp',
    disableTotp: 'deploy:disableTotp',
    onSetupProgress: 'deploy:onSetupProgress',
    /** (serverId) -> DeployConnection: the server's lasting connection right now. */
    connection: 'deploy:connection',
    /** (serverId) -> DeployConnection: tries the connection again now, whatever it waited for. */
    reconnect: 'deploy:reconnect',
    /** main -> the main window: DeployConnection, whenever a server's connection changes. */
    onConnection: 'deploy:onConnection',
  },
  /** The Deploy section's Overview: a server's facts, live metrics, updates, reboot and restarts. */
  deploySystem: {
    info: 'deploySystem:info',
    services: 'deploySystem:services',
    metricsHistory: 'deploySystem:metricsHistory',
    updates: 'deploySystem:updates',
    checkUpdates: 'deploySystem:checkUpdates',
    upgradeSecurity: 'deploySystem:upgradeSecurity',
    upgradeAll: 'deploySystem:upgradeAll',
    setAutomaticUpdates: 'deploySystem:setAutomaticUpdates',
    reboot: 'deploySystem:reboot',
    restartService: 'deploySystem:restartService',
    /** (DeployMetricsWatchInput) -> subscription id; samples arrive on onMetrics. */
    watchMetrics: 'deploySystem:watchMetrics',
    unwatchMetrics: 'deploySystem:unwatchMetrics',
    /** main -> the window that asked: DeployMetricsEvent, a batch of live samples. */
    onMetrics: 'deploySystem:onMetrics',
  },
  /** The jobs a server core runs (updates, reboots, restarts) and their live logs. */
  deployJobs: {
    list: 'deployJobs:list',
    get: 'deployJobs:get',
    cancel: 'deployJobs:cancel',
    /** (DeployJobWatchInput) -> subscription id; the log arrives on onLog. */
    watch: 'deployJobs:watch',
    unwatch: 'deployJobs:unwatch',
    /** main -> the window that asked: DeployJobEvent, new log lines and the job's state. */
    onLog: 'deployJobs:onLog',
  },
  /** A server core's alerts: disk pressure, failed jobs, a reboot waiting. */
  deployAlerts: {
    list: 'deployAlerts:list',
    acknowledge: 'deployAlerts:acknowledge',
    /** (serverId) -> subscription id; the open alerts, then changes, arrive on onChanged. */
    watch: 'deployAlerts:watch',
    unwatch: 'deployAlerts:unwatch',
    /** main -> the window that asked: DeployAlertsEvent, alerts in revision order. */
    onChanged: 'deployAlerts:onChanged',
  },
  /** A server's websites (E10): nginx itself, sites, stream proxies, applying, and site logs. */
  deploySites: {
    status: 'deploySites:status',
    list: 'deploySites:list',
    listStreams: 'deploySites:listStreams',
    install: 'deploySites:install',
    save: 'deploySites:save',
    remove: 'deploySites:remove',
    saveStream: 'deploySites:saveStream',
    removeStream: 'deploySites:removeStream',
    apply: 'deploySites:apply',
    setSnippets: 'deploySites:setSnippets',
    /** (DeploySiteLogWatchInput) -> subscription id; lines arrive on onLog. */
    watchLog: 'deploySites:watchLog',
    unwatchLog: 'deploySites:unwatchLog',
    /** main -> the window that asked: DeploySiteLogEvent, new lines of a site's log. */
    onLog: 'deploySites:onLog',
  },
  /** A server's certificates (E11): Let's Encrypt orders and renewals, uploads and removal. */
  deployCerts: {
    list: 'deployCerts:list',
    issue: 'deployCerts:issue',
    renew: 'deployCerts:renew',
    upload: 'deployCerts:upload',
    remove: 'deployCerts:remove',
  },
  /**
   * A server's host firewall (E13): status, presets, change history and exposure for every role;
   * preview, apply (safe apply: confirm over a new SSH connection, or it rolls back) for Admins.
   */
  deployFirewall: {
    status: 'deployFirewall:status',
    presets: 'deployFirewall:presets',
    history: 'deployFirewall:history',
    exposure: 'deployFirewall:exposure',
    preview: 'deployFirewall:preview',
    apply: 'deployFirewall:apply',
    /** (DeployFirewallDecisionInput) -> the change kept, confirmed over a new SSH connection. */
    confirm: 'deployFirewall:confirm',
    revert: 'deployFirewall:revert',
    /** main -> the main window: DeployFirewallProgressEvent, each step of apply/confirm/revert. */
    onProgress: 'deployFirewall:onProgress',
  },
  /**
   * Direct TLS (E16): the core's opt-in HTTPS port with mutual TLS. Reads and changes go over SSH
   * only, which is where the pin comes from; the firewall rule goes through deployFirewall.
   */
  deployDirectTls: {
    /** (serverId) -> DeployDirectTlsInfo: the core's account, the pin kept here, and whether it changed. */
    status: 'deployDirectTls:status',
    /** (DeployDirectTlsEnableInput) -> DeployDirectTlsInfo; Owner, may need a step-up. */
    enable: 'deployDirectTls:enable',
    /** (serverId) -> DeployDirectTlsInfo, after this computer stopped using the port. */
    disable: 'deployDirectTls:disable',
    /** (serverId) -> DeployDirectTlsInfo, with the key the core presents now pinned. */
    acceptPin: 'deployDirectTls:acceptPin',
  },
  /**
   * Docker on a server (E06): the engine and its install, containers and their lifecycle, live
   * stats, logs and engine events, a console, and images, volumes, networks and disk use.
   */
  deployDocker: {
    status: 'deployDocker:status',
    install: 'deployDocker:install',
    listContainers: 'deployDocker:listContainers',
    inspect: 'deployDocker:inspect',
    /** Admins, after a step-up: the container's environment values. */
    revealEnv: 'deployDocker:revealEnv',
    act: 'deployDocker:act',
    remove: 'deployDocker:remove',
    /** The last lines of a container's log, collected once. */
    logTail: 'deployDocker:logTail',
    listImages: 'deployDocker:listImages',
    pullImage: 'deployDocker:pullImage',
    removeImage: 'deployDocker:removeImage',
    listVolumes: 'deployDocker:listVolumes',
    removeVolume: 'deployDocker:removeVolume',
    listNetworks: 'deployDocker:listNetworks',
    removeNetwork: 'deployDocker:removeNetwork',
    diskUsage: 'deployDocker:diskUsage',
    prune: 'deployDocker:prune',
    /** (serverId) -> subscription id; every running container's stats arrive on onStats. */
    watchStats: 'deployDocker:watchStats',
    unwatchStats: 'deployDocker:unwatchStats',
    onStats: 'deployDocker:onStats',
    /** (DeployContainerLogsWatchInput) -> subscription id; lines arrive on onLogs. */
    watchLogs: 'deployDocker:watchLogs',
    unwatchLogs: 'deployDocker:unwatchLogs',
    onLogs: 'deployDocker:onLogs',
    /** (serverId) -> subscription id; engine events arrive on onEvents. */
    watchEvents: 'deployDocker:watchEvents',
    unwatchEvents: 'deployDocker:unwatchEvents',
    onEvents: 'deployDocker:onEvents',
    /** (DeployConsoleOpenInput) -> subscription id; the screen arrives on onConsole. */
    openConsole: 'deployDocker:openConsole',
    /** (subscription id, keystrokes) */
    consoleInput: 'deployDocker:consoleInput',
    /** (subscription id, columns, rows) */
    consoleResize: 'deployDocker:consoleResize',
    closeConsole: 'deployDocker:closeConsole',
    onConsole: 'deployDocker:onConsole',
  },
  /**
   * A server's Apps (E07): compose stacks from a project's compose file and environment. Env
   * values stay in the main process; the renderer sees keys only.
   */
  deployStacks: {
    /** (projectId) -> DeployComposeDiscovery, the compose files in the project. */
    discover: 'deployStacks:discover',
    /** (DeployStackPreviewInput) -> DeployStackPreview: services, exposure, risks, env keys. */
    preview: 'deployStacks:preview',
    list: 'deployStacks:list',
    get: 'deployStacks:get',
    files: 'deployStacks:files',
    /** (DeployStackCreateInput) -> DeployStackUploadResult: the app and its first revision. */
    create: 'deployStacks:create',
    /** (DeployStackRevisionInput) -> DeployStackUploadResult: a new revision of an app. */
    upload: 'deployStacks:upload',
    acknowledge: 'deployStacks:acknowledge',
    deploy: 'deployStacks:deploy',
    rollback: 'deployStacks:rollback',
    action: 'deployStacks:action',
    delete: 'deployStacks:delete',
    /** (DeployMakePrivateInput) -> DeployRevisionResult: services moved to 127.0.0.1 (E13). */
    makePrivate: 'deployStacks:makePrivate',
    /** main -> renderer: DeployStackUploadProgress while files go up. */
    onUploadProgress: 'deployStacks:onUploadProgress',
  },
  /**
   * A server's App Store (E12): an app installed from the catalog, its update to newer images and
   * its generated passwords revealed (Admins, after a step-up). The main process renders the
   * files itself from what was picked.
   */
  deployAppStore: {
    /** (DeployAppInstallInput) -> DeployAppInstallResult: the app, its revision and deploy job. */
    install: 'deployAppStore:install',
    /** (DeployAppUpdateInput) -> DeployRevisionResult: a copy of the live revision on newer images. */
    update: 'deployAppStore:update',
    /** (DeployAppRevealInput) -> the app's .env as a map of key to value. */
    revealSecrets: 'deployAppStore:revealSecrets',
  },
  /**
   * Private registries (E08): sign-ins kept on this computer (GitHub packages token, the gh
   * sign-in behind a warning, Docker Hub, custom registries), each app's choice to send them with
   * its deploys, and the write-only credentials stored on a server. No channel returns a secret.
   */
  deployRegistry: {
    list: 'deployRegistry:list',
    /** (token) -> DeployGithubTokenCheck: what GitHub says the token can do. Nothing is saved. */
    checkGithubToken: 'deployRegistry:checkGithubToken',
    saveGithubToken: 'deployRegistry:saveGithubToken',
    githubCliStatus: 'deployRegistry:githubCliStatus',
    saveGithubCli: 'deployRegistry:saveGithubCli',
    saveCredential: 'deployRegistry:saveCredential',
    remove: 'deployRegistry:remove',
    /** (DeployAppRegistryChoice) -> void */
    setAppChoice: 'deployRegistry:setAppChoice',
    /** ({ serverId, stackId?, revision?, images? }) -> DeployRegistryPlan */
    plan: 'deployRegistry:plan',
    serverList: 'deployRegistry:serverList',
    serverSave: 'deployRegistry:serverSave',
    serverRemove: 'deployRegistry:serverRemove',
  },
  /**
   * A server core's Security area: users and roles (Owner), devices and sessions, enrollment
   * codes (made by an Owner, redeemed on another computer) and the audit trail.
   */
  /**
   * The Deploy AI (E09): one run per server on the SSH AI's loop, with the server core as its
   * shell. Progress and live output go to the main window.
   */
  deployAssistant: {
    /** (DeployAssistantStartInput) -> void */
    start: 'deployAssistant:start',
    approve: 'deployAssistant:approve',
    skip: 'deployAssistant:skip',
    answer: 'deployAssistant:answer',
    resume: 'deployAssistant:resume',
    stop: 'deployAssistant:stop',
    /** (serverId) -> DeployAssistantState */
    state: 'deployAssistant:state',
    /** (serverId) -> AssistantModeInfo */
    getMode: 'deployAssistant:getMode',
    /** (DeployAssistantModeInput) -> AssistantModeInfo; turning auto-run on needs a step-up. */
    setMode: 'deployAssistant:setMode',
    /** main -> renderer: DeployAssistantProgressEvent */
    onProgress: 'deployAssistant:onProgress',
    /** main -> renderer: DeployAssistantOutputEvent */
    onOutput: 'deployAssistant:onOutput',
  },
  /** The logs center (E09): a systemd unit's journal; the other sources have channels already. */
  deployLogs: {
    /** (DeployJournalWatchInput) -> subscription id; lines arrive on onJournal. */
    watchJournal: 'deployLogs:watchJournal',
    unwatchJournal: 'deployLogs:unwatchJournal',
    /** main -> the window that asked: DeployJournalEvent */
    onJournal: 'deployLogs:onJournal',
  },
  deploySecurity: {
    listUsers: 'deploySecurity:listUsers',
    createUser: 'deploySecurity:createUser',
    setUserRole: 'deploySecurity:setUserRole',
    setUserDisabled: 'deploySecurity:setUserDisabled',
    resetUserPassword: 'deploySecurity:resetUserPassword',
    deleteUser: 'deploySecurity:deleteUser',
    createEnrollmentCode: 'deploySecurity:createEnrollmentCode',
    redeemEnrollmentCode: 'deploySecurity:redeemEnrollmentCode',
    listDevices: 'deploySecurity:listDevices',
    revokeDevice: 'deploySecurity:revokeDevice',
    listSessions: 'deploySecurity:listSessions',
    revokeSession: 'deploySecurity:revokeSession',
    revokeOtherSessions: 'deploySecurity:revokeOtherSessions',
    queryAudit: 'deploySecurity:queryAudit',
    verifyAudit: 'deploySecurity:verifyAudit',
    exportAudit: 'deploySecurity:exportAudit',
  },
  /** The Security center (E15): the checklist, its SSH fixes, backups and restores. */
  deployHardening: {
    checklist: 'deployHardening:checklist',
    previewSsh: 'deployHardening:previewSsh',
    applySsh: 'deployHardening:applySsh',
    confirmSsh: 'deployHardening:confirmSsh',
    revertSsh: 'deployHardening:revertSsh',
    /** main -> the main window: the steps of an SSH change. */
    onSshProgress: 'deployHardening:onSshProgress',
    createBackup: 'deployHardening:createBackup',
    pickBackup: 'deployHardening:pickBackup',
    restore: 'deployHardening:restore',
    /** main -> the main window: the steps of a restore. */
    onRestoreProgress: 'deployHardening:onRestoreProgress',
  },
  /**
   * WordPress sites connected through the AgentMate Connector plugin (E19 to E21): connecting
   * with a key, the site's items and deploy history, and pulling and deploying WordPress projects.
   */
  deployWordPress: {
    listSites: 'deployWordPress:listSites',
    connect: 'deployWordPress:connect',
    disconnect: 'deployWordPress:disconnect',
    updateSettings: 'deployWordPress:updateSettings',
    siteInfo: 'deployWordPress:siteInfo',
    listItems: 'deployWordPress:listItems',
    history: 'deployWordPress:history',
    rollback: 'deployWordPress:rollback',
    audit: 'deployWordPress:audit',
    planPull: 'deployWordPress:planPull',
    pull: 'deployWordPress:pull',
    planDeploy: 'deployWordPress:planDeploy',
    deploy: 'deployWordPress:deploy',
    cancel: 'deployWordPress:cancel',
    createProject: 'deployWordPress:createProject',
    setProjectItems: 'deployWordPress:setProjectItems',
    linkProject: 'deployWordPress:linkProject',
    unlinkProject: 'deployWordPress:unlinkProject',
    localChanges: 'deployWordPress:localChanges',
    remoteFile: 'deployWordPress:remoteFile',
    saveConnectorZip: 'deployWordPress:saveConnectorZip',
    /** Replaces the plugin on a site with the version bundled in this app. */
    updateConnector: 'deployWordPress:updateConnector',
    /** main -> the main window: the steps of a pull, deploy, rollback or new project. */
    onProgress: 'deployWordPress:onProgress',
  },
  /** The Deploy section's Cloudflare dialog: the API token, zones, DNS, settings and rules. */
  cloudflare: {
    status: 'cloudflare:status',
    saveToken: 'cloudflare:saveToken',
    checkToken: 'cloudflare:checkToken',
    removeToken: 'cloudflare:removeToken',
    listZones: 'cloudflare:listZones',
    listRecords: 'cloudflare:listRecords',
    createRecord: 'cloudflare:createRecord',
    updateRecord: 'cloudflare:updateRecord',
    deleteRecord: 'cloudflare:deleteRecord',
    zoneSettings: 'cloudflare:zoneSettings',
    changeSetting: 'cloudflare:changeSetting',
    purgeCache: 'cloudflare:purgeCache',
    listCustomRules: 'cloudflare:listCustomRules',
    createCustomRule: 'cloudflare:createCustomRule',
    setCustomRuleEnabled: 'cloudflare:setCustomRuleEnabled',
    deleteCustomRule: 'cloudflare:deleteCustomRule',
    listAccessRules: 'cloudflare:listAccessRules',
    createAccessRule: 'cloudflare:createAccessRule',
    deleteAccessRule: 'cloudflare:deleteAccessRule',
    planPointDomain: 'cloudflare:planPointDomain',
    pointDomain: 'cloudflare:pointDomain',
  },
  /** Cloudflare work on one server (E14): origin lock, Origin CA certificates, DNS-01 tokens. */
  cloudflareServer: {
    originLock: 'cloudflareServer:originLock',
    previewOriginLock: 'cloudflareServer:previewOriginLock',
    applyOriginLock: 'cloudflareServer:applyOriginLock',
    originCertificate: 'cloudflareServer:originCertificate',
    dnsTokens: 'cloudflareServer:dnsTokens',
    provisionDnsToken: 'cloudflareServer:provisionDnsToken',
    removeDnsToken: 'cloudflareServer:removeDnsToken',
  },
  /** The workspace Pull request tab: the current branch's PR, its checks, review and merge. */
  pullRequests: {
    status: 'pullRequests:status',
    suggestText: 'pullRequests:suggestText',
    comment: 'pullRequests:comment',
    replyThread: 'pullRequests:replyThread',
    resolveThread: 'pullRequests:resolveThread',
    markReady: 'pullRequests:markReady',
    merge: 'pullRequests:merge',
    cleanup: 'pullRequests:cleanup',
    localReview: 'pullRequests:localReview',
    /** Stops a suggestText or localReview run by its request id. */
    cancelAi: 'pullRequests:cancelAi',
  },
  /**
   * The in-app notification inbox. Distinct from the `notifications` group above,
   * which is about sending a notification out (Telegram, the desktop companion).
   */
  appNotifications: {
    list: 'appNotifications:list',
    markRead: 'appNotifications:markRead',
    markAllRead: 'appNotifications:markAllRead',
    remove: 'appNotifications:remove',
    unreadCount: 'appNotifications:unreadCount',
    /** main -> every renderer: something was added to or changed in the inbox. */
    onChanged: 'appNotifications:onChanged',
  },
  /** Git worktrees: a folder and branch per task, each with a workspace of its own. */
  worktrees: {
    list: 'worktrees:list',
    defaults: 'worktrees:defaults',
    suggestPath: 'worktrees:suggestPath',
    create: 'worktrees:create',
    previewCopy: 'worktrees:previewCopy',
    copyFiles: 'worktrees:copyFiles',
    removePreflight: 'worktrees:removePreflight',
    remove: 'worktrees:remove',
    mergePreflight: 'worktrees:mergePreflight',
    merge: 'worktrees:merge',
    mergeBaseIn: 'worktrees:mergeBaseIn',
    prune: 'worktrees:prune',
    suggestBranch: 'worktrees:suggestBranch',
    cancelSuggestBranch: 'worktrees:cancelSuggestBranch',
    pickLocation: 'worktrees:pickLocation',
    /** main -> every renderer: a project's worktrees were added, removed or changed. */
    onChanged: 'worktrees:onChanged',
  },
  git: {
    status: 'git:status',
    listFiles: 'git:listFiles',
    changeSummary: 'git:changeSummary',
    fetch: 'git:fetch',
    pull: 'git:pull',
    push: 'git:push',
    sync: 'git:sync',
    createBranch: 'git:createBranch',
    checkoutBranch: 'git:checkoutBranch',
    setDefaultBranch: 'git:setDefaultBranch',
    renameBranch: 'git:renameBranch',
    deleteBranch: 'git:deleteBranch',
    branchHistory: 'git:branchHistory',
    commit: 'git:commit',
    tags: 'git:tags',
    createTag: 'git:createTag',
    suggestTag: 'git:suggestTag',
    cancelSuggestTag: 'git:cancelSuggestTag',
    applyVersion: 'git:applyVersion',
    cancelApplyVersion: 'git:cancelApplyVersion',
    swapVersionFile: 'git:swapVersionFile',
    writeVersionHunks: 'git:writeVersionHunks',
    suggestBranchName: 'git:suggestBranchName',
    cancelSuggestBranchName: 'git:cancelSuggestBranchName',
    suggestCommitMessage: 'git:suggestCommitMessage',
    cancelSuggestCommitMessage: 'git:cancelSuggestCommitMessage',
    createPullRequest: 'git:createPullRequest',
    init: 'git:init',
    githubAccount: 'git:githubAccount',
    githubActivity: 'git:githubActivity',
    githubNotifications: 'git:githubNotifications',
    githubMarkNotificationRead: 'git:githubMarkNotificationRead',
    githubMarkNotificationsRead: 'git:githubMarkNotificationsRead',
    lookupGithubRepo: 'git:lookupGithubRepo',
    createGithubRepo: 'git:createGithubRepo',
    connectRemote: 'git:connectRemote',
    detectRemote: 'git:detectRemote',
    cloneInto: 'git:cloneInto',
    watchRepo: 'git:watchRepo',
    unwatchRepo: 'git:unwatchRepo',
    // main -> renderer: the repo moved on disk (commit, checkout, merge, fetch, stage)
    onRepoChanged: 'git:onRepoChanged',
    workspaceState: 'git:workspaceState',
    watchWorkingTree: 'git:watchWorkingTree',
    unwatchWorkingTree: 'git:unwatchWorkingTree',
    stage: 'git:stage',
    unstage: 'git:unstage',
    discard: 'git:discard',
    undoDiscard: 'git:undoDiscard',
    applyLines: 'git:applyLines',
    resolveConflict: 'git:resolveConflict',
    resolveConflictWithAi: 'git:resolveConflictWithAi',
    cancelResolveConflictWithAi: 'git:cancelResolveConflictWithAi',
    abortOperation: 'git:abortOperation',
    commitStaged: 'git:commitStaged',
    stashPush: 'git:stashPush',
    stashList: 'git:stashList',
    stashPop: 'git:stashPop',
    stashApply: 'git:stashApply',
    stashDrop: 'git:stashDrop',
    fileDiff: 'git:fileDiff',
    writeWorkingFile: 'git:writeWorkingFile',
    commitFiles: 'git:commitFiles',
    commitFileDiff: 'git:commitFileDiff',
    fileImage: 'git:fileImage',
    commitFileImage: 'git:commitFileImage',
    // main -> renderer: (projectId, WorkspaceGitState) whenever a watched working tree changes
    onWorkspaceState: 'git:onWorkspaceState',
  },
  terminalClipboard: {
    saveImage: 'terminalClipboard:saveImage',
    read: 'terminalClipboard:read',
    previewImage: 'terminalClipboard:previewImage',
  },
  browser: {
    /** (webContentsId, rect, viewport) -> BrowserElementShot | null: a crop of a picked element. */
    captureElement: 'browser:captureElement',
    /** main -> renderer: a browser key pressed while a page had focus (BrowserGuestShortcut). */
    onGuestShortcut: 'browser:guestShortcut',
    /** main -> renderer: a page asked for a new window (BrowserOpenInNewTab). */
    onOpenInNewTab: 'browser:openInNewTab',
  },
  power: {
    // () -> KeepAwakeStatus
    keepAwakeStatus: 'power:keepAwakeStatus',
    // (mode) -> KeepAwakeStatus: stores the choice and applies it
    setKeepAwake: 'power:setKeepAwake',
    // main -> renderer: the keep-awake state changed
    onKeepAwake: 'power:onKeepAwake',
  },

  agents: {
    sync: 'agents:sync',
    setViewing: 'agents:setViewing',
    acknowledge: 'agents:acknowledge',
    list: 'agents:list',
    statusHookSettings: 'agents:statusHookSettings',
    runInfos: 'agents:runInfos',
    // The model and effort each CLI was last actually running on, kept across restarts
    lastRunInfoByCli: 'agents:lastRunInfoByCli',
    // (projectId) -> AgentHistorySession[]: past conversations from every supported CLI in its folder
    history: 'agents:history',
    // (provider, conversationId) -> AgentSessionUsage: tokens and estimated cost of a past conversation
    sessionUsage: 'agents:sessionUsage',
    // (projectId, days | null) -> ProjectUsageReport: what a project's conversations used, its worktrees included
    projectUsage: 'agents:projectUsage',
    // main -> renderer: AgentRunInfoMap of sessions whose model or effort just changed
    onRunInfo: 'agents:onRunInfo',
    // main -> renderer: AgentStatusMap of sessions whose status just changed
    onStatus: 'agents:onStatus',
    // () -> AutoContinuePendingMap: every "continue" scheduled after a limit or network error
    autoContinuePending: 'agents:autoContinuePending',
    // (sessionId) -> void: drops the continue scheduled for that tab
    cancelAutoContinue: 'agents:cancelAutoContinue',
    // main -> renderer: AutoContinuePendingMap of tabs whose scheduled continue changed
    onAutoContinue: 'agents:onAutoContinue',
  },
  apiClient: {
    listCollections: 'apiClient:listCollections',
    getCollection: 'apiClient:getCollection',
    createCollection: 'apiClient:createCollection',
    renameCollection: 'apiClient:renameCollection',
    removeCollection: 'apiClient:removeCollection',
    saveRequest: 'apiClient:saveRequest',
    createFolder: 'apiClient:createFolder',
    removeItem: 'apiClient:removeItem',
    // (ExecuteApiRequestInput) -> ApiExecutionResult, once the request finished or failed
    execute: 'apiClient:execute',
    // (requestId) -> boolean: stops a request started by execute
    cancel: 'apiClient:cancel',
  },
  packages: {
    list: 'packages:list',
    update: 'packages:update',
    // main -> renderer: per-package progress while an update batch runs
    onUpdateProgress: 'packages:onUpdateProgress',
  },
} as const;
