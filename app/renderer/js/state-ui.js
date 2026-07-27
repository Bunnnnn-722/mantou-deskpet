'use strict';
const S = {
  // 界面
  panel: null,          // 当前打开的面板 id('panel-todo' 等，null=全关)
  speaking: false,      // 打字机吐字中(说话期间不接受新的说话请求)
  speechBeat: 0,        // 说话引擎心跳(打字机每 tick 刷新;看门狗判"speaking 卡死"用)
  histView: false,      // 聊天面板是否停在"历史列表"视图
  // 待办 / 追踪
  todos: [], curIdx: -1, tracking: false,
  plan: null,           // AI 拆解确认页的暂存方案(确认/还原后清空)
  taskHistory: [],      // 今日结算用:完成/跳过的任务流水
  timer: null,          // 番茄钟 { endAt, breakAt, paused, ... }
  screenChecks: 0,      // 今日屏检次数
  slackStreak: 0,       // 连续摸鱼计数(连抓加重语气)
  checkTimer: null,
  // 随机屏摄日记(journalMode)
  journal: [],          // 今日观察记录 [{t, note}]
  journalDay: '',       // (弃用)旧版记录归属日,留字段兼容旧存档
  journalTimer: null,
  // 聊天 / 报告
  convs: [], curConvId: null, reports: [], llmLog: [],
  // 桌宠行为
  eggTimer: null,
  pokes: [], lastPokeSulk: 0,   // 连戳生气检测
  lastActive: Date.now(), sleeping: false, lastWake: 0,
  lastHealthSay: 0,
  // 杂项持久化(周报红点等)
  misc: {},
};

/* 不经 LLM 的本地说话(外部接口/预设台词用):打字机+blip+表情 */
function sayLocal(text, emo = 'neutral') {
  if (S.speaking) return;
  if (emo !== 'neutral') {
    if (Persona.active) {
      const anim = Persona.emoAnim(emo);
      if (anim) Player.play(anim, { loop: true, prio: PRIORITY.emo });
    } else if (Player.manifest['emo_' + emo]) {
      Player.play('emo_' + emo, { loop: true, prio: PRIORITY.emo });
    }
  }
  const b = document.getElementById('bubble');
  b.innerHTML = ''; clearTimeout(b._t);
  S.speaking = true;
  let i = 0;
  const iv = setInterval(() => {
    S.speechBeat = Date.now(); // 心跳:证明说话引擎活着
    if (i >= text.length) {
      clearInterval(iv);
      S.speaking = false;
      setTimeout(() => { if (!S.speaking) { hideBubble(); Player.requestIdle(); } }, 2400);
      return;
    }
    const ch = text[i++];
    if (!b.classList.contains('show')) {
      b.classList.add('show');
      document.getElementById('pet-wrapper').classList.add('bubble-shown');
    }
    if (!/[\s。，！？…、，.!?]/.test(ch) && i % 2 === 0) blip(emo);
    b.innerHTML += ch === '\n' ? '<br>' : ch;
  }, 55);
}
const $ = (id) => document.getElementById(id);

function showBubble(html, ms = 4000) {
  const b = $('bubble');
  b.innerHTML = html;
  b.classList.add('show');
  $('pet-wrapper').classList.add('bubble-shown');
  clearTimeout(b._t);
  if (ms > 0) b._t = setTimeout(hideBubble, ms);
}
function hideBubble() {
  $('bubble').classList.remove('show');
  $('pet-wrapper').classList.remove('bubble-shown');
}
function showToast(text) {
  const t = $('toast');
  t.textContent = text;
  // 跟着视觉焦点走:有面板开着就贴在该面板正上方(窗口铺满整屏,固定在
  // 屏顶的提示离操作点十万八千里,用户根本看不见——真机反馈);没面板才回顶部居中
  const p = S.panel && document.getElementById(S.panel);
  const anchor = (p && p.classList.contains('show')) ? p : $('pet'); // 没面板=弹在桌宠头上
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    t.style.left = (r.left + r.width / 2) + 'px';
    t.style.top = Math.max(8, r.top - 46) + 'px';
  } else {
    t.style.left = ''; t.style.top = '';
  }
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 2600);
}

/* 桌宠本体像素级命中:某屏幕坐标是否真的压在可见的馒头/角色形象上
   (而非它的透明外框矩形)。穿透判定与点击反应共用同一套,保证
   "透明区域全部穿透"这个承诺真的成立。 */
function petBodyHit(clientX, clientY) {
  const cv = $('pet');
  if (!cv) return false;
  const rect = cv.getBoundingClientRect();
  const px = clientX - rect.left, py = clientY - rect.top;
  if (px < 0 || py < 0 || px > rect.width || py > rect.height) return false;
  if (Persona.active) {
    try {
      const cvs = Sprites.canvas;
      const cx = Math.max(2, Math.min(cvs.width - 3, Math.round(px * cvs.width / rect.width)));
      const cy = Math.max(2, Math.min(cvs.height - 3, Math.round(py * cvs.height / rect.height)));
      const d = Sprites.ctx.getImageData(cx - 2, cy - 2, 5, 5).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 10) return true;
      return false;
    } catch {
      const ex = (px - rect.width / 2) / (rect.width * 0.46);
      const ey = (py - rect.height * 0.52) / (rect.height * 0.5);
      return ex * ex + ey * ey <= 1;
    }
  }
  try {
    const outline = document.getElementById('bun-outline');
    const p = new DOMPoint(px * (112 / rect.width), py * (91 / rect.height));
    return outline.isPointInFill(p);
  } catch { return true; } // 几何异常按命中(宁可多反应,不可点不动)
}

/* ---- 鼠标穿透管理:只有真正压在桌宠本体、或已展开的面板/按钮上时才
   接管鼠标;其余透明区一律穿透(旧版按 .interactive 整个矩形接管,
   #pet-wrapper 那 230×210 透明框把周围点击全挡了——实测踩到) ---- */
function setupPassthrough() {
  let inside = false;
  document.addEventListener('mousemove', (e) => {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    let hit = false;
    if (el) {
      // 不透明 UI(展开的面板/气泡/悬浮按钮/待办横条):整块接管
      if (el.closest('.panel.show, #bubble.show, #hover-btns.show, #todo-banner.show')) hit = true;
      // 桌宠本体:像素级判定,透明外框不算
      else if (el.closest('#pet')) hit = petBodyHit(e.clientX, e.clientY);
    }
    if (hit !== inside) { inside = hit; API.setIgnore(!hit); }
  });
}

/* ---- 悬浮按钮 ---- */
function setupHover() {
  const w = $('pet-wrapper');
  let hovering = false;
  w.addEventListener('mouseenter', () => {
    hovering = true;
    S.lastActive = Date.now();
    updateWeeklyDot();
    $('hover-btns').classList.add('show');
    if (S.tracking && S.curIdx < S.todos.length) { updateBanner(); $('todo-banner').classList.add('show'); }
  });
  w.addEventListener('mouseleave', () => {
    hovering = false;
    setTimeout(() => {
      if (!hovering) {
        // 红点已被这次悬停展示过 → 标记本周已看，下次不再亮
        if (document.querySelector('[data-panel="todo"]')?.classList.contains('has-dot')) {
          markWeeklySeen();
          updateWeeklyDot();
        }
        $('hover-btns').classList.remove('show');
        $('todo-banner').classList.remove('show');
      }
    }, 350);
  });
  document.querySelectorAll('.hbtn[data-panel]').forEach((b) =>
    b.addEventListener('click', () => togglePanel(b.dataset.panel)));
  document.querySelectorAll('#panel-todo .ptab').forEach((b) =>
    b.addEventListener('click', () => {
      if (b.dataset.tab === 'todo') { setTodoTab('todo'); renderTodo(); }
      else if (b.dataset.tab === 'study') { setTodoTab('study'); renderStudy(); }
      else renderReportList();
    }));
  $('btn-comment').addEventListener('click', commentScreen);
  // F2 精简版:扣子客户端在跑才亮这颗按钮(30s 轮询);点击直接把扣子拉到前台
  // (deep link 自动带话进输入框=二期,现在只负责"一键拉起扣子")
  const cozeBtn = $('btn-coze');
  const cozeCheck = async () => {
    const on = await API.cozeDetect?.();
    cozeBtn.style.display = on ? '' : 'none';
  };
  cozeBtn.addEventListener('click', async () => {
    if (await API.cozeOpen?.()) showBubble('扣子拉起来了～');
    else { showBubble('咦，扣子好像关掉了…'); cozeCheck(); }
  });
  cozeCheck();
  setInterval(cozeCheck, 10000); // 10s:扣子关窗后按钮最多亮 10 秒就收(30s 会被当成"检测坏了")
  document.querySelectorAll('.panel-close').forEach((b) =>
    b.addEventListener('click', () => togglePanel(b.dataset.close, true)));
  setupPanelDrag();
}
function togglePanel(name, forceClose = false) {
  const id = 'panel-' + name;
  const showing = S.panel === id;
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('show'));
  S.panel = null;
  if (!showing && !forceClose) {
    if (name === 'todo') { setTodoTab('todo'); renderTodo(); syncStudyTab(); } // 打开默认落在待办 tab;研究 tab 随开关显隐
    if (name === 'settings') renderSettings();
    if (name === 'chat') { S.histView = false; renderChatMsgs(); } // 默认续上最近的对话
    const el = $(id);
    el.classList.add('show');
    positionPanel(el); // 面板跟着桌宠当前位置走
    S.panel = id;
  }
}

/* 日程面板三 tab:待办 / 观察(桌宠每次看屏幕的流水) / 报告 */
function setTodoTab(which) {
  document.querySelectorAll('#panel-todo .ptab').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === which));
  $('todo-body').style.display = which === 'todo' ? '' : 'none';
  $('study-body').style.display = which === 'study' ? '' : 'none';
  $('report-body').style.display = which === 'report' ? '' : 'none';
}
/* 报告视图入口:保证待办面板开着且切到报告 tab(渲染由调用方负责) */
function openReportView() {
  if (S.panel !== 'panel-todo') togglePanel('todo');
  setTodoTab('report');
}

/* 面板可拖动:按住标题栏拖走(清单加多了会向下撑长，贴屏幕下沿打开时底部会
   探出屏幕外——拖起来就能继续操作)。夹在屏幕内，至少留 44px 标题栏可抓回 */
function setupPanelDrag() {
  document.querySelectorAll('.panel').forEach((p) => {
    const h = p.querySelector('.panel-header');
    if (!h) return;
    h.style.cursor = 'grab';
    h.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      const r = p.getBoundingClientRect();
      const gx = e.clientX - r.left, gy = e.clientY - r.top;
      const move = (ev) => {
        const x = Math.max(60 - r.width, Math.min(window.innerWidth - 60, ev.clientX - gx));
        const y = Math.max(0, Math.min(window.innerHeight - 44, ev.clientY - gy));
        p.style.left = x + 'px'; p.style.top = y + 'px';
        p.style.right = 'auto'; p.style.bottom = 'auto';
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  });
}

/* 面板贴着桌宠摆放(桌宠可全屏拖动，面板位置随之计算，并夹在屏幕内)。
 * 避让基准取 wrapper 与悬浮按钮列的更左者:按钮列探在 wrapper 左外侧约 56px,
 * 只按 wrapper 让 12px 会压住按钮 14px(实测穿帮;style.css 里的 right 只是
 * 开面板前的初始值,真正位置由这里的内联样式决定) */
function positionPanel(el) {
  const r = $('pet-wrapper').getBoundingClientRect();
  const hb = $('hover-btns').getBoundingClientRect();
  const anchor = Math.min(r.left, hb.left);
  const pw = el.offsetWidth || 330, ph = el.offsetHeight || 480;
  let left = anchor - pw - 14;
  if (left < 8) left = Math.min(window.innerWidth - pw - 8, r.right + 12);
  const top = Math.max(8, Math.min(window.innerHeight - ph - 8, r.top + r.height / 2 - ph / 2));
  // 底边锚定(用户拍板 07-26):切 tab 内容变多时面板向上"顶起"生长,
  // 下沿钉住不再滑出屏幕下缘;maxHeight 防顶破屏幕上缘(超出部分 body 内滚)
  const bottom = Math.max(8, window.innerHeight - (top + ph));
  el.style.left = left + 'px';
  el.style.bottom = bottom + 'px';
  el.style.top = 'auto';
  el.style.right = 'auto';
  el.style.maxHeight = (window.innerHeight - bottom - 8) + 'px';
}

/* ---- 点击/拖拽:头/手/身体 分区 ---- */
function setupPetMouse() {
  const cv = $('pet');
  let down = null, dragged = false;
  let dragV = 0;
  cv.addEventListener('mousedown', (e) => {
    const r = document.getElementById('pet-wrapper').getBoundingClientRect();
    down = { x: e.screenX, y: e.screenY, grabX: e.clientX - r.left, grabY: e.clientY - r.top };
    dragged = false;
  });
  window.addEventListener('mousemove', (e) => {
    if (!down) return;
    const dx = e.screenX - down.x, dy = e.screenY - down.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragged = true;
    if (dragged) {
      // 拖的是窗口内的桌宠本体(窗口铺满工作区不动)→ 全屏自由，不受窗口边框顶头
      const w = document.getElementById('pet-wrapper');
      if (!w.style.left) {
        const r = w.getBoundingClientRect();
        w.style.left = r.left + 'px';
        w.style.top = r.top + 'px';
        w.style.right = 'auto';
        w.style.bottom = 'auto';
      }
      const nx = Math.max(-140, Math.min(window.innerWidth - 140, parseFloat(w.style.left) + dx));
      const ny = Math.max(-40, Math.min(window.innerHeight - 120, parseFloat(w.style.top) + dy));
      w.style.left = nx + 'px';
      w.style.top = ny + 'px';
      down = { x: e.screenX, y: e.screenY, grabX: down.grabX, grabY: down.grabY };
      // 多显示器跳岛:拖到屏幕边缘时问主进程"光标在哪块屏"，窗口跳过去，桌宠跟着光标落位
      if (e.clientX < 2 || e.clientY < 2 ||
          e.clientX > window.innerWidth - 2 || e.clientY > window.innerHeight - 2) {
        API.moveToDisplay(e.screenX, e.screenY).then((wa) => {
          if (!wa) return;
          w.style.left = Math.max(-140, e.screenX - wa.x - down.grabX) + 'px';
          w.style.top = Math.max(-40, e.screenY - wa.y - down.grabY) + 'px';
        });
      }
      // 拖拽物理:按水平速度轻微倾斜(幅度收着，±5° 意思一下就够)。
      // 包形象的 #pet 靠 translateX(-50%) 居中,内联 transform 必须带上它,
      // 否则松手后人物右跳半个身位(图标/气泡全体"漂移"的元凶)
      dragV = dragV * 0.8 + dx * 0.2;
      const baseT = document.getElementById('pet-wrapper').classList.contains('persona-on')
        ? 'translateX(-50%) ' : '';
      cv.style.transition = 'none';
      cv.style.transformOrigin = '50% 15%';
      cv.style.transform = `${baseT}rotate(${Math.max(-5, Math.min(5, -dragV * 0.3))}deg)`;
    }
  });
  window.addEventListener('mouseup', (e) => {
    if (!down) return;
    const wasDrag = dragged;
    down = null; dragged = false;
    if (wasDrag) {
      // 松手回弹;回弹完清掉内联 transform,交还样式表(包形象的居中/hover 才能恢复)
      dragV = 0;
      const baseT = document.getElementById('pet-wrapper').classList.contains('persona-on')
        ? 'translateX(-50%) ' : '';
      cv.style.transition = 'transform 0.6s cubic-bezier(0.34,1.56,0.64,1)';
      cv.style.transform = `${baseT}rotate(0deg)`;
      setTimeout(() => { cv.style.transition = 'none'; cv.style.transform = ''; }, 650);
      return;
    }
    S.lastActive = Date.now();
    const rect = cv.getBoundingClientRect();
    const px = e.clientX - rect.left, py = e.clientY - rect.top;
    // 命中测试:点在形象轮廓之外 = 没点到人，不触发任何反应。
    // 馒头用 SVG 路径几何;包形象直接查雪碧图画布该点的透明度(像素级,
    // 细长立绘两侧的透明区不再误判"戳它";取 5×5 邻域容错发丝间隙)
    if (Persona.active) {
      let hit = false;
      try {
        const cvs = Sprites.canvas;
        const cx = Math.max(2, Math.min(cvs.width - 3, Math.round(px * cvs.width / rect.width)));
        const cy = Math.max(2, Math.min(cvs.height - 3, Math.round(py * cvs.height / rect.height)));
        const d = Sprites.ctx.getImageData(cx - 2, cy - 2, 5, 5).data;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 10) { hit = true; break; }
      } catch { // 画布不可读(理论不会):退回旧的中心椭圆近似
        const ex = (px - rect.width / 2) / (rect.width * 0.46);
        const ey = (py - rect.height * 0.52) / (rect.height * 0.5);
        hit = ex * ex + ey * ey <= 1;
      }
      if (!hit) return;
    } else try {
      const outline = document.getElementById('bun-outline');
      const p = new DOMPoint(px * (112 / rect.width), py * (91 / rect.height));
      if (!outline.isPointInFill(p)) return;
    } catch { /* 几何测试异常按命中处理(宁可多反应，不可点不动) */ }
    if (S.sleeping) { wakeUp(); return; }
    // 自习中点它=抓包(摸鱼→慌张认账;没摸→汇报进度),普通触摸反应让位
    if (typeof Study !== 'undefined' && Study.clickIntercept()) return;
    // 包带 hitZones(格式 v1.1)按标注框分部位播对应动画;没带维持旧默认。
    // part 供搭话文案增味;码绘馒头不分头/身(统一"原地一惊")
    const fy = py / rect.height;
    let part = fy < 0.5 ? '头' : '身体';
    let anim = 'touch_body';
    const hz = Persona.active && Persona.hitZone(px, py, rect);
    if (hz) ({ anim, part } = hz);
    // 连戳彩蛋:8 秒内戳 5 次 → 满头黑线嫌弃你(冷却 60s)
    const now = Date.now();
    S.pokes = S.pokes.filter((t) => now - t < 8000);
    S.pokes.push(now);
    if (S.pokes.length >= 5 && now - S.lastPokeSulk > 60000) {
      S.lastPokeSulk = now;
      S.pokes = [];
      FX.freeze(); // 被戳到恼:冰封震慑(用户拍板)
      const anim = Persona.emoAnim('blackline');
      if (anim) Player.play(anim, { loop: true, prio: PRIORITY.emo });
      sayLocal(P('line_poke_enough'), 'blackline');
      return;
    }
    Player.play(anim, { prio: PRIORITY.touch });
    // 随机搭话:三成概率把"被戳了"告诉模型，让他自由发挥
    if (Math.random() < 0.3 && CFG.chatApi.key && !S.speaking)
      chatLLM(P('poke', { part }), { hideUser: true });
  });
}

/* ---- 待机彩蛋 ---- */
// egg_float 已移出:浮空时龙角会超出画布被裁断
const EGGS = ['egg_yawn', 'egg_frost', 'egg_breeze'];
function scheduleEgg() {
  clearTimeout(S.eggTimer);
  S.eggTimer = setTimeout(() => {
    if (Player.cur?.name === 'idle' && !S.speaking) {
      // 包形象:彩蛋池=包里所有 egg_ 前缀动画——彩蛋名随角色起(egg_xxx 即可),
      // 不锁死本体三件套(每只角色的小动作本来就该不一样);码绘馒头维持自家三条
      const pool = Persona.active
        ? Object.keys(Persona.manifest || {}).filter((e) => e.startsWith('egg_') && Persona.eggEnabled(e))
        : EGGS.filter((e) => Player.manifest[e]);
      // 在待机循环回到首帧(=标准立绘)时再切换，消除切换瞬间的闪跳
      if (pool.length) Player.playAtLoopEnd(pool[Math.floor(Math.random() * pool.length)], { prio: PRIORITY.egg });
    }
    scheduleEgg();
  }, 30000 + Math.random() * 60000);
}

