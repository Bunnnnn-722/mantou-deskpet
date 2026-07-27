'use strict';
/* ---- 全屏特效:寒潮(桌宠"施法"——摸鱼被抓/被惹毛/模型主动 [fx:frost]) ---- */
const FX = {
  canvas: null, ctx: null, parts: [], running: false, lastCast: 0,
  clip: null, clips: {}, fxman: null,
  init() {
    this.canvas = $('fx-layer');
    this.ctx = this.canvas.getContext('2d');
    const fit = () => { this.canvas.width = window.innerWidth; this.canvas.height = window.innerHeight; };
    fit();
    window.addEventListener('resize', fit);
  },
  /* 形象切换:特效片段/包网格缓存全清(不占内存;播到一半的画面也停) */
  resetPackClips() {
    this.clips = {}; this.clip = null; this._packFxMan = null;
    if (this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  },
  /* -- 全屏特效片段:激活包带 fx_<名字>.webp 就用包里的，没有才码绘寒潮兜底 -- */
  async playClip(name) {
    let m = null, base = null;
    if (Persona.active) {
      const url = await API.personaFile(Persona.active.id, `fx_${name}.webp`);
      if (url) {
        m = await this._packFxMeta(name);   // 网格参数读包内置/素材管线同构默认值
        base = { webp: url, mp4: await API.personaFile(Persona.active.id, `fx_${name}.mp4`) };
      }
    }
    if (!m) { // 馒头 或 包没这个特效 → 调用方会落回 frost，这里直接返回
      return false;
    }
    if (!this.clips[name]) {
      const img = new Image();
      img.src = base.webp;
      await img.decode().catch(() => {});
      this.clips[name] = img;
    }
    // 即梦自带音效:直接播原 mp4 的音轨(比合成音真实得多);没有音轨才用合成风声
    let audio = null;
    if (base.mp4) {
      audio = new Audio(base.mp4);
      audio.volume = 0.85;
      audio.play().catch(() => {});
    } else this.sndWind(2.6);
    if (this.releaseTimers?.[name]) clearTimeout(this.releaseTimers[name]);
    this.clip = { m, img: this.clips[name], start: performance.now(), audio, name };
    if (!this.running) { this.running = true; requestAnimationFrame((t) => this.tick(t)); }
    return true;
  },
  /* 包内 fx 雪碧图的网格参数:素材管线产物统一 49帧/7列/1280×720，先读包里的
   * fx_manifest.json(可选)，没有就用这套默认值 */
  async _packFxMeta(name) {
    if (!this._packFxMan) {
      this._packFxMan = {};
      const url = await API.personaFile(Persona.active.id, 'fx_manifest.json');
      if (url) {
        try { this._packFxMan = await (await fetch(url, { cache: 'no-store' })).json(); }
        catch { /* 没有就用默认 */ }
      }
    }
    return this._packFxMan[name]
      || { frames: 49, cols: 7, fw: 1280, fh: 720, fps: 12.074688796680498 };
  },
  /* 当前形象可用的特效名列表(提示词注入用) */
  available() {
    return Persona.active ? (Persona.active.fx || []) : ['frost'];
  },
  /* 风啸(合成，无素材):黑底风雪片段的听觉一半 */
  sndWind(sec = 2.6) {
    try {
      const t = audioCtx.currentTime;
      const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * sec, audioCtx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const n = audioCtx.createBufferSource(); n.buffer = buf;
      const f = audioCtx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.2;
      f.frequency.setValueAtTime(300, t);
      f.frequency.linearRampToValueAtTime(900, t + sec * 0.4);
      f.frequency.linearRampToValueAtTime(250, t + sec);
      const g = audioCtx.createGain();
      g.gain.setValueAtTime(0.001, t);
      g.gain.exponentialRampToValueAtTime(0.4, t + sec * 0.3);
      g.gain.exponentialRampToValueAtTime(0.001, t + sec);
      n.connect(f).connect(g).connect(audioCtx.destination);
      n.start(t);
    } catch { /* 音频不可用不挡特效 */ }
  },
  /* 法术书:包里有的特效→全屏片段;包没有(或馒头)→码绘寒潮兜底。
   * 冷却共享;[fx:名字] 标签与业务调用点(抓摸鱼/连戳)不用改 */
  async cast(name) {
    if (Date.now() - this.lastCast < 8000) return;
    this.lastCast = Date.now();
    if (await this.playClip(name)) return;
    this.lastCast = 0; // 没播成，不占冷却
    this.frost();
  },
  /* 旧调用点兼容:blizzard/shockwave/freeze 统一走 cast，自动按包路由 */
  blizzard() { this.cast('blizzard'); },
  shockwave() { this.cast('shockwave'); },
  freeze() { this.cast('freeze'); },
  frost() {
    if (this._frostAt && Date.now() - this._frostAt < 8000) return; // 施法冷却，防连刷
    this._frostAt = Date.now();
    const tint = $('fx-tint');
    tint.classList.remove('frost'); void tint.offsetWidth; tint.classList.add('frost');
    // 冰晶从四边射入屏幕，减速、旋转、消散
    const W = this.canvas.width, H = this.canvas.height;
    for (let i = 0; i < 110; i++) {
      const edge = i % 4, sp = 5 + Math.random() * 9;
      let x, y, vx, vy;
      if (edge === 0) { x = Math.random() * W; y = -20; vx = (Math.random() - 0.5) * 3; vy = sp; }
      else if (edge === 1) { x = Math.random() * W; y = H + 20; vx = (Math.random() - 0.5) * 3; vy = -sp; }
      else if (edge === 2) { x = -20; y = Math.random() * H; vx = sp; vy = (Math.random() - 0.5) * 3; }
      else { x = W + 20; y = Math.random() * H; vx = -sp; vy = (Math.random() - 0.5) * 3; }
      this.parts.push({
        x, y, vx, vy, born: performance.now(),
        life: 1100 + Math.random() * 1100,
        s: 9 + Math.random() * 16,
        rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.12,
        g: ['❄', '❅', '✦'][Math.floor(Math.random() * 3)],
      });
    }
    if (!this.running) { this.running = true; requestAnimationFrame((t) => this.tick(t)); }
  },
  tick(now) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // AI 特效片段:按 cover 撑满全屏(超出裁掉，不变形)
    if (this.clip) {
      const { m, img, start, audio, name } = this.clip;
      const f = Math.floor((now - start) / 1000 * m.fps);
      if (f >= m.frames || !img.width) {
        // 画面播完:音频快速淡出收尾(音轨可能比包络后的画面略长)
        if (audio) {
          const fade = setInterval(() => {
            audio.volume = Math.max(0, audio.volume - 0.12);
            if (audio.volume <= 0) { audio.pause(); clearInterval(fade); }
          }, 60);
        }
        // 特效雪碧图解码后高达 ~181MB/条:播完 30 秒无复用就释放引用，
        // 让内存可回收;冷却期内再施法则取消释放
        this.releaseTimers = this.releaseTimers || {};
        this.releaseTimers[name] = setTimeout(() => { delete this.clips[name]; }, 30000);
        this.clip = null;
      } else {
        const col = f % m.cols, row = Math.floor(f / m.cols);
        const W = this.canvas.width, H = this.canvas.height;
        const s = Math.max(W / m.fw, H / m.fh);
        const dw = m.fw * s, dh = m.fh * s;
        ctx.drawImage(img, col * m.fw, row * m.fh, m.fw, m.fh,
          (W - dw) / 2, (H - dh) / 2, dw, dh);
      }
    }
    this.parts = this.parts.filter((p) => now - p.born < p.life);
    for (const p of this.parts) {
      const t = (now - p.born) / p.life;
      p.x += p.vx; p.y += p.vy;
      p.vx *= 0.985; p.vy *= 0.985; // 冲入后减速悬停
      p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.globalAlpha = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
      ctx.font = `${p.s}px sans-serif`;
      ctx.fillStyle = '#eaf6ff';
      ctx.shadowColor = 'rgba(150,215,255,0.95)';
      ctx.shadowBlur = 8;
      ctx.textAlign = 'center';
      ctx.fillText(p.g, 0, 0);
      ctx.restore();
    }
    if (this.parts.length || this.clip) requestAnimationFrame((t) => this.tick(t));
    else { this.running = false; ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); }
  },
};

/* ---- 音符/z 特效层(DOM 飘浮字符，CSS 自驱动画) ---- */
const Notes = {
  spawn(glyph) {
    const pet = document.getElementById('pet');
    if (!pet) return;
    const s = document.createElement('span');
    s.className = 'float-note';
    s.textContent = glyph || ['♪', '♫', '♩'][Math.floor(Math.random() * 3)];
    s.style.left = (30 + Math.random() * 110) + 'px';
    s.style.top = (glyph === 'z' ? 20 + Math.random() * 10 : 4 + Math.random() * 18) + 'px';
    s.style.fontSize = (13 + Math.random() * 8) + 'px';
    pet.appendChild(s);
    setTimeout(() => s.remove(), 2600);
  },
};

