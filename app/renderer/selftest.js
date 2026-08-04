/* 自测通道(--selftest=xxx):仅当启动参数带 selftest 时由 app.js 动态加载，
 * 不进正式路径。所有用例依赖 app.js 的全局(Persona/Sprites/FX/Player/CFG/…),
 * 本文件在 init() 跑完后才注入，无时序问题。
 * 用法:electron . --selftest=persona|frost|blizzard|bubble，结果打进主进程日志 */
'use strict';

(function () {
  const FLAGS = window.location.search + (window.process?.argv || '');

  /* ============ 集成自测(--selftest=all):交互流程全覆盖 ============
   * 在真实 Electron 运行时里用 mock fetch 跑完整场景,每项输出 PASS/FAIL。
   * 用户不该当人肉 QA —— 改完先跑这个,全绿再交付。约 35s。 */
  if (FLAGS.includes('selftest=all')) {
    (async () => {
      const R = [];
      const ok = (name, cond) => { R.push(`${cond ? 'PASS' : 'FAIL'} ${name}`); console.log(`[selftest:all] ${cond ? 'PASS' : 'FAIL'} ${name}`); };
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await wait(200); } return !!fn(); };
      const idleish = () => !S.speaking && ['idle', 'sleep', 'sleep_in'].includes(Player.cur?.name);
      await wait(2600); // 等 boot
      const realFetch = window.fetch;
      const disk0 = await API.getConfig(); // 结束后原样还原用户配置

      // ① 开机形态唯一性:码绘馒头与雪碧图画布必须恰好亮一个
      const bunVis = () => document.getElementById('pet-body').style.display !== 'none';
      const spriteVis = () => document.getElementById('pet-sprite').style.display === 'block';
      ok('开机形态唯一(馒头 XOR 包)', bunVis() !== spriteVis());
      // 等出场动画彻底播完(包 appear 可长达 4s+,prio 高,不等完情绪打不断)
      await waitFor(() => ['idle', 'sleep'].includes(Player.cur?.name), 12000);

      // ② 聊天触发情绪 → 说完归位(不卡循环)
      CFG.chatApi = { key: 'fake', base: 'http://fake', model: 'fake' };
      const sse = (txt) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: txt } }] }) + '\ndata: [DONE]\n';
      window.fetch = async () => new Response(new Blob([sse('[emo:gloomy]哼。')]).stream(), { status: 200 });
      await chatLLM('自测:聊天情绪');
      ok('聊天触发情绪动画', await waitFor(() => !['idle', 'appear'].includes(Player.cur?.name), 4000));
      ok('说完归位不卡循环', await waitFor(idleish, 12000));

      // ③ 请求失败(断网/断流)→ 归位
      window.fetch = async () => { throw new Error('mock 断网'); };
      await chatLLM('自测:断网');
      ok('请求失败也归位', await waitFor(idleish, 10000));

      // ④ 情绪循环卡死 → 看门狗救场
      Player.cur = { name: 'emo_sad', loop: true, prio: PRIORITY.emo, finished: false };
      S.speaking = false;
      ok('看门狗救卡死情绪(≤8s)', await waitFor(() => Player.cur?.name !== 'emo_sad', 9000));

      // ⑤ speaking 标志卡死 → 心跳自愈
      S.speaking = true; S.speechBeat = Date.now() - 60000;
      ok('speaking 卡死心跳自愈', await waitFor(() => !S.speaking, 9000));

      // ⑤b 贴边收起/滑出双向(没有 dock_ 动画时走默认 CSS 过场)
      await Dock.out('test');
      ok('贴边收起(人物隐藏+把手出现)',
        $('pet-wrapper').style.visibility === 'hidden' && $('dock-tab').classList.contains('show'));
      // 把手必须在鼠标接管白名单里,否则点它会穿透到桌面(踩过:人出不来)
      ok('把手不被鼠标穿透', !!$('dock-tab').closest(PASSTHRU_UI));
      await Dock.in();
      await waitFor(() => !Dock.docked, 2000);
      ok('从边缘滑出(人物回来+把手收掉)',
        $('pet-wrapper').style.visibility !== 'hidden' && !$('dock-tab').classList.contains('show'));

      // ⑥ 形象热切换双向(启用=写键;切回=删键,删键曾被 merge 借尸还魂)
      // 用本机第一个已安装角色包测,不依赖任何特定包
      const list = await API.personaList();
      const pack = list[0];
      if (pack) {
        const cfgA = { ...(await API.getConfig()), activePersona: pack.id };
        await API.setConfig(cfgA); await handleConfigChanged();
        ok('热切换→角色包', await waitFor(() => Persona.active?.id === pack.id && spriteVis(), 20000));
        // ⑥b 槽位映射:工坊把某个槽位指到包里另一条动画,桌宠该按映射取素材
        // (用户在工坊对调彩蛋/摸鱼时走的就是这条路)。测完把包的 slotMap 还原
        const man0 = (await API.personaManifest(pack.id))?.manifest || {};
        const alt = Object.keys(man0).find((k) => k !== 'idle');
        if (alt) {
          const meta0 = (await API.personaManifest(pack.id))?.persona?.slotMap || {};
          await window.pet.personaSetMeta(pack.id, { slotMap: { think: alt } });
          await Persona.reloadMeta();
          ok('槽位映射改指向', Persona.manifest?.think?.src === alt);
          await window.pet.personaSetMeta(pack.id, { slotMap: meta0 });
          await Persona.reloadMeta();
        } else ok('槽位映射(包里动画不足,跳过)', true);
        const cfgB = { ...(await API.getConfig()) }; delete cfgB.activePersona;
        await API.setConfig(cfgB); await handleConfigChanged();
        ok('热切换→馒头(删键方向)', await waitFor(() => !Persona.active && bunVis(), 9000));
      } else ok('热切换(未装角色包,跳过)', true);

      // ⑦ 随机屏摄日记全链路(观察→记说拆分→开口点评→按钮数据→日记型日报;journal 存档测完还原)
      // 用户存档里若有 doing 待办,boot 会还原 S.tracking=true,把 runJournalCheck
      // 的准入门禁(!S.tracking)挡死 → 本项在任何 commit 上都假 FAIL。测前强制清掉,
      // 屏检定时器一并停(免得测试中途真跑一次盯梢撞上 mock fetch),测完还原
      const tracking0 = S.tracking;
      S.tracking = false; clearTimeout(S.checkTimer);
      const journal0 = await API.getStore('journal');
      CFG.journalMode = true; CFG.visionCanChat = true; // 单段:记+说一次出
      CFG.visionApi = { key: 'k', base: 'http://fake', model: 'm', protocol: 'openai' };
      // API(contextBridge)是冻结对象改不了属性 → mock 全局函数 captureScreenSafe
      const realCapture = captureScreenSafe;
      captureScreenSafe = async () => 'QUFBQQ==';
      window.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: '记:在写代码\n说:辛苦了。' } }] }), { status: 200 });
      S.journal = []; S.journalDay = '';
      await runJournalCheck();
      ok('日记观察当场开口', S.speaking || document.getElementById('bubble').classList.contains('show'));
      await waitFor(() => !S.speaking, 8000);
      await runJournalCheck();
      ok('日记观察入库(2 条,记说拆分)', S.journal.length === 2 && S.journal[0].note === '在写代码');
      showJournalReport();
      ok('日记型日报生成', await waitFor(() => { const r = S.reports[S.reports.length - 1]; return r?.journal && r?.comment; }, 6000));
      S.reports.pop(); saveReports(); CFG.journalMode = false; CFG.visionCanChat = false; clearTimeout(S.journalTimer);
      S.journal = []; S.journalDay = '';
      await API.setStore('journal', journal0 || null);
      captureScreenSafe = realCapture;
      S.tracking = tracking0; if (tracking0) scheduleCheck(); // 还原待办追踪(见测前注释)

      // ⑧ anthropic 协议组包(路径/思考关/图块)
      let shape = null;
      window.fetch = async (url, opt) => { shape = { url, body: JSON.parse(opt.body) }; return new Response(JSON.stringify({ content: [{ type: 'text', text: '红' }] }), { status: 200 }); };
      CFG.visionApi = { key: 'k', base: 'http://fake/coding', model: 'm', protocol: 'anthropic' };
      await visionChat({ text: '?', imageB64: 'AA', maxTokens: 8 });
      ok('anthropic 组包正确', !!shape && shape.url.endsWith('/v1/messages') &&
        shape.body.thinking?.type === 'disabled' && shape.body.messages[0].content[0].type === 'image');

      // ⑧b 对话组包按服务商路由:anthropic 系走 /v1/messages+system 拆出,
      //     智谱走 /chat/completions 且带 thinking:disabled(关思考方言查表)
      let creq = null;
      window.fetch = async (url, opt) => { creq = { url, body: JSON.parse(opt.body) }; return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }), { status: 200 }); };
      CFG.chatApi = { provider: 'kimi-coding', key: 'k', base: 'https://api.kimi.com/coding', model: 'k3' };
      CFG.chatApi2 = { provider: '', key: '', base: '', model: '' };
      await chatLLMPlain('ping').catch(() => {});
      const okAnth = !!creq && creq.url.endsWith('/v1/messages') && !!creq.body.system &&
        creq.body.thinking?.type === 'disabled' && creq.body.messages[0].role === 'user';
      window.fetch = async (url, opt) => { creq = { url, body: JSON.parse(opt.body) }; return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }); };
      CFG.chatApi = { provider: 'zhipu', key: 'k', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.7-flash' };
      await chatLLMPlain('ping').catch(() => {});
      ok('对话组包按服务商路由', okAnth && creq.url.endsWith('/chat/completions') &&
        creq.body.thinking?.type === 'disabled');

      // ⑨ 情绪协议词表(2026-07-23 新规则:只收包能演的——有 emo_ 动画或别名映射;
      //    包没有的标准情绪不再教给模型,粒子兜底只留给不听话的硬输出)
      Persona.active = { id: 't', name: 'T', emoDesc: { proud: '得意时' }, emoAliases: { sad: 'emo_proud' } };
      Persona.manifest = { idle: { frames: 1, fps: 12 }, emo_proud: { frames: 1, fps: 12 } };
      const cap = capabilityAddendum();
      ok('情绪词表(只收包能演的)', cap.includes('[emo:proud]=得意时') &&
        cap.includes('[emo:sad]') && !cap.includes('[emo:surprise]') && !cap.includes('[emo:happy]'));
      Persona.active = null; Persona.manifest = null;

      // 收尾:恢复用户配置与真实网络
      window.fetch = realFetch;
      await API.setConfig(disk0); await handleConfigChanged();
      const pass = R.filter((r) => r.startsWith('PASS')).length;
      console.log(`[selftest:all] ==== ${pass === R.length ? 'ALL PASS' : 'HAS FAIL'} (${pass}/${R.length}) ====`);
    })().catch((e) => console.log('[selftest:all] SUITE CRASH: ' + (e.stack || e)));
  }

  /* 布局探针:面板与悬浮按钮列的真实几何(排查重叠用)。
   * 关键:先等按钮 show 过渡(0.22s)走完再 positionPanel——真实流程里用户点按钮时
   * 按钮早已停稳;并覆盖"桌宠被拖离默认位"场景(拖拽写 wrapper 内联 left,
   * 按钮跟走而 CSS 锚定的面板不跟,positionPanel 必须按实时坐标避让) */
  if (FLAGS.includes('selftest=layout')) {
    setTimeout(() => {
      const log = (m) => console.log('[selftest:layout] ' + m);
      const panel = document.getElementById('panel-settings');
      const hb = document.getElementById('hover-btns');
      const w = document.getElementById('pet-wrapper');
      const rects = () => {
        const pr = panel.getBoundingClientRect(), hr = hb.getBoundingClientRect();
        return `panel右缘=${pr.right.toFixed(1)} 按钮左缘=${hr.left.toFixed(1)} 重叠=${(pr.right - hr.left).toFixed(1)}px(正数=压住)`;
      };
      panel.classList.add('show');
      hb.classList.add('show');
      setTimeout(() => {                     // 等 show 过渡稳定
        positionPanel(panel);
        log('默认位 ' + rects());
        const r = w.getBoundingClientRect(); // 模拟用户把桌宠拖离默认位(左移 38px)
        w.style.left = (r.left - 38) + 'px';
        w.style.top = r.top + 'px';
        w.style.right = 'auto'; w.style.bottom = 'auto';
        setTimeout(() => {
          positionPanel(panel);
          log('拖走后 ' + rects());
          w.style.left = ''; w.style.top = ''; w.style.right = ''; w.style.bottom = '';
          log('DONE');
        }, 300);
      }, 350);
    }, 3000);
  }

  /* 形象系统全链路:激活→提示词联动→雪碧图出图→切回馒头释放 */
  if (FLAGS.includes('selftest=persona')) {
    setTimeout(async () => {
      const r = [];
      r.push('active=' + (Persona.active ? Persona.active.id : 'null'));
      r.push('idle_loaded=' + !!Sprites.images.idle);
      r.push('bun_hidden=' + ($('pet-body').style.display === 'none'));
      r.push('sprite_shown=' + ($('pet-sprite').style.display === 'block'));
      r.push('alias_surprise=' + Persona.emoAnim('surprise'));
      r.push('fx_avail=' + FX.available().join(','));
      // 提示词联动:包形象下不允许出现馒头专属的 emo/fx 标签行
      const sys = systemPrompt();
      const leakLines = sys.split('\n').filter((l) =>
        /\[emo:[a-z]|\[fx:[a-z]/.test(l) &&
        !l.startsWith('只能在台词里使用这些情绪标签') &&
        !l.startsWith('你有一个真实的施法能力') &&
        !l.startsWith('示例:'));
      r.push('sys_prompt_clean=' + (leakLines.length === 0));
      if (leakLines.length) console.log('[selftest:persona] LEAK>> ' + leakLines.join(' ⏎ '));
      // 雪碧图逐帧出图(画布中心像素必须有内容)
      Player.play('emo_happy', { loop: true, prio: PRIORITY.emo });
      await Sprites.preload('emo_happy');
      await new Promise((res) => setTimeout(res, 700));
      const px = Sprites.ctx.getImageData(236, 315, 1, 1).data;
      r.push('sprite_drawn=' + (px[3] > 0));
      // 切回馒头:SVG 恢复、包图释放、提示词还原
      const cfg = await API.getConfig(); delete cfg.activePersona;
      await API.setConfig(cfg);
      await Persona.refresh();
      Player.backToIdle();
      await new Promise((res) => setTimeout(res, 300));
      r.push('mantou_back=[' + [!Persona.active, $('pet-body').style.display !== 'none',
        Object.keys(Sprites.images).length === 0,
        $('pet-sprite').style.display === 'none'].join(',') + ']');
      const sys2 = systemPrompt();
      r.push('mantou_prompt_restored=' + (sys2.includes('[emo:surprise]') || /surprise = /.test(sys2)));
      console.log('[selftest:persona] ' + r.join(' | '));
    }, 2500);
  }

  if (FLAGS.includes('selftest=frost')) {
    setTimeout(() => {
      FX.frost();
      setTimeout(() => console.log('[selftest] frost parts=', FX.parts.length, 'running=', FX.running), 800);
    }, 1500);
  }

  if (FLAGS.includes('selftest=blizzard')) {
    setTimeout(() => {
      FX.blizzard();
      setTimeout(() => console.log('[selftest] blizzard clip=', !!FX.clip, 'running=', FX.running), 1200);
    }, 1500);
  }

  /* 聊天流式气泡:mock 一段 SSE，观测气泡逐句显示节奏 */
  if (FLAGS.includes('selftest=bubble')) {
    CFG.chatApi = { key: 'fake', base: 'http://fake', model: 'fake' };
    const sse = 'data: ' + JSON.stringify({ choices: [{ delta: { content: '[emo:neutral]第一句话。[emo:speechless]第二句话来了。' } }] }) + '\ndata: [DONE]\n';
    window.fetch = async () => new Response(new Blob([sse]).stream(), { status: 200 });
    const bubble = document.getElementById('bubble');
    const seen = [];
    let last = null;
    const t0 = Date.now();
    setInterval(() => {
      const txt = bubble.textContent;
      if (txt !== last) { seen.push(`${((Date.now() - t0) / 1000).toFixed(1)}s:"${txt}"`); last = txt; }
    }, 150);
    setTimeout(() => chatLLM('自测'), 1200);
    setTimeout(() => console.log('SELFTEST_RESULT', JSON.stringify(seen)), 12000);
  }
})();
