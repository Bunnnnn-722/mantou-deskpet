'use strict';
/* ================= 馒头本体:程序化渲染(眼睛 + 动作) ================= */
/* 眼睛系统:视线追鼠标(全窗口)、随机眨眼/单眼 wink、按动画名切换眼型。
 * 所有眼型变化都走 inline transform 逐帧合成，闭眼用慢速插值(入睡是"渐渐合眼") */
const Eyes = {
  els: [], gx: 0, gy: 0, syL: 1, syR: 1, sc: 1, blinking: false,
  winkEye: -1, winkAt: 0, tempMode: null, tempUntil: 0,
  init() {
    this.els = [document.getElementById('eyeL'), document.getElementById('eyeR')];
    document.addEventListener('mousemove', (e) => {
      const svg = document.getElementById('pet-svg');
      const r = svg.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
      const d = Math.hypot(dx, dy) || 1, max = 2.5;
      this.gx = Math.max(-max, Math.min(max, dx / d * max));
      this.gy = Math.max(-max, Math.min(max, dy / d * max));
    });
    const loop = () => { this.apply(); requestAnimationFrame(loop); };
    loop();
    const blink = () => {
      if (this.mode() === 'normal') {
        if (Math.random() < 0.2) this.wink();
        else { this.blinking = true; setTimeout(() => { this.blinking = false; }, 140); }
      }
      setTimeout(blink, 2500 + Math.random() * 4000);
    };
    setTimeout(blink, 1500);
  },
  wink() { this.winkEye = Math.floor(Math.random() * 2); this.winkAt = performance.now(); },
  temp(mode, ms) { this.tempMode = mode; this.tempUntil = performance.now() + ms; },
  mode() {
    if (this.tempMode && performance.now() < this.tempUntil) return this.tempMode;
    const n = Player.cur?.name;
    if (n === 'sleep' || n === 'sleep_in') return 'closed';
    if (n === 'emo_surprise') return 'wide';
    if (n === 'emo_speechless') return 'speechless'; // 一眼中等一眼扁(用户定稿)
    if (n === 'emo_blackline') return 'blackline';   // 双眼缩成细线
    // gloomy 不映射:进场用 Eyes.temp('gloomy', 3.2s)微放大+增亮,几秒后自动恢复
    if (n === 'emo_sad') return 'droop';
    if (n === 'egg_yawn') return 'squint';
    return 'normal';
  },
  apply() {
    const mode = this.mode();
    let tL = 1, tR = 1, ty = 0, wide = 1, glow = '';
    if (mode === 'closed') tL = tR = 0.06;
    else if (mode === 'halflid') tL = tR = 0.55;
    else if (mode === 'droop') { tL = tR = 0.72; ty = 1.5; }
    else if (mode === 'squint') tL = tR = 0.4;
    else if (mode === 'wide') wide = 1.3;
    else if (mode === 'speechless') { tL = 0.6; tR = 0.18; }  // 一眼中等一眼扁
    else if (mode === 'blackline') tL = tR = 0.13;            // 双眼细线
    else if (mode === 'gloomy') { wide = 1.12; glow = 'drop-shadow(0 0 7px rgba(255,255,255,0.85))'; }
    if (this.blinking) { tL = Math.min(tL, 0.06); tR = Math.min(tR, 0.06); }
    // 闭眼慢速收合(入睡感)，其余快速跟随;左右眼独立插值(speechless 是不对称眼)
    const k = mode === 'closed' ? 0.06 : 0.35;
    this.syL += (tL - this.syL) * k;
    this.syR += (tR - this.syR) * k;
    this.sc += (wide - this.sc) * 0.3; // 瞪大/复原都走平滑插值，不再瞬切
    // 眼睛自发光:睡熟(眼已闭拢)关掉,gloomy 增强,平时用样式表默认(.eye-n 带 filter 过渡)
    const f = (mode === 'closed' && Math.max(this.syL, this.syR) < 0.15) ? 'none' : glow;
    const gz = mode === 'closed' ? { x: 0, y: 0 } : { x: this.gx, y: this.gy };
    const winkActive = performance.now() - this.winkAt < 200;
    this.els.forEach((el, i) => {
      const s = (winkActive && i === this.winkEye) ? 0.06 : (i === 0 ? this.syL : this.syR);
      el.style.transform = `translate(${gz.x}px, ${gz.y + ty}px) scale(${this.sc}, ${s * this.sc})`;
      if (el.style.filter !== f) el.style.filter = f;
    });
    document.querySelectorAll('.eye-a').forEach((g) => { g.style.translate = `${gz.x}px ${gz.y}px`; });
  },
};

/* 动作渲染:动画名 → 进入效果(CSS 类爆发/粒子/眼型)，跳舞逐帧点头(锁相环驱动) */
const BUN = {
  pet: null, bob: null, _t: null,
  init() {
    this.pet = $('pet');
    this.bob = $('bun-bob');
    // 情绪配件注入(Figma 定稿抽取):本体/眼睛不动,只叠配件。
    // 阴影遮罩必须是 SVG 内部件:插在"轮廓发光之上、眼睛之下"——层序与定稿一致。
    // (曾试过垫在 #pet-svg 下的 div:盖不住右上角边缘光,真机穿帮)
    const svgNS = 'http://www.w3.org/2000/svg';
    const psvg = $('pet-svg');
    const grad = document.createElementNS(svgNS, 'linearGradient');
    grad.id = 'shadeGrad';
    grad.setAttribute('x1', '0'); grad.setAttribute('y1', '0');
    grad.setAttribute('x2', '0'); grad.setAttribute('y2', '1');
    const s1 = document.createElementNS(svgNS, 'stop');
    s1.setAttribute('offset', '0'); s1.setAttribute('stop-color', 'black');
    const s2 = document.createElementNS(svgNS, 'stop');
    s2.setAttribute('offset', '0.93'); s2.setAttribute('stop-color', 'black'); s2.setAttribute('stop-opacity', '0');
    grad.append(s1, s2);
    psvg.querySelector('defs').appendChild(grad);
    const shade = document.createElementNS(svgNS, 'path');
    shade.id = 'ov-shade';
    shade.setAttribute('d', $('bun-outline').getAttribute('d')); // 身体轮廓原样裁形
    shade.setAttribute('fill', 'url(#shadeGrad)');
    shade.style.display = 'none';
    psvg.insertBefore(shade, $('eyeL'));
    for (const [id, svg] of [['ov-bllines', EMO_PARTS.bl_lines], ['ov-spdrop', EMO_PARTS.sp_drop]]) {
      const d = document.createElement('div');
      d.className = 'emo-ov';
      d.id = id;
      d.style.display = 'none';
      d.innerHTML = svg;
      this.bob.appendChild(d);
    }
    Eyes.init();
  },
  /* 情绪配件切换:display 翻转会重启配件的 CSS 入场/生命周期动画。
   * 包形象激活时不叠(本体已隐藏,兜底走容器动作+CSS 汗滴) */
  parts(name) {
    const t = !Persona.active ? name : null;
    const isBl = t === 'emo_blackline', isGl = t === 'emo_gloomy';
    const shade = $('ov-shade');
    shade.classList.toggle('bl', isBl);
    shade.classList.toggle('gl', isGl);
    shade.style.display = isBl || isGl ? 'block' : 'none';
    $('ov-bllines').style.display = isBl ? 'block' : 'none';
    $('ov-spdrop').style.display = t === 'emo_speechless' ? 'block' : 'none';
  },
  burst(cls, ms) {
    const ALL = ['anim-appear', 'anim-bounce', 'anim-surprise', 'anim-shake',
                 'anim-happy', 'anim-yawn', 'anim-sag', 'anim-sway', 'anim-blbob'];
    this.pet.classList.remove(...ALL);
    void this.pet.offsetWidth;
    this.pet.classList.add(cls);
    clearTimeout(this._t);
    this._t = setTimeout(() => this.pet.classList.remove(cls), ms);
  },
  sparks(n, glyphs = ['✦', '✧', '･']) {
    for (let i = 0; i < n; i++) {
      setTimeout(() => {
        const s = document.createElement('span');
        s.className = 'spark';
        s.textContent = glyphs[i % glyphs.length];
        s.style.left = (30 + Math.random() * 110) + 'px';
        s.style.top = (2 + Math.random() * 16) + 'px';
        s.style.fontSize = (10 + Math.random() * 8) + 'px';
        this.pet.appendChild(s);
        setTimeout(() => s.remove(), 1200);
      }, i * 130);
    }
  },
  spawnDrop(kind) {
    const s = document.createElement('span');
    s.className = 'drop ' + kind;
    if (Persona.active) {
      // 包形象(兜底路径):按容器比例定位，脸大约在上 1/3(各家立绘差不多)
      if (kind === 'tear') { s.style.left = '58%'; s.style.top = '30%'; }
      else { s.style.left = '63%'; s.style.top = '12%'; }
    } else if (kind === 'tear') { s.style.left = '95px'; s.style.top = '80px'; }  // 右眼再右移半个眼珠
    else { s.style.left = '110px'; s.style.top = '18px'; }                        // 脑门再右移半个眼珠
    this.pet.appendChild(s);
    setTimeout(() => s.remove(), kind === 'tear' ? 3300 : 3500);
  },
  enter(name) {
    // name=null = 只清码绘状态(包形象接管画面，码绘休眠);touch_* 在包形象下
    // 只播包内动画——包没配的点击不再弹跳兜底(2026-07-28 用户口径:没有就没反应,
    // 正常点击已在 state-ui 门控拦下,这里兜住其余调用路径)
    if (name == null || (Persona.active && name && name.startsWith('touch_'))) {
      this.pet.classList.remove('angry', 'saddroop');
      this.parts(null);
      return;
    }
    // 包形象缺槽位:兜底只保留粒子(泪滴/汗珠/星星)，容器 burst 一律不做——
    // 角色定格时整体弹跳/下沉很出戏(用户拍板:能接受粒子，不能接受抖)
    if (Persona.active) {
      switch (name) {
        case 'emo_happy': this.sparks(6); break;
        case 'emo_sad': this.spawnDrop('tear'); break;
        case 'emo_blackline':
        case 'emo_speechless': this.spawnDrop('sweat'); break;
        case 'egg_frost': this.sparks(10, ['❄', '✦', '❅']); break;
      }
      return;
    }
    // 生气=横条眼;难过=垂眼半圆;黑线/低气压/无语=眼型变化+定稿配件叠加(parts)
    this.parts(name);
    this.pet.classList.toggle('angry', name === 'emo_angry');
    this.pet.classList.toggle('saddroop', name === 'emo_sad');
    switch (name) {
      case 'appear': this.burst('anim-appear', 1650); break;
      // 点击 = 原地一惊 + 眼睛平滑瞪大(用户定稿:比弹跳好);头/身不区分
      case 'touch_head':
      case 'touch_body': this.burst('anim-surprise', 780); Eyes.temp('wide', 780); break;
      case 'emo_surprise': this.burst('anim-surprise', 780); break;  // 惊讶=独立表情，眼睛瞪大由 Eyes.mode 保持
      case 'emo_happy': this.burst('anim-happy', 1400); this.sparks(6); break;
      case 'emo_angry': this.burst('anim-shake', 570); break;
      // 被雷到:双眼缩线+黑线与阴影浮现(约3秒后同步消失)+身体轻微上下弹动
      case 'emo_blackline': this.burst('anim-blbob', 2600); if (Persona.active) this.spawnDrop('sweat'); break;
      case 'emo_sad': this.burst('anim-sag', 920); this.spawnDrop('tear'); break;
      // 低气压:沉一下;眼微放大+自发光增强(3.2s 后自动恢复),阴影同步浮现又散去
      case 'emo_gloomy': this.burst('anim-sag', 920); Eyes.temp('gloomy', 3200); break;
      // 无语:小蔫;一眼中等一眼扁+定稿位置大汗滴(滑入→停留→滑落消失)
      case 'emo_speechless': this.burst('anim-sag', 760); if (Persona.active) this.spawnDrop('sweat'); break;
      case 'egg_yawn': this.burst('anim-yawn', 2260); break;
      case 'egg_frost': this.sparks(10, ['❄', '✦', '❅']); break;
      case 'egg_breeze': this.burst('anim-sway', 2440); break;
    }
  },
  render(name, frame, acc) {
    if (Persona.active) { // 包形象:码绘渲染休眠(跳舞的缩放也停，雪碧图自带律动)
      if (this.bob.style.transform) this.bob.style.transform = '';
      return;
    }
    if (name === 'dance_nod') {
      // 跳舞 = 上下拉长压扁(不左右晃);相位由 Player.frame 决定，Music 锁相环变速直接生效
      const m = Player.manifest.dance_nod;
      const nods = Math.max(1, Math.round((CFG.danceBpm || 89) / 60 * (m.frames / m.fps)));
      const period = m.frames / nods;
      const pos = (frame + acc / (1000 / m.fps)) % period;
      const s = Math.sin(2 * Math.PI * (pos / period)); // 一拍内:拉长→压扁→回
      const sy = 1 + s * 0.075, sx = 1 / sy;            // 体积守恒(幅度调小)
      this.bob.style.transformOrigin = 'center bottom';
      this.bob.style.transform = `scale(${sx.toFixed(3)}, ${sy.toFixed(3)})`;
    } else if (this.bob.style.transform) {
      this.bob.style.transform = '';
    }
  },
};

