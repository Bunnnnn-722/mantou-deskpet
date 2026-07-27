'use strict';
/* ================= 说话系统 ================= */
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const EMO_PITCH = { neutral: 520, happy: 640, surprise: 700, sad: 430, angry: 560, speechless: 470, gloomy: 300, blackline: 470 };
function blip(emo) {
  if (audioCtx.state === 'suspended') audioCtx.resume();
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = 'square';
  o.frequency.value = (EMO_PITCH[emo] || 520) * (0.96 + Math.random() * 0.08);
  g.gain.setValueAtTime(0.06, audioCtx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.06);
  o.connect(g).connect(audioCtx.destination);
  o.start(); o.stop(audioCtx.currentTime + 0.07);
}

function systemPrompt() {
  // 人设(身份+性格，设置面板可编辑)已合并为一个字段，不再拆身份定式/性格两段
  const todoCtx = S.tracking && S.curIdx < S.todos.length
    ? `用户当前的待办任务是「${S.todos[S.curIdx].name}」。` : '';
  return `${personaText()}\n${todoCtx}\n${P('system_rules')}${capabilityAddendum()}`;
}

/* 形象能力联动:按当前激活形象生成情绪/特效协议补段，追加在 system_rules 之后。
 * 情绪词表 = 标准情绪(包没动画的走通用小动作兜底，永远可触发)
 *          ∪ 包自定义情绪(persona.json 的 emoDesc:{名字:"使用场合"} 声明;
 *            没写场合说明模型不知道何时用，写了才进词表)。
 * 场合说明优先用包 emoDesc，标准情绪缺省用内置 EMO_DESC;
 * 自定义情绪必须有对应动画(emo_<名> 槽位或 emoAliases 映射)才进词表，否则触发不了 */
const EMO_DESC = {
  happy: '被夸/顺心/愉悦', surprise: '被吓到/意外', angry: '不满/被冒犯/用户摸鱼被抓',
  sad: '遗憾/共情低落/失望', speechless: '无奈/轻微吐槽', gloomy: '低气压/阴阳怪气',
  blackline: '尴尬到极点/无语住',
};
function capabilityAddendum() {
  if (!Persona.active) return ''; // 馒头:就用 system_rules 原文(frost+全 emo)
  const packDesc = Persona.active.emoDesc || {};
  const names = [...new Set([...Object.keys(EMO_DESC), ...Object.keys(packDesc)])];
  // 只收包能真演出来的情绪(有 emo_ 动画或别名映射)。标准情绪的"定格+粒子"
  // 兜底代码仍在(模型不听话硬输出时不崩),但不再写进词表教模型用——
  // 包没有的表情,模型压根不该知道(用户拍板:没有的槽位就该隐藏)
  const usable = names.filter((e) => Persona.emoAnim(e));
  const lines = ['\n【当前形象能力】你现在的形象是「' + Persona.active.name + '」。'];
  lines.push('只能在台词里使用这些情绪标签(其他的一律不要输出):' +
    usable.map((e) => `[emo:${e}]=${packDesc[e] || EMO_DESC[e]}`).join('、') + '，以及 [emo:neutral] 平常状态。');
  const fx = FX.available();
  if (fx.length) {
    lines.push('你有一个真实的施法能力(放在句前使用，屏幕上真的会发生):' +
      fx.map((f) => `[fx:${f}]`).join('、') +
      '。用于警告摸鱼或耍威风，冷却较长，一次对话最多一次，平时闲聊禁用。');
  } else {
    lines.push('你没有任何施法能力，不要输出特效标签。');
  }
  lines.push('示例: [emo:speechless]……又在摸鱼。[emo:neutral]回去工作。');
  return lines.join('\n');
}

/* ---- 对话历史(本地持久化) ---- */
async function loadConvs() {
  S.convs = (await API.getStore('chats')) || [];
  S.curConvId = S.convs.length ? S.convs[S.convs.length - 1].id : null;
}
function saveConvs() {
  API.setStore('chats', S.convs.slice(-100)); // 最多存 100 个会话
}
function curConv() {
  let c = S.convs.find((x) => x.id === S.curConvId);
  if (!c) {
    c = { id: Date.now().toString(36), title: '新对话', msgs: [], updated: Date.now() };
    S.convs.push(c);
    S.curConvId = c.id;
  }
  return c;
}
function newConv() {
  // 空会话复用:列表里已有一句没说的空会话就直接切过去,
  // 连点「新建」不再攒一排空壳进历史
  const empty = [...S.convs].reverse().find((x) => !x.msgs.length);
  S.curConvId = empty ? empty.id : null;
  const c = curConv();
  renderChatMsgs();
  showToast('已开启新对话');
  return c;
}
function renderChatMsgs() {
  const box = $('chat-messages');
  box.innerHTML = '';
  curConv().msgs.forEach((m) => {
    if (m.hidden) return;
    const div = document.createElement('div');
    div.className = 'chat-msg ' + (m.role === 'user' ? 'user' : 'pet');
    div.textContent = m.role === 'assistant'
      ? m.content.replace(/\[[^\]]{0,24}\]/g, '').replace(/\*[^*]{0,24}\*/g, '').trim()
      : m.content;
    box.appendChild(div);
  });
  box.scrollTop = box.scrollHeight;
}
/* 通用卡片列表(聊天历史/报告列表共用):conv-item 行 + 点开 + 二次确认删除 */
function renderCardList(box, items, { empty, onOpen, onDelete }) {
  box.innerHTML = '';
  if (!items.length) {
    box.innerHTML = `<div style="color:var(--muted);font-size:12px;text-align:center;padding:20px;">${empty}</div>`;
    return;
  }
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  items.forEach((it) => {
    const div = document.createElement('div');
    div.className = 'conv-item' + (it.cls ? ' ' + it.cls : '');
    div.innerHTML = `<div style="flex:1;min-width:0;">
        <div class="conv-title">${esc(it.title)}</div>
        <div class="conv-sub">${esc(it.sub)}</div>
      </div>
      ${it.meta ? `<span class="conv-meta">${esc(it.meta)}</span>` : ''}
      <button class="tl-del card-del" title="删除">✕</button>`;
    div.addEventListener('click', () => onOpen(it));
    div.querySelector('.card-del').addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = e.currentTarget;
      // 二次确认:第一次点变"确删?",2.6 秒内再点才真删
      if (!btn.classList.contains('arm')) {
        btn.classList.add('arm');
        btn.textContent = '确删?';
        setTimeout(() => { btn.classList.remove('arm'); btn.textContent = '✕'; }, 2600);
        return;
      }
      onDelete(it);
    });
    box.appendChild(div);
  });
}

function renderConvList() {
  const items = [...S.convs].reverse().map((c) => {
    // 标题=第一条用户输入;小字=最后一条回复
    const firstUser = c.msgs.find((m) => m.role === 'user' && !m.hidden);
    const lastReply = [...c.msgs].reverse().find((m) => m.role === 'assistant');
    const t = new Date(c.updated);
    return {
      conv: c,
      cls: c.id === S.curConvId ? 'active' : '',
      title: (firstUser?.content || '(空对话)').slice(0, 20),
      sub: lastReply ? lastReply.content.replace(/\[(emo|fx):\w+\]/g, '').trim().slice(0, 26) : '…',
      meta: `${t.getMonth() + 1}/${t.getDate()}`,
    };
  });
  renderCardList($('chat-messages'), items, {
    empty: '还没有历史对话',
    onOpen: (it) => { S.curConvId = it.conv.id; S.histView = false; renderChatMsgs(); },
    onDelete: (it) => {
      S.convs = S.convs.filter((x) => x.id !== it.conv.id);
      if (S.curConvId === it.conv.id) S.curConvId = S.convs.length ? S.convs[S.convs.length - 1].id : null;
      saveConvs();
      renderConvList(); // 删完留在列表页
    },
  });
}

/* ================= 流式聊天管线 =================
 * chatLLM 拆四层:emo 标签路由 / 打字机(标签状态机+分段气泡) / SSE 读流 / 编排。
 * 各层无网络⇄渲染交叉依赖，气泡节奏问题只看打字机，断流问题只看读流。 */

/* emo 标签路由:中性回待机;包形象走别名映射;码绘馒头走 emo_ 槽位。
 * 包没这个情绪但属于标准情绪 → 仍播 emo_ 槽位:角色定格在当前帧，
 * 只出粒子兜底(泪滴/汗珠/星星，无容器弹跳)，不会闪回码绘馒头 */
function applyEmoTag(emo) {
  if (emo === 'neutral') { Player.requestIdle(); return; }
  if (Persona.active) {
    const anim = Persona.emoAnim(emo);
    if (anim) { Player.play(anim, { loop: true, prio: PRIORITY.emo }); return; }
  }
  if (Player.manifest['emo_' + emo]) {
    Player.play('emo_' + emo, { loop: true, prio: PRIORITY.emo });
  }
}

/* 打字机:字符队列逐字上屏 + [emo:]/[fx:] 标签攒读 + 分段气泡。
 * push() 喂字，finish() 宣告流结束(排空后回调 onDone),cancel() 静默停机 */
function createTyper({ silent, onDone }) {
  const bubbleEl = $('bubble'); bubbleEl.innerHTML = '';
  clearTimeout(bubbleEl._t);  // 注意:气泡等第一个字到了才显示
  let shown = '', emo = 'neutral', charCount = 0, tagBuf = '';
  let segGap = 0, clearNext = false;
  // 分段:句间的情绪标签或换行 = 新气泡(上一泡停留 2.2s 再换，不挤一泡里丑换行)
  const boundary = () => { if (shown.trim()) { segGap = Date.now() + 2200; clearNext = true; } };
  const emit = (ch) => {
    // 攒标签: [emo:xxx]
    if (tagBuf || ch === '[') {
      tagBuf += ch;
      if (ch === ']') {
        const m = tagBuf.match(/\[emo:(\w+)\]/);
        if (m) { boundary(); emo = m[1]; applyEmoTag(emo); }
        // 特效标签:[fx:frost]/[fx:blizzard] 等，统一走 cast(包路由+兜底在内部)
        const fm = tagBuf.match(/\[fx:(\w+)\]/);
        if (fm) FX.cast(fm[1]);
        // 非协议标签的方括号内容(动作描写/舞台指示)一律丢弃，不显示
        tagBuf = '';
      } else if (tagBuf.length > 24) { shown += tagBuf; tagBuf = ''; } // 超长=可能是正文，放行
      return;
    }
    if (ch === '\n') { boundary(); return; }
    if (clearNext) { shown = ''; clearNext = false; }
    shown += ch;
    charCount++;
    if (!bubbleEl.classList.contains('show')) {
      bubbleEl.classList.add('show');
      document.getElementById('pet-wrapper').classList.add('bubble-shown');
    }
    if (!/[\s。，！？…、，.!?]/.test(ch) && charCount % 2 === 0 && !silent) blip(emo);
    bubbleEl.innerHTML = shown;
  };
  const queue = [];
  let done = false;
  const timer = setInterval(() => {
    S.speechBeat = Date.now(); // 心跳:证明说话引擎活着(看门狗判卡死用)
    if (Date.now() < segGap) return; // 分段间歇:上一泡停留展示
    if (queue.length) emit(queue.shift());
    else if (done) { clearInterval(timer); onDone(); }
  }, 55);
  return {
    push(text) { for (const ch of text) queue.push(ch); },
    finish() { done = true; },
    cancel() { clearInterval(timer); }, // 开流即失败时静默停机(不触发 onDone)
  };
}

/* 打字机收尾统一动作:入会话/关说话态/延时收泡回待机(流式与整段共用) */
function speechDone(conv, full) {
  S.speaking = false;
  conv.msgs.push({ role: 'assistant', content: full });
  conv.updated = Date.now();
  saveConvs();
  if (!S.histView) renderChatMsgs();
  setTimeout(() => { if (!S.speaking) { hideBubble(); Player.requestIdle(); } }, 2200);
}

/* 整段文本走打字机上屏(带 [emo:]/[fx:] 解析)+入会话:
 * 非流式来源(单段锐评等"拿到整段再开口"的场景)用 */
function speakText(full) {
  const conv = curConv();
  S.speaking = true;
  const typer = createTyper({ silent: false, onDone: () => speechDone(conv, full) });
  typer.push(full);
  typer.finish();
}

/* SSE 读流:逐 delta 回调;解析失败的行静默跳过 */
async function readSSEStream(resp, onDelta) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n'); buf = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:') || s === 'data: [DONE]') continue;
      // openai 形状(choices.delta.content)与 anthropic 形状(content_block_delta)双兼容
      try {
        const j = JSON.parse(s.slice(5));
        onDelta(j.choices?.[0]?.delta?.content
          || (j.type === 'content_block_delta' && j.delta?.text) || '');
      } catch {}
    }
  }
}

/* 编排:会话记账 → 请求(故障转移) → 读流喂打字机 → 完稿持久化 */
async function chatLLM(userText, { silent = false, hideUser = false } = {}) {
  if (!CFG.chatApi.key) {
    const msg = '还没配置 API…在设置里填一下吧';
    addChatMsg('pet', msg); showBubble(msg);
    return;
  }
  const conv = curConv();
  conv.msgs.push({ role: 'user', content: userText, hidden: hideUser });
  if (conv.title === '新对话' && !hideUser) conv.title = userText.slice(0, 18);
  conv.updated = Date.now();
  const ctx = conv.msgs.slice(-(CFG.ctxLimit || 50)).map(({ role, content }) => ({ role, content }));
  let full = '';
  try {
    const { resp } = await chatFetchFailover((a) => ({
      model: a.model,
      stream: true,
      messages: [{ role: 'system', content: systemPrompt() }, ...ctx],
    }), 'chat');
    S.speaking = true;
    const typer = createTyper({ silent, onDone: () => speechDone(conv, full) });
    try {
      await readSSEStream(resp, (delta) => { full += delta; typer.push(delta); });
    } catch (err) {
      // 半路断流:已经说出口的话保留，别整段作废弹报错
      if (!full) { typer.cancel(); throw err; }
      logLLM('chat', userText, `(断流，保留已收 ${full.length} 字) ${err.message}`);
    }
    typer.finish();
    // 调试日志记完整请求(system+全部上下文):用户侧排查"回复跑偏"必须能对账
    logLLM('chat',
      `[system]\n${systemPrompt()}\n—— 上下文 ${ctx.length} 条 ——\n` +
      ctx.map((m) => `${m.role}: ${m.content}`).join('\n'), full);
  } catch (err) {
    S.speaking = false;
    Player.backToIdle(); // 中途可能已按 [emo:] 标签播了循环动画,出错必须归位(否则一直"叹气")
    logLLM('chat', userText, `ERROR: ${err.message}`);
    const msg = friendlyLLMError(err);
    addChatMsg('pet', msg); showBubble(msg);
  }
}
/* 桌宠的旁路发言(盯梢点评等)入会话:不请求模型,只落账;聊天面板开着就上屏。
 * 此前点评只走气泡,4.5 秒一过就无处可翻(真机反馈"评价没进对话 list") */
function petSay(text) {
  if (!text) return;
  const conv = curConv();
  conv.msgs.push({ role: 'assistant', content: text });
  conv.updated = Date.now();
  saveConvs();
  if (S.panel === 'panel-chat' && !S.histView) renderChatMsgs();
}
function addChatMsg(role, text) {
  const c = $('chat-messages');
  const div = document.createElement('div');
  div.className = 'chat-msg ' + role;
  div.textContent = text;
  c.appendChild(div);
  c.scrollTop = c.scrollHeight;
}
function setupChat() {
  const send = () => {
    const input = $('chat-input');
    const v = input.value.trim();
    if (!v) return;
    input.value = '';
    S.histView = false;
    chatLLM(v);        // 内部会把 user 消息推进当前会话
    renderChatMsgs();  // push 是同步的，立即重绘可见
  };
  $('chat-send').addEventListener('click', send);
  bindEnter('chat-input', send);
  $('chat-hist').addEventListener('click', () => {
    S.histView = !S.histView;
    S.histView ? renderConvList() : renderChatMsgs();
  });
  $('chat-new').addEventListener('click', () => { S.histView = false; newConv(); });
}
function bindEnter(id, fn) {
  const el = $(id);
  let comp = false;
  el.addEventListener('compositionstart', () => (comp = true));
  el.addEventListener('compositionend', () => (comp = false));
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !comp && !e.isComposing) { e.preventDefault(); fn(); }
  });
}

