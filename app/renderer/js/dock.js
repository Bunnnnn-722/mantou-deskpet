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
    const pass = this.playOrSlide('dock_out', 'out');
    await this.waitPass(pass);
    w.style.visibility = 'hidden';
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
    // 贴边收起是"滑到屏幕外"，回来时先把人物放回右边缘再滑进画面
    const petW = document.getElementById('pet').offsetWidth || 168;
    const r = w.getBoundingClientRect();
    if (r.right > window.innerWidth - 4) {
      w.style.left = (window.innerWidth - petW - 24) + 'px';
      w.style.right = 'auto';
    }
    /* 先让 Player 切到 dock_in 再显形:反过来的话,显形那一刻画布上还是
     * idle 的帧,会"啪"地弹出一整个人物,而不是从画外滑进来 */
    const pass = this.playOrSlide('dock_in', 'in');
    if (pass.anim) await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
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
