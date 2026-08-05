'use strict';
/* ================= 贴边收起 / 从边缘滑出 =================
 * 只做右边缘一侧(用户拍板:别支持乱七八糟的方向)。
 *
 * 跟多显示器跳屏的冲突,裁决依据是「桌宠所在这块屏的右边还有没有别的屏」:
 *   有  → 拖到右边缘 = 跳过去(老行为不变);
 *   没有 → 拖到右边缘 = 贴边收起。
 * 跟 macOS 把光标推过去的直觉一致,不用教用户第二套手势。左边那块屏想贴边,
 * 走悬浮按钮列里的「收起」按钮 —— 任何屏上都能手动收。
 *
 * 动画两档:
 *   包里有 dock_out/dock_in → 播它(尾帧/首帧是空白,人物自己滑出画外);
 *   没有 → 默认效果:整个人横向滑出屏幕外 + 淡出(纯 CSS)。
 * 收起后右边缘留一个半透明小把手,点一下滑回来。 */
const Dock = {
  docked: false,
  busy: false,
  hasRight: null,      // null=还没问过;true/false=右边有没有别的屏

  async probe() {
    try { this.hasRight = (await API.displayInfo?.())?.hasRight ?? null; }
    catch { this.hasRight = null; }
  },

  tab() { return document.getElementById('dock-tab'); },

  /* 让某条动画「画面的右边缘」正好压在屏幕右边缘上,返回 wrapper 该放的 left。
   * 不能拿 #pet 的右边当准星:雪碧图的画布比人物宽(待机右侧就空着 40 多个
   * 画布像素),再叠上 fit 的位移,人物会从离边缘几十像素的地方冒出来,
   * 看着不像"从屏幕外滑进来"(用户实测)。所以按这条动画实际画到画布上的
   * 矩形右端来算。 */
  edgeLeftFor(anim) {
    const w = $('pet-wrapper'), pet = $('pet');
    const wr = w.getBoundingClientRect(), pr = pet.getBoundingClientRect();
    const inset = pr.left - wr.left;              // #pet 在 wrapper 里的左偏移
    const m = Persona.active && Persona.has(anim) ? Persona.manifest[anim] : null;
    if (!m || !pr.width) return Math.round(window.innerWidth - (pr.right - wr.left));
    const base = Persona.baseCanvas();
    const k = pr.width / base.w;                  // 画布像素 → 屏幕像素
    const s2 = m.fit ? m.fit.s1 : 1;
    const x = m.fit ? m.fit.x1 : (m.dx || 0);
    // 画面右端相对 #pet 左边的距离。画超出画布的部分会被 canvas 裁掉,
    // 所以封顶在画布宽度上——否则会把裁掉的那截也算进去,反而贴过头
    const right = Math.min(x + m.fw * s2, base.w) * k;
    return Math.round(window.innerWidth - inset - right);
  },

  /* 把雪碧图画布的右边缘怼到屏幕右边缘。
   * 不能直接拿容器定位:容器比画布宽一圈(包形象下 #pet 是 left:50% 居中的,
   * 两侧各空 15px),再叠上 CSS 里 right:20px 的默认内缩,画布实际离屏幕边
   * 有三十几像素;贴边动画里人物是"走到画布右缘"消失的,于是看着像悬在半空
   * 出来(用户实测:离边缘还有几十像素)。这里按实测几何算,馒头本体和包形象
   * 都适用,不写死任何数字。 */
  snapToEdge() {
    const w = $('pet-wrapper'), p = $('pet');
    const wr = w.getBoundingClientRect(), pr = p.getBoundingClientRect();
    if (!pr.width) return;
    w.style.left = (wr.left + (window.innerWidth - pr.right)) + 'px';
    w.style.top = wr.top + 'px';
    w.style.right = 'auto';
    w.style.bottom = 'auto';
  },

  /* 有专属动画就播它,没有就退回 CSS 滑动。返回 {ms, anim, fps}(anim=null 表示走的 CSS) */
  playOrSlide(anim, slideClass) {
    const w = $('pet-wrapper');
    if (Persona.active && Persona.has(anim)) {
      const m = Persona.manifest[anim];
      const fps = Math.max(1, +m.fps);
      Player.play(anim, { loop: false, prio: PRIORITY.emo });
      return { ms: Math.round(m.frames / fps * 1000), anim, fps };
    }
    w.classList.toggle('docking', slideClass === 'out');
    return { ms: 340, anim: null, fps: 60 };   // 与 style.css 里 .docking 的 transition 对齐
  },

  /* 等这段过场走完。不能纯掐表:Player 播完非循环动画会自己回落 idle,
   * 一旦它先落地,屏幕上会闪出一整帧完整人物再被藏掉——用户实测"人飘出去了
   * 还在外面闪一下"。所以两头都盯:动画一被换掉就立刻返回;掐表兜底并提前
   * 两帧(dock_out 末尾本来就是空白帧,早收两帧看不出来)。 */
  waitPass({ ms, anim, fps }) {
    if (!anim) return new Promise((r) => setTimeout(r, ms));
    const deadline = performance.now() + Math.max(0, ms - 2000 / fps);
    return new Promise((res) => {
      const tick = () => {
        if (Player.cur?.name !== anim || performance.now() >= deadline) return res();
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  },

  async out(from) {
    if (this.docked || this.busy) return;
    this.busy = true;
    const w = $('pet-wrapper');
    // 收起时把展开的面板/气泡一起收掉,免得人没了框还飘在那
    document.querySelectorAll('.panel.show').forEach((p) => p.classList.remove('show'));
    $('hover-btns').classList.remove('show');
    $('todo-banner')?.classList.remove('show');
    this.snapToEdge();        // 先贴死右缘,人物才是从屏幕边上飘出去的
    /* 落位规矩(用户拍板):拖到边上触发的——就在当下这个位置播,一个像素都别动;
     * 点「收起」按钮触发的——人可能还在屏幕中间,先快速滑到右缘再播,
     * 否则人物会在原地凭空消失,不像"贴到边上去了"。 */
    if (from !== 'drag') {
      const target = this.edgeLeftFor('dock_out');
      let cur = parseFloat(w.style.left);
      if (!Number.isFinite(cur)) { cur = w.getBoundingClientRect().left; w.style.left = cur + 'px'; }
      w.style.right = 'auto';
      if (Math.abs(cur - target) > 8) {
        await new Promise((r) => requestAnimationFrame(r));
        w.style.transition = 'left 0.18s ease-out';
        w.style.left = target + 'px';
        await new Promise((r) => setTimeout(r, 200));
        w.style.transition = '';
      }
    }
    const pass = this.playOrSlide('dock_out', 'out');
    await this.waitPass(pass);
    w.style.visibility = 'hidden';
    // 顺手把雪碧图画布擦干净:不擦的话画布上留着 Player 回落 idle 时画的那一帧,
    // 下次滑出来的瞬间会先闪出一整个人物再被 dock_in 覆盖(用户实测"出来时闪现")
    Sprites.ctx?.clearRect(0, 0, Sprites.canvas.width, Sprites.canvas.height);
    w.classList.remove('docking');
    this.docked = true;
    this.busy = false;
    const t = this.tab();
    if (t) {
      // 把手竖直方向对齐收起前人物的位置,别每次都跳回屏幕正中
      const r = w.getBoundingClientRect();
      const petH = document.getElementById('pet').offsetHeight || 137;
      const mid = r.bottom - 14 - petH / 2;
      t.style.top = Math.max(40, Math.min(window.innerHeight - 80, mid)) + 'px';
      t.classList.add('show');
      refreshPassthrough();   // 把手可能正好冒在光标底下,不重算的话第一下点击会穿透
    }
    if (from === 'drag') S.lastActive = Date.now();
  },

  async in() {
    if (!this.docked || this.busy) return;
    this.busy = true;
    this.tab()?.classList.remove('show');
    refreshPassthrough();
    const w = $('pet-wrapper');
    w.classList.remove('docking');   // CSS 兜底那档的 translateX 得先撤,不然量出来的几何是偏的
    this.snapToEdge();               // 回来也贴死右缘,人物才是从屏幕边上飘进来的
    /* 先让 Player 切到 dock_in 再显形:反过来的话,显形那一刻画布上还是
     * idle 的帧,会"啪"地弹出一整个人物,而不是从画外滑进来 */
    const pass = this.playOrSlide('dock_in', 'in');
    if (pass.anim) {
      // Player 是按动画 fps 推帧的(12fps≈83ms),等两个 rAF 根本轮不到它画;
      // 先把首帧(空白)自己画上去,再显形 —— 否则显形那一刻画布还是空的/旧的
      await Sprites.preload(pass.anim);
      Sprites.draw(pass.anim, 0);
    }
    w.style.visibility = '';
    this.docked = false;
    this.busy = false;
  },

  toggle() { return this.docked ? this.in() : this.out('btn'); },

  init() {
    this.probe();
    const t = this.tab();
    if (t) t.addEventListener('click', () => this.in());
    document.getElementById('btn-dock')?.addEventListener('click', () => this.out('btn'));
  },
};
