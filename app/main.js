const { app, BrowserWindow, ipcMain, desktopCapturer, screen, nativeImage } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const platform = require('./platform'); // 跨平台旁路:正在播放/进程门禁/自启

const SMOKE = process.argv.includes('--smoke');
let win = null;

// 窗口铺满当前屏工作区;桌宠在窗口内部拖动，跨屏时窗口跳岛

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

/* ================= Agent 本地通讯(本地文件桥 v1.0,见用户手册第15节) =================
 * 外部 Agent(如日程助手)往 ~/agent_pet/notifications.json 追加通知;
 * 这里轮询读取 → 逐条下发渲染层展示 → 收到回执后原子删除。 */
const AGENT_DIR = path.join(os.homedir(), 'agent_pet');
const NOTIF_FILE = path.join(AGENT_DIR, 'notifications.json');
const AGENT_CFG_FILE = path.join(AGENT_DIR, 'config.json');
// 双向通讯扩展(2026-07-23 需求汇总 F1/Part3/Part4):
// outbox=用户给 Agent 的留言;observations/status=观察导出;todo_inbox/todo_status=待办直通与回写
const OUTBOX_FILE = path.join(AGENT_DIR, 'outbox.json');
const OBS_FILE = path.join(AGENT_DIR, 'observations.jsonl');
const STATUS_FILE = path.join(AGENT_DIR, 'status.json');
const TODO_INBOX_FILE = path.join(AGENT_DIR, 'todo_inbox.json');
const TODO_STATUS_FILE = path.join(AGENT_DIR, 'todo_status.json');
// 原子写(临时文件+rename):Agent 轮询读这些文件，绝不能读到半截
function agentWrite(file, data) {
  const tmp = file + '.pet.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
}
// 带本地时区偏移的 ISO 时间(协议里 created_at 是 +08:00 风格，不用 UTC 的 Z)
function isoLocal(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-', ao = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(ao / 60))}:${pad(ao % 60)}`;
}
let agentCfg = {
  poll_interval_seconds: 5,
  max_display_seconds: 10,
  sound_enabled: true,
  position: 'bottom-right',
};

// 目录改名迁移(2026-07-25):旧路径整体搬到 ~/agent_pet,原地留软链,
// 仍写旧路径的 Agent 侧脚本不改也能落到同一份文件
const LEGACY_AGENT_DIR = path.join(os.homedir(), 'seren_pet');
function agentDirMigrate() {
  try {
    const legacyStat = fs.existsSync(LEGACY_AGENT_DIR) ? fs.lstatSync(LEGACY_AGENT_DIR) : null;
    if (legacyStat && !legacyStat.isSymbolicLink() && !fs.existsSync(AGENT_DIR)) {
      fs.renameSync(LEGACY_AGENT_DIR, AGENT_DIR);
    }
    if (!fs.existsSync(LEGACY_AGENT_DIR) && !fs.lstatSync(LEGACY_AGENT_DIR, { throwIfNoEntry: false })) {
      fs.symlinkSync(AGENT_DIR, LEGACY_AGENT_DIR, 'dir');
    }
  } catch { /* 迁移失败不拦启动:新目录照常建,旧目录留待下次再试 */ }
}
function agentInit() {
  agentDirMigrate();
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  if (!fs.existsSync(NOTIF_FILE)) fs.writeFileSync(NOTIF_FILE, '[]');
  // 双向文件建空骨架:Agent 侧轮询脚本不用判断"文件还没出生"
  if (!fs.existsSync(OUTBOX_FILE)) fs.writeFileSync(OUTBOX_FILE, '[]');
  if (!fs.existsSync(TODO_INBOX_FILE)) fs.writeFileSync(TODO_INBOX_FILE, '[]');
  try { agentCfg = { ...agentCfg, ...JSON.parse(fs.readFileSync(AGENT_CFG_FILE, 'utf8')) }; }
  catch { /* 无 config 或损坏:用默认 */ }
}
function readNotifs() {
  // null = 这轮读不了(不存在/半截数据)，下轮重试，绝不崩溃
  try {
    const a = JSON.parse(fs.readFileSync(NOTIF_FILE, 'utf8'));
    return Array.isArray(a) ? a : null;
  } catch { return null; }
}
function writeNotifs(arr) {
  // 原子写:临时文件 + rename，避免 Agent 读到半截
  const tmp = NOTIF_FILE + '.pet.tmp';
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 1));
  fs.renameSync(tmp, NOTIF_FILE);
}
function agentExpired(n) {
  const t = Date.parse(n.created_at);
  return Number.isFinite(t) && (Date.now() - t) / 1000 > (Number(n.ttl_seconds) || 600);
}
const agentSeen = new Set();   // 同名 id 去重(会话内)
const agentQueue = [];         // 同时只展示 1 条，其余排队
let agentDisplaying = false;

function agentPoll() {
  const arr = readNotifs();
  if (!arr) return;
  let dirty = false;
  const keep = [];
  for (const n of arr) {
    if (!(n && typeof n.id === 'string' && n.id && n.title && n.message)) { dirty = true; continue; }
    if (agentExpired(n)) { console.log('[agent] expired->drop', n.id); dirty = true; continue; }
    keep.push(n);
    if (!agentSeen.has(n.id)) { agentSeen.add(n.id); agentQueue.push(n); }
  }
  if (dirty) { try { writeNotifs(keep); } catch {} }
  agentPump();
}
function agentPump() {
  if (agentDisplaying || !agentQueue.length || !win || win.isDestroyed()) return;
  const n = agentQueue.shift();
  agentDisplaying = true;
  const byPrio = { 1: 5, 2: 8, 3: 10 };
  const duration = Math.min(byPrio[n.priority] || 5, agentCfg.max_display_seconds);
  console.log('[agent] display', n.id);
  win.webContents.send('agent-notify', { n, duration, sound: !!agentCfg.sound_enabled });
}
ipcMain.on('agent-shown', (_e, id) => {
  agentDisplaying = false;
  // 展示完毕:重读文件再删自己那条(不丢并发写入的新通知)
  const arr = readNotifs();
  if (arr) {
    const left = arr.filter((x) => !(x && x.id === id));
    if (left.length !== arr.length) {
      try { writeNotifs(left); console.log('[agent] removed', id); } catch {}
    }
  }
  agentPump();
});

/* ---- F1 回信信箱:渲染层"发给 Agent"的留言落盘，Agent 轮询读取、
 * 回信走 notifications.json 老通道，读完标 read=true(Agent 侧动作) ---- */
ipcMain.handle('agent-outbox', (_e, message) => {
  try {
    let arr = [];
    try {
      const a = JSON.parse(fs.readFileSync(OUTBOX_FILE, 'utf8'));
      if (Array.isArray(a)) arr = a;
    } catch { /* 不存在/半截:当空箱重建 */ }
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const id = `msg_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
      `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    arr.push({ id, message: String(message).slice(0, 2000), created_at: isoLocal(d), read: false });
    agentWrite(OUTBOX_FILE, arr.slice(-200)); // 信箱封顶 200 封，Agent 读过就该清
    return true;
  } catch { return false; }
});

/* ---- Part 3 观察导出:方案A jsonl 追加流水 + 方案B status.json 最新快照。
 * 只收"活动级"摘要文本，截图原图不出本机(隐私边界与观察tab一致) ---- */
ipcMain.on('agent-observe', (_e, entry) => {
  try {
    const e = {
      t: isoLocal(new Date(entry.t || Date.now())),
      source: String(entry.source || 'screen_diary').slice(0, 24),
      summary: String(entry.summary || '').slice(0, 200),
      todo_running: entry.todo_running ? String(entry.todo_running).slice(0, 60) : null,
    };
    fs.appendFileSync(OBS_FILE, JSON.stringify(e) + '\n');
    agentWrite(STATUS_FILE, { updated_at: e.t, source: e.source, summary: e.summary, todo_running: e.todo_running });
  } catch { /* 导出失败不影响本体记账 */ }
});

/* ---- Part 4 待办直通:Agent 写 todo_inbox.json → 轮询未导入条目下发渲染层
 * 入清单 → 回执后标 imported=true(与 notifications 同款轮询+回执三件套)。
 * est_minutes 由渲染层 clamp 到 5~90;note 备注进待办卡片并喂给 AI 拆解 ---- */
function todoInboxPoll() {
  if (!win || win.isDestroyed()) return;
  let arr;
  try {
    const a = JSON.parse(fs.readFileSync(TODO_INBOX_FILE, 'utf8'));
    if (!Array.isArray(a)) return;
    arr = a;
  } catch { return; } // 这轮读不了下轮重试
  // 不在主进程记"已发送":渲染层按 sid 去重，回执落盘 imported 后自然停发
  const fresh = arr.filter((t) => t && typeof t.id === 'string' && t.id && t.title && !t.imported);
  if (fresh.length) win.webContents.send('agent-todos', fresh);
}
ipcMain.on('agent-todos-imported', (_e, ids) => {
  try {
    const a = JSON.parse(fs.readFileSync(TODO_INBOX_FILE, 'utf8'));
    if (!Array.isArray(a) || !Array.isArray(ids)) return;
    let dirty = false;
    for (const t of a) {
      if (t && ids.includes(t.id) && !t.imported) { t.imported = true; dirty = true; }
    }
    if (dirty) agentWrite(TODO_INBOX_FILE, a);
  } catch {}
});
// 完成状态回写(闭环增强):渲染层每次存待办都同步快照，Agent 据此更新上游任务系统。
// 渲染层传毫秒时间戳(*_ms),这里统一转协议风格的本地 ISO(+08:00,与 created_at 同款)
ipcMain.on('agent-todo-status', (_e, snap) => {
  try {
    const iso = (ms) => (Number.isFinite(ms) && ms > 0 ? isoLocal(new Date(ms)) : null);
    if (snap.current) {
      snap.current.started_at = iso(snap.current.started_at_ms);
      delete snap.current.started_at_ms;
    }
    for (const t of snap.todos || []) { t.done_at = iso(t.done_at_ms); delete t.done_at_ms; }
    for (const h of snap.history || []) { h.done_at = iso(h.done_at_ms); delete h.done_at_ms; }
    agentWrite(TODO_STATUS_FILE, { updated_at: isoLocal(), ...snap });
  } catch {}
});

function createWindow() {
  // 窗口 = 当前屏工作区(屏幕减 Dock/菜单栏)。曾试过铺满整屏+高层级盖住
  // Dock，实测 macOS 会干预窗口边界导致启动后跳位/底角截断，已回滚
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: workArea.width,
    height: workArea.height,
    x: workArea.x,
    y: workArea.y,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // 桌宠失焦时动画也不能停
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 默认鼠标穿透(透明区域不挡桌面);renderer 悬停到交互元素时再关闭穿透
  win.setIgnoreMouseEvents(true, { forward: true });
  const st = process.argv.find((a) => a.startsWith('--selftest='));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'),
    st ? { query: { selftest: st.split('=')[1] } } : undefined);
  // 自测模式下把渲染层 console 转进主进程日志(selftest 结果才能落盘)
  if (st) {
    win.webContents.on('console-message', (_e, _lvl, msg) => {
      if (msg.includes('[selftest')) console.log(msg);
    });
  }

  if (SMOKE || st) {
    // 16s:足够跑完一条 priority=2 通知的完整"展示 8s → 回执删除"链路;
    // 集成自测(selftest=all)要跑完整场景,放宽到 60s。
    // selftest 也要定时退出:只传 --selftest 不带 --smoke 时 app 会永远活着,
    // CI/命令行管道等 EOF 等到天荒地老(07-27"selftest 卡死"三连的真相)
    const ms = process.argv.some((a) => a.includes('selftest=all')) ? 60000 : 16000;
    setTimeout(() => { console.log('[smoke] ok, quitting'); app.quit(); }, ms);
  }
}

ipcMain.handle('set-ignore', (_e, flag) => {
  if (win) win.setIgnoreMouseEvents(flag, { forward: true });
});

ipcMain.on('drag-by', (_e, { dx, dy }) => {
  if (!win) return;
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + dx), Math.round(y + dy));
});

// 铺满指定工作区。resizable:false 时 macOS 会忽略 setBounds 里的尺寸(只挪位置),
// 导致跨分辨率跳屏后窗口大小卡在旧屏尺寸("主屏没铺满")，必须临时放开再锁回
function fitWindowTo(wa) {
  if (!win || win.isDestroyed()) return;
  const cur = win.getBounds();
  if (cur.x === wa.x && cur.y === wa.y && cur.width === wa.width && cur.height === wa.height) return;
  win.setResizable(true);
  win.setBounds(wa);
  win.setResizable(false);
}

// 桌宠窗口当前所在的显示器
function currentDisplay() {
  return screen.getDisplayMatching(win.getBounds());
}

// 多显示器跳岛:光标(屏幕坐标)在哪块屏，窗口就铺满哪块屏的工作区
ipcMain.handle('move-to-display', (_e, { x, y }) => {
  if (!win) return null;
  const d = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
  fitWindowTo(d.workArea);
  return d.workArea;
});

ipcMain.handle('capture-screen', async () => {
  try {
    const { systemPreferences } = require('electron');
    if (process.platform === 'darwin' &&
        systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
      return { ok: false, err: 'no-permission' };
    }
    // 截"桌宠所在的那块屏"(跳岛后跟着走)，按该屏比例出图
    const d = currentDisplay();
    const th = Math.round(1440 * d.size.height / Math.max(d.size.width, 1));
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1440, height: Math.min(Math.max(th, 400), 1440) },
    });
    if (!sources.length) return { ok: false, err: 'no-source' };
    const src = sources.find((s) => s.display_id === String(d.id)) || sources[0];
    return { ok: true, data: src.thumbnail.toJPEG(72).toString('base64') };
  } catch (e) {
    return { ok: false, err: String(e.message || e).slice(0, 120) };
  }
});

// 配置后台(开发者模式)窗口
let promptsWin = null;
ipcMain.on('open-prompts', () => {
  if (promptsWin && !promptsWin.isDestroyed()) { promptsWin.focus(); return; }
  promptsWin = new BrowserWindow({
    width: 760, height: 860, title: '配置后台',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  promptsWin.loadFile(path.join(__dirname, 'renderer', 'prompts.html'));
});
ipcMain.on('prompts-saved', () => {
  if (win && !win.isDestroyed()) win.webContents.send('config-changed');
});

ipcMain.handle('get-config', () => {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); }
  catch { return null; }
});

ipcMain.handle('set-config', (_e, cfg) => {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  return true;
});

/* ================= 角色包(persona)存储 =================
 * userData/personas/<id>/ 一个文件夹一个形象;config.activePersona 指向当前生效 id。
 * 包格式 v1:persona.json + manifest.json(动画 map) + <槽位>.webp + fx_<名字>.webp/.mp4 */
const PERSONAS_DIR = () => path.join(app.getPath('userData'), 'personas');

function personaList() {
  try {
    return fs.readdirSync(PERSONAS_DIR(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        try {
          const pj = JSON.parse(fs.readFileSync(path.join(PERSONAS_DIR(), d.name, 'persona.json'), 'utf8'));
          const man = JSON.parse(fs.readFileSync(path.join(PERSONAS_DIR(), d.name, 'manifest.json'), 'utf8'));
          return { id: d.name, ...pj, animCount: Object.keys(man).length, anims: Object.keys(man) };
        } catch { return null; } // 缺文件/损坏的包不进列表
      })
      .filter(Boolean);
  } catch { return []; }
}

ipcMain.handle('persona-list', personaList);

// zip 解包:系统 bsdtar 就地解到临时目录(mac /usr/bin/tar 与 win10+ tar.exe 都认 zip,
// 免带解压依赖);返回含 persona.json 的目录(允许 zip 根下套一层文件夹)
function extractPackZip(zipPath) {
  const os = require('os');
  const { execFileSync } = require('child_process');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mantou-pack-'));
  execFileSync('tar', ['-xf', zipPath, '-C', tmp], { timeout: 60000 });
  if (fs.existsSync(path.join(tmp, 'persona.json'))) return tmp;
  for (const d of fs.readdirSync(tmp)) {
    const p = path.join(tmp, d);
    if (fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'persona.json'))) return p;
  }
  throw new Error('压缩包里没找到 persona.json');
}

ipcMain.handle('persona-import', async () => {
  const { dialog } = require('electron');
  // mac 一个对话框可同时选文件夹或 zip;win/linux 二选一,给 zip(文件夹用户可先压包)
  const r = await dialog.showOpenDialog({
    title: '选择角色包(zip 或文件夹,含 persona.json + manifest.json)',
    properties: process.platform === 'darwin' ? ['openFile', 'openDirectory'] : ['openFile'],
    filters: [{ name: '角色包', extensions: ['zip'] }],
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false, err: 'canceled' };
  let src = r.filePaths[0];
  let tmpRoot = null;
  try {
    if (fs.statSync(src).isFile()) {
      if (!/\.zip$/i.test(src)) return { ok: false, err: '只支持 zip 压缩包或文件夹' };
      src = extractPackZip(src);
      tmpRoot = src;
    }
    const pj = JSON.parse(fs.readFileSync(path.join(src, 'persona.json'), 'utf8'));
    const man = JSON.parse(fs.readFileSync(path.join(src, 'manifest.json'), 'utf8'));
    if (!pj.id || !pj.name) return { ok: false, err: 'persona.json 缺 id/name' };
    if (!man.idle) return { ok: false, err: 'idle 待机动画必传' };
    if (!fs.existsSync(path.join(src, 'idle.webp'))) return { ok: false, err: '缺 idle.webp' };
    // manifest 里声明的动画，对应 webp 必须都在(缺的剔出清单，不挡导入)
    for (const k of Object.keys(man)) {
      if (!fs.existsSync(path.join(src, k + '.webp'))) delete man[k];
    }
    const dst = path.join(PERSONAS_DIR(), pj.id);
    fs.rmSync(dst, { recursive: true, force: true }); // 同 id 覆盖重装
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(src)) {
      if (/\.(webp|mp4|json)$/.test(f)) fs.copyFileSync(path.join(src, f), path.join(dst, f));
    }
    fs.writeFileSync(path.join(dst, 'manifest.json'), JSON.stringify(man, null, 1));
    return { ok: true, id: pj.id, name: pj.name, animCount: Object.keys(man).length };
  } catch (e) { return { ok: false, err: String(e.message || e).slice(0, 120) };
  } finally {
    // zip 解出来的临时目录用完即焚(tmpRoot 可能是 tmp 根下一层,删根)
    if (tmpRoot) {
      const os = require('os');
      let root = tmpRoot;
      while (path.dirname(root) !== os.tmpdir() && path.dirname(root) !== root) root = path.dirname(root);
      try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    }
  }
});

ipcMain.handle('persona-delete', (_e, id) => {
  try {
    if (!/^[\w-]+$/.test(id)) return false;
    fs.rmSync(path.join(PERSONAS_DIR(), id), { recursive: true, force: true });
    // 删的是当前生效包:自动回落馒头
    const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    if (cfg.activePersona === id) {
      delete cfg.activePersona;
      fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
      if (win && !win.isDestroyed()) win.webContents.send('config-changed');
    }
    return true;
  } catch { return false; }
});

// 激活/切回馒头(id=null):只写配置，渲染层收 config-changed 自行热切换
ipcMain.handle('persona-activate', (_e, id) => {
  try {
    // 启用底线:待机动画必须有(自建包传完 idle 才算能站上桌面)
    if (id) {
      try {
        const man = JSON.parse(fs.readFileSync(
          path.join(PERSONAS_DIR(), id, 'manifest.json'), 'utf8'));
        if (!man.idle) return false;
      } catch { return false; }
    }
    const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    if (id) cfg.activePersona = id; else delete cfg.activePersona;
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
    if (win && !win.isDestroyed()) win.webContents.send('config-changed');
    return true;
  } catch { return false; }
});

// 改包内 persona.json 的显示高度(px);广播 persona-refresh 让生效中的形象热应用
// (走 config-changed 没用:activePersona 没变时渲染端不会重读 persona.json)
ipcMain.handle('persona-set-size', (_e, { id, height }) => {
  try {
    if (!/^[\w-]+$/.test(id)) return false;
    const pj = path.join(PERSONAS_DIR(), id, 'persona.json');
    const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
    j.displayHeight = Math.max(120, Math.min(1200, Math.round(height)));
    fs.writeFileSync(pj, JSON.stringify(j, null, 1));
    if (win && !win.isDestroyed()) win.webContents.send('persona-refresh');
    return true;
  } catch { return false; }
});

// 配置后台编辑包元数据(情绪场合 emoDesc / 动画映射 emoAliases):写回 persona.json,
// 通知桌宠热刷新元数据(不重载雪碧图)
ipcMain.handle('persona-set-meta', (_e, { id, meta }) => {
  try {
    if (!/^[\w-]+$/.test(id)) return false;
    const pj = path.join(PERSONAS_DIR(), id, 'persona.json');
    const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
    if (meta && typeof meta.emoDesc === 'object') j.emoDesc = meta.emoDesc;
    if (meta && typeof meta.emoAliases === 'object') j.emoAliases = meta.emoAliases;
    // 彩蛋禁用清单:只收 egg_ 槽位(功能路由槽位禁了动画就播不出来,不许禁)
    if (meta && Array.isArray(meta.disabledEggs))
      j.disabledEggs = meta.disabledEggs.map(String).filter((k) => /^egg_[\w-]+$/.test(k));
    fs.writeFileSync(pj, JSON.stringify(j, null, 1));
    if (win && !win.isDestroyed()) win.webContents.send('persona-refresh');
    return true;
  } catch { return false; }
});
// 配置后台点动画 → 桌宠真机预览
ipcMain.handle('persona-preview-anim', (_e, name) => {
  if (win && !win.isDestroyed()) win.webContents.send('play-anim', String(name).slice(0, 40));
  return true;
});

// 渲染层按需取包文件(雪碧图/特效)，返回 file:// 路径;不传 id 时用当前激活包
ipcMain.handle('persona-file', (_e, { id, file }) => {
  const pid = id || (() => {
    try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')).activePersona; } catch { return null; }
  })();
  if (!pid || !/^[\w-]+$/.test(pid) || !/^[\w.-]+$/.test(file)) return null;
  const p = path.join(PERSONAS_DIR(), pid, file);
  return fs.existsSync(p) ? 'file://' + p : null;
});

ipcMain.handle('persona-manifest', (_e, id) => {
  const pid = id || (() => {
    try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')).activePersona; } catch { return null; }
  })();
  if (!pid || !/^[\w-]+$/.test(pid)) return null;
  try {
    const dir = path.join(PERSONAS_DIR(), pid);
    return {
      persona: JSON.parse(fs.readFileSync(path.join(dir, 'persona.json'), 'utf8')),
      manifest: JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')),
    };
  } catch { return null; }
});

/* ---- 包内生产(配置后台雪碧图工坊):建空包 / 写动画 / 删动画 / 说明书 ---- */
// 新建人设:只要名字就能建(persona.json + 空 manifest);性格等信息由渲染层
// 写进 config.personaBindings(不填=运行时默认底稿),这里不管
ipcMain.handle('persona-create', (_e, name) => {
  const nm = String(name || '').trim().slice(0, 24);
  if (!nm) return { ok: false, err: '名字不能为空' };
  // id 用时间戳+随机,与导入包的作者 id 空间天然不撞
  const id = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  try {
    const dir = path.join(PERSONAS_DIR(), id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'persona.json'),
      JSON.stringify({ id, name: nm, displayHeight: 360 }, null, 1));
    fs.writeFileSync(path.join(dir, 'manifest.json'), '{}');
    return { ok: true, id, name: nm };
  } catch (e) { return { ok: false, err: String(e.message || e).slice(0, 120) }; }
});

// 写入一条动画:渲染层抠图打包好的雪碧图(webp dataURL)+manifest 条目落盘。
// entry 只收数值字段,防止渲染层被注入奇怪结构
ipcMain.handle('persona-write-anim', (_e, { id, slot, dataUrl, entry }) => {
  try {
    if (!/^[\w-]+$/.test(id) || !/^[a-z0-9_]{1,24}$/.test(slot || '')) return { ok: false, err: '参数非法' };
    const m = /^data:image\/webp;base64,(.+)$/.exec(dataUrl || '');
    if (!m) return { ok: false, err: '雪碧图数据非法' };
    const dir = path.join(PERSONAS_DIR(), id);
    const manPath = path.join(dir, 'manifest.json');
    const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));
    const ent = {};
    for (const k of ['frames', 'cols', 'fw', 'fh', 'fps', 'dx', 'dy', 'canvasW', 'canvasH']) {
      const v = +entry[k];
      if (!Number.isFinite(v)) return { ok: false, err: `manifest 缺字段 ${k}` };
      ent[k] = k === 'fps' ? v : Math.round(v);
    }
    fs.writeFileSync(path.join(dir, slot + '.webp'), Buffer.from(m[1], 'base64'));
    man[slot] = ent;
    fs.writeFileSync(manPath, JSON.stringify(man, null, 1));
    if (win && !win.isDestroyed()) win.webContents.send('persona-refresh');
    return { ok: true };
  } catch (e) { return { ok: false, err: String(e.message || e).slice(0, 120) }; }
});

ipcMain.handle('persona-remove-anim', (_e, { id, slot }) => {
  try {
    if (!/^[\w-]+$/.test(id) || !/^[a-z0-9_]{1,24}$/.test(slot || '')) return { ok: false, err: '参数非法' };
    const cfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    if (slot === 'idle' && cfg.activePersona === id)
      return { ok: false, err: 'idle 是启用底线,先切回馒头再删' };
    const dir = path.join(PERSONAS_DIR(), id);
    const manPath = path.join(dir, 'manifest.json');
    const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));
    delete man[slot];
    fs.rmSync(path.join(dir, slot + '.webp'), { force: true });
    fs.writeFileSync(manPath, JSON.stringify(man, null, 1));
    if (win && !win.isDestroyed()) win.webContents.send('persona-refresh');
    return { ok: true };
  } catch (e) { return { ok: false, err: String(e.message || e).slice(0, 120) }; }
});

// 操作说明:打包在 app 里的纯文本(txt 而非 md:不是人人有 markdown 阅读器,
// 记事本/文本编辑双击就开,用户拍板 07-28)。打开=拷到临时目录再交给系统默认
// 程序(asar 里的文件 shell.openPath 打不开,必须先落地);导出=存到用户选的位置
ipcMain.handle('persona-open-guide', async (_e, mode) => {
  const src = path.join(__dirname, 'docs', '角色包制作指南.txt');
  try {
    if (mode === 'export') {
      const { dialog } = require('electron');
      const r = await dialog.showSaveDialog({ defaultPath: '角色包制作指南.txt' });
      if (r.canceled || !r.filePath) return { ok: false, err: 'canceled' };
      fs.copyFileSync(src, r.filePath);
      return { ok: true, path: r.filePath };
    }
    const os = require('os');
    const tmp = path.join(os.tmpdir(), 'mantou-角色包制作指南.txt');
    fs.copyFileSync(src, tmp);
    const err = await require('electron').shell.openPath(tmp);
    return err ? { ok: false, err } : { ok: true };
  } catch (e) { return { ok: false, err: String(e.message || e).slice(0, 120) }; }
});

// 今日天气(wttr.in 按 IP 定位，免 key)
ipcMain.handle('get-weather', () => new Promise((res) => {
  const https = require('https');
  const req = https.get('https://wttr.in/?format=j1&lang=zh',
    { headers: { 'User-Agent': 'curl/8' }, timeout: 8000 }, (r) => {
      let b = '';
      r.on('data', (c) => (b += c));
      r.on('end', () => {
        try {
          const j = JSON.parse(b);
          const c = j.current_condition[0], t = j.weather[0];
          res({
            now: (c.lang_zh && c.lang_zh[0].value) || c.weatherDesc[0].value,
            temp: c.temp_C, min: t.mintempC, max: t.maxtempC,
            area: (j.nearest_area && j.nearest_area[0].areaName[0].value) || '',
          });
        } catch { res(null); }
      });
    });
  req.on('error', () => res(null));
  req.on('timeout', () => { req.destroy(); res(null); });
}));

ipcMain.handle('get-store', (_e, name) => {
  try { return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), name + '.json'), 'utf8')); }
  catch { return null; }
});
ipcMain.handle('set-store', (_e, name, data) => {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(path.join(app.getPath('userData'), name + '.json'), JSON.stringify(data));
  return true;
});

// 自习室打卡图:渲染层出好 PNG dataURL,这里只管存盘(默认下载目录,可改路径)
ipcMain.handle('study-save-card', async (_e, dataUrl) => {
  try {
    const { dialog } = require('electron');
    const m = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl) || '');
    if (!m) return { ok: false, err: '图像数据不对' };
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const r = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath('downloads'), `自习打卡_${stamp}.png`),
      filters: [{ name: 'PNG', extensions: ['png'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, err: 'canceled' };
    fs.writeFileSync(r.filePath, Buffer.from(m[1], 'base64'));
    return { ok: true, path: r.filePath };
  } catch (err) { return { ok: false, err: err.message }; }
});

// 正在播放 / 音乐进程门禁 / 开机自启:跨平台实现见 platform.js
ipcMain.handle('now-playing', () => platform.nowPlaying());
ipcMain.handle('music-app-running', () => platform.musicAppRunning());
ipcMain.handle('get-autostart', () => platform.getAutostart());
ipcMain.handle('set-autostart', (_e, on) => platform.setAutostart(on));

// 打开系统隐私设置对应面板(屏幕录制无法程序化授权，只能替用户跳到开关前)。
// 仅 macOS 需要:Windows 截屏/音频回环都不需授权,渲染层也不会调这个。
ipcMain.on('open-privacy', (_e, pane) => {
  const { shell } = require('electron');
  if (process.platform === 'win32') {
    shell.openExternal('ms-settings:privacy'); // 兜底入口,一般用不到
    return;
  }
  const map = {
    screen: 'Privacy_ScreenCapture',
    mic: 'Privacy_Microphone',
    accessibility: 'Privacy_Accessibility',
  };
  shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${map[pane] || 'Privacy'}`);
});

ipcMain.on('quit-app', () => app.quit());

/* ---- F2 精简版(2026-07-23 拍板):不做 deep link，只做"一键把扣子拉到面前"。
 * 检测扣子客户端进程(在跑渲染层才亮悬浮按钮)，点击 open 其 .app 激活到前台 ---- */
function cozeProcUp() {
  // 不能用 ps 输出配中文:ps 会把非 ASCII 路径转义("扣子"变 M-f...)。
  // pgrep -f 对真实命令行匹配,UTF-8 可用;再兜一层主二进制名 Coze(实测两条都命中)
  const { execSync } = require('child_process');
  for (const pat of ['扣子\\.app/Contents/MacOS/', '/Coze\\.app/Contents/MacOS/', 'MacOS/Coze$']) {
    try { execSync(`pgrep -f "${pat}"`, { stdio: 'pipe' }); return true; } catch { /* 没命中试下一条 */ }
  }
  return false;
}
async function cozeRunning() {
  if (process.platform !== 'darwin') return false; // win 待真机验证后补
  if (!cozeProcUp()) return false;
  // 进程在跑≠"打开着":扣子点红叉关窗后进程常驻(Electron 通病,实测窗口数掉 0
  // 进程照样 pgrep 命中),用户视角已经关了。再查一层可见窗口数兜住这种假开;
  // 查不了(比如没给辅助功能权限)就退回进程判定,不比老行为差
  return new Promise((resolve) => {
    require('child_process').execFile('osascript', ['-e',
      'tell application "System Events" to count windows of (first process whose name is "Coze" or name is "扣子")'],
      { timeout: 3000 }, (err, out) => resolve(err ? true : parseInt(out, 10) > 0));
  });
}
ipcMain.handle('coze-detect', () => cozeRunning());
ipcMain.handle('coze-open', () => {
  for (const name of ['扣子', 'Coze']) {
    try { require('child_process').execSync(`open -a "${name}"`, { stdio: 'pipe' }); return true; } catch {}
  }
  return false;
});

// 本地"让桌宠说话"接口:POST http://127.0.0.1:8631/say {"text":"...","emo":"happy"}
// 只监听本机回环，外部脚本/快捷指令/Agent 都可调用
function startSayServer() {
  const http = require('http');
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/say') {
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
      req.on('end', () => {
        try {
          const { text, emo } = JSON.parse(body || '{}');
          if (win && text) win.webContents.send('external-say',
            { text: String(text).slice(0, 300), emo: String(emo || 'neutral') });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        } catch { res.writeHead(400); res.end('{"ok":false}'); }
      });
    } else { res.writeHead(404); res.end(); }
  });
  srv.on('error', () => {});
  srv.listen(8631, '127.0.0.1'); // 8630 是前身版本，馒头版用 8631，两只可同时在线
}

// 单实例锁:双屏下桌宠"跑丢"再点启动器会开出第二只——双份内存双份轮询,
// 还互抢通讯文件回执(用户实锤)。二启不开新窗,把已有那只拉回主屏工作区示人,
// 正好治"找不到它以为关了"的场景。selftest 模式不抢锁(要和真机并行跑)
const isSelftest = process.argv.some((a) => a.startsWith('--selftest'));
if (!isSelftest && !app.requestSingleInstanceLock()) {
  app.exit(0);
}
app.on('second-instance', () => {
  if (win && !win.isDestroyed()) {
    fitWindowTo(screen.getPrimaryDisplay().workArea);
    win.show();
  }
});

/* ================= 检查更新(轻量版) =================
 * 不走 electron-updater 自动装(未签名 mac 包过不了替换校验),只做
 * "查 GitHub latest release → 比版本 → 通知渲染端提示手动下载"。
 * 零依赖:主进程自带 fetch;离线/限流静默,下次启动再查 */
const UPDATE_REPO = 'Bunnnnn-722/mantou-deskpet';
let updateUrl = null; // 渲染端点「去下载」只开这里存的地址
function verNewer(a, b) { // 'v0.2.1' > '0.1.0' ?
  const pa = String(a).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}
async function checkUpdate() {
  try {
    const r = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`,
      { headers: { 'User-Agent': 'mantou-pet' } });
    if (!r.ok) return;
    const rel = await r.json();
    if (!rel.tag_name || !verNewer(rel.tag_name, app.getVersion())) return;
    updateUrl = rel.html_url || `https://github.com/${UPDATE_REPO}/releases/latest`;
    if (win && !win.isDestroyed())
      win.webContents.send('update-available', { version: rel.tag_name.replace(/^v/i, '') });
  } catch {}
}
ipcMain.on('open-update', () => {
  if (updateUrl) require('electron').shell.openExternal(updateUrl);
});

app.whenReady().then(() => {
  // 系统音频回环:听歌点头改听"系统播出的声音"。
  // macOS 走 ScreenCaptureKit(复用屏幕录制权限);Windows 走 WASAPI 回环(无需授权)。
  const { session } = require('electron');
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    // 回调只许调一次:旧写法 callback 自身抛错会掉进 catch 再调一次，产生
    // "One-time callback was called more than once" 未处理拒绝(启动日志实测)
    let called = false;
    const done = (v) => { if (called) return; called = true; try { callback(v); } catch {} };
    desktopCapturer.getSources({ types: ['screen'] }).then(
      (sources) => done(sources.length ? { video: sources[0], audio: 'loopback' } : {}),
      () => done({}),
    );
  });
  startSayServer();
  agentInit();
  setTimeout(() => { agentPoll(); todoInboxPoll(); }, 2500);   // 启动后先扫一次积压
  setInterval(() => { agentPoll(); todoInboxPoll(); }, Math.max(2, agentCfg.poll_interval_seconds) * 1000);
  // 分辨率/Dock/菜单栏变化(或插拔显示器)时，重新铺满当前所在屏;启动后也校一次
  // (LaunchAgent 拉起时 Dock 可能尚未就绪，拿到的 workArea 偏小)
  const refit = () => { if (win && !win.isDestroyed()) fitWindowTo(currentDisplay().workArea); };
  screen.on('display-metrics-changed', refit);
  screen.on('display-added', refit);
  screen.on('display-removed', refit);
  setTimeout(refit, 3000);
  setTimeout(checkUpdate, 20000);                  // 启动稳定后查一次更新
  setInterval(checkUpdate, 24 * 3600 * 1000);      // 常驻不重启的场景:每天复查
  if (process.platform === 'darwin' && app.dock) {
    const ic = path.join(__dirname, 'dock_icon.png');
    if (fs.existsSync(ic)) app.dock.setIcon(nativeImage.createFromPath(ic));
  }
  createWindow();
});
app.on('window-all-closed', () => app.quit());
