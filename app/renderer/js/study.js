/* ================= 自习室模式(功能1) =================
 * 它不是陪读书童,是同桌:它有自己的宏大研究目标,每天按用户待办数镜像拆出等量
 * "子课题";用户追踪待办时它同步推进——按专注时长自然推进,用户每勾完一条它也
 * "刚好"干完一条冒泡汇报(同步前进的错觉)。子课题完成时联网检索真实冷知识
 * (智谱 web_search,检索词用拆题产出的"事实内核"q 字段),按"事实真实+推论跳跃"
 * 双句式汇报;没配检索就纯凭大语言模型直答。它也会摸鱼(演出随机,盯梢抓到用户
 * 摸鱼后 30 分钟共犯窗口内概率×4),点它可抓包;结束用 PK 打卡图结算。
 * 目标=研究线列表(07-25 结构升级):每条线独立存 进度/研究天数/成果档案,
 * 切换不丢进度。默认关闭(CFG.studyMode),关闭时本模块零行为。 */

/* 码绘摸鱼演出池:场景类→时长(CSS 小剧场在 style.css「自习室演出池」块) */
const BUN_SLACK_SCENES = { 'sc-cat': 8000, 'sc-fish': 9000, 'sc-tea': 6700 };

const Study = {
  d: null,          // store 'study':{day,cur,lines:{goal:{...}},当日战况}
  slacking: false, scene: '', slackTimer: null,
  napping: false,   // 睡觉摸鱼中(slack 的一种,三段式入睡→睡→睡醒)
  graceUntil: 0,    // 散场缓刑:演出/瞌睡收摊后 5 秒内点到照算抓包
  thinking: false, thinkTimer: null,
  boostUntil: 0,    // 共犯窗口:盯梢抓到用户摸鱼→30 分钟内它摸鱼概率×4
  gen: false,       // 拆题请求进行中(防并发重复生成)
  saveT: null,

  on() { return CFG.studyMode && S.tracking && !S.sleeping; },

  async init() {
    this.d = (await API.getStore('study')) || null;
    this.normalize();
  },
  /* 结构与日界整理(幂等):旧单线存档迁移 / 全局战况跨天清零 /
   * 当前线今天首次被用到→研究天数+1、清当日课题(成果档案 feed 不清) */
  normalize() {
    const today = new Date().toDateString();
    // 旧单线存档 → 研究线列表(切目标丢进度的旧结构,迁移后不丢)
    if (this.d && this.d.goal && !this.d.lines) {
      const o = this.d;
      this.d = {
        day: o.day || today, cur: o.goal,
        lines: { [o.goal]: { goal: o.goal, dayIdx: o.dayIdx || 1, pct: o.pct || 3,
          doneTitles: o.doneTitles || [], tasks: o.tasks || [], lastDay: o.day || today,
          feed: (o.tasks || []).filter((t) => t.done && t.f).map((t) => ({ t: t.t, f: t.f })) } },
        caughtYou: o.caughtYou || 0, caughtPet: o.caughtPet || 0,
        petSlack: o.petSlack || 0, focusMin: o.focusMin || 0,
      };
    }
    if (!this.d || !this.d.lines)
      this.d = { day: today, cur: '', lines: {}, caughtYou: 0, caughtPet: 0, petSlack: 0, focusMin: 0 };
    if (!this.d.cur) this.d.cur = CFG.studyGoal || DEFAULT_STUDY_GOAL;
    if (!this.d.lines[this.d.cur])
      this.d.lines[this.d.cur] = { goal: this.d.cur, dayIdx: 0, pct: 2 + Math.random() * 2,
        doneTitles: [], tasks: [], lastDay: '', feed: [] };
    if (this.d.day !== today) {
      this.d.day = today;
      this.d.caughtYou = 0; this.d.caughtPet = 0; this.d.petSlack = 0; this.d.focusMin = 0;
      this.save();
    }
    const L = this.d.lines[this.d.cur];
    if (L.lastDay !== today) {
      L.lastDay = today; L.dayIdx = (L.dayIdx || 0) + 1; L.tasks = [];
      this.save();
    }
  },
  rollover() { this.normalize(); },  // 旧入口名保留(settings 等处在调)
  line() { return this.d && this.d.lines[this.d.cur]; },

  /* 研究线切换/新增/删除:进度与成果档案都在各自线里,切换自由 */
  switchLine(goal) {
    goal = String(goal || '').trim().slice(0, 20);
    if (!goal || !this.d) return;
    this.d.cur = goal;
    CFG.studyGoal = goal; API.setConfig(CFG);
    this.normalize(); this.save();
    renderStudy();
    showToast(this.d.lines[goal].dayIdx > 1 ? '接着研究:' + goal : '新研究线开张:' + goal);
  },
  removeLine(goal) {
    if (!this.d || goal === this.d.cur) return;
    delete this.d.lines[goal];
    this.save(); renderStudy();
  },
  save() {
    clearTimeout(this.saveT);
    this.saveT = setTimeout(() => API.setStore('study', this.d), 400);
  },

  /* ---- 镜像拆题:它的任务数跟当天用户待办数走 ---- */
  async ensureTasks() {
    if (!this.d) return;
    this.normalize();
    const L = this.line();
    if (L.done) return; // 结题的线不再拆新课题(换线或开新目标才继续)
    const target = Math.max(1, Math.min(8, S.todos.length));
    const missing = target - L.tasks.length;
    if (missing <= 0 || this.gen) return;
    this.gen = true;
    try {
      let items = [];
      if (CFG.chatApi.key) {
        const done = (L.doneTitles || []).slice(-30).join('、') || '(无)';
        const raw = await chatLLMPlain(P('study_split',
          { goal: L.goal, n: missing, done }), 500);
        // 标题上限只当保险丝(提示词已要求 ≤16 字):剪太狠会"结巴"(真机实锤);
        // q=事实内核检索词——拿荒诞标题原文去搜只会捞回不相关营销号,模型被迫
        // 照抄就"说胡话"(奶酪课题答金币,真机实锤),兼容旧格式纯字符串
        let parsed = [];
        try { parsed = JSON.parse((raw.match(/\[[\s\S]*\]/) || ['[]'])[0]); } catch { parsed = []; }
        // 模型爱输出「1. {...} 2. {...}」编号列表(没方括号,拆题整批作废落兜底
        // 抽出无关示例题,真机实锤"吞噬宇宙抽到外星人打招呼"):逐个抠对象救回
        if (!parsed.length)
          parsed = [...raw.matchAll(/\{[^{}]*\}/g)]
            .map((m) => { try { return JSON.parse(m[0]); } catch { return null; } })
            .filter(Boolean);
        items = parsed
          .map((x) => typeof x === 'string' ? { t: x, q: '' } : x)
          .map((x) => ({ t: String(x.t || '').trim().slice(0, 32), q: String(x.q || '').trim().slice(0, 60) }))
          .filter((x) => x.t);
      }
      // 没配 API/拆题失败:内置示例课题池兜底(自带结论,离线也能玩)
      if (!items.length) {
        const used = new Set(L.tasks.map((t) => t.t).concat(L.doneTitles || []));
        items = STUDY_OFFLINE.filter((o) => !used.has(o.t)).slice(0, missing)
          .map((o) => ({ t: o.t, q: '' }));
      }
      items.slice(0, missing).forEach(({ t, q }) =>
        L.tasks.push({ t, q, f: '', done: false, need: 12 + Math.random() * 10, got: 0 }));
      this.save();
      this.renderIfOpen();
    } catch (e) { logLLM('study', '拆题', `ERROR: ${e.message}`); }
    this.gen = false;
  },

  /* ---- 主循环:10s 一拍,只在"用户追踪待办 + 模式开启"时活动 ---- */
  tick() {
    const pet = document.getElementById('pet');
    if (!this.on() || !this.d) { this.clearVisual(pet); return; }
    this.normalize();
    const L = this.line();
    const dt = 10 / 60; // 本拍折合的专注分钟数
    this.d.focusMin += dt;
    if (L.tasks.length < Math.min(8, S.todos.length)) this.ensureTasks();

    // 摸鱼状态机:演出池随机抽;共犯窗口内概率×4。
    // 听歌口径(用户拍板 07-26):点头就是听歌时的待机,研究推进/记账照常,
    // 但摸鱼/思考演出不往点头上叠
    const busy = S.speaking || Player.cur?.name === 'dance_nod';
    if (!this.slacking && !this.thinking && !busy) {
      const mult = Date.now() < this.boostUntil ? 4 : 1;
      if (Math.random() < 0.005 * mult) this.slackStart(pet);
      // 思考插播(彩蛋级:平均两三分钟一段)
      else if (Math.random() < 0.05) this.thinkStart(pet);
    }
    // 认真态标记(码绘微眯眼;摸鱼演出接管时不打)
    if (pet) pet.classList.toggle('studying', !this.slacking);

    // 任务推进(摸鱼时不推进)
    const cur = L.tasks.find((t) => !t.done);
    if (cur && !this.slacking) {
      cur.got += dt;
      if (cur.got >= cur.need) this.completeTask(cur, false);
    }
    // 偶尔冒一句"在学什么"(本地台词,不花 token)
    if (cur && !this.slacking && !S.speaking && Math.random() < 0.008) {
      const short = cur.t.split(/[:：]/).pop();
      showBubble(pickLine(P('line_study_focus')).replace('{t}', short), 3600);
    }
    this.save();
  },

  /* ---- 摸鱼演出池(07-26 定稿):码绘=CSS 小剧场随机抽(小猫/鱼群/泡汤,单次演完
   * 自动收工);包形象=slack_* 槽位随机。睡觉摸鱼(07-26 二版):非正常睡觉
   * 时段做着任务打瞌睡也是一种摸鱼,30~60 秒三段式(入睡→睡→睡醒);
   * 正常睡觉时段的睡是正经睡,不进摸鱼池 ---- */
  slackStart(pet) {
    clearTimeout(this.slackTimer);
    if (Persona.active) {
      const pool = Object.keys(Persona.manifest || {}).filter((k) => k.startsWith('slack_'));
      if (Persona.has('sleep') && !isNight()) pool.push('__nap');
      if (!pool.length) return;
      this.slacking = true;
      this.d.petSlack++;
      const pick = pool[Math.floor(Math.random() * pool.length)];
      if (pick === '__nap') {
        this.napping = true;
        if (Persona.has('sleep_in'))
          Player.play('sleep_in', { prio: PRIORITY.egg, onEnd: () => {
            if (this.slacking && this.napping) Player.play('sleep', { loop: true, prio: PRIORITY.egg });
          } });
        else Player.play('sleep', { loop: true, prio: PRIORITY.egg });
        this.slackTimer = setTimeout(() => this.slackEnd(), 30000 + Math.random() * 30000);
      } else {
        Player.play(pick, { loop: true, prio: PRIORITY.egg });
        this.slackTimer = setTimeout(() => this.slackEnd(), 45000 + Math.random() * 75000);
      }
    } else {
      this.slacking = true;
      this.d.petSlack++;
      this.thinkEnd(); // 思考让位摸鱼
      const keys = Object.keys(BUN_SLACK_SCENES);
      this.scene = keys[Math.floor(Math.random() * keys.length)];
      if (pet) { pet.classList.remove('studying'); pet.classList.add(this.scene); }
      this.slackTimer = setTimeout(() => this.slackEnd(), BUN_SLACK_SCENES[this.scene]);
    }
  },
  slackEnd(caught) {
    clearTimeout(this.slackTimer);
    if (!this.slacking) return;
    this.slacking = false;
    const wasNap = this.napping;
    this.napping = false;
    const pet = document.getElementById('pet');
    if (pet) pet.classList.remove('sc-cat', 'sc-fish', 'sc-tea');
    this.scene = '';
    let outMs = 0;
    if (wasNap && !caught && Player.manifest['sleep_out']) {
      // 自然睡醒:睡醒过渡单次,播完 Player 自动回待机
      const m = Player.manifest['sleep_out'];
      outMs = Math.round((m.frames / (m.fps || 12)) * 1000);
      Player.play('sleep_out', { prio: PRIORITY.egg });
    } else if (Player.cur?.name?.startsWith('slack_') || Player.cur?.name?.startsWith('sleep')) {
      Player.requestIdle();
    }
    if (caught) this.d.caughtPet++;
    // 散场缓刑:演出结束/睡醒之后 5 秒内点到照算抓包(用户拍板 07-26)
    else this.graceUntil = Date.now() + 5000 + outMs;
    this.save();
  },
  /* ---- 思考插播:学习中偶尔"陷入思考"(彩蛋级频率,tick 里摇骰子)。
   * 码绘=sc-think 小剧场两轮;包形象=think 槽位 ---- */
  thinkStart(pet) {
    if (this.thinking || this.slacking) return;
    this.thinking = true;
    if (Persona.active) playThink();
    else if (pet) pet.classList.add('sc-think');
    clearTimeout(this.thinkTimer);
    this.thinkTimer = setTimeout(() => this.thinkEnd(), 11200);
  },
  thinkEnd() {
    clearTimeout(this.thinkTimer);
    if (!this.thinking) return;
    this.thinking = false;
    const pet = document.getElementById('pet');
    if (pet) pet.classList.remove('sc-think');
    if (Persona.active) stopThink();
  },
  clearVisual(pet) {
    if (this.slacking) this.slackEnd();
    this.thinkEnd();
    if (pet) pet.classList.remove('studying', 'sc-busted');
  },

  /* ---- 抓包:自习中点它,由 state-ui 命中处理先转进来(返回 true=事件已消费) ---- */
  clickIntercept() {
    if (!this.on() || !this.d) return false;
    // 散场缓刑:演出/瞌睡刚收摊 5 秒内被点到,照样算抓包(slackEnd 里开的窗)
    const inGrace = Date.now() < (this.graceUntil || 0);
    if (this.slacking || inGrace) {
      if (this.slacking) this.slackEnd(true);
      else { this.graceUntil = 0; this.d.caughtPet++; this.save(); }
      if (Persona.active) {
        // 包带专属 busted 槽位优先播它,没有才用 surprise 情绪顶;
        // 单次动画播完会定格末帧,必须有人叫归位(真机包抓包卡死实锤)
        if (Persona.has('busted')) Player.play('busted', { loop: false, prio: PRIORITY.emo });
        else playEmo('surprise', { loop: false, prio: PRIORITY.emo });
        setTimeout(() => Player.backToIdle(), 2600);
      } else {
        // 码绘:被抓包小剧场(弹跳瞪眼+慌张乱瞟+头顶「!」,2.2s 自收)
        const pet = document.getElementById('pet');
        if (pet) {
          pet.classList.add('sc-busted');
          setTimeout(() => pet.classList.remove('sc-busted'), 2300);
        }
      }
      let line = pickLine(P('line_study_busted'));
      if (Date.now() < this.boostUntil) line += '<br><span class="hint">(你不也在摸鱼)</span>';
      showBubble(line, 4500);
      petSay(line.replace(/<[^>]+>/g, ' '));
      this.renderIfOpen();
    } else {
      const cur = this.line()?.tasks.find((t) => !t.done);
      const short = cur ? cur.t.split(/[:：]/).pop() : '';
      showBubble(cur
        ? '真在学。' + pickLine(P('line_study_focus')).replace('{t}', short)
        : '我这边都研究完了。摸会儿鱼不过分吧。', 3800);
    }
    return true;
  },

  /* ---- 与盯梢联动:它抓到你摸鱼→计一笔+开 30 分钟共犯窗口;你回去认真→窗口提前关 ---- */
  noteUserSlack() {
    if (!CFG.studyMode || !this.d) return;
    this.d.caughtYou++;
    this.boostUntil = Date.now() + 30 * 60000;
    this.save();
    this.renderIfOpen();
  },
  noteUserWork() { this.boostUntil = 0; },

  /* ---- 完成一条研究:同步错觉(用户勾一条它也刚好干完)与时间自然推进共用 ---- */
  onUserDone() {
    if (!this.on() || !this.d) return;
    const cur = this.line()?.tasks.find((t) => !t.done);
    if (cur) setTimeout(() => {
      if (!cur.done) this.completeTask(cur, true);
    }, 700 + Math.random() * 1000);
  },
  async completeTask(task, synced) {
    const L = this.line();
    task.done = true; task.got = task.need;
    // 进度逻辑:每完成一条 +0.1~0.35% 随机;攒满 100% 正式结题(用户拍板:研究得能完成)
    L.pct = Math.min(100, L.pct + 0.1 + Math.random() * 0.25);
    if (L.pct >= 100 && !L.done) {
      L.done = true;
      const cheer = `「${L.goal}」——结题了。` +
        pickLine('世界得救了…大概。\n给我记一功。\n下一个宏大命题在哪。');
      petSay(cheer);
      if (!S.speaking) showBubble(cheer, 8000);
      showToast('它的大目标研究完成了!');
    }
    (L.doneTitles = L.doneTitles || []).push(task.t);
    if (L.doneTitles.length > 60) L.doneTitles.splice(0, L.doneTitles.length - 60);
    task.f = await this.solveTask(task, L);
    // 成果档案:跨天留底(当日 tasks 会清,feed 不清);带研究日期(用户要求:
    // 成果得知道是哪天研究出来的)
    (L.feed = L.feed || []).push({ t: task.t, f: task.f, day: L.dayIdx, dt: Date.now() });
    if (L.feed.length > 12) L.feed.splice(0, L.feed.length - 12);
    this.save();
    journalRecord(`[研究] 完成「${task.t}」`);
    playEmo('happy', { loop: false, prio: PRIORITY.emo });
    const say = `「${task.t}」办完了。${task.f}`;
    petSay(say);
    if (!CFG.silentFocus && !S.speaking) {
      showBubble(say + (synced ? '<br><span class="hint">(你干完一条,我也刚好干完一条)</span>' : ''), 6500);
      setTimeout(() => Player.backToIdle(), 5000);
    }
    this.renderIfOpen();
  },
  /* 研究解题:优先按服务商自动联网(见 studyNetProvider 适配矩阵)→双句式;
   * 联网不可用/挂了→纯凭大语言模型直答;模型也没有→内置结论或老实认输 */
  async solveTask(task, L) {
    const offline = STUDY_OFFLINE.find((o) => o.t === task.t);
    try {
      if (!CFG.chatApi.key) throw new Error('no api');
      let out;
      try {
        out = await this.netSolve(task, L);
      } catch (se) {
        logLLM('study', `研究「${task.t}」`, `联网不可用(${se.message}),纯凭大语言模型`);
        out = await chatLLMPlain(P('study_solve_dry', { task: task.t, goal: L.goal }), 300);
      }
      if (out && out.length > 5) return out.slice(0, 120);
      throw new Error('empty');
    } catch (e) {
      logLLM('study', `研究「${task.t}」`, `落兜底: ${e.message}`);
      return offline ? offline.f : '今天没查到靠谱资料。改天再战。';
    }
  },
  /* 联网解题路由:检索词用拆题给的事实内核(task.q),没有才退回标题去前缀 */
  async netSolve(task, L) {
    if (CFG.webSearch === false) throw new Error('search off');
    const q = task.q || task.t.replace(/^[^:：]+[:：]/, '');
    const p = studyNetProvider();
    // 智谱本家或外配了智谱检索 Key:独立检索 API(资料饲喂式,最可控)
    if (p === 'zhipu' || CFG.searchKey) {
      const search = await webSearchStd(q);
      return chatLLMPlain(P('study_solve',
        { task: task.t, goal: L.goal, search: search || '(没搜到)' }), 300);
    }
    if (p === 'qwen')      // 阿里百炼:enable_search 单参开搜,一次调用出结果
      return studyNetChat(P('study_solve_net', { task: task.t, goal: L.goal, q }),
        { enable_search: true });
    if (p === 'moonshot')  // Kimi:$web_search 内置工具,tool_calls 回环
      return kimiSearchSolve(P('study_solve_net', { task: task.t, goal: L.goal, q }));
    throw new Error('该服务商暂无自动联网适配');
  },

  /* ---- 研究 tab ---- */
  renderIfOpen() {
    if (S.panel === 'panel-todo' && $('study-body') && $('study-body').style.display !== 'none')
      renderStudy();
  },
};

const DEFAULT_STUDY_GOAL = '搞清楚要怎么拯救世界';
const STUDY_GOAL_PRESETS = [DEFAULT_STUDY_GOAL, '搞清楚人的本质是什么', '搞清楚情感的本质是什么',
  '搞清楚友谊的本质是什么', '查明第一颗星星什么时候诞生', '搞清楚宇宙的尽头是什么'];
/* 内置示例课题(没配对话 API 也能完整体验;配了 API 只作检索失败的兜底) */
const STUDY_OFFLINE = [
  { t: '调研:小行星撞过来怎么办', f: 'NASA 在 2022 年真撞过一颗小行星,DART 任务把轨道撞短了 32 分钟。方法是有的,先记一笔。' },
  { t: '评估:超级火山的脾气', f: '黄石火山上次爆发是 64 万年前。按周期算还早,这条 ddl 不急。' },
  { t: '研究:太阳打喷嚏的后果', f: '1859 年卡林顿事件,极光亮到半夜能看报纸,电报机自己着火。得给电网记一笔风险。' },
  { t: '学习:怎么跟外星人打招呼', f: '旅行者金唱片录了 55 种语言的「你好」,还有一段人的脑电波。先辈准备得很足。' },
  { t: '调查:人类没了谁来接班', f: '章鱼有 5 亿个神经元、3 个心脏,可惜寿命只有三年。接班梯队堪忧。' },
  { t: '攻关:永动机是不是骗局', f: '热力学第二定律说不行,1900 年美国专利局被逼到公告永动机申请一律不收。排除一个错误答案。' },
  { t: '复盘:恐龙当年输在哪', f: '恐龙统治了 1.6 亿年,人类才 30 万年。结论:别嘲笑前辈,先活过前辈再说。' },
  { t: '考据:方舟的载重量够吗', f: '按记载尺寸换算,方舟排水量约 4.3 万吨,和泰坦尼克一个量级。工程上竟然说得通。' },
];
function pickLine(s) {
  const rows = String(s || '').split('\n').filter(Boolean);
  return rows[Math.floor(Math.random() * rows.length)] || '';
}

/* ---- 联网适配矩阵(2026-07 检索各家现行方案后定):用户不用手配——
 * 智谱=独立 web_search API / 阿里百炼=enable_search 请求参数 / Kimi=$web_search
 * 内置工具回环;火山的联网走控制台配置的应用通道(纯 API 接不了,暂不支持),
 * DeepSeek/硅基流动无官方检索。不支持的家可填智谱检索 Key 兜底 ---- */
function studyNetProvider() {
  const p = CFG.chatApi.provider;
  if (p) return p;
  const b = CFG.chatApi.base || '';   // 老配置 provider 为空:按 base 嗅探
  if (b.includes('bigmodel')) return 'zhipu';
  if (b.includes('dashscope') || b.includes('aliyuncs')) return 'qwen';
  if (b.includes('moonshot')) return 'moonshot';
  return '';
}
/* 带附加请求参数的单发对话(enable_search 这类"开关型"联网用) */
async function studyNetChat(prompt, extra) {
  const { resp } = await chatFetchFailover((a) => ({
    model: a.model,
    messages: [{ role: 'system', content: systemPrompt() }, { role: 'user', content: prompt }],
    max_tokens: 400, ...extra,
  }), 'study-net');
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message || 'API错误');
  const out = chatText(data).replace(/\[(emo|fx):\w+\]/g, '').trim();
  logLLM('study-net', prompt, out);
  return out;
}
/* Kimi $web_search:模型返回 tool_calls 时把 arguments 原样回给它再问一轮 */
async function kimiSearchSolve(prompt) {
  const msgs = [{ role: 'system', content: systemPrompt() }, { role: 'user', content: prompt }];
  const tools = [{ type: 'builtin_function', function: { name: '$web_search' } }];
  for (let round = 0; round < 3; round++) {
    const { resp } = await chatFetchFailover((a) => ({
      model: a.model, messages: msgs, max_tokens: 600, tools,
    }), 'study-net');
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message || 'API错误');
    const choice = (data.choices || [])[0];
    const m = choice && choice.message;
    if (choice && choice.finish_reason === 'tool_calls' && m && m.tool_calls) {
      msgs.push(m);
      for (const tc of m.tool_calls)
        msgs.push({ role: 'tool', tool_call_id: tc.id, name: tc.function.name, content: tc.function.arguments });
      continue;
    }
    const out = chatText(data).replace(/\[(emo|fx):\w+\]/g, '').trim();
    logLLM('study-net', prompt, out);
    return out;
  }
  throw new Error('检索回环没收敛');
}

/* ---- 联网检索(智谱 web_search,search_std 档):对话 API 就是智谱时直接复用它的
 * Key,否则用 设置→API 配置→检索 Key。 */
async function webSearchStd(query) {
  if (CFG.webSearch === false) throw new Error('search off'); // 开关关=纯模型研究
  const key = (CFG.chatApi.base || '').includes('bigmodel') ? CFG.chatApi.key : (CFG.searchKey || '');
  if (!key) throw new Error('no search key');
  const resp = await llmFetch('https://open.bigmodel.cn/api/paas/v4/web_search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ search_engine: 'search_std', search_query: String(query).slice(0, 70) }),
  }, { label: 'web-search', retries: 1 });
  const data = await resp.json();
  const items = data.search_result || data.search_results || [];
  const text = items.slice(0, 5)
    .map((r) => `${r.title || ''}:${String(r.content || '').slice(0, 160)}`).join('\n');
  logLLM('web-search', query, text || '(空结果)');
  return text;
}

/* 研究 tab 按钮只在自习室开着时显示(关了还挂着像残留);
 * 正停在研究 tab 时关掉开关→弹回待办 tab */
function syncStudyTab() {
  const b = document.querySelector('#panel-todo .ptab[data-tab="study"]');
  if (!b) return;
  b.style.display = CFG.studyMode ? '' : 'none';
  if (!CFG.studyMode && b.classList.contains('active')) { setTodoTab('todo'); renderTodo(); }
}

/* 日报用:今天的自习室战况一行(没开/没动静返回空) */
function studySummaryLine() {
  if (!CFG.studyMode || !Study.d) return '';
  const d = Study.d, L = Study.line();
  if (!L || (!d.focusMin && !L.tasks.length)) return '';
  const done = L.tasks.filter((t) => t.done).length;
  return `一起自习 ${Math.round(d.focusMin)} 分钟;它的研究「${L.goal}」第 ${L.dayIdx} 天完成 ${done}/${L.tasks.length},总进度 ${L.pct.toFixed(1)}%;你抓到它摸鱼 ${d.caughtPet} 次,它抓到你 ${d.caughtYou} 次`;
}

/* ---- 研究 tab 渲染 ---- */
function renderStudy() {
  const body = $('study-body');
  if (!body || !Study.d) return;
  Study.normalize();
  const d = Study.d, L = Study.line();
  const esc = (s) => String(s).replace(/</g, '&lt;');
  const attr = (s) => String(s).replace(/"/g, '&quot;');
  const np = studyNetProvider();
  const netAuto = ['zhipu', 'qwen', 'moonshot'].includes(np) && CFG.chatApi.key;
  const searchOK = CFG.webSearch !== false && (netAuto || CFG.searchKey);
  const cur = L.tasks.find((t) => !t.done);
  let html = `
    <div class="st-goal">
      <div class="st-goal-tag">它的大目标</div>
      <div class="st-goal-head" id="st-goal-head" title="展开研究线列表">
        <div class="st-goal-name">${esc(L.goal)}${L.done ? ' ✓' : ''}</div>
        <span class="st-goal-caret">▾</span>
      </div>
      <div class="st-goal-meta"><span>研究第 ${L.dayIdx} 天${L.done ? ' · 已结题' : ''}</span><span>进度 ${L.pct.toFixed(1)}%</span></div>
      <div class="st-track"><div class="st-fill" style="width:${L.pct}%"></div></div>
      <div class="st-lines-list" id="st-lines-list" style="display:none;">
        ${Object.keys(d.lines).map((g) => `
          <div class="st-lrow ${g === d.cur ? 'on' : ''}" data-goal="${attr(g)}">
            <span class="lr-name">${esc(g)}</span>
            <span class="lr-pct">${d.lines[g].done ? '✓ 100%' : d.lines[g].pct.toFixed(1) + '%'}</span>
            ${g !== d.cur ? '<b class="st-line-x" data-del="' + attr(g) + '">✕</b>' : ''}
          </div>`).join('')}
        <div class="st-lrow add" id="st-line-add">＋ 新目标</div>
      </div>
      <div id="st-newgoal-row" style="display:none;">
        <input class="st-ng-in" id="st-ng-in" maxlength="20" placeholder="给它一个宏大命题…">
        <button class="st-ng-btn" id="st-ng-ai" title="让 AI 想一个新命题">AI 起题</button>
        <button class="st-ng-btn" id="st-ng-rand" title="从预设命题池抽一个">随机</button>
        <button class="st-ng-btn ok" id="st-ng-ok">开研</button>
      </div>
    </div>`;
  if (L.done)
    html += `<div class="st-hint st-night">★ 这条大目标已经研究完成(第 ${L.dayIdx} 天结题)。点上面的目标名换一条,或开个新目标。</div>`;
  if (!CFG.studyMode)
    html += `<div class="st-hint">自习室没开。设置 → 行为 里打开「自习室」,开始追踪待办时它就跟你一起自习。</div>`;
  else if (S.sleeping)
    html += `<div class="st-hint st-night">☾ 睡眠时段,研究暂停中——这是正经睡觉,不算摸鱼。醒了接着推进。</div>`;
  else if (!S.tracking)
    html += `<div class="st-hint">等你开始执行待办,它就开工(同桌是要一起自习的)。</div>`;
  if (CFG.studyMode && CFG.chatApi.key && CFG.webSearch === false)
    html += `<div class="st-hint">联网检索关着(设置 → API 配置):纯凭大语言模型研究中。</div>`;
  else if (CFG.studyMode && CFG.chatApi.key && !searchOK)
    html += `<div class="st-hint">当前对话服务商没有能自动接的联网接口:可在 设置 → API 配置 填智谱检索 Key 兜底,或就这样纯凭大语言模型研究(可信度略降)。</div>`;
  html += `<div class="st-sec">它的待办(镜像你的条数)</div>`;
  html += L.tasks.length ? L.tasks.map((t) => `
    <div class="st-item ${t.done ? 'done' : ''} ${t === cur ? 'cur' : ''}">
      <span class="st-dotmark"></span><span class="st-t">${esc(t.t)}</span>
      <span class="st-prog">${t.done ? '✓' : t === cur ? Math.min(99, Math.round(t.got / t.need * 100)) + '%' : '排队中'}</span>
    </div>`).join('')
    : `<div class="st-hint">今天还没拆题。开始追踪待办后按你的条数自动排。</div>`;
  const feed = (L.feed || []).slice().reverse();
  if (feed.length) {
    const stamp = (x) => {
      if (!x.day && !x.dt) return '';   // 旧存档没记日期的条目
      const d = x.dt ? new Date(x.dt) : null;
      return `<span class="st-feed-day">${x.day ? '第 ' + x.day + ' 天' : ''}${d ? ' · ' + (d.getMonth() + 1) + '/' + d.getDate() : ''}</span>`;
    };
    html += `<div class="st-sec">研究成果(近 ${feed.length} 条)</div>` + feed.map((x) =>
      `<div class="st-feed"><div class="st-feed-hd"><b>${esc(x.t)}</b>${stamp(x)}</div>${esc(x.f)}</div>`).join('');
  }
  html += `
    <div class="st-ledger">你抓到它摸鱼 <b>${d.caughtPet}</b> 次 · 它抓到你 <b>${d.caughtYou}</b> 次 · 它共摸 <b>${d.petSlack}</b> 次</div>
    <button class="start-btn" id="st-card-btn">生成今日打卡图</button>
    <div id="st-card-out"></div>`;
  body.innerHTML = html;
  // 研究线列表:点目标名展开/收起(ChatGPT 式垂直列表);切换/删除(双击确认)/新增
  $('st-goal-head').addEventListener('click', () => {
    const list = $('st-lines-list');
    const open = list.style.display !== 'none';
    list.style.display = open ? 'none' : '';
    $('st-goal-head').classList.toggle('open', !open);
  });
  body.querySelectorAll('.st-lrow[data-goal]').forEach((el) =>
    el.addEventListener('click', () => Study.switchLine(el.dataset.goal)));
  body.querySelectorAll('.st-line-x').forEach((x) =>
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      if (x.dataset.arm) Study.removeLine(x.dataset.del);
      else {
        x.dataset.arm = '1'; x.textContent = '确认删?';
        setTimeout(() => { x.dataset.arm = ''; x.textContent = '✕'; }, 2500);
      }
    }));
  $('st-line-add').addEventListener('click', () => {
    $('st-newgoal-row').style.display = 'flex';
    $('st-line-add').style.display = 'none';
    $('st-ng-in').focus();
  });
  $('st-ng-ai').addEventListener('click', async () => {
    if (!CFG.chatApi.key) { showToast('没配对话 API,起不了题'); return; }
    const b = $('st-ng-ai');
    b.textContent = '想题中…'; b.disabled = true;
    try {
      const have = Object.keys(Study.d.lines).join('、') || '(无)';
      let g = await chatLLMPlain(P('study_goal_gen', { have }), 100);
      g = g.replace(/^["「『\s]+|["」』。\s]+$/g, '').split('\n')[0].trim().slice(0, 20);
      if (g) $('st-ng-in').value = g;
      else showToast('它没想出来…再点一次?');
    } catch (e) { showToast('起题失败:' + friendlyLLMError(e)); }
    b.textContent = 'AI 起题'; b.disabled = false;
  });
  $('st-ng-rand').addEventListener('click', () => {
    const pool = STUDY_GOAL_PRESETS.filter((g) => !Study.d.lines[g]);
    $('st-ng-in').value = pool.length ? pool[Math.floor(Math.random() * pool.length)]
      : STUDY_GOAL_PRESETS[Math.floor(Math.random() * STUDY_GOAL_PRESETS.length)];
  });
  const ngCommit = () => { const v = $('st-ng-in').value.trim(); if (v) Study.switchLine(v); };
  $('st-ng-ok').addEventListener('click', ngCommit);
  $('st-ng-in').addEventListener('keydown', (e) => { if (e.key === 'Enter') ngCommit(); });
  $('st-card-btn').addEventListener('click', makeStudyCard);
}

/* ---- PK 打卡图:互相抓包次数对决(用户拍板)+待办完成对比+判定戳+判词 → PNG ---- */
async function makeStudyCard() {
  const btn = $('st-card-btn');
  btn.textContent = '生成中…'; btn.disabled = true;
  try {
    const d = Study.d, L = Study.line();
    // 完成台账是当天完成数的唯一口径(finishCurrent 每笔都记,日报结算后也不丢);
    // 直接数 S.todos 会和台账双计,别改回去
    const youDone = (S.doneLedger || []).filter((x) => isToday(x.done_at_ms)).length
      || S.todos.filter((t) => t.status === 'done').length;
    const youN = youDone + S.todos.filter((t) => t.status !== 'done').length;
    const petDone = L.tasks.filter((t) => t.done).length;
    // PK 两项:待办完成率 + 抓包对决(抓到对方多的赢——火眼金睛项)
    let sy = 0, sp = 0;
    const yr = youN ? youDone / youN : 0, pr = L.tasks.length ? petDone / L.tasks.length : 0;
    if (yr > pr) sy++; else if (pr > yr) sp++;
    if (d.caughtPet > d.caughtYou) sy++; else if (d.caughtYou > d.caughtPet) sp++;
    const verdict = sy > sp ? '你胜' : sp > sy ? '它胜' : '平局';
    const stats = { min: Math.round(d.focusMin), you: `${youDone}/${youN}`, pet: `${petDone}/${L.tasks.length}`,
      cy: d.caughtYou, cp: d.caughtPet, verdict };
    // 判词提示词里的"你"=桌宠自己:卡面上的「你胜」直接塞进去会被读成"桌宠胜"
    // (真机实锤:判定你胜,判词却喊"我赢啦")——按桌宠视角翻译再喂
    const petView = { '你胜': '用户赢了、你输了', '它胜': '你赢了', '平局': '平局' }[verdict];
    const fb = { '你胜': '行吧,今天你赢。我输在多看了几次猫猫图。',
      '它胜': '今天我比你能干。人类,要加油了。', '平局': '打平。谁也别说谁。' };
    let quote = fb[verdict];
    if (CFG.chatApi.key) {
      try {
        quote = await Promise.race([
          chatLLMPlain(P('study_verdict', { ...stats, verdict: petView }), 120),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
        ]) || quote;
      } catch { /* 判词拿不到就用兜底,出卡不等模型 */ }
    }
    const fact = (L.feed || [])[L.feed.length - 1];
    const png = await studyCardPng({ ...stats, quote: quote.slice(0, 40), goal: L.goal,
      dayIdx: L.dayIdx, pct: L.pct, fact: fact ? fact.f : '今天还没学到新的。明天继续。',
      win1: yr === pr ? 0 : yr > pr ? 1 : 2, win2: d.caughtPet === d.caughtYou ? 0 : d.caughtPet > d.caughtYou ? 1 : 2 });
    $('st-card-out').innerHTML = `<img class="st-card-img" src="${png}">
      <button class="report-btn" id="st-card-save">保存 PNG</button>`;
    $('st-card-save').addEventListener('click', async () => {
      const r = await API.saveStudyCard(png);
      if (r && r.ok) showToast('已保存:' + r.path);
      else if (r && r.err !== 'canceled') showToast('保存失败:' + r.err);
    });
  } catch (e) {
    showToast('出卡失败:' + e.message);
    logLLM('study', '打卡图', `ERROR: ${e.message}`);
  }
  btn.textContent = '生成今日打卡图'; btn.disabled = false;
}

/* 卡片渲染(07-26 海报版·深色定稿,用户口径:人物在深底上表现更好,描边也用深色;
 * 底色遵循暗色零色相口径(纯灰黑不带蓝调),冰青主色+亮灰文字):
 * HTML→SVG foreignObject→canvas 打底(多边形装饰是模板里的内嵌 svg),
 * 人物用 canvas 叠画——按 alpha 内容框贴底放大到接近海报高,深色描边贴纸 +
 * 主色错位剪影;判词章盖在右下负空间 */
async function studyCardPng(v) {
  const W = 900, H = 900;
  const x = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const winCls = (n, side) => (n === side ? 'color:#5FA8C4;' : '');
  const row = (label, a, b, w1, w2) => `
      <div style="display:flex;align-items:baseline;padding:9px 0;border-bottom:2px dashed rgba(232,234,238,0.14);">
        <span style="flex:1;font-size:19px;color:rgba(232,234,238,0.62);">${label}</span>
        <span style="width:92px;text-align:center;font-size:22px;font-weight:700;${w1}">${a}</span>
        <span style="width:92px;text-align:center;font-size:22px;font-weight:700;${w2}">${b}</span></div>`;
  const html = `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${W}px;height:${H}px;box-sizing:border-box;
      font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;color:#e8eaee;
      background:linear-gradient(155deg,#141518 0%,#1e1f23 55%,#17181b 100%);position:relative;overflow:hidden;">
    <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"
      style="position:absolute;left:0;top:0;">
      <polygon points="0,540 470,900 0,900" fill="rgba(95,168,196,0.13)"/>
      <polygon points="620,0 900,0 900,240" fill="rgba(95,168,196,0.13)"/>
      <rect x="60" y="150" width="480" height="480" fill="none" stroke="rgba(95,168,196,0.5)"
        stroke-width="2.5" transform="rotate(45 300 390)"/>
      <polygon points="700,845 760,875 700,905" fill="rgba(95,168,196,0.16)"/>
      <rect x="466" y="118" width="16" height="16" fill="rgba(95,168,196,0.5)" transform="rotate(45 474 126)"/>
      <rect x="63" y="96" width="12" height="12" fill="rgba(95,168,196,0.42)" transform="rotate(45 69 102)"/>
      <rect x="422" y="806" width="13" height="13" fill="rgba(95,168,196,0.4)" transform="rotate(45 428 812)"/>
      <line x1="20" y1="736" x2="96" y2="660" stroke="rgba(95,168,196,0.45)" stroke-width="2.5"/>
      <line x1="40" y1="748" x2="98" y2="690" stroke="rgba(95,168,196,0.3)" stroke-width="2.5"/>
    </svg>
    <div style="position:absolute;top:700px;right:76px;transform:rotate(-8deg);border:4px solid #5FA8C4;
      color:#5FA8C4;border-radius:16px;padding:8px 22px;font-size:30px;font-weight:800;letter-spacing:6px;opacity:0.85;">${x(v.verdict)}</div>
    <div style="position:absolute;left:496px;top:44px;width:360px;">
      <div style="font-size:20px;color:rgba(232,234,238,0.5);letter-spacing:3px;">自习打卡 · ${new Date().getMonth() + 1} 月 ${new Date().getDate()} 日</div>
      <div style="font-size:33px;font-weight:800;line-height:1.35;margin:14px 0 18px;">${x(v.goal)}</div>
      <div style="display:flex;align-items:baseline;gap:18px;">
        <span style="font-size:30px;font-weight:800;color:#5FA8C4;letter-spacing:1px;">DAY ${v.dayIdx}</span>
        <span style="font-size:52px;font-weight:800;line-height:1;">${v.pct.toFixed(1)}<span style="font-size:28px;">%</span></span></div>
      <div style="margin:12px 0 22px;height:9px;border-radius:5px;background:rgba(95,168,196,0.22);">
        <div style="width:${Math.min(100, v.pct).toFixed(1)}%;min-width:9px;height:9px;border-radius:5px;background:#5FA8C4;"></div></div>
      <div style="display:flex;padding:0 0 6px;font-size:17px;color:rgba(232,234,238,0.42);font-weight:600;letter-spacing:2px;">
        <span style="flex:1;"></span><span style="width:92px;text-align:center;">你</span><span style="width:92px;text-align:center;">它</span></div>
      ${row('待办完成', x(v.you), x(v.pet), winCls(v.win1, 1), winCls(v.win1, 2))}
      ${row('抓到对方摸鱼', v.cp + ' 次', v.cy + ' 次', winCls(v.win2, 1), winCls(v.win2, 2))}
      <div style="font-size:17px;color:rgba(232,234,238,0.45);padding:10px 0 0;letter-spacing:1px;">一起自习 ${v.min} 分钟</div>
      <div style="margin-top:24px;padding:2px 0 2px 18px;border-left:5px solid #5FA8C4;">
        <div style="font-size:17px;color:#5FA8C4;font-weight:700;letter-spacing:2px;margin-bottom:6px;">它今天学到</div>
        <div style="font-size:19px;line-height:1.66;color:rgba(232,234,238,0.88);">${x(v.fact)}</div></div>
      <div style="font-size:19px;color:rgba(232,234,238,0.55);margin-top:20px;font-style:italic;">"${x(v.quote)}"</div>
    </div>
    <div style="position:absolute;left:0;right:0;bottom:0;display:flex;justify-content:space-between;
      padding:12px 44px 14px;font-size:16px;color:rgba(232,234,238,0.4);background:rgba(255,255,255,0.05);">
      <span>${x(Persona.petName ? Persona.petName() : CFG.petName)} · 馒头桌宠</span><span>github.com/Bunnnnn-722/mantou-deskpet</span></div>
  </div>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><foreignObject width="100%" height="100%">${html}</foreignObject></svg>`;
  const img = new Image();
  await new Promise((res, rej) => {
    img.onload = res; img.onerror = () => rej(new Error('卡片底图渲染失败'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  });
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0);
  drawCardPet(ctx, 248, 838);
  return cv.toDataURL('image/png');
}

/* 海报 C 位:人物按 alpha 内容框贴底放大到接近海报高,白描边贴纸 + 主色错位剪影 */
function drawCardPet(ctx, cx, bottomY) {
  const ground = (w) => {
    ctx.save();
    ctx.filter = 'blur(7px)';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.ellipse(cx, bottomY + 12, Math.min(w, 330) * 0.42, 14, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };
  if (Persona.active) {
    try {
      const sc = Sprites.canvas;
      if (sc && sc.width) {
        // alpha 内容框:雪碧图画布四周是留白,按画布高缩放人物会小一圈
        const id = sc.getContext('2d').getImageData(0, 0, sc.width, sc.height).data;
        let x0 = sc.width, y0 = sc.height, x1 = 0, y1 = 0;
        for (let y = 0; y < sc.height; y += 2)
          for (let xx = 0; xx < sc.width; xx += 2)
            if (id[(y * sc.width + xx) * 4 + 3] > 16) {
              if (xx < x0) x0 = xx; if (xx > x1) x1 = xx;
              if (y < y0) y0 = y; if (y > y1) y1 = y;
            }
        const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
        if (bw > 4 && bh > 4) {
          const k = Math.min(742 / bh, 430 / bw);
          const w = bw * k, h = bh * k;
          ground(w);
          const r = 9;
          const sil = document.createElement('canvas');
          sil.width = Math.ceil(w) + 2 * r + 2; sil.height = Math.ceil(h) + 2 * r + 2;
          const sg = sil.getContext('2d');
          sg.drawImage(sc, x0, y0, bw, bh, r + 1, r + 1, w, h);
          sg.globalCompositeOperation = 'source-in';
          sg.fillStyle = 'rgba(95,168,196,0.4)';
          sg.fillRect(0, 0, sil.width, sil.height);
          const dx0 = cx - w / 2 - r - 1, dy0 = bottomY - h - r - 1;
          ctx.drawImage(sil, dx0 + 14, dy0 + 14);   // 主色错位剪影(海报印刷感)
          sg.globalCompositeOperation = 'source-over';
          sg.clearRect(0, 0, sil.width, sil.height);
          sg.drawImage(sc, x0, y0, bw, bh, r + 1, r + 1, w, h);
          sg.globalCompositeOperation = 'source-in';
          sg.fillStyle = 'rgba(10,11,14,0.95)';
          sg.fillRect(0, 0, sil.width, sil.height);
          for (let i = 0; i < 16; i++)
            ctx.drawImage(sil, dx0 + Math.cos(i * Math.PI / 8) * r, dy0 + Math.sin(i * Math.PI / 8) * r);
          ctx.drawImage(sc, x0, y0, bw, bh, cx - w / 2, bottomY - h, w, h);
          return;
        }
      }
    } catch {}
  }
  // 码绘馒头兜底:按本体 SVG 原样重画(黑玻璃形态:包子形身体+左上轮廓光+发光眼)
  const s = 3.4, w = 112 * s, h = 91 * s, xb = cx - w / 2, yb = bottomY - h;
  ground(w);
  const bunPath = new Path2D('M111.621 55.1379C111.621 85.5898 86.6335 91 55.8103 91C24.9871 91 0 85.5898 0 55.1379C0 24.6861 24.9871 0 55.8103 0C86.6335 0 111.621 24.6861 111.621 55.1379Z');
  ctx.save();
  ctx.translate(xb, yb); ctx.scale(s, s);
  ctx.save();                                   // 主色错位剪影(与包形象同款海报语言)
  ctx.translate(14 / s, 14 / s);
  ctx.fillStyle = 'rgba(95,168,196,0.4)'; ctx.fill(bunPath);
  ctx.restore();
  const g = ctx.createLinearGradient(0, 0, 0, 91);
  g.addColorStop(0, 'rgba(24,24,27,0.97)'); g.addColorStop(1, 'rgba(13,13,15,0.97)');
  ctx.fillStyle = g; ctx.fill(bunPath);
  const eg = ctx.createLinearGradient(10, 5, 102, 88); // 轮廓光:左上亮右下弱(edgeGrad 同款)
  eg.addColorStop(0, 'rgba(255,255,255,0.95)');
  eg.addColorStop(0.32, 'rgba(255,255,255,0.10)');
  eg.addColorStop(0.68, 'rgba(255,255,255,0.10)');
  eg.addColorStop(1, 'rgba(255,255,255,0.40)');
  ctx.shadowColor = 'rgba(255,255,255,0.4)'; ctx.shadowBlur = 6;
  ctx.strokeStyle = eg; ctx.lineWidth = 1.6; ctx.stroke(bunPath);
  ctx.shadowColor = 'rgba(255,255,255,0.85)'; ctx.shadowBlur = 16;
  ctx.fillStyle = '#fff';
  for (const ex of [33.4, 58.9]) {
    ctx.beginPath();
    ctx.ellipse(ex, 38.8, 8.3, 16.8, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/* 自初始化:加载存档 + 10s 主循环(模式关着=零开销空转) */
Study.init();
setInterval(() => Study.tick(), 10000);
