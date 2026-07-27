'use strict';
/* ================= 设置面板 ================= */
/* 一个 API 配置块(服务商下拉+Base+模型+Key+测试):对话/副对话/视觉三处共用。
 * 服务商决定协议与"关思考"方言(PROVIDERS 表,core.js),自定义两项手填 Base */
function apiGroupHtml(idp, a, label, { keyPh = 'sk-...', testLabel = '测试连通', extra = '' } = {}) {
  const cur = a.provider || inferProvider(a) || 'zhipu';
  const opts = PROVIDERS.map((p) => `<option value="${p.id}" ${p.id === cur ? 'selected' : ''}>${p.name}</option>`).join('');
  const eg = providerOf({ provider: cur })?.eg;
  return `<div class="setting-group"><label>${label}</label>
    <div class="api-field"><label>服务商</label><select class="api-input" id="${idp}-prov" style="flex:1;">${opts}</select></div>
    <div class="api-field"><label>Base URL</label><input class="api-input" id="${idp}-base" value="${a.base}" placeholder="选服务商自动填"></div>
    <div class="api-field"><label>模型 ID</label><input class="api-input" id="${idp}-model" value="${a.model}" placeholder="${eg ? '如 ' + eg : ''}"></div>
    <div class="api-field"><label>Key</label><input class="api-input" id="${idp}-key" type="password" value="${a.key}" placeholder="${keyPh}"></div>
    ${extra}
    <button class="test-btn" id="test-${idp}">${testLabel}</button><span id="test-${idp}-r" style="font-size:11px;margin-left:8px;display:inline-block;max-width:100%;word-break:break-all;vertical-align:middle;"></span>
  </div>`;
}
function collectApi(idp) {
  return {
    provider: $(idp + '-prov').value,
    key: $(idp + '-key').value.trim(),
    base: $(idp + '-base').value.trim(),
    model: $(idp + '-model').value.trim(),
  };
}
function renderSettings() {
  const body = $('settings-body');
  // 能力门控:当前形象缺依赖动画的功能开关置灰(CFG 里的偏好不清,
  // 切回有动画的形象自动恢复;运行时另有兜底,这里只管 UI 表达)
  const noSleep = !Persona.canFeature('nightSleep');
  const noDance = !Persona.canFeature('musicMode');
  // 四组折叠:基础常开;API 没配 Key 时自动展开引导;其余默认收起(面板不再一屏长表单)
  body.innerHTML = `
    <details class="set-sec" open><summary>基础</summary><div class="sec-body">
      <div class="setting-group"><label>桌宠名字(当前形象:${Persona.active ? Persona.active.name : '馒馒本体'})</label>
        <input class="name-input" id="set-name" value="${Persona.petName()}"></div>
      <div class="setting-group"><label>人设(身份+性格一段写完;{petName} 会代入上面的名字)</label>
        <textarea id="custom-perso" placeholder="描述身份与性格…">${(Persona.binding().customPersonality || '').trim() || DEFAULT_PERSONA}</textarea>
        <div class="gate-why" style="margin-top:3px;">名字与人设按形象包各存一份,切形象自动跟着换;配置后台「形象」页的人设编辑框与这里是同一份,任一处改完两边同步。</div>
      </div>
      <div class="setting-toggle"><span>暗色模式(黑曜馒头)</span><div class="toggle ${CFG.darkMode ? 'on' : ''}" id="tg-dark"></div></div>
    </div></details>
    <details class="set-sec"><summary>行为</summary><div class="sec-body">
      <div class="setting-toggle"><span>专注时保持静音</span><div class="toggle ${CFG.silentFocus ? 'on' : ''}" id="tg-silent"></div></div>
      <div class="setting-toggle"><span>整点起身提醒</span><div class="toggle ${CFG.healthReminder ? 'on' : ''}" id="tg-health"></div></div>
      <div class="setting-toggle${noSleep ? ' gated' : ''}"><span>深夜睡觉(到点就困)${noSleep ? '<em class="gate-why">当前形象没有睡觉动画</em>' : ''}</span><div class="toggle ${CFG.nightSleep && !noSleep ? 'on' : ''}" id="tg-sleep"></div></div>
      <div class="api-field"><label>睡觉时段</label>
        <input class="api-input" id="set-sleep-start" type="number" min="0" max="23" value="${CFG.sleepStart}" style="flex:0 0 52px;text-align:center;"><span style="font-size:11px;color:var(--muted-2);">点 ~</span>
        <input class="api-input" id="set-sleep-end" type="number" min="0" max="23" value="${CFG.sleepEnd}" style="flex:0 0 52px;text-align:center;"><span style="font-size:11px;color:var(--muted-2);">点(相同=不睡)</span>
      </div>
      <div class="setting-toggle"><span>随机屏摄记日记(看到什么记一笔+开口点评，不判摸鱼)</span><div class="toggle ${CFG.journalMode ? 'on' : ''}" id="tg-journal"></div></div>
      <div class="setting-toggle"><span>自习室(它也有自己的研究待办，跟你一起自习;大目标在日程面板「研究」tab 改)</span><div class="toggle ${CFG.studyMode ? 'on' : ''}" id="tg-study"></div></div>
      <div class="setting-toggle"><span>观察记录分享给 Agent(只导出文字摘要，不含截图)</span><div class="toggle ${CFG.agentShare !== false ? 'on' : ''}" id="tg-agentshare"></div></div>
      <div class="setting-toggle"><span>每天首启报天气</span><div class="toggle ${CFG.morningWeather ? 'on' : ''}" id="tg-weather"></div></div>
      <div class="setting-toggle"><span>开机自动启动</span><div class="toggle" id="tg-autostart"></div></div>
      <div class="setting-toggle${noDance ? ' gated' : ''}"><span>听歌点头(抓系统声音，需屏幕录制权限)${noDance ? '<em class="gate-why">当前形象没有点头动画</em>' : ''}</span><div class="toggle ${CFG.musicMode && !noDance ? 'on' : ''}" id="tg-music"></div></div>
      <div class="api-field"><label>素材BPM</label><input class="api-input" id="set-bpm" type="number" min="40" max="200" value="${CFG.danceBpm}" title="点头素材原生BPM，用节奏校准器实测后填"></div>
      <div id="music-status" style="font-size:11px;color:var(--muted-2);padding:2px 0 6px;">${CFG.musicMode ? Music.status : ''}</div>
    </div></details>
    <details class="set-sec" ${CFG.chatApi.key ? '' : 'open'}><summary>API 配置</summary><div class="sec-body">
      <div class="setting-toggle"><span>禁用模型思考(桌宠不需要，省时省钱)</span><div class="toggle ${CFG.disableThinking !== false ? 'on' : ''}" id="tg-think"></div></div>
      ${apiGroupHtml('chat', CFG.chatApi, '对话模型 API', { keyPh: 'sk-...' })}
      ${apiGroupHtml('chat2', CFG.chatApi2, '副对话 API(可选:主API连不上时自动顶上)', { keyPh: '留空=不启用' })}
      ${apiGroupHtml('vis', CFG.visionApi, '视觉模型 API(屏摄判定)', {
        keyPh: 'sk-...', testLabel: '测试连通(发一张小图)',
        extra: `<div class="setting-toggle"><span>视觉模型也有对话能力(锐评单段直答，更快)</span><div class="toggle ${CFG.visionCanChat ? 'on' : ''}" id="tg-visdirect"></div></div>`,
      })}
      <div class="setting-toggle"><span>联网检索(自习室研究查资料用)</span><div class="toggle ${CFG.webSearch !== false ? 'on' : ''}" id="tg-search"></div></div>
      <div class="api-field"><label>检索 Key</label>
        <input class="api-input" id="set-searchkey" type="password" value="${CFG.searchKey || ''}" placeholder="智谱 Key(选填)"></div>
      <div style="font-size:10.5px;color:var(--muted-2);padding:0 0 6px;line-height:1.7;">按服务商自动适配:智谱直连检索(约 0.01 元/次,复用对话 Key)、通义/Kimi 走各自官方联网,都不用填;其他服务商可填智谱检索 Key 兜底。关掉开关或都没有,它就纯凭大语言模型研究(可信度略降)。火山的联网要在其控制台配应用,暂不支持。</div>
    </div></details>
    <details class="set-sec"><summary>高级</summary><div class="sec-body">
      <div class="setting-group"><label>屏摄频率(快→慢)</label>
        <div class="setting-slider">快<input type="range" min="1" max="5" id="set-freq" value="${CFG.screenLevel}">慢</div>
        <div id="freq-val" style="font-size:11px;color:var(--muted-2);margin-top:4px;"></div></div>
      <div class="setting-group"><label>摸鱼判定(宽松→严格)</label>
        <div class="setting-slider">宽<input type="range" min="1" max="5" id="set-sens" value="${CFG.sensitivity}">严</div></div>
      <div class="setting-group"><label>聊天携带上下文条数(1~500)</label>
        <input class="name-input" id="set-ctx" type="number" min="1" max="500" value="${CFG.ctxLimit}"></div>
      <button class="report-btn" id="btn-prompts" style="color:var(--accent);border-color:var(--accent-line);">⌥ 开发者模式:配置后台</button>
    </div></details>
    ${S.updateInfo ? `<button class="report-btn" id="btn-update" style="color:var(--accent);border-color:var(--accent-line);">⬆ 有新版本 v${S.updateInfo.version}，去下载</button>` : ''}
    <button class="quit-btn" id="btn-quit">退出桌宠</button>`;

  const save = () => {
    // 名字/人设写进当前形象的绑定格(功能4);mantou 本体同步镜像旧全局键
    // (todo 报告等旧读取路径 + selftest 还认它们)
    const pid = Persona.active?.id || 'mantou';
    const bName = $('set-name').value.trim() || (Persona.active?.name || '馒馒');
    const bPerso = $('custom-perso').value.trim();
    CFG.personaBindings = { ...(CFG.personaBindings || {}),
      [pid]: { petName: bName, customPersonality: bPerso } };
    if (pid === 'mantou') { CFG.petName = bName; CFG.customPersonality = bPerso; }
    CFG.chatApi = collectApi('chat');
    CFG.chatApi2 = collectApi('chat2');
    // protocol 旧字段跟着 provider 同步写,兼容还在读它的老路径
    CFG.visionApi = { ...collectApi('vis'), protocol: apiProto({ provider: $('vis-prov').value }) };
    CFG.screenLevel = +$('set-freq').value;
    CFG.sensitivity = +$('set-sens').value;
    CFG.sleepStart = Math.max(0, Math.min(23, +$('set-sleep-start').value || 0));
    CFG.sleepEnd = Math.max(0, Math.min(23, +$('set-sleep-end').value || 0));
    CFG.ctxLimit = Math.max(1, Math.min(500, +$('set-ctx').value || 50));
    CFG.danceBpm = Math.max(40, Math.min(200, +$('set-bpm').value || 89));
    CFG.searchKey = $('set-searchkey').value.trim();
    CFG.personality = 'custom'; // 预设档位已随 UI 移除;人设=自由文本(默认底稿为清冷)
    API.setConfig(CFG);
  };
  body.querySelectorAll('input,textarea,select').forEach((el) => el.addEventListener('change', save));
  // 切服务商:预设的直接换官方端点;切到自定义时若 Base 还是某个预设端点则清空待手填
  ['chat', 'chat2', 'vis'].forEach((idp) => {
    $(idp + '-prov').addEventListener('change', () => {
      const p = providerOf({ provider: $(idp + '-prov').value });
      const baseEl = $(idp + '-base');
      if (p && p.base) baseEl.value = p.base;
      else if (PROVIDERS.some((x) => x.base && x.base === baseEl.value)) baseEl.value = '';
      $(idp + '-model').placeholder = p && p.eg ? '如 ' + p.eg : '';
      save();
    });
  });
  // 频率滑块:实时显示当前档的分钟数(档位表 CHECK_BASE_MIN 在 todo.js，全局共享)
  const updFreq = () => {
    const b = CHECK_BASE_MIN[+$('set-freq').value - 1];
    $('freq-val').textContent = `当前档:约每 ${b} 分钟看一次(实际 ±30% 随机抖动;全档位 ${CHECK_BASE_MIN[0]}~${CHECK_BASE_MIN[4]} 分钟)`;
  };
  updFreq();
  $('set-freq').addEventListener('input', updFreq);
  // 改频率立即生效:盯梢/日记的下一发定时器挂着旧间隔,不重排的话从
  // 最慢档切最快档要等旧倒计时(至多 45 分钟)打完才生效(真机实锤"调快没反应")
  $('set-freq').addEventListener('change', () => { scheduleCheck(); scheduleJournal(); });
  $('tg-dark').addEventListener('click', function () {
    this.classList.toggle('on'); CFG.darkMode = this.classList.contains('on'); save();
    applyTheme(); // 立即生效
  });
  $('tg-silent').addEventListener('click', function () {
    this.classList.toggle('on'); CFG.silentFocus = this.classList.contains('on'); save();
  });
  $('tg-think').addEventListener('click', function () {
    this.classList.toggle('on'); CFG.disableThinking = this.classList.contains('on'); save();
  });
  $('tg-visdirect').addEventListener('click', function () {
    this.classList.toggle('on'); CFG.visionCanChat = this.classList.contains('on'); save();
  });
  $('tg-search').addEventListener('click', function () {
    this.classList.toggle('on'); CFG.webSearch = this.classList.contains('on'); save();
  });
  $('tg-journal').addEventListener('click', function () {
    this.classList.toggle('on'); CFG.journalMode = this.classList.contains('on'); save();
    scheduleJournal(); // 开关立即生效(开=排上定时器，关=清掉)
  });
  $('tg-study').addEventListener('click', function () {
    this.classList.toggle('on'); CFG.studyMode = this.classList.contains('on'); save();
    if (CFG.studyMode) { Study.rollover(); if (S.tracking) Study.ensureTasks(); }
    else Study.clearVisual(document.getElementById('pet')); // 关=收掉摸鱼演出与认真态
    syncStudyTab(); // 研究 tab 随开关显隐
  });
  $('tg-agentshare').addEventListener('click', function () {
    this.classList.toggle('on'); CFG.agentShare = this.classList.contains('on'); save();
  });
  $('tg-health').addEventListener('click', function () {
    this.classList.toggle('on'); CFG.healthReminder = this.classList.contains('on'); save();
  });
  $('tg-sleep').addEventListener('click', function () {
    if (noSleep) { showToast('当前形象没有睡觉动画，开了也睡不着'); return; }
    this.classList.toggle('on'); CFG.nightSleep = this.classList.contains('on'); save();
    if (!CFG.nightSleep) wakeUp(true);
  });
  $('tg-weather').addEventListener('click', function () {
    this.classList.toggle('on'); CFG.morningWeather = this.classList.contains('on'); save();
  });
  API.getAutostart?.().then((on) => $('tg-autostart')?.classList.toggle('on', on));
  $('tg-autostart').addEventListener('click', async function () {
    const on = !this.classList.contains('on');
    if (await API.setAutostart?.(on)) {
      this.classList.toggle('on', on);
      showToast(on ? '已设为开机启动' : '已取消开机启动');
    } else showToast('设置失败');
  });
  $('tg-music').addEventListener('click', async function () {
    if (noDance) { showToast('当前形象没有点头动画，听歌模式开不了'); return; }
    if (!this.classList.contains('on')) {
      if (await Music.start()) { this.classList.add('on'); CFG.musicMode = true; showToast('听歌点头已开启🎵'); }
    } else { Music.stop(); this.classList.remove('on'); CFG.musicMode = false; }
    save();
  });
  $('test-vis').addEventListener('click', async () => {
    save();
    const r = $('test-vis-r');
    r.textContent = '测试中…'; r.style.color = 'var(--muted)';
    try {
      // 64x64 纯红测试图(1像素图会被部分平台以"尺寸过小"拒收)
      // 注意:旧图 IDAT 截断+CRC 坏，宽容解码器能忍，严格端点(如 Kimi)直接
      // "failed to decode image" 拒收 —— 换图前先本地校验过全部 chunk
      const RED_PX = 'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAS0lEQVR42u3PQQkAAAgAsetfWiP4FgYrsKZeS0BAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEDgsqnc8OJg6Ln3AAAAAElFTkSuQmCC';
      // 统一走 visionChat(协议路由 openai/anthropic 在里面)
      const txt = await visionChat({
        text: '这张图主要是什么颜色?只回颜色名。',
        imageB64: RED_PX, mime: 'image/png', maxTokens: 128, label: 'vision-test', // 思考型模型 20 不够，正文会被吃光
      });
      if (!txt) throw new Error('空响应');
      logLLM('vision-test', '(测试连通:发小图问颜色)', txt);
      r.textContent = `✓ 能看图(答:${txt.slice(0, 8)})`; r.style.color = 'var(--success)';
    } catch (e) {
      // 报错全文展示(span 可折行)+ 进调试日志，别让用户猜后半句
      logLLM('vision-test', '(测试连通:发小图问颜色)', `ERROR: ${e.message}`);
      r.textContent = `✗ ${String(e.message).slice(0, 200)}`; r.title = String(e.message);
      r.style.color = 'var(--danger)';
    }
  });

  // 测试按钮必须单端点隔离(不走故障转移)——否则主 API 挂了副 API 顶上会误报 ✓
  const testChatApi = async (a) => {
    if (!a.key) throw new Error('未填 Key');
    // 统一组包(协议+关思考跟着服务商走);万一思考没关掉,128 token 也够吐出正文
    const req = chatRequest(a, { model: a.model, max_tokens: 128,
      messages: [{ role: 'user', content: '回复"连通"两个字即可。' }] });
    const resp = await llmFetch(req.url, {
      method: 'POST', headers: req.headers, body: JSON.stringify(req.body),
    }, { label: 'test', retries: 0 });
    if (!resp.ok) { const d = await resp.text().catch(() => ''); throw new Error(`HTTP ${resp.status} ${d.slice(0, 60)}`); }
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message || 'API错误');
    return (chatText(data) || '').trim() || '(空响应)';
  };
  const bindApiTest = (btnId, rId, getApi) => {
    $(btnId).addEventListener('click', async () => {
      save();
      const r = $(rId);
      r.textContent = '测试中…'; r.style.color = 'var(--muted)';
      try {
        const txt = await testChatApi(getApi());
        logLLM('api-test:' + btnId, '(测试连通)', txt);
        r.textContent = `✓ ${txt.slice(0, 12)}`; r.style.color = 'var(--success)';
      } catch (e) {
        logLLM('api-test:' + btnId, '(测试连通)', `ERROR: ${e.message}`);
        r.textContent = `✗ ${String(e.message).slice(0, 200)}`; r.title = String(e.message);
        r.style.color = 'var(--danger)';
      }
    });
  };
  bindApiTest('test-chat', 'test-chat-r', () => CFG.chatApi);
  bindApiTest('test-chat2', 'test-chat2-r', () => CFG.chatApi2);
  $('btn-prompts')?.addEventListener('click', () => API.openPrompts?.());
  $('btn-update')?.addEventListener('click', () => API.openUpdate?.());
  $('btn-quit').addEventListener('click', () => API.quit());
}

