'use strict';
/* ---- 深夜睡觉(时间驱动) / 整点提醒 / 早安天气 ---- */
const HEALTH_LINES = () => P('health_lines').split('\n').filter(Boolean);
function isNight() {
  const h = new Date().getHours();
  const s = CFG.sleepStart ?? 23, e = CFG.sleepEnd ?? 7;
  if (s === e) return false;                        // 起点=终点 = 不启用
  return s < e ? (h >= s && h < e) : (h >= s || h < e); // 支持跨午夜(23~7)和同日(13~14 午睡)
}
function wakeUp(quiet) {
  if (!S.sleeping) return;
  S.sleeping = false;
  S.lastWake = Date.now();
  // 有"闭眼→睁眼"过渡素材就先播它再回待机(不带表情动画，别盖掉睁眼过程)
  if (Player.manifest['sleep_out']) Player.play('sleep_out', { prio: PRIORITY.egg });
  else Player.backToIdle();
  if (!quiet) sayLocal(P('line_wake'));
}
function setupIdleWatchers() {
  document.addEventListener('mousemove', () => { S.lastActive = Date.now(); });
  // 到点就困:23 点后不管主人在不在忙——打哈欠 → 催睡台词 → 自己睡着。
  // (旧版"挂机 5 分钟才睡"永远赶不上主人醒着的时候，彩蛋无人得见)
  // 点击会被弄醒，醒后 10 分钟再犯困;睡着时不跳舞、不整点提醒
  setInterval(() => {
    // 到点起床:时段结束自动醒(原版只有入睡，得靠戳才醒)
    if (S.sleeping && !isNight()) { wakeUp(); return; }
    if (!CFG.nightSleep || S.sleeping || S.speaking) return;
    // 能力门控:当前形象没有睡觉动画就整条链跳过(开关在设置里也已置灰)
    if (!Persona.canFeature('nightSleep') || !isNight()) return;
    if (Date.now() - (S.lastWake || 0) < 600000) return;
    // 睡眠×音乐分级:激烈(≥100BPM/重低音)响着不犯困;舒缓轻摇照睡(先收舞再打哈欠)
    const M = typeof Music !== 'undefined' ? Music : null;
    if (M && (M.intenseUntil > performance.now() || (M.lastAvg || 0) >= 30)) return;
    const softDance = M && M.dancing && Player.cur?.name === 'dance_nod';
    if (Player.cur?.name !== 'idle' && !softDance) return;
    if (softDance) M.stopDance();
    // 催睡演出:包形象没做(或禁用了)哈欠动画就只念台词,不硬播定格装样子
    if (!Persona.active || (Persona.has('egg_yawn') && Persona.eggEnabled('egg_yawn')))
      Player.play('egg_yawn', { prio: PRIORITY.egg });
    setTimeout(() => {
      const lines = P('sleepy_lines').split('\n').filter(Boolean);
      if (!S.speaking) sayLocal(lines[Math.floor(Math.random() * lines.length)] || '……去睡。');
    }, 4300);
    setTimeout(() => {
      if (!S.sleeping && isNight() && !S.speaking && CFG.nightSleep) {
        S.sleeping = true;
        // 三段式:睁眼→闭眼过渡(单次) → 睡觉循环;无过渡素材则直接入睡
        if (Player.manifest['sleep_in'])
          Player.play('sleep_in', { prio: PRIORITY.egg, onEnd: () => {
            if (S.sleeping) Player.play('sleep', { loop: true, prio: PRIORITY.egg });
          } });
        else
          Player.play('sleep', { loop: true, prio: PRIORITY.egg });
      }
    }, 10000);
  }, 60000);
  // 整点提醒(白天 9-22 点，说话/睡觉/静音专注时跳过)
  setInterval(() => {
    if (!CFG.healthReminder || S.speaking || S.sleeping) return;
    const d = new Date();
    if (d.getMinutes() !== 0 || d.getHours() < 9 || d.getHours() > 22) return;
    if (Date.now() - S.lastHealthSay < 3000000) return;
    S.lastHealthSay = Date.now();
    const lines = HEALTH_LINES();
    sayLocal(lines[Math.floor(Math.random() * lines.length)]);
  }, 45000);
}
async function morningWeather() {
  if (!CFG.morningWeather) return;
  const today = new Date().toDateString();
  if (S.misc.weatherDate === today || new Date().getHours() < 6) return;
  const w = await API.getWeather();
  if (!w) return;
  S.misc.weatherDate = today;
  API.setStore('misc', S.misc);
  const fact = `${w.area ? w.area + ',' : ''}${w.now}，现在${w.temp}°，今天${w.min}~${w.max}°`;
  if (CFG.chatApi.key) {
    chatLLMPlain(P('weather', { fact }))
      .then((txt) => sayLocal(txt)).catch(() => sayLocal(`今天${w.now},${w.min}~${w.max}°。`));
  } else sayLocal(`今天${w.now},${w.min}~${w.max}°。`);
}

/* ---- 周报(周五起亮红点，点击生成) ---- */
function weekKey(ts) {
  const d = new Date(ts || Date.now());
  const day = (d.getDay() + 6) % 7; // 周一=0
  const mon = new Date(d); mon.setDate(d.getDate() - day); mon.setHours(0, 0, 0, 0);
  return mon.toISOString().slice(0, 10);
}
function weeklyAvailable() { // 面板里的"生成周报"按钮:直到生成为止都在
  const day = new Date().getDay();
  if (!(day === 5 || day === 6 || day === 0)) return false;
  if (S.misc.weeklyDone === weekKey()) return false;
  return S.reports.some((r) => !r.weekly && weekKey(r.ts) === weekKey());
}
function needWeeklyDot() { // 红点:本周被用户看到过一次就不再亮(看过即焚)
  return weeklyAvailable() && S.misc.weeklySeen !== weekKey();
}
function updateWeeklyDot() {
  document.querySelector('[data-panel="todo"]')?.classList.toggle('has-dot', needWeeklyDot());
}
function markWeeklySeen() {
  if (S.misc.weeklySeen !== weekKey() && needWeeklyDot()) {
    S.misc.weeklySeen = weekKey();
    API.setStore('misc', S.misc);
  }
}
async function generateWeekly() {
  const week = S.reports.filter((r) => !r.weekly && weekKey(r.ts) === weekKey());
  const rep = {
    ts: Date.now(), weekly: true,
    done: week.reduce((s, r) => s + r.done, 0),
    all: week.reduce((s, r) => s + r.all, 0),
    totalMin: week.reduce((s, r) => s + r.totalMin, 0),
    checks: week.reduce((s, r) => s + r.checks, 0),
    slack: week.reduce((s, r) => s + r.slack, 0),
    comment: null,
  };
  S.reports.push(rep);
  S.misc.weeklyDone = weekKey();
  API.setStore('misc', S.misc);
  saveReports();
  renderReport(rep);
  updateWeeklyDot();
  const digest = week.map((r) => `${fmtReportTitle(r.ts)}:完成${r.done}/${r.all}，摸鱼${r.slack};评语:${r.comment || '无'}`).join('\n');
  // 近一周观察流水也入周报(观察一本账保留 100 条,周报取 7 天内的)
  const fmtN = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const notes7 = S.journal.filter((n) => inDays(n.t, 7)).map((n) => `${fmtN(n.t)} ${n.note}`).join('\n');
  chatLLMPlain(P('weekly_report', { digest: digest || '本周没有日报', notes: notes7 || '(无)' }))
    .then((t) => { rep.comment = t; })
    .catch(() => { rep.comment = '这一周，就这样过去了。'; })
    .finally(() => {
      saveReports();
      const el = document.getElementById('report-ai');
      if (el) el.textContent = rep.comment;
    });
}

/* ================= 全局状态袋 =================
 * 所有跨模块可变状态集中在此声明(字段不许运行时新增，加字段先在这里登记) */
