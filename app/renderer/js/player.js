'use strict';
/* ================= 动画播放器 ================= */
const PRIORITY = { touch: 5, emo: 4, dance: 3, egg: 2, idle: 1 };

/* 馒头版播放器:零素材，程序化渲染。与前身版本同 API(play/backToIdle/
 * playAtLoopEnd/cur/manifest/frame/acc/rate)，业务逻辑一行不用改。
 * manifest 只声明"逻辑帧网格"(帧数/fps):决定一次性动画的时长、
 * playAtLoopEnd 的循环切点、跳舞锁相环的相位计算 */
const Player = {
  manifest: {
    idle: { frames: 24, fps: 12 }, appear: { frames: 20, fps: 12 },
    touch_head: { frames: 8, fps: 12 }, touch_body: { frames: 9, fps: 12 },
    emo_happy: { frames: 24, fps: 12 }, emo_surprise: { frames: 24, fps: 12 }, emo_angry: { frames: 24, fps: 12 },
    emo_sad: { frames: 24, fps: 12 }, emo_speechless: { frames: 24, fps: 12 },
    emo_gloomy: { frames: 24, fps: 12 }, emo_blackline: { frames: 24, fps: 12 },
    egg_yawn: { frames: 50, fps: 12 },  // ≈4.2s:催睡台词在哈欠 4.3s 后出，节奏与前身版本对齐
    egg_frost: { frames: 36, fps: 12 }, egg_breeze: { frames: 30, fps: 12 },
    dance_nod: { frames: 24, fps: 12 },
    sleep_in: { frames: 18, fps: 12 }, sleep: { frames: 24, fps: 12 }, sleep_out: { frames: 12, fps: 12 },
  },
  images: {}, cur: null, frame: 0, acc: 0, lastT: 0, rate: 1, pending: null,
  lastZ: 0, lastNote: 0,

  async init() {
    Sprites.init();
    await Persona.refresh();                       // 有激活包就先把它装上
    BUN.init();
    // 包形象由用户主动切换而来，浮现动画只有在包显式传了 appear 才播
    if (!Persona.active || Persona.has('appear'))
      this.play('appear', { prio: PRIORITY.touch }); // 单次，播完自动回待机
    requestAnimationFrame((t) => this.tick(t));
  },
  /* prio 高的可打断低的;同 prio 不打断。播完非 loop 自动回 idle */
  play(name, { loop = false, prio = 1, rate = 1, onEnd = null } = {}) {
    // 兜底回 idle:码绘 manifest 没有且激活包也没有，才算未知槽位
    // (包可以带馒头没有的槽位，如 touch_hand，不能被错误重定向)
    if (!this.manifest[name] && !(Persona.active && Persona.has(name))) name = 'idle';
    if (this.cur && prio < this.cur.prio && !this.cur.finished) return false;
    this.cur = { name, loop, prio, finished: false, onEnd };
    this.frame = 0; this.acc = 0; this.rate = rate;
    this._enter(name);
    return true;
  },
  /* 槽位路由:包里有该动画→雪碧图(含 touch_*，包传了就播包的);
   * 包没传的槽位→BUN.enter 只出粒子(泪滴/汗珠/星星，不做容器弹跳——定格
   * 角色整体抖动出戏，用户拍板)，码绘本体不渲染——tick 渲染分支只在
   * !Persona.active 时才画 BUN，角色不会中途闪回码绘馒头 */
  _enter(name) {
    if (Persona.active && Persona.has(name)) {
      Sprites.preload(name); // 懒加载:第一次播时才解码这张雪碧图
      BUN.enter(null);       // 清掉码绘残留类(angry/saddroop)，但不播码绘动作
    } else {
      BUN.enter(name);
    }
  },
  /* 优雅归位:循环动画不从半截硬切(5秒的怒容播一半跳回待机首帧=肉眼闪跳),
   * 标记 endAtLoop 让 tick 在循环边界退出——素材尾帧≈待机首帧,无缝。
   * 非循环/已停机才立即归位。说话收尾定时器/看门狗/[emo:neutral] 都走这里 */
  requestIdle() {
    const c = this.cur;
    if (c && c.loop && !c.finished && c.name !== 'idle' && this.frame > 0) {
      c.endAtLoop = true;
      return;
    }
    this.backToIdle();
  },
  backToIdle() {
    // 睡眠=状态动画不是停机:睡着时"归位"回睡觉循环而不是清醒待机
    // (否则屏检点评/聊天播完表情把睡颜切成待机，状态和画面脱节)
    if (typeof S !== 'undefined' && S.sleeping && this.manifest['sleep']) {
      this.play('sleep', { loop: true, prio: PRIORITY.egg });
      return;
    }
    this.cur = { name: 'idle', loop: true, prio: PRIORITY.idle, finished: false };
    this.frame = 0; this.acc = 0; this.rate = 1;
    this._enter('idle');
  },
  /* 等当前循环回到首帧再切换，用于自动触发的彩蛋，避免打断感 */
  playAtLoopEnd(name, opts) {
    this.pending = { name, opts };
    setTimeout(() => { // 兜底:6s 内没等到循环点就直接切
      if (this.pending?.name === name) { this.pending = null; this.play(name, opts); }
    }, 6000);
  },
  tick(t) {
    const dt = this.lastT ? t - this.lastT : 16;
    this.lastT = t;
    const curName = this.cur?.name;
    // 激活包时:manifest 用包的帧网格(时长/fps 以素材为准，不再用码绘逻辑帧)
    const useSprite = Persona.active && Persona.has(curName);
    const m = useSprite ? Persona.manifest[curName] : this.manifest[curName];
    if (m) {
      this.acc += dt * this.rate;
      const frameMs = 1000 / m.fps;
      while (this.acc >= frameMs) {
        this.acc -= frameMs;
        this.frame++;
        if (this.frame >= m.frames) {
          if (this.pending) { // 循环点是无缝切换窗口
            const p = this.pending; this.pending = null;
            this.play(p.name, p.opts); break;
          }
          if (this.cur.endAtLoop) { // requestIdle 的优雅归位:循环边界收尾
            this.cur.finished = true;
            this.backToIdle();
            break;
          }
          // 情绪循环的自然退出点:一轮播完时说话已结束且气泡已收 → 回待机。
          // 情绪只在"说话/气泡在场"期间保持,不靠看门狗掐表(那会多播一两轮才救,难看)
          if (this.cur.loop && this.cur.prio === PRIORITY.emo &&
              typeof S !== 'undefined' && !S.speaking &&
              !document.getElementById('bubble').classList.contains('show')) {
            this.cur.finished = true;
            this.backToIdle();
            break;
          }
          if (this.cur.loop) this.frame = 0;
          else {
            // 播完:有 onEnd 回调(如入睡过渡→睡觉循环)则让它接管;没接管才回待机
            this.cur.finished = true;
            const cb = this.cur.onEnd;
            this.cur.onEnd = null;
            if (cb) cb();
            if (this.cur.finished) this.backToIdle();
            break;
          }
        }
      }
      // 渲染:必须用"此刻"的动画名——上面推帧循环里可能刚发生 播完→backToIdle
      // 切换，沿用 tick 开头抓的 curName 会把上一动画的第 0 帧(如 appear 的
      // 透明首帧)画出来一帧，肉眼可见闪一下(前身版本出场→待机交界实测)
      const nowName = this.cur?.name;
      const nowSprite = Persona.active && Persona.has(nowName);
      if (nowSprite) {
        if (Sprites.ready(nowName)) Sprites.draw(nowName, this.frame);
      } else if (!Persona.active) {
        BUN.render(nowName, this.frame, this.acc);
      }
      // 包形象播 touch_*:雪碧图不会动，但给个码绘小弹跳当"被戳到"的反馈
      // (BUN.burst 作用在 #pet 容器上，雪碧图 canvas 在容器里，一起弹)
      // 音符特效:只在"真的在跳舞"时冒
      if (typeof Music !== 'undefined' && Music.dancing && this.cur?.name === 'dance_nod' &&
          t - this.lastNote > 640 / (this.rate || 1)) {
        this.lastNote = t;
        Notes.spawn();
      }
      // 睡觉时冒 z
      if (this.cur?.name === 'sleep' && t - this.lastZ > 1500) {
        this.lastZ = t;
        Notes.spawn('z');
      }
    }
    requestAnimationFrame((tt) => this.tick(tt));
  },
};

/* 兜底看门狗:循环中的情绪动画本该由"说话结束"的定时器收尾,但任何路径
 * (断流/异常/竞态)漏掉 backToIdle 都会永久卡在循环里(实测:一直叹气)。
 * 规则:没人说话 + 情绪循环滞留 ≥6s → 强制归位待机;正常流程的收尾定时器
 * 都在 2.4s 内触发,看门狗只接漏网的 */
let _emoStuckTicks = 0;
setInterval(() => {
  if (typeof S === 'undefined') return;
  // speaking 卡死自愈:说话标志立着但打字机心跳断了 >10s = 引擎已死,
  // 放着不管会同时瘫掉情绪看门狗和所有 sayLocal/锐评(它们开头都查 speaking)
  if (S.speaking && Date.now() - (S.speechBeat || 0) > 10000) {
    S.speaking = false;
    hideBubble();
    Player.backToIdle();
    return;
  }
  if (Player.cur?.loop && Player.cur.prio === PRIORITY.emo && !S.speaking) {
    _emoStuckTicks++;
    // 两段制:先请求循环边界优雅收尾(≤一圈时长,无缝);推帧引擎死透
    // 等不到循环点时(≥12s)才硬切——闪跳只留给真出事的场合
    if (_emoStuckTicks === 2) Player.requestIdle();
    else if (_emoStuckTicks >= 6) { _emoStuckTicks = 0; Player.backToIdle(); }
  } else _emoStuckTicks = 0;
}, 2000);

