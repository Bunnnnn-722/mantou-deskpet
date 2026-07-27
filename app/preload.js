const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  setIgnore: (flag) => ipcRenderer.invoke('set-ignore', flag),
  dragBy: (dx, dy) => ipcRenderer.send('drag-by', { dx, dy }),
  moveToDisplay: (x, y) => ipcRenderer.invoke('move-to-display', { x, y }),
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  setConfig: (cfg) => ipcRenderer.invoke('set-config', cfg),
  getStore: (name) => ipcRenderer.invoke('get-store', name),
  setStore: (name, data) => ipcRenderer.invoke('set-store', name, data),
  musicAppRunning: () => ipcRenderer.invoke('music-app-running'),
  nowPlaying: () => ipcRenderer.invoke('now-playing'),
  onExternalSay: (cb) => ipcRenderer.on('external-say', (_e, d) => cb(d)),
  getWeather: () => ipcRenderer.invoke('get-weather'),
  openPrompts: () => ipcRenderer.send('open-prompts'),
  openPrivacy: (pane) => ipcRenderer.send('open-privacy', pane),
  getAutostart: () => ipcRenderer.invoke('get-autostart'),
  setAutostart: (on) => ipcRenderer.invoke('set-autostart', on),
  promptsSaved: () => ipcRenderer.send('prompts-saved'),
  // 检查更新(轻量版):主进程发现 GitHub 有新 release → 渲染端提示;
  // 「去下载」只让主进程开它自己存的 release 页地址
  onUpdateAvailable: (cb) => ipcRenderer.on('update-available', (_e, d) => cb(d)),
  openUpdate: () => ipcRenderer.send('open-update'),
  saveStudyCard: (dataUrl) => ipcRenderer.invoke('study-save-card', dataUrl),
  onConfigChanged: (cb) => ipcRenderer.on('config-changed', () => cb()),
  // 角色包(形象)
  personaList: () => ipcRenderer.invoke('persona-list'),
  personaImport: () => ipcRenderer.invoke('persona-import'),
  personaDelete: (id) => ipcRenderer.invoke('persona-delete', id),
  personaActivate: (id) => ipcRenderer.invoke('persona-activate', id),
  personaSetSize: (id, height) => ipcRenderer.invoke('persona-set-size', { id, height }),
  personaSetMeta: (id, meta) => ipcRenderer.invoke('persona-set-meta', { id, meta }),
  personaPreviewAnim: (name) => ipcRenderer.invoke('persona-preview-anim', name),
  onPlayAnim: (cb) => ipcRenderer.on('play-anim', (_e, name) => cb(name)),
  onPersonaRefresh: (cb) => ipcRenderer.on('persona-refresh', () => cb()),
  personaFile: (id, file) => ipcRenderer.invoke('persona-file', { id, file }),
  personaManifest: (id) => ipcRenderer.invoke('persona-manifest', id),
  // Agent 本地通讯:通知下发与展示回执
  onNotify: (cb) => ipcRenderer.on('agent-notify', (_e, d) => cb(d)),
  agentShown: (id) => ipcRenderer.send('agent-shown', id),
  // Agent 双向扩展:回信信箱(F1) / 观察导出(Part3) / 待办直通与状态回写(Part4)
  agentOutbox: (message) => ipcRenderer.invoke('agent-outbox', message),
  agentObserve: (entry) => ipcRenderer.send('agent-observe', entry),
  onAgentTodos: (cb) => ipcRenderer.on('agent-todos', (_e, list) => cb(list)),
  agentTodosImported: (ids) => ipcRenderer.send('agent-todos-imported', ids),
  agentTodoStatus: (snap) => ipcRenderer.send('agent-todo-status', snap),
  // F2 精简版:扣子进程检测与一键拉起
  cozeDetect: () => ipcRenderer.invoke('coze-detect'),
  cozeOpen: () => ipcRenderer.invoke('coze-open'),
  quit: () => ipcRenderer.send('quit-app'),
});
