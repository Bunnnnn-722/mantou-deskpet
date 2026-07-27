'use strict';
/* ================= 启动 ================= */

/* 配置热加载(配置后台保存/形象切换都走这里;selftest 也直接调用)。
 * 必须以 DEFAULT_CFG 为底重建,不能 merge 到旧 CFG 上:磁盘上被"删除"的键
 * (如切回馒头时删掉的 activePersona)会被旧值借尸还魂,判定"形象没变"
 * 导致热切换失效 —— 实测踩坑 */
/* 黑白双模式:html.dark 一个类切全套令牌(style.css :root.dark 段) */
function applyTheme() {
  document.documentElement.classList.toggle('dark', !!CFG.darkMode);
}

async function handleConfigChanged() {
  const prevPersona = CFG.activePersona || null;
  const fresh = await API.getConfig();
  if (fresh) CFG = mergeCfg(DEFAULT_CFG, fresh);
  applyTheme();
  if ((CFG.activePersona || null) !== prevPersona) {
    await Persona.refresh();
    Player.backToIdle();
    // 能力门控重评估:新形象缺依赖动画 → 进行中的功能就地收掉
    // (CFG 偏好保留,切回有动画的形象自动恢复;设置面板开着就重渲染刷置灰态)
    if (S.sleeping && !Persona.canFeature('nightSleep')) wakeUp(true);
    if (CFG.musicMode && !Persona.canFeature('musicMode') && Music.stream) {
      Music.stop();
      showToast('新形象没有点头动画，听歌点头先歇了');
    } else if (CFG.musicMode && Persona.canFeature('musicMode') && !Music.stream) {
      Music.start(true); // 从缺动画的形象切回来:偏好还开着就把听歌拾回
    }
    if (S.panel === 'panel-settings') renderSettings();
    showToast(Persona.active ? `形象已切换:${Persona.active.name}` : '形象已切回馒馒');
  } else {
    // 形象没变的后台保存(提示词/人设绑定):设置面板开着就重渲染——
    // 后台「形象」页与设置面板的人设编辑框绑同一字段,两处改动互相可见
    if (S.panel === 'panel-settings') renderSettings();
    showToast('配置已更新');
  }
}

(async function init() {
  const saved = await API.getConfig();
  if (saved) CFG = mergeCfg(DEFAULT_CFG, saved);
  // 一次性迁移(2026-07-19 人设合并):旧版性格预设存的是纯性格文案(不含身份句),
  // 撞上就清空，让新的"身份+性格"合并底稿(DEFAULT_PERSONA)生效
  const OLD_PRESETS = [
    '你温柔体贴，说话软软的，喜欢鼓励人，偶尔撒娇。',
    '你活泼外向，语气充满元气，爱用感叹号，像个小太阳。',
    '你毒舌傲娇，喜欢用简短犀利的话戳穿对方，但内心是关心的。',
    '你清冷淡漠，话少，句子短，语气平静疏离，但句句在点子上。偶尔流露一丝不易察觉的在意。',
  ];
  // 逗号归一化再比对:磁盘上存的可能是半角逗号旧版,数组文案已是全角(2026-07-19 全角化)
  const normP = (s) => String(s || '').trim().replace(/,/g, '，');
  if (OLD_PRESETS.some((p) => normP(p) === normP(CFG.customPersonality))) CFG.customPersonality = '';
  // 一次性迁移(2026-07-19 服务商化):旧配置只有 base/protocol,按 Base URL 推断出
  // provider 写回,此后协议与关思考方言都跟着服务商走
  let provMigrated = false;
  for (const k of ['chatApi', 'chatApi2', 'visionApi']) {
    if (CFG[k] && !CFG[k].provider && CFG[k].base) {
      CFG[k].provider = inferProvider(CFG[k]) || '';
      provMigrated = provMigrated || !!CFG[k].provider;
    }
  }
  // 一次性迁移(2026-07-23 字段中性化):serenShare→agentShare、提示词键
  // line_seren_todo→line_agent_todo(用户在配置后台改过的覆盖跟着搬家)
  let fieldMigrated = false;
  if (CFG.serenShare !== undefined && CFG.agentShare === undefined) {
    CFG.agentShare = CFG.serenShare; delete CFG.serenShare; fieldMigrated = true;
  }
  if (CFG.prompts && CFG.prompts.line_seren_todo && !CFG.prompts.line_agent_todo) {
    CFG.prompts.line_agent_todo = CFG.prompts.line_seren_todo;
    delete CFG.prompts.line_seren_todo; fieldMigrated = true;
  }
  // 一次性迁移(2026-07-24 人设按形象绑定):老全局 petName/customPersonality
  // 搬进 personaBindings['mantou'](放在 OLD_PRESETS 清洗之后,旧预设文案不入绑定)
  if (!(CFG.personaBindings || {}).mantou) {
    CFG.personaBindings = { ...(CFG.personaBindings || {}),
      mantou: { petName: CFG.petName || '', customPersonality: CFG.customPersonality || '' } };
    fieldMigrated = true;
  }
  if (provMigrated || fieldMigrated) API.setConfig(CFG);
  applyTheme();
  await loadConvs();
  S.reports = (await API.getStore('reports')) || [];
  // 待办跨重启持久化 + 追踪状态还原:有合法存档(对应待办仍是 doing)→ 接着执行
  // 并继续屏摄监督;没有存档才把 doing 打回 pending(由用户重新开始)
  S.todos = (await API.getStore('todos')) || [];
  S.doneLedger = (await API.getStore('doneLedger')) || []; // 完成/跳过台账(todo_status 快照用)
  S.obsMark = (await API.getStore('obsMark')) || 0;        // 观察导出水位线
  const tk = await API.getStore('tracking');
  if (tk && typeof tk.curIdx === 'number' && S.todos[tk.curIdx]?.status === 'doing') {
    S.tracking = true;
    S.curIdx = tk.curIdx;
    S.timer = tk.timer || null;   // 绝对时间戳，离线期间照常流逝，倒计时自然继续
    scheduleCheck();
  } else {
    S.todos = S.todos.map((t) => ({ ...t, status: t.status === 'doing' ? 'pending' : t.status }));
  }
  // 快照对齐(真机反馈#3/#4):重启后立即把真实 tracking/清单回写 todo_status.json——
  // 只等下次 renderTodo 会留一段"tracking:false 配 doing"的矛盾快照(线上实锤)
  saveTodos();
  await Player.init();
  setupPassthrough();
  setupHover();
  setupPetMouse();
  setupChat();
  FX.init();
  API.onExternalSay(({ text, emo }) => { S.lastActive = Date.now(); wakeUp(true); sayLocal(text, emo); });
  // 配置后台联动:点动画→真机预览;改情绪协议→热刷新包元数据
  API.onPlayAnim?.((name) => {
    S.lastActive = Date.now();
    wakeUp(true);
    Player.play(name, { prio: PRIORITY.touch }); // 单次播完自动回待机
  });
  API.onPersonaRefresh?.(async () => { await Persona.reloadMeta(); showToast('形象配置已更新'); });
  // Agent 日程通知(本地协议 v1.0):主进程轮询 ~/agent_pet/，这里只管展示与回执
  API.onNotify?.(({ n, duration, sound }) => {
    S.lastActive = Date.now();
    wakeUp(true);
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    showBubble(`<b>${esc(n.title)}</b><br>${esc(n.message)}`, duration * 1000);
    if (n.type === 'push') playEmo('happy');
    else if (n.type === 'reminder') Player.play('touch_body', { prio: PRIORITY.emo });
    else if (n.type === 'sleep_warning') playEmo('speechless');
    if (sound) blip(n.priority >= 3 ? 'angry' : 'happy');
    setTimeout(() => {
      if (Player.cur?.prio === PRIORITY.emo && !S.speaking) Player.requestIdle(); // 通知播的情绪也走循环边界收尾(说话中的交给收尾定时器)
      API.agentShown?.(n.id);   // 回执后主进程才从文件删这条并放行下一条
    }, duration * 1000 + 300);
  });
  // Agent 待办直通(Part4):主进程轮询 todo_inbox.json → 这里入清单 + 回执
  API.onAgentTodos?.((list) => {
    S.lastActive = Date.now();
    wakeUp(true);
    importSerenTodos(list);
  });
  API.onConfigChanged?.(handleConfigChanged); // 配置后台保存/形象切换后热加载
  // 检查更新(轻量版):留个「去下载」入口在设置面板,气泡只提示一次
  API.onUpdateAvailable?.((info) => {
    S.updateInfo = info;
    if (S.panel === 'panel-settings') renderSettings();
    showBubble(`有新版本 v${info.version} 啦～<br><span class="hint">设置面板里点「去下载」手动更新</span>`, 10000);
  });
  S.misc = (await API.getStore('misc')) || {};
  // 随机屏摄日记:还原今天的观察记录(隔天的丢弃)，再把定时器排上
  const jn = await API.getStore('journal');
  if (jn && jn.notes) S.journal = jn.notes; // 观察流水持久保留(上限 100 条,不跨天清)
  exportObservations(); // 水位线补发:上次会话漏导出的观察补进 ~/agent_pet/ 流水
  scheduleJournal();
  setupIdleWatchers();
  updateWeeklyDot();
  setTimeout(morningWeather, 9000);
  scheduleEgg();
  // 开机初次取流延后 3 秒:启动瞬间抢系统声音回环会拿到死产流(ScreenCaptureKit 未就绪)
  if (CFG.musicMode) setTimeout(() => Music.start(), 3000);
  setInterval(() => { // 设置面板里的听歌状态实时刷新
    const el = document.getElementById('music-status');
    if (el && CFG.musicMode) el.textContent = Music.status;
  }, 1000);
  // 自测通道(--selftest=xxx):用例全部在 selftest.js，只在带标志时动态加载，
  // 不进正式路径(此处在 init 尾部注入，selftest 全局依赖已就绪)
  if ((window.location.search + (window.process?.argv || '')).includes('selftest=')) {
    const sc = document.createElement('script');
    sc.src = 'selftest.js';
    document.body.appendChild(sc);
  }
  // 开机:有浮现素材先播浮现，问候语从预设池随机
  const GREETS = P('greetings').split('\n').filter(Boolean);
  // 浮现在 Player.init 里已作为首帧播放，这里只管问候语的时机
  const greetDelay = Player.manifest['appear'] ? 2000 : 800; // 馒头浮现 1.7s，问候紧随其后
  setTimeout(() => showBubble(`${GREETS[Math.floor(Math.random() * GREETS.length)]}<br><span class="hint">悬停:待办 / 聊天 / 设置</span>`, 5000), greetDelay);
})();
