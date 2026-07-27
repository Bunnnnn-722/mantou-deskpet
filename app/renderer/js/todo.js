'use strict';
/* ================= 待办 + 屏检 ================= */
function saveTodos() {
  API.setStore('todos', S.todos);
  API.setStore('doneLedger', S.doneLedger || []);
  // Part4 闭环:待办快照回写 ~/agent_pet/todo_status.json(Agent 据此更新上游任务系统)。
  // AI 拆解后的子任务共享原条目的 sid:Agent 侧同 id 全 done 才算该条完成。
  // 字段口径(真机反馈#4 后定稿):tracking=是否在执行;current=正在执行的一条;
  // todos=当前清单(skipped 与 done 分开报,跳过的别当完成);history=完成/跳过
  // 滚动台账(最近 50 条)——日报结算会把 done 移出清单,轮询间隔长的 Agent 靠台账不漏账
  const cur = S.tracking && S.todos[S.curIdx] ? S.todos[S.curIdx] : null;
  API.agentTodoStatus?.({
    tracking: !!S.tracking,
    current: cur ? { id: cur.sid || null, title: cur.name,
      started_at_ms: cur.startTime || null } : null,
    todos: S.todos.map((t) => ({
      id: t.sid || null, from: t.from || 'manual', title: t.name,
      status: t.status === 'done' && t.skipped ? 'skipped' : t.status,
      est_minutes: t.est || 25, done_at_ms: t.endTime || null,
    })),
    history: (S.doneLedger || []).slice(-50),
  });
}
/* Agent 待办直通(Part4):主进程轮询 todo_inbox.json 下发未导入条目 → 这里入清单
 * (与手动添加同等地位:可改名/改时长/排序/删除/AI拆解) → 回执 id，主进程标 imported。
 * 按 sid 去重:回执前的重复下发不会重复入队 */
function importSerenTodos(list) {
  const ids = [];
  let added = 0;
  for (const t of list) {
    if (!t || !t.id || !t.title) continue;
    ids.push(t.id);
    if (S.todos.some((x) => x.sid === t.id)) continue; // 已导入:只补回执
    // est 字段双认(真机反馈#1):协议草案写的 est_minutes,Agent 实发是 est,
    // 只认前者会让 60/120 全部塌成默认 25;仍 clamp 到馒头番茄钟的 5~90
    const estRaw = Math.round(+(t.est_minutes ?? t.est));
    S.todos.push({
      name: String(t.title).trim().slice(0, 40),
      est: Math.max(5, Math.min(90, estRaw || 25)),
      status: 'pending', startTime: null, endTime: null, hadSlack: false,
      note: t.note ? String(t.note).slice(0, 500) : '',
      from: 'agent', sid: t.id,
    });
    added++;
  }
  if (added) {
    renderTodo();
    showToast(`Agent 排来 ${added} 条待办`);
    if (!S.speaking) sayLocal(P('line_agent_todo', { n: added }), 'happy');
  }
  if (ids.length) API.agentTodosImported?.(ids);
}
function renderTodo() {
  saveTodos(); // 所有增删改/排序/完成都会重渲染，这里统一落盘(内联编辑单独存)
  const body = $('todo-body');
  let html = `<div class="todo-add-row"><input id="todo-add" placeholder="添加待办…" autocomplete="off"><button id="todo-add-btn">添加</button></div>`;
  S.todos.forEach((t, i) => {
    const cls = t.status === 'done' ? 'done' : i === S.curIdx ? 'active' : '';
    // 打勾圈只在执行中出现:还没开始执行的清单项点了也不算"完成"，显示纯圆点占位
    const check = t.status === 'done'
      ? `<div class="tl-check checked">✓</div>`
      : S.tracking ? `<div class="tl-check" data-i="${i}"></div>`
                   : `<div class="tl-dot"></div>`;
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    // 三段式卡片(UI 重构二轮):标题行只留 勾+来源+标题(textarea 可换行不截断),
    // 时长/删除/跳过收进右下角操作区,备注居中段点击展开/收起
    const nameCell = t.status === 'done'
      ? `<span class="tl-name">${esc(t.name)}</span>`
      : `<textarea class="tl-name-in" data-i="${i}" rows="1">${esc(t.name)}</textarea>`;
    const noteRow = t.note
      ? `<div class="tl-note" data-note="${i}"><span class="tl-note-text">${esc(t.note)}</span><span class="tl-note-more">展开</span></div>`
      : '';
    const foot = t.status === 'done'
      ? `<div class="tl-foot"><span class="tl-est-ro">${t.est || 25} 分</span></div>`
      : `<div class="tl-foot">
          <input class="tl-est-in" data-i="${i}" type="number" min="5" max="90" value="${t.est || 25}"><span class="tl-est-unit">分</span>
          ${!S.tracking ? `<button class="tl-del" data-del="${i}" title="删除">✕</button>` : ''}
          ${i === S.curIdx ? `<button class="tl-skip" data-skip="${i}">⏭ 跳过</button>` : ''}
          ${S.tracking && i !== S.curIdx && t.status === 'pending'
            ? `<button class="tl-go" data-go="${i}" title="把执行中切到这条">▸ 执行这条</button>` : ''}
        </div>`;
    html += `<div class="tl-item ${cls}" data-i="${i}">
      <div class="tl-row">
        <span class="tl-grip" draggable="true" data-i="${i}" title="拖动排序">⠿</span>
        ${check}
        ${['agent', 'seren'].includes(t.from) ? '<span class="tl-from" title="Agent 排的">A</span>' : ''}
        ${nameCell}
      </div>
      ${noteRow}
      ${foot}
    </div>`;
  });
  if (!S.tracking) {
    // 双按钮:AI 拆解(有 key 才显示)+ 直接开始(永远显示，没配 API 也不卡死)
    const pend = S.todos.filter((t) => t.status !== 'done').length ? '' : 'disabled';
    if (CFG.chatApi.key)
      html += `<button class="start-btn" id="todo-start" ${pend}>✦ AI 拆解</button>`;
    html += `<button class="start-btn" id="todo-start-direct" ${pend}
      ${CFG.chatApi.key ? 'style="margin-top:8px;background:transparent;border-color:var(--glass-border);color:var(--muted);"' : ''}>${
      CFG.visionApi.key ? '直接开始(带屏摄监督)' : '直接开始(未配视觉API，仅计时)'}</button>`;
  } else {
    html += `<button class="report-btn" id="todo-report">结束今天，看报告</button>`;
    // 追踪开关(2026-07-27 用户需求):执行中可随时收手,不结算不出报告,
    // 进度(已完成/剩余清单)原样保留,「直接开始/AI 拆解」再开
    html += `<button class="report-btn" id="todo-pause" style="background:transparent;">⏸ 暂停执行(进度保留)</button>`;
  }
  // 「☀生成今日日报」已挪去记录 tab(和周报做邻居,2026-07-26 用户拍板)
  body.innerHTML = html;
  bindEnter('todo-add', addTodoFromPanel);
  $('todo-add-btn').addEventListener('click', addTodoFromPanel);
  body.querySelectorAll('.tl-check[data-i]').forEach((el) =>
    el.addEventListener('click', () => completeTodo(+el.dataset.i)));
  // 详情展开/收起:整段可点;只有真被截断的才显示「展开」角标。
  // clientHeight=0 说明当前不可见量不出(如挂在观察 tab 时后台重渲染),
  // 保留角标照常绑——切回待办 tab 会重渲染重量,不会残留误判
  body.querySelectorAll('.tl-note').forEach((el) => {
    const txt = el.querySelector('.tl-note-text');
    const more = el.querySelector('.tl-note-more');
    if (txt.clientHeight > 0 && txt.scrollHeight <= txt.clientHeight + 2) { more.remove(); return; }
    el.addEventListener('click', () => {
      const open = el.classList.toggle('open');
      more.textContent = open ? '收起' : '展开';
    });
  });
  body.querySelectorAll('.tl-del').forEach((el) =>
    el.addEventListener('click', () => { S.todos.splice(+el.dataset.del, 1); renderTodo(); }));
  body.querySelectorAll('.tl-skip').forEach((el) =>
    el.addEventListener('click', () => skipTodo(+el.dataset.skip)));
  // 随时可编辑:输入即写回，不重渲染(不打断输入焦点)。
  // 标题是单行语义的 textarea:视觉上自动换行+撑高,回车不产生真换行符
  body.querySelectorAll('.tl-name-in').forEach((el) => {
    const fit = () => { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; };
    fit();
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
    el.addEventListener('input', () => {
      const t = S.todos[+el.dataset.i];
      if (t) t.name = el.value.replace(/\n/g, ' ').trim().slice(0, 40) || t.name;
      fit();
      saveTodos();
    });
  });
  body.querySelectorAll('.tl-est-in').forEach((el) =>
    el.addEventListener('change', () => {
      const i = +el.dataset.i, t = S.todos[i];
      if (!t) return;
      t.est = Math.max(5, Math.min(90, +el.value || 25));
      el.value = t.est;
      // 改的是进行中的任务 → 倒计时终点跟着新预估走(从开始时刻起算);
      // 同时重置超时标记(新截止点到了要重新问)并落盘(重启还原新倒计时)
      if (i === S.curIdx && t.status === 'doing' && S.timer) {
        S.timer.endAt = (t.startTime || Date.now()) + t.est * 60000;
        S.timer.overNotified = false;
        saveTracking();
      }
      updateBanner();
      saveTodos();
    }));
  // 拖动排序:抓 ⠿ 手柄，松手落位;进行中的任务用对象身份重新定位 curIdx
  let dragFrom = null;
  body.querySelectorAll('.tl-grip').forEach((g) => {
    g.addEventListener('dragstart', (e) => {
      dragFrom = +g.dataset.i;
      e.dataTransfer.effectAllowed = 'move';
    });
  });
  body.querySelectorAll('.tl-item').forEach((it) => {
    it.addEventListener('dragover', (e) => { e.preventDefault(); it.classList.add('drop-hint'); });
    it.addEventListener('dragleave', () => it.classList.remove('drop-hint'));
    it.addEventListener('drop', (e) => {
      e.preventDefault();
      it.classList.remove('drop-hint');
      const to = +it.dataset.i;
      if (dragFrom === null || to === dragFrom) { dragFrom = null; return; }
      const doing = S.curIdx >= 0 ? S.todos[S.curIdx] : null;
      const [m] = S.todos.splice(dragFrom, 1);
      S.todos.splice(to, 0, m);
      if (doing) S.curIdx = S.todos.indexOf(doing);
      dragFrom = null;
      renderTodo();
    });
  });
  const st = $('todo-start'); if (st) st.addEventListener('click', startTracking);
  const sd = $('todo-start-direct'); if (sd) sd.addEventListener('click', beginTracking);
  const rp = $('todo-report'); if (rp) rp.addEventListener('click', showReport);
  const pz = $('todo-pause'); if (pz) pz.addEventListener('click', pauseTracking);
  body.querySelectorAll('.tl-go').forEach((el) =>
    el.addEventListener('click', () => switchTodo(+el.dataset.go)));
}
function addTodoFromPanel() {
  const v = $('todo-add').value.trim();
  if (!v) return;
  S.todos.push({ name: v, est: 25, status: 'pending', startTime: null, endTime: null, hadSlack: false });
  renderTodo();
}

/* ---- 任务番茄钟:预估倒计时 + 25 分钟休息提醒 + 可暂停 ---- */
function startTaskTimer(t) {
  S.timer = {
    paused: false, pausedAt: 0,
    endAt: Date.now() + (t.est || 25) * 60000,
    breakAt: Date.now() + 25 * 60000,
    overNotified: false,
  };
}
function pauseTimer(p) {
  if (!S.timer) return;
  if (p && !S.timer.paused) { S.timer.paused = true; S.timer.pausedAt = Date.now(); }
  else if (!p && S.timer.paused) {
    const gap = Date.now() - S.timer.pausedAt;
    S.timer.endAt += gap; S.timer.breakAt += gap;
    S.timer.paused = false;
  }
  saveTracking();
  updateBanner();
}
function fmtRemain(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
/* 追踪状态跨重启持久化:timer 用绝对时间戳，离线期间照常流逝 */
function saveTracking() {
  API.setStore('tracking', S.tracking ? { curIdx: S.curIdx, timer: S.timer } : null);
}
setInterval(() => {
  if (!S.tracking || !S.timer || S.timer.paused) return;
  const now = Date.now();
  const el = document.getElementById('timer-text');
  if (el) el.textContent = fmtRemain(S.timer.endAt - now);
  if (now >= S.timer.endAt && !S.timer.overNotified) {
    S.timer.overNotified = true;
    const t = S.todos[S.curIdx];
    if (!S.speaking) sayLocal(P('line_task_timeup', { name: t?.name || '这个任务' }), 'speechless');
    // 问完等 5 秒:期间用户无任何操作(完成/跳过/暂停/改时长)→ 自动续 15 分钟
    const snapIdx = S.curIdx, snapEnd = S.timer.endAt;
    setTimeout(() => {
      if (!S.tracking || S.curIdx !== snapIdx) return;          // 完成/跳过了
      const tt = S.todos[S.curIdx];
      if (!tt || tt.status !== 'doing') return;
      if (!S.timer || S.timer.paused || S.timer.endAt !== snapEnd) return; // 暂停/手动改过
      // 必须从"现在"起续:endAt 可能已过期很久(合盖/挂机后恢复,离线照常流逝),
      // 在旧值上累加仍在过去→秒到期→"再给你15分钟"复读机(真机实锤)
      S.timer.endAt = Date.now() + 15 * 60000;
      S.timer.overNotified = false;                             // 新周期到点再问
      saveTracking();
      updateBanner();
      if (!S.speaking) sayLocal(P('line_extend'));
    }, 5000);
  }
  if (now >= S.timer.breakAt) {
    S.timer.breakAt = now + 25 * 60000;
    if (!CFG.silentFocus && !S.speaking && now < S.timer.endAt)
      sayLocal(P('line_break'));
  }
}, 1000);
/* 思考中动画(真机反馈#6):包形象带 think 槽位才播(码绘馒头没画这条,静默跳过);
 * loop 到 stopThink 在循环边界优雅收——AI 拆解/屏检判定期间桌宠不再干站着 */
function playThink() {
  if (Persona.active && Persona.has('think'))
    Player.play('think', { loop: true, prio: PRIORITY.emo });
}
function stopThink() {
  if (Player.cur?.name === 'think') Player.requestIdle();
}
/* Agent 派单直通(真机反馈#5):Agent 本身就是 AI,标题颗粒度和 est 都定好了,
 * 再拆解=脱裤子放屁——Agent 来源的条目跳过 LLM 原样保留;整单全是 Agent 派的
 * 直接开始执行,混合清单只把手动项送去拆解(确认页照出,可再手调) */
const isAgentTodo = (t) => ['agent', 'seren'].includes(t.from);
async function startTracking() {
  // AI 拆解 → 出确认页(用户可改名字/时长/删项/恢复原始项，确认后才开始执行)
  const pending = S.todos.filter((t) => t.status !== 'done');
  if (!pending.length) return;
  if (pending.every(isAgentTodo)) { beginTracking(); return; }
  if (CFG.chatApi.key) {
    showToast('AI 正在拆解待办…');
    playThink();
    // 每条原始待办单独拆(并行):子任务天然知道自己来自哪条，可整组恢复原始项
    const groups = await Promise.all(pending.map(async (t) => {
      // note 联动:备注一并喂给拆解模型;子任务继承 sid/note/from，
      // Agent 侧按"同 sid 全 done"判原条目完成
      const meta = { origin: t.name, originEst: t.est || 25, sid: t.sid, note: t.note || '', from: t.from };
      if (isAgentTodo(t)) return [{ name: t.name, est: t.est || 25, ...meta }];
      try {
        const raw = await chatLLMPlain(P('todo_split',
          { todos: t.name + (t.note ? `\n备注(拆解时参考的上下文):${t.note}` : '') }));
        const arr = JSON.parse((raw.match(/\[[\s\S]*\]/) || ['[]'])[0]);
        if (Array.isArray(arr) && arr.length)
          return arr.map((n) => ({
            name: String(n.name || n).slice(0, 40),
            est: Math.max(5, Math.min(90, +n.min || 25)),
            ...meta,
          }));
      } catch { /* 单条失败按原样保留 */ }
      return [{ name: t.name, est: t.est || 25, ...meta }];
    }));
    stopThink();
    const plan = groups.flat();
    if (plan.length) { renderPlanView(plan); return; }
    showToast('拆解失败，按原样执行');
  }
  beginTracking();
}

/* AI 拆解确认页:按原始待办分组展示;可改名/改时长/删单项/整组恢复原始项，确认才生效 */
function renderPlanView(plan) {
  S.plan = plan;
  const body = $('todo-body');
  // 按 origin 分组(保持出现顺序)
  const order = [];
  plan.forEach((p) => { if (!order.includes(p.origin)) order.push(p.origin); });
  let html = `<div style="font-size:12px;color:var(--accent);margin-bottom:10px;">AI 拆解结果 · 可修改/删项，确认后开始执行</div>`;
  order.forEach((org) => {
    const idxs = plan.map((p, i) => [p, i]).filter(([p]) => p.origin === org);
    const restored = idxs.length === 1 && idxs[0][0].name === org;
    html += `<div class="plan-origin">
      <span class="po-label" title="${org.replace(/"/g, '&quot;')}">来自「${org}」</span>
      ${restored ? '<span class="po-kept">原始项</span>'
                 : `<button class="po-restore" data-org="${org.replace(/"/g, '&quot;')}">↩ 恢复原始项</button>`}
    </div>`;
    idxs.forEach(([p, i]) => {
      // 不能复用 .tl-item:卡片重构后它是纵向布局,拆解行要横排(名字|时长|分|删)
      html += `<div class="plan-row">
        <input class="plan-name" data-i="${i}" value="${p.name.replace(/"/g, '&quot;')}">
        <input class="plan-min" data-i="${i}" type="number" min="5" max="90" value="${p.est}">
        <span class="plan-unit">分</span>
        <button class="tl-del" data-del="${i}" title="删除这一步">✕</button>
      </div>`;
    });
  });
  body.innerHTML = html +
    `<button class="start-btn" id="plan-confirm">确认，开始执行</button>
     <div class="plan-acts">
       <button class="report-btn" id="plan-redo">重新拆解</button>
       <button class="report-btn" id="plan-back">返回</button>
     </div>`;
  // 输入实时写回 S.plan:删项/恢复会重渲染，不能丢手改内容
  body.querySelectorAll('.plan-name').forEach((el) =>
    el.addEventListener('input', () => { S.plan[+el.dataset.i].name = el.value; }));
  body.querySelectorAll('.plan-min').forEach((el) =>
    el.addEventListener('input', () => { S.plan[+el.dataset.i].est = Math.max(5, Math.min(90, +el.value || 25)); }));
  body.querySelectorAll('.tl-del').forEach((el) =>
    el.addEventListener('click', () => { S.plan.splice(+el.dataset.del, 1); renderPlanView(S.plan); }));
  body.querySelectorAll('.po-restore').forEach((el) =>
    el.addEventListener('click', () => {
      const org = el.dataset.org;
      const keep = S.plan.filter((p) => p.origin !== org);
      const first = S.plan.find((p) => p.origin === org) || {};
      const est = first.originEst || 25;
      // 恢复到该组第一步原来的位置(sid/note/from 一并还原)
      const at = S.plan.findIndex((p) => p.origin === org);
      keep.splice(Math.min(at < 0 ? keep.length : at, keep.length), 0,
        { name: org, est, origin: org, originEst: est, sid: first.sid, note: first.note || '', from: first.from });
      renderPlanView(keep);
    }));
  $('plan-confirm').addEventListener('click', () => {
    const clean = S.plan.filter((p) => p.name.trim());
    if (!clean.length) return;
    S.todos = S.todos.filter((t) => t.status === 'done')
      .concat(clean.map((p) => ({ name: p.name.trim().slice(0, 40), est: p.est,
        status: 'pending', startTime: null, endTime: null, hadSlack: false,
        sid: p.sid, note: p.note || '', from: p.from })));
    beginTracking();
  });
  $('plan-redo').addEventListener('click', startTracking);
  $('plan-back').addEventListener('click', renderTodo);
}

/* 追踪开关(2026-07-27):暂停执行=收手不结算。执行中那条退回 pending
 * (startTime 清掉,下次执行重新计),番茄钟/屏检全停,已完成的照留台账;
 * 与「结束今天」的区别:不出报告、不清清单——中午吃饭合盖的正确姿势 */
function pauseTracking() {
  const t = S.todos[S.curIdx];
  if (t && t.status === 'doing') { t.status = 'pending'; t.startTime = null; }
  S.tracking = false;
  S.curIdx = -1;
  S.timer = null;
  clearTimeout(S.checkTimer);
  saveTracking();
  updateBanner();
  renderTodo();
  showToast('已暂停执行,进度保留');
}
/* 切换执行项(同一次需求):清单里挑一条 pending 直接顶上,当前那条退回等着 */
function switchTodo(i) {
  if (!S.tracking || i === S.curIdx) return;
  const t = S.todos[i];
  if (!t || t.status !== 'pending') return;
  const cur = S.todos[S.curIdx];
  if (cur && cur.status === 'doing') { cur.status = 'pending'; cur.startTime = null; }
  S.curIdx = i;
  t.status = 'doing';
  t.startTime = Date.now();
  startTaskTimer(t);
  saveTracking();
  updateBanner();
  renderTodo();
}
function beginTracking() {
  S.curIdx = S.todos.findIndex((t) => t.status !== 'done');
  if (S.curIdx < 0) return;
  S.tracking = true;
  S.todos[S.curIdx].status = 'doing';
  S.todos[S.curIdx].startTime = Date.now();
  startTaskTimer(S.todos[S.curIdx]);
  saveTracking();
  togglePanel('todo', true);
  showBubble(`${P('line_start', { name: S.todos[S.curIdx].name })}<br><span class="hint">${P('line_start_hint')}</span>`);
  scheduleCheck();
  renderTodo();
}
function updateBanner() {
  const b = $('todo-banner');
  if (S.curIdx < 0 || S.curIdx >= S.todos.length) { b.classList.remove('show'); return; }
  const t = S.todos[S.curIdx];
  const rm = S.timer ? fmtRemain(S.timer.endAt - Date.now()) : '';
  b.innerHTML = `<span style="color:var(--accent)">▸</span><span class="task-text">${t.name}</span>
    <span class="timer-label" title="番茄钟:本任务预估时长的倒计时">专注</span>
    <span id="timer-text" style="font-variant-numeric:tabular-nums;">${rm}</span>
    <button class="banner-btn pause" title="${S.timer?.paused ? '继续' : '暂停'}">${S.timer?.paused ? '▶' : '⏸'}</button>
    <button class="banner-btn ok" title="完成">✓</button>
    <button class="banner-btn skip" title="跳过此任务">⏭</button>`;
  b.querySelector('.pause').onclick = (e) => { e.stopPropagation(); pauseTimer(!S.timer?.paused); };
  b.querySelector('.ok').onclick = (e) => { e.stopPropagation(); completeTodo(S.curIdx); };
  b.querySelector('.skip').onclick = (e) => { e.stopPropagation(); skipTodo(S.curIdx); };
  b.onclick = () => togglePanel('todo');
}
function finishCurrent(skipped) {
  const t = S.todos[S.curIdx];
  t.endTime = Date.now();
  t.skipped = skipped;   // 快照要分清"跳过"与"完成"(Agent 按这个更新上游,别把跳过记成办完)
  S.taskHistory.push({ ...t, skipped });
  t.status = 'done';
  // 完成台账:日报结算会把 done 移出清单,Agent 轮询隔 10~30 分钟,
  // 没有台账就会漏账(真机反馈#3"勾了不回写"的另一半真相)
  (S.doneLedger = S.doneLedger || []).push({
    id: t.sid || null, from: t.from || 'manual', title: t.name,
    status: skipped ? 'skipped' : 'done', done_at_ms: t.endTime,
  });
  if (S.doneLedger.length > 50) S.doneLedger.splice(0, S.doneLedger.length - 50);
  const next = S.todos.findIndex((x) => x.status === 'pending');
  if (next === -1) {
    S.tracking = false;
    clearTimeout(S.checkTimer);
    playEmo('happy', { loop: false, prio: PRIORITY.emo });
    setTimeout(showReport, 1200);
  } else {
    S.curIdx = next;
    S.todos[next].status = 'doing';
    S.todos[next].startTime = Date.now();
    startTaskTimer(S.todos[next]);
    updateBanner();
  }
  saveTracking();
  renderTodo();
}
/* 情绪播放入口统一走这里:包形象自动映射;包没这个情绪但属标准情绪
 * → 仍播 emo_ 槽位:角色定格，只出粒子兜底(泪滴/汗珠，无容器弹跳) */
function playEmo(emo, opts = { loop: true, prio: PRIORITY.emo }) {
  if (Persona.active) {
    const anim = Persona.emoAnim(emo);
    if (anim) { Player.play(anim, opts); return; }
  }
  if (Player.manifest['emo_' + emo]) Player.play('emo_' + emo, opts);
}
/* 事件反应:优先让模型现场发挥，没 API 才用预设 */
function llmReact(event, fallback, emo) {
  if (CFG.chatApi.key && !S.speaking) chatLLM(event, { hideUser: true });
  else sayLocal(fallback, emo);
}
function completeTodo(i) {
  if (i !== S.curIdx || S.todos[i].status === 'done') return;
  const name = S.todos[i].name;
  playEmo('happy', { loop: false, prio: PRIORITY.emo });
  llmReact(P('complete_react', { name }), P('line_complete'), 'happy');
  Study.onUserDone(); // 自习室同步错觉:你勾完一条,它也"刚好"干完一条
  finishCurrent(false);
}
function skipTodo(i) {
  if (i !== S.curIdx || S.todos[i].status === 'done') return;
  const name = S.todos[i].name;
  llmReact(P('skip_react', { name }), P('line_skip'), 'speechless');
  finishCurrent(true);
}

/* 屏检:频率 1快~5慢 → 基础间隔分钟 */
const CHECK_BASE_MIN = [3, 6, 12, 20, 35];
function scheduleCheck() {
  clearTimeout(S.checkTimer);
  if (!S.tracking) return;
  const base = CHECK_BASE_MIN[(CFG.screenLevel || 3) - 1] * 60000;
  S.checkTimer = setTimeout(runScreenCheck, base * (0.7 + Math.random() * 0.6));
}
async function runScreenCheck() {
  if (!S.tracking) return;
  // 断网快跳:不摸相机不转圈,直接排下一轮(在线但连不上的场景由
  // vision 单次 60s 超时兜底——盯梢是周期活,失败不值得重试三连)
  if (!navigator.onLine) {
    logLLM('vision-judge', '(跳过)', '离线,本轮盯梢不发起');
    scheduleCheck();
    return;
  }
  S.screenChecks++;
  const ui = $('screen-check-ui');
  ui.classList.add('active');
  playThink();   // 屏检判定期间也进入思考态(包形象带 think 槽位才生效)
  try {
    const b64 = await captureScreenSafe();
    const task = S.todos[S.curIdx]?.name || '';
    // 判定标准按灵敏度档位取「判定标准分级」提示词的对应行(后台可编辑)
    const levels = P('screen_strict_levels').split('\n').filter(Boolean);
    const strict = levels[Math.min(levels.length, CFG.sensitivity || 3) - 1] || '中等';
    // 统一走 visionChat(协议路由 openai/anthropic 在里面)
    const judgePrompt = P('screen_judge', { task, strict, persona: personaText() });
    const content = await visionChat({
      text: judgePrompt, imageB64: b64, maxTokens: 120, label: 'vision-judge',
      retries: 0, // 单次 60s 超时封顶:三连重试曾把观察圈挂 3 分钟(真机实锤)
    });
    let v = { verdict: 'unsure', comment: '' };
    try { v = JSON.parse((content.match(/\{[\s\S]*\}/) || ['{}'])[0]); } catch {}
    logLLM('vision-judge', judgePrompt, content || '(空)');
    ui.classList.remove('active');
    stopThink();   // 静音专注+认真的分支不播情绪,思考循环得在这里收掉
    // 盯梢也记观察流水(只记客观判定+任务;桌宠评语只进对话不入账)
    const vt = v.verdict === 'slacking' ? '摸鱼' : v.verdict === 'working' ? '认真' : '没看清';
    journalRecord(`[盯梢·${vt}] ${task}`);
    reactToCheck(v);
  } catch (err) {
    ui.classList.remove('active');
    stopThink();
    console.warn('屏检失败:', err.message);
    // 失败也进调试日志(后台"锐评没看清先来对账"的承诺要兑现)
    logLLM('vision-judge', `task=${S.todos[S.curIdx]?.name || ''}`, `ERROR: ${err.message}`);
  }
  scheduleCheck();
}
function reactToCheck(v) {
  const say = v.comment || fbMsg(v.verdict === 'slacking' ? 'catch'
    : v.verdict === 'working' ? 'work' : 'unsure');
  // 点评入对话列表(气泡 4.5s 一闪而过,翻不到=没说过);静音专注也照落账,只是不冒泡
  petSay(say);
  if (v.verdict === 'slacking') {
    if (S.curIdx >= 0 && S.curIdx < S.todos.length) S.todos[S.curIdx].hadSlack = true;
    Study.noteUserSlack(); // 自习室:它抓到你摸鱼计一笔+开 30 分钟共犯窗口(它也更敢摸)
    // 特效映射(用户拍板):抓摸鱼=冲击波;连续 3 次屡教不改=冰封大招
    S.slackStreak = (S.slackStreak || 0) + 1;
    if (S.slackStreak >= 3) FX.freeze(); else FX.shockwave();
    playEmo('angry');
    showBubble(say, 6000);
    setTimeout(() => Player.backToIdle(), 6000);
  } else if (v.verdict === 'working') {
    S.slackStreak = 0; // 认真干活即清零"屡教不改"计数
    Study.noteUserWork(); // 你回去干活了,它的共犯窗口提前关闭
    if (CFG.silentFocus) return;
    playEmo('happy');
    showBubble(say, 4500);
    setTimeout(() => Player.backToIdle(), 4500);
  } else {
    playEmo('speechless');
    showBubble(say, 4500);
    setTimeout(() => Player.backToIdle(), 4500);
  }
}

/* ---- 随机屏摄日记:无待办也定期看一眼，记下来并开口点评，但绝不判摸鱼(journalMode) ----
 * 频率与待办屏检共用 screenLevel 档位;有待办监督在跑时歇着(那边已有记录) */
function scheduleJournal() {
  clearTimeout(S.journalTimer);
  if (!CFG.journalMode) return;
  const base = CHECK_BASE_MIN[(CFG.screenLevel || 3) - 1] * 60000;
  S.journalTimer = setTimeout(runJournalCheck, base * (0.7 + Math.random() * 0.6));
}
/* 观察入库:保留最近 100 条不跨天清空(日报取今天/周报取近一周)。
 * 清洗只删 emo/fx 标签,别误伤 [盯梢·]/[锐评] 这类来源前缀(踩过) */
function journalRecord(note) {
  if (!note) return;
  const clean = String(note).replace(/\[(emo|fx):[^\]]*\]/g, '').trim().slice(0, 60);
  // 时间戳单调递增:同一毫秒进两条时,水位线(严格大于)会把后一条永远漏掉(单测实锤)
  const t = Math.max(Date.now(), (S.journal[S.journal.length - 1]?.t || 0) + 1);
  S.journal.push({ t, note: clean });
  if (S.journal.length > 100) S.journal.splice(0, S.journal.length - 100);
  API.setStore('journal', { notes: S.journal });
  exportObservations();
}
/* Part3 观察导出对齐口径(真机反馈#2:UI"已观察 16 次" vs jsonl 仅 2 条):
 * 观察 tab 的每一条都必须出现在 ~/agent_pet/ 流水里——用水位线(最后已导出
 * 条目的时间戳,持久化)保证 jsonl ⊇ 观察账本,崩溃/漏发的条目下次启动补发。
 * 分享关着时只推水位不导出:关闭期间的记录永不出门(隐私边界不变)。
 * 补发条目的 todo_running 按当前状态填,历史时刻的任务名本就在 note 文本里 */
function exportObservations() {
  const fresh = S.journal.filter((n) => n.t > (S.obsMark || 0));
  if (!fresh.length) return;
  if (CFG.agentShare !== false) {
    for (const n of fresh) {
      const source = n.note.startsWith('[盯梢') ? 'screen_watch'
        : n.note.startsWith('[锐评') ? 'screen_comment'
        : n.note.startsWith('[研究') ? 'study' : 'screen_diary';
      API.agentObserve?.({
        t: n.t, source, summary: n.note,
        todo_running: S.tracking && S.todos[S.curIdx] ? S.todos[S.curIdx].name : null,
      });
    }
  }
  S.obsMark = fresh[fresh.length - 1].t;
  API.setStore('obsMark', S.obsMark);
}
/* 时间过滤:今天 / 近 N 天 */
function isToday(ts) { return new Date(ts).toDateString() === new Date().toDateString(); }
function inDays(ts, n) { return Date.now() - ts < n * 86400000; }
/* 单段回复的"记/说"两行拆分(日记与锐评单段共用)。模型没按格式来时按内容分流:
 * 旁白式("用户正在…")=客观内容→只入账不开口;点评式=只开口不入账
 * (观察日志只收客观记录,桌宠的评价只进对话——用户拍板) */
function parseJournalReply(reply) {
  const t = String(reply || '').trim();
  const note = (t.match(/记[:：]\s*(.+)/) || [])[1] || '';
  const say = (t.match(/说[:：]\s*([\s\S]+)/) || [])[1] || '';
  if (!note && !say) {
    const narr = isNarration(t);
    return { note: narr ? t : '', say: narr ? '' : t };
  }
  return { note: note.trim(), say: say.trim() };
}
/* 旁白检测:视觉模型溜号时会输出"用户正在…"式第三人称复述而不是开口说话 */
function isNarration(s) {
  return /^\[?[a-z:\]]*\s*(用户|ta|他|她)\s*(正在|在|似乎|好像)/i.test(String(s || '').trim());
}
async function runJournalCheck() {
  // 睡觉门禁看的是"画面上在睡"(sleep_in/sleep/sleep_out),不是深夜时段标志:
  // 用户熬夜把桌宠吵醒了就照记;正在说话则跳过本轮等下一轮
  const asleep = typeof Player !== 'undefined' && Player.cur && /^sleep/.test(Player.cur.name);
  if (CFG.journalMode && !S.tracking && !asleep && !S.speaking &&
      CFG.visionApi.key && (CFG.chatApi.key || CFG.visionCanChat)) {
    try {
      const b64 = await captureScreenSafe();
      if (CFG.visionCanChat) {
        // 单段:一次看图产出「记(日记一句)+说(人设点评)」,点评当场开口
        const conv = curConv();
        conv.msgs.push({ role: 'user', content: '(随手看了一眼你的屏幕)', hidden: true });
        conv.updated = Date.now();
        const ctx = conv.msgs.slice(0, -1).slice(-(CFG.ctxLimit || 50))
          .map(({ role, content }) => ({ role, content }));
        const reply = await visionChat({
          system: systemPrompt(), history: ctx,
          text: P('journal_observe_direct'), imageB64: b64, maxTokens: 200, label: 'journal',
        });
        logLLM('journal', P('journal_observe_direct'), reply || '(空)');
        const { note, say } = parseJournalReply(reply);
        journalRecord(note);
        if (say) speakText(say);
      } else {
        // 两段:视觉模型客观记一句 → 对话模型按人设开口点评
        const note = await visionChat({
          text: P('journal_observe'), imageB64: b64, maxTokens: 60, label: 'journal',
        });
        logLLM('journal', P('journal_observe'), note || '(空)');
        if (note) {
          journalRecord(note);
          chatLLM(P('journal_comment', { desc: note }), { hideUser: true });
        }
      }
    } catch (e) { logLLM('journal', '(随机屏摄)', `ERROR: ${e.message}`); }
  }
  scheduleJournal();
}
/* 观察流水已并入「记录」tab 顶部折叠区(renderReportList,2026-07-26 整合) */

/* 生成今日日报:待办完成情况 + 观察流水统一喂给对话模型(2026-07-19 用户拍板联动) */
function showJournalReport() {
  const doneN = S.todos.filter((t) => t.status === 'done').length;
  const tj = S.journal.filter((n) => isToday(n.t)); // 日报只取今天的观察
  const rep = {
    ts: Date.now(), journal: true,
    done: doneN, all: S.todos.length, totalMin: 0, slack: 0,
    checks: tj.length,
    span: tj.length ? tj[tj.length - 1].t - tj[0].t : 0,
    comment: null,
  };
  S.reports.push(rep); saveReports();
  renderReport(rep);
  const fmtT = (t) => { const d = new Date(t); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const notes = S.journal.filter((n) => isToday(n.t)).map((n) => `${fmtT(n.t)} ${n.note}`).join('\n');
  const todos = S.todos.length
    ? S.todos.map((t) => `${t.status === 'done' ? '✓' : t.status === 'skipped' ? '跳过' : '未完成'} ${t.name}`).join('; ')
    : '(今天没录待办)';
  chatLLMPlain(P('journal_report', { notes: notes || '(今天没有观察记录)', todos, study: studySummaryLine() || '(没开自习室)' }))
    .then((t) => { rep.comment = t; })
    .catch(() => { rep.comment = '今天就这样过去了。'; })
    .finally(() => {
      saveReports();
      const el = document.getElementById('report-ai');
      if (el) el.textContent = rep.comment;
    });
}

/* ---- 日报(本地持久化，可回看) ---- */
function fmtReportTitle(ts, weekly) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日${d.getHours()}点${String(d.getMinutes()).padStart(2, '0')}分生成的${weekly ? '周报' : '日报'}`;
}
function saveReports() { API.setStore('reports', S.reports.slice(-60)); }
function renderReport(rep) {
  // 日记型日报(无待办，凭随机观察):统计卡换成 观察次数/时间跨度
  const stats = rep.journal
    ? `<div class="stat-card"><div class="num">${rep.checks}</div><div class="lbl">观察次数</div></div>
       <div class="stat-card"><div class="num">${((rep.span || 0) / 3600000).toFixed(1)}<span style="font-size:12px">h</span></div><div class="lbl">时间跨度</div></div>`
    : `<div class="stat-card"><div class="num">${rep.done}/${rep.all}</div><div class="lbl">完成待办</div></div>
       <div class="stat-card"><div class="num">${rep.totalMin.toFixed(0)}<span style="font-size:12px">min</span></div><div class="lbl">总耗时</div></div>
       <div class="stat-card"><div class="num">${rep.checks}</div><div class="lbl">检查次数</div></div>
       <div class="stat-card"><div class="num">${rep.slack}</div><div class="lbl">摸鱼任务数</div></div>`;
  $('report-body').innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
      <button class="chat-hbtn" id="rep-back" aria-label="返回报告列表"><svg viewBox="0 0 20 20"><path d="M12 4.5 6.5 10 12 15.5"/></svg></button>
      <div class="rep-head ${rep.weekly ? 'weekly' : ''}" style="margin-bottom:0;">${rep.weekly ? '✦ ' : rep.journal ? '☀ ' : ''}${fmtReportTitle(rep.ts, rep.weekly)}</div>
    </div>
    <div class="report-stats">${stats}</div>
    <div class="report-ai" id="report-ai">${rep.comment || Persona.petName() + '正在写评语…'}</div>`;
  $('rep-back').addEventListener('click', renderReportList);
  openReportView();
}
function renderReportList() {
  const body = $('report-body');
  // 「记录」tab(2026-07-26 整合):今日观察流水折叠区 + 周报入口 + 日报列表
  const escW = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const fmtTW = (t) => { const d = new Date(t); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const fmtDW = (t) => { const d = new Date(t); return isToday(t) ? '今天' : `${d.getMonth() + 1}/${d.getDate()}`; };
  // 全量展示(保留最近 100 条不跨天清——别只滤今天,历史会凭空"消失",踩过)
  const rows = S.journal.slice().reverse();
  const todayN2 = S.journal.filter((n) => isToday(n.t)).length;
  const watch = `<details class="rec-watch" open><summary>观察流水(今天 ${todayN2} 条 / 共 ${rows.length} 条,留最近 100 条)——盯梢/锐评/日记原始记录,日报取今天、周报取近一周</summary>${
    rows.length
      ? rows.map((n) => `<div class="watch-row"><span class="watch-t">${fmtDW(n.t)} ${fmtTW(n.t)}</span><span class="watch-note">${escW(n.note)}</span></div>`).join('')
      : '<div class="watch-empty">还没有:开日记、点锐评、或开始待办监督就有了</div>'}</details>`;
  // 生成入口统一住记录区:今日日报(今天有观察记录且没在跑待办才可出)+ 周报
  const todayN = S.journal.filter((n) => isToday(n.t)).length;
  const dailyBtn = (!S.tracking && todayN)
    ? `<button class="report-btn" id="todo-journal-report" style="margin:0 0 10px;">☀ 生成今日日报(已观察 ${todayN} 次)</button>` : '';
  // 默认态(用户拍板 07-26):原始流水展开,历史报表收起;
  // 周报按钮常驻(藏起来会被当成"没有这功能"),不可用置灰点击给原因
  const wkOk = weeklyAvailable();
  const wkWhy = ![5, 6, 0].includes(new Date().getDay()) ? '周五到周日才可生成'
    : S.misc.weeklyDone === weekKey() ? '本周周报已生成过了'
    : '本周还没有日报,先出一份日报';
  const weeklyBtn = `<button class="report-btn" id="todo-weekly"
    style="color:var(--accent);border-color:var(--accent);margin:0 0 10px;${wkOk ? '' : 'opacity:0.45;'}">✦ 生成本周周报${wkOk ? '' : `(${wkWhy})`}</button>`;
  body.innerHTML = watch + dailyBtn + weeklyBtn +
    `<details class="rec-reports"><summary>历史日报 / 周报(${S.reports.length} 份)</summary><div id="report-list"></div></details>`;
  $('todo-journal-report')?.addEventListener('click', showJournalReport);
  $('todo-weekly')?.addEventListener('click', () => {
    if (!weeklyAvailable()) { showToast(wkWhy); return; }
    generateWeekly();
  });
  const items = [...S.reports].reverse().map((r, i) => ({
    idx: S.reports.length - 1 - i,
    cls: r.weekly ? 'weekly' : '',
    title: `${r.weekly ? '✦ ' : r.journal ? '☀ ' : ''}${fmtReportTitle(r.ts, r.weekly)}`,
    sub: r.journal ? `屏摄日记 · 观察 ${r.checks} 次`
      : `${r.weekly ? '本周汇总 · ' : ''}完成 ${r.done}/${r.all} · 摸鱼 ${r.slack}`,
  }));
  renderCardList($('report-list'), items, {
    empty: '还没有日报',
    onOpen: (it) => renderReport(S.reports[it.idx]),
    onDelete: (it) => { S.reports.splice(it.idx, 1); saveReports(); renderReportList(); },
  });
  openReportView();
}
/* 点击"眼睛"按钮:看一眼当前屏幕，结合待办状态锐评 */
async function commentScreen() {
  if (S.speaking) return;
  if (!CFG.visionApi.key) { showBubble('还没配置视觉模型 API…'); return; }
  // 单段模式不经对话模型，没配 chatApi 也能锐评
  if (!CFG.chatApi.key && !CFG.visionCanChat) { showBubble('还没配置对话模型 API…'); return; }
  const ui = $('screen-check-ui');
  ui.classList.add('active');
  try {
    const b64 = await captureScreenSafe();
    const hasTodo = S.tracking && S.curIdx < S.todos.length;
    const task = S.todos[S.curIdx]?.name || '';
    if (CFG.visionCanChat) {
      // 单段:多模态模型带人设+聊天上下文，看图直接开口(省一次往返)
      const conv = curConv();
      conv.msgs.push({ role: 'user', content: '(瞄了一眼你的屏幕)', hidden: true });
      conv.updated = Date.now();
      const ctx = conv.msgs.slice(0, -1).slice(-(CFG.ctxLimit || 50))
        .map(({ role, content }) => ({ role, content }));
      const key2 = hasTodo ? 'comment_direct_with_todo' : 'comment_direct_no_todo';
      const sys = systemPrompt();
      const reply = await visionChat({
        system: sys, history: ctx,
        text: P(key2, { task }), imageB64: b64, maxTokens: 200, label: 'vision-direct',
      });
      logLLM('vision-direct',
        `[system]\n${sys}\n—— 上下文 ${ctx.length} 条 ——\n` +
        ctx.map((m) => `${m.role}: ${m.content}`).join('\n') +
        `\n[指令] ${P(key2, { task })}`, reply || '(空响应)');
      ui.classList.remove('active');
      if (!reply) throw new Error('视觉模型返回空，详见配置后台的调试日志');
      // 双字段拆分(与日记同款格式):「记」=客观入观察流水,「说」=开口点评只进对话
      // (用户拍板:桌宠的评价不进观察日志)
      const jr = parseJournalReply(reply);
      if (jr.note) journalRecord('[锐评] ' + jr.note); // 只有客观部分才入观察流水
      if (jr.say && !isNarration(jr.say)) { speakText(jr.say); return; }
      // 没给出能开口的「说」(或仍是旁白):把客观部分丢给对话模型点评
      if (CFG.chatApi.key) {
        logLLM('vision-direct', '(无有效开口内容,降级两段点评)', reply);
        chatLLM(P(hasTodo ? 'comment_with_todo' : 'comment_no_todo', { desc: jr.note || reply, task }), { hideUser: true });
        return;
      }
      speakText(reply);
      return;
    }
    // 两段:视觉模型客观描述 → 对话模型按人设锐评
    const desc = await visionChat({
      text: P('screen_desc'), imageB64: b64, maxTokens: 150, label: 'vision-desc',
    });
    logLLM('vision-desc', P('screen_desc'), desc || '(空响应)');
    ui.classList.remove('active');
    if (!desc) throw new Error('视觉模型返回空，详见配置后台的调试日志');
    journalRecord('[锐评] ' + desc); // 锐评也进观察流水(不再看 journalMode)
    const key2 = hasTodo ? 'comment_with_todo' : 'comment_no_todo';
    chatLLM(P(key2, { desc, task }), { hideUser: true });
  } catch (e) {
    ui.classList.remove('active');
    // 请求没发出去/HTTP 挂了也要进调试日志，不然"去后台对账"会扑空
    logLLM('vision-desc', P('screen_desc'), `ERROR: ${e.message}`);
    showBubble(`没看清…(${String(e.message).slice(0, 60)})`, 7000);
  }
}

function showReport() {
  const rep = {
    ts: Date.now(),
    done: S.taskHistory.filter((t) => !t.skipped).length,
    all: S.taskHistory.length,
    totalMin: S.taskHistory.reduce((s, t) =>
      s + (t.startTime && t.endTime ? (t.endTime - t.startTime) / 60000 : 0), 0),
    checks: S.screenChecks,
    slack: S.taskHistory.filter((t) => t.hadSlack).length,
    comment: null,
  };
  S.reports.push(rep); saveReports();
  renderReport(rep);
  const summary = S.taskHistory.map((t) =>
    `${t.name}(${t.skipped ? '跳过' : '完成'}${t.hadSlack ? '，有摸鱼' : ''})`).join('; ');
  // 观察流水也一并入报(与 ☀ 日记型日报同一本账)
  const fmtT2 = (t) => { const d = new Date(t); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const notes2 = S.journal.filter((n) => isToday(n.t))
    .map((n) => `${fmtT2(n.t)} ${n.note}`).join('\n');
  chatLLMPlain(P('daily_report', { summary: summary || '无', checks: rep.checks, notes: notes2 || '(无)', study: studySummaryLine() || '(没开自习室)' }))
    .then((txt) => { rep.comment = txt; })
    .catch(() => { rep.comment = '今天结束了。明天继续。'; })
    .finally(() => {
      saveReports();
      const el = document.getElementById('report-ai');
      if (el) el.textContent = rep.comment;
    });
  // 日报结算:只清已完成的，没做完的留到明天(用户拍板)
  S.taskHistory = []; S.screenChecks = 0; S.curIdx = -1;
  S.todos = S.todos.filter((t) => t.status !== 'done')
    .map((t) => ({ ...t, status: 'pending', startTime: null, endTime: null }));
  saveTodos();
}
async function chatLLMPlain(prompt, maxTokens = 200) {
  if (!CFG.chatApi.key) throw new Error('no api');
  const { resp } = await chatFetchFailover((a) => ({
    model: a.model,
    messages: [{ role: 'system', content: systemPrompt() }, { role: 'user', content: prompt }],
    max_tokens: maxTokens,
  }), 'plain');
  const data = await resp.json();
  if (data.error) { logLLM('plain', prompt, `API ERROR: ${JSON.stringify(data.error)}`); throw new Error(data.error.message || 'API错误'); }
  const out = chatText(data).replace(/\[(emo|fx):\w+\]/g, '').trim();
  logLLM('plain', prompt, out);
  return out;
}

