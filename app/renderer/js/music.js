'use strict';
/* ================= 听歌点头 ================= */
const Music = {
  stream: null, raf: null, beats: [], lastBeat: 0, energy: [], dancing: false,
  appRunning: false, appPoll: null, status: '未启动',
  async start(quiet) {
    // 能力门控:当前形象没有点头动画,不占音频源白听(开关在设置里也已置灰)
    if (!Persona.canFeature('musicMode')) {
      this.status = '当前形象没有点头动画';
      if (!quiet) showToast('当前形象没有点头动画，听歌模式开不了');
      return false;
    }
    // 重拾入口也走这里:先清旧循环/轮询，避免双循环
    cancelAnimationFrame(this.raf);
    clearInterval(this.appPoll);
    // 首选系统声音回环(听"播出来的声音"，免疫键盘/环境噪音);失败退回麦克风
    try {
      this.stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      // 视频轨只禁用不停止:回环音频和视频挂在同一条 ScreenCaptureKit 会话上，
      // stop 掉视频可能让会话稍后被系统回收→音频跟着死(中途死流头号嫌疑)
      this.stream.getVideoTracks().forEach((t) => { t.enabled = false; });
      if (!this.stream.getAudioTracks().length) throw new Error('无音轨');
      this.srcName = '系统声音';
    } catch {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.srcName = '麦克风';
      } catch { this.status = '音频源不可用(权限被拒)'; showToast('拿不到系统声音也拿不到麦克风，听歌模式无法开启'); return false; }
    }
    if (!quiet) showToast(`听歌点头:使用${this.srcName}`);
    await audioCtx.resume(); // AudioContext 可能处于挂起态，不唤醒的话分析器全是 0
    // 只有检测到音乐播放器进程才分析节拍，防止语音输入/说话误触发跳舞
    this.appRunning = await API.musicAppRunning();
    this.appPoll = setInterval(async () => {
      this.appRunning = await API.musicAppRunning();
      if (!this.appRunning && this.dancing) this.stopDance();
    }, 8000);
    const src = audioCtx.createMediaStreamSource(this.stream);
    const an = audioCtx.createAnalyser();
    an.fftSize = 2048;
    src.connect(an);
    const buf = new Uint8Array(an.frequencyBinCount);
    const binHz = audioCtx.sampleRate / an.fftSize;
    const lo = Math.floor(60 / binHz), hi = Math.ceil(250 / binHz);
    this.everHeard = false;
    this.silentSince = 0;
    const myStream = this.stream; // 循环持有自己的流:被重拾/关闭后旧循环自行退出
    const loop = () => {
      if (this.stream !== myStream) return;
      // 每帧体检:ctx 挂起就唤醒;音频轨 ended = 确凿死亡，立即重拾(5s 冷却)
      if (audioCtx.state !== 'running') audioCtx.resume();
      const tr = myStream.getAudioTracks()[0];
      if (tr && tr.readyState === 'ended' && this.reacquire('音频轨 ended')) return;
      if (!this.appRunning) {
        this.status = '未检测到音乐播放器';
        if (this.dancing) this.stopDance();
        this.raf = requestAnimationFrame(loop);
        return;
      }
      an.getByteFrequencyData(buf);
      let e = 0, full = 0;
      for (let i = lo; i <= hi; i++) e += buf[i];
      e /= hi - lo + 1;
      for (let i = 0; i < buf.length; i++) full += buf[i];
      full /= buf.length;
      const now = performance.now();
      this.energy.push({ t: now, e });
      while (this.energy.length && now - this.energy[0].t > 1200) this.energy.shift();
      const avg = this.energy.reduce((s, x) => s + x.e, 0) / (this.energy.length || 1);
      this.lastAvg = avg; // 睡眠×音乐分级要看"当下响不响"(重低音判据)
      // 门限按音源分:回环流里只有播放器输出、没有环境音，"有声即音乐";
      // 麦克风才需要高门限防键盘/说话声
      const isLoop = this.srcName === '系统声音';
      const musicOn = isLoop ? (avg > 2 || full > 8) : (avg > 9 || full > 45);
      // 分档静音自愈(仅回环源:麦克风安静是常态):
      // 本流从没出过声→5s 重拾(死产流，健康流有歌 1s 内必有信号);
      // 出过声后转静→等 15s(可能只是歌间隙/暂停);一有信号计数清零
      if (isLoop) {
        if (musicOn) { this.everHeard = true; this.silentSince = 0; this.reacquires = 0; }
        else {
          if (!this.silentSince) this.silentSince = now;
          if (now - this.silentSince > (this.everHeard ? 15000 : 5000)) {
            this.silentSince = 0;
            if (this.reacquire(this.everHeard ? '出声后转静15s' : '死产流(从未出声)')) return;
          }
        }
      }
      if (musicOn) {
        if (!this.audibleSince) this.audibleSince = now;
        // 抒情歌兜底:持续有音乐但 8s 锁不到节拍 → 默认慢速轻摇(轻摇=舒缓，不吵醒睡眠)
        if (!this.dancing && now - this.audibleSince > 8000 && !S.sleeping) {
          this.dancing = true;
          document.getElementById('pet-wrapper').classList.add('dance');
          this.lastBeat = now;
          Player.play('dance_nod', { loop: true, prio: PRIORITY.dance, rate: 0.8 });
          this.scheduleLyric();
        }
        if (this.dancing && now - this.lastBeat > 4000) this.lastBeat = now - 3000; // 音乐在响就续命
        this.quietSince = 0;
      } else {
        this.audibleSince = 0;
        if (this.dancing && now - (this.quietSince || (this.quietSince = now)) > 3000) this.stopDance();
      }
      // 状态栏=诊断仪表:所有状态都带音源名+实时能量数字
      if (this.dancing && this.status.indexOf('跳舞中') < 0)
        this.status = `${this.srcName}:轻摇中(低频${avg.toFixed(0)}/全频${full.toFixed(0)}，节拍不规律，按默认慢速摇)`;
      if (!this.dancing)
        this.status = musicOn
          ? `${this.srcName}:找节拍中(低频${avg.toFixed(0)}/全频${full.toFixed(0)})`
          : `${this.srcName}:安静(低频${avg.toFixed(1)}/全频${full.toFixed(1)}${isLoop && !this.everHeard ? '，流无信号' : ''})`;
      // 节拍门限地板按音源分:回环 8/6，麦克风 16/12(跳舞中取低档，粘性)
      const gate = this.dancing
        ? Math.max(isLoop ? 6 : 12, avg * 1.18)
        : Math.max(isLoop ? 8 : 16, avg * 1.3);
      // 桌宠自己说话的 blip 音效会进系统回环,节奏规律得像鼓点——说话期间不采拍
      if (e > gate && now - this.lastBeat > 260 && !S.speaking) {
        this.lastBeat = now;
        this.beats.push(now);
        if (this.beats.length > 10) this.beats.shift();
        this.onBeat();
      }
      if (this.dancing && now - this.lastBeat > 6000) this.stopDance(); // 6s 无拍才退场
      // 该跳没跳就补切;睡着不切，睡醒过渡(sleep_out)播完再接，别硬切
      if (this.dancing && !S.speaking && !S.sleeping && Player.cur &&
          Player.cur.name !== 'dance_nod' && Player.cur.name !== 'sleep_out' &&
          Player.cur.prio <= PRIORITY.dance)
        Player.play('dance_nod', { loop: true, prio: PRIORITY.dance, rate: this.lastRate || 0.8 });
      this.raf = requestAnimationFrame(loop);
    };
    loop();
    return true;
  },
  /* 拾音自愈:重建整条采集链。冷却 20s(轨 ended 5s)、封顶 30 次、有信号即清零计数。
     返回 true = 已接管(旧循环应退出);false = 冷却中/超封顶(旧循环继续跑) */
  reacquire(reason) {
    const now = performance.now();
    const cd = /ended/.test(reason) ? 5000 : 20000;
    if (now - (this.lastReacq || 0) < cd) return false;
    if ((this.reacquires || 0) >= 30) {
      this.status = `${this.srcName}:拾音多次失败，已停止自愈(重开听歌模式重试)`;
      return false;
    }
    this.lastReacq = now;
    this.reacquires = (this.reacquires || 0) + 1;
    const tr = this.stream?.getAudioTracks()[0];
    logLLM('audio', '(拾音自愈)',
      `第${this.reacquires}次重拾:${reason};track=${tr ? tr.readyState : '无'},ctx=${audioCtx.state}`);
    const old = this.stream;
    this.stream = null;              // 旧分析循环的退出条件
    old?.getTracks().forEach((t) => t.stop());
    this.start(true);                // 异步重建，静默(不重复弹 toast)
    return true;
  },
  onBeat() {
    if (this.beats.length < 4) return;
    const iv = [];
    for (let i = 1; i < this.beats.length; i++) iv.push(this.beats[i] - this.beats[i - 1]);
    iv.sort((a, b) => a - b);
    const med = iv[Math.floor(iv.length / 2)];
    // 节拍规律性检查:进舞要求规律，跳舞中放宽(粘性)
    const spread = (iv[iv.length - 1] - iv[0]) / med;
    if (spread > (this.dancing ? 0.9 : 0.65)) return;
    let bpm = 60000 / med;
    if (bpm < 40 || bpm > 260) return;
    // 睡眠×音乐分级(用户拍板):激烈 = 原始节拍≥100BPM 或重低音(低频能量≥30)。
    // 激烈响着→不犯困(15s 滚动续期);睡着了→吵醒陪跳;舒缓→照睡不误
    const intense = bpm >= 100 || (this.lastAvg || 0) >= 30;
    if (intense) this.intenseUntil = performance.now() + 15000;
    if (S.sleeping) {
      if (!intense) return;   // 舒缓节拍:继续睡
      wakeUp(true);           // 激烈:吵醒(睁眼过渡播完由补切接舞)
    }
    // 快歌折半拍:>130BPM 的歌两拍点一次头(音乐上叫 half-time),
    // 否则素材被拉到极速反而对不上;慢歌同理翻倍
    let eff = bpm;
    while (eff > 130) eff /= 2;
    while (eff < 55) eff *= 2;
    this.status = `${this.srcName}:跳舞中 ♪ ${bpm.toFixed(0)} BPM${eff !== bpm ? `(折算${eff.toFixed(0)})` : ''}`;
    const rate = Math.min(1.5, Math.max(0.6, eff / (CFG.danceBpm || 89)));
    this.lastRate = rate;
    if (!this.dancing) {
      this.dancing = true;
      document.getElementById('pet-wrapper').classList.add('dance');
      this.scheduleLyric(); // 听歌点评:跳舞期间随机偷瞄屏幕上的歌名/歌词
    }
    if (Player.cur?.name !== 'dance_nod')
      Player.play('dance_nod', { loop: true, prio: PRIORITY.dance, rate });
    else
      // 锁相环:绝不重置帧(重置=卡顿)，但每拍按相位误差微调速度，
      // 把"点头落点"渐渐拉回节拍上——只平滑速度会让相位自由漂移，越跳越不合拍
      Player.rate = Player.rate * 0.5 + this.phaseLockedRate(rate) * 0.5;
  },
  /* 当前点头相位 → 校正速率。素材一循环含 N 次点头(由原生 BPM 推出),
     相位 0 = 点头落点;偏差经 ±18% 限幅的变速在几拍内收敛归零 */
  phaseLockedRate(baseRate) {
    const m = Player.manifest['dance_nod'];
    if (!m || Player.cur?.name !== 'dance_nod') return baseRate;
    const nods = Math.max(1, Math.round((CFG.danceBpm || 89) / 60 * (m.frames / m.fps)));
    const period = m.frames / nods;
    const pos = (Player.frame + Player.acc / (1000 / m.fps)) % period;
    let err = pos / period;
    if (err > 0.5) err -= 1; // 走最短路径回落点:超前则减速等拍，滞后则加速追拍
    return baseRate * (1 - Math.max(-0.18, Math.min(0.18, err * 0.6)));
  },
  stopDance() {
    this.dancing = false;
    // 注意:这里不清 lyricTimer——歌与歌之间的静音间隙也会走到这，
    // 清了就等于每换一首歌点评倒计时归零，永远等不到(踩过坑)
    document.getElementById('pet-wrapper').classList.remove('dance');
    if (Player.cur?.name === 'dance_nod') Player.backToIdle();
  },
  /* ---- 听歌点评 ---- */
  lyricTimer: null, lastSong: '',
  scheduleLyric() {
    if (this.lyricTimer) return; // 已有倒计时就别重置(跳舞常因歌曲切换反复进出)
    this.lyricTimer = setTimeout(() => { this.lyricTimer = null; this.lyricComment(); }, 45000 + Math.random() * 120000);
  },
  async lyricComment() {
    if (!this.dancing) return;
    try {
      // 优先问系统"正在播放什么"(不需要开歌词页);模型认识歌名就能点评
      const raw = (await API.nowPlaying()) || '';
      const APPNAMES = ['网易云音乐', 'NeteaseMusic', 'QQ音乐', 'QQMusic', '酷狗音乐', 'Music', 'Spotify'];
      const title = APPNAMES.includes(raw) ? '' : raw;
      // 日志分档:真歌名 / 只拿到应用名(窗口标题无歌名) / 全部通道为空，方便排查
      logLLM('lyric', 'nowPlaying', title ? `歌名:${title}`
        : raw ? `只拿到应用名(${raw}):窗口标题不含歌名，历史库也没给出新记录`
        : '(全部通道为空:官方接口没在播/窗口标题拿不到/网易云历史库无半小时内记录。转看屏方案)');
      if (title.length > 1 && CFG.chatApi.key && !S.speaking) {
        if (title !== this.lastSong) {
          this.lastSong = title;
          chatLLM(P('lyric', { title }), { hideUser: true });
        }
        this.scheduleLyric();
        return;
      }
      // 拿不到歌名再退回"看屏幕"方案(统一走 visionChat:协议路由/关思考在里面)
      if (CFG.visionApi.key && CFG.chatApi.key && !S.speaking) {
        const b64 = await captureScreenSafe();
        const txt = await visionChat({
          text: '看这张屏幕截图，如果能看到正在播放的音乐(播放器窗口/歌名/歌词)，提取出来。只回JSON:{"seen":true或false,"song":"歌名或空串","lyric":"可见的一句歌词或空串"}',
          imageB64: b64, maxTokens: 120, label: 'lyric',
        });
        const v = JSON.parse((String(txt).match(/\{[\s\S]*\}/) || ['{}'])[0]);
        if (v.seen && v.song && v.song !== this.lastSong) {
          this.lastSong = v.song;
          chatLLM(`(你注意到用户正在听《${v.song}》${v.lyric ? `，飘来一句歌词:"${v.lyric}"` : ''}。随口对这首歌发表一句符合你性格的简短点评)`, { hideUser: true });
        }
      }
    } catch {}
    this.scheduleLyric();
  },
  stop() {
    cancelAnimationFrame(this.raf);
    clearInterval(this.appPoll);
    clearTimeout(this.lyricTimer); this.lyricTimer = null; // 听歌模式整个关掉才清点评倒计时
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.stopDance();
  },
};

