'use strict';
/* ================= 角色包(persona)形象系统 =================
 * 包 = userData/personas/<id>/{persona.json, manifest.json, <槽位>.webp, fx_*.webp/mp4}
 * 激活后:码绘馒头(#pet-body / #pet-svg)隐藏，雪碧图 canvas(#pet-sprite)顶位;
 * 动画槽位路由:包里有的→雪碧图;包里没的→不画码绘本体(角色定格在当前帧,
 * 仅粒子兜底:泪滴/汗珠/星星,无容器弹跳,不会闪回码绘馒头);特效同理走包优先。
 * 同时只有一个形象生效，切换时全量释放上一形象的图片/音频引用。 */
/* 功能→依赖动画映射(动画能力门控):形象包缺依赖动画时,对应功能开关
 * 置灰、运行时静默跳过。sleep_in/out 过渡不列为硬依赖:behavior 已有
 * "无过渡素材直接入睡/醒"的兜底,只差过渡不至于禁掉整个功能 */
const FEATURE_ANIMS = {
  nightSleep: ['sleep'],
  musicMode: ['dance_nod'],
};
const Persona = {
  active: null,      // { id, name, emoAliases } 当前激活包，null=馒头
  manifest: null,    // 包的动画 map(槽位 → 帧网格/锚点)
  /* 只刷新 persona.json 元数据(emoDesc/emoAliases/displayHeight 后台改完热应用),
   * 不动已解码的雪碧图;重排容器让尺寸类字段立即生效 */
  async reloadMeta() {
    if (!this.active) return;
    const data = await API.personaManifest(this.active.id);
    if (data) { this.active = { id: this.active.id, ...data.persona }; this.manifest = data.manifest; }
    Sprites.apply();
  },
  async refresh() {
    const fresh = await API.getConfig();          // 总是以磁盘为准(CFG 可能是旧快照)
    const id = fresh?.activePersona || null;
    if ((this.active?.id || null) === id) { Sprites.apply(); return; } // 没变:仍要 apply(码绘本体初始隐藏，首次必须由这里点亮)
    this.unload();
    if (!id) { Sprites.apply(); return; }         // 切回馒头
    const data = await API.personaManifest(id);
    if (!data) { // 包被删了/损坏:回落馒头
      this.active = null; this.manifest = null;
      Sprites.apply(); return;
    }
    this.active = { id, ...data.persona };
    this.manifest = data.manifest;
    // 关键动画全预载完再让 Player 决定播什么:否则 appear/idle 还没解码，
    // 空窗期会闪出码绘馒头(用户实测差评)
    const KEY = ['appear', 'idle', 'sleep', 'sleep_in', 'sleep_out', 'dance_nod'];
    await Promise.all(KEY.filter((k) => this.has(k)).map((k) => Sprites.preload(k)));
    Sprites.apply();
  },
  unload() {
    Sprites.releaseAll();
    this.active = null; this.manifest = null;
  },
  has(anim) { return !!(this.manifest && this.manifest[anim]); },
  // 彩蛋禁用(包 persona.json 可带 disabledEggs):禁的不进待机彩蛋池、
  // 催睡不点名。只对 egg_ 槽位生效——功能路由槽位禁了动画就播不出来
  eggEnabled(k) { return !(this.active?.disabledEggs || []).includes(k); },
  // 功能门控:该功能缺哪些依赖动画(码绘馒头本体动画全,永远返回空)
  featureMissing(feature) {
    if (!this.active) return [];
    return (FEATURE_ANIMS[feature] || []).filter((a) => !this.has(a));
  },
  canFeature(feature) { return !this.featureMissing(feature).length; },
  /* 当前形象的 { petName, customPersonality } 绑定(人设/名字跟形象包走)。
   * mantou 本体没有绑定时回退旧全局字段——迁移前的老配置也能读对 */
  binding() {
    const key = this.active?.id || 'mantou';
    const b = (CFG.personaBindings || {})[key];
    if (b) return b;
    return key === 'mantou'
      ? { petName: CFG.petName, customPersonality: CFG.customPersonality } : {};
  },
  // 当前形象的名字:绑定里存的 → 包作者起的名 → 旧全局 petName
  petName() { return this.binding().petName || this.active?.name || CFG.petName || '馒馒'; },
  // emo 标签 → 包内实际动画;包没有该 emo 时查别名表(如 surprise→touch_head)
  emoAnim(emo) {
    const direct = 'emo_' + emo;
    if (this.has(direct)) return direct;
    const alias = this.active?.emoAliases?.[emo];
    if (alias && this.has(alias)) return alias;
    return null;
  },
  /* 命中区(包格式 v1.1):persona.json 可带 hitZones =
   * { zones: [{anim, part, x0,y0,x1,y1}, …], fallback: {anim, part} }
   * 坐标 = 待机帧内百分比(与生产线标注器同一约定)。zones 按序判定,
   * 小框放前面(手在头框内侧的场景);都不中用 fallback。
   * 返回 {anim, part},包没配命中区返回 null(调用方走旧默认)。 */
  hitZone(px, py, rect) {
    const hz = this.active?.hitZones;
    const m = this.manifest?.idle;
    if (!hz?.zones?.length || !m) return null;
    const fx = (px * m.canvasW / rect.width - (m.dx || 0)) / m.fw;
    const fy = (py * m.canvasH / rect.height - (m.dy || 0)) / m.fh;
    for (const z of hz.zones) {
      if (this.has(z.anim) && fx >= z.x0 && fx <= z.x1 && fy >= z.y0 && fy <= z.y1)
        return { anim: z.anim, part: z.part || '身体' };
    }
    const fb = hz.fallback;
    if (fb && this.has(fb.anim)) return { anim: fb.anim, part: fb.part || '身体' };
    return null;
  },
};

/* 包形象下戳它:包传了 touch_* 就播包的，没有才容器弹跳兜底 */

const Sprites = {
  canvas: null, ctx: null, images: {}, decoding: {},
  init() {
    this.canvas = $('pet-sprite');
    this.ctx = this.canvas.getContext('2d');
  },
  /* 按当前 Persona 状态切换 码绘馒头 ↔ 雪碧图画布。
   * 包形象高度:包可声明 displayHeight(px，默认 360=前身版本视觉大小),
   * 容器/wrapper 跟着拉，630p 公共画布等比缩放，分辨率不动 */
  apply() {
    const on = !!Persona.active;
    const wrap = $('pet-wrapper');
    wrap.classList.toggle('persona-on', on);
    const pet = $('pet');
    if (on) {
      const h = Persona.active.displayHeight || 360;
      const cw = Persona.manifest?.idle?.canvasW || 472;
      const ch = Persona.manifest?.idle?.canvasH || 630;
      pet.style.height = h + 'px';
      pet.style.width = Math.round(h * cw / ch) + 'px';
      wrap.style.height = (h + 200) + 'px'; // 头顶留给气泡/待办横条
      wrap.style.width = (Math.round(h * cw / ch) + 30) + 'px';
      wrap.style.setProperty('--pet-h', h + 'px'); // 悬浮按钮列锚定角色视觉中心用
    } else {
      pet.style.height = ''; pet.style.width = '';
      wrap.style.height = ''; wrap.style.width = '';
      wrap.style.removeProperty('--pet-h');
    }
    this.canvas.style.display = on ? 'block' : 'none';
    $('pet-body').style.display = on ? 'none' : '';
    $('pet-svg').style.display = on ? 'none' : '';
    // 投影只给码绘馒头:包形象立绘常带自光影,再叠地面椭圆影很脏(用户拍板 2026-07-25 去掉)
    $('pet-shadow').style.display = on ? 'none' : '';
    // 包形象没有码绘呼吸/挤压，但保留影随动:影子留着，呼吸停掉(雪碧图自带动)
    $('pet-body').style.animationPlayState = on ? 'paused' : '';
    if (!on) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  },
  async preload(name) {
    if (this.images[name] || this.decoding[name] || !Persona.has(name)) return;
    this.decoding[name] = (async () => {
      const url = await API.personaFile(Persona.active.id, name + '.webp');
      if (!url) return;
      const img = new Image();
      img.src = url;
      await img.decode().catch(() => {});
      if (img.width) this.images[name] = img;
    })();
    await this.decoding[name];
    delete this.decoding[name];
  },
  releaseAll() {
    this.images = {}; this.decoding = {};
    if (this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    FX.resetPackClips(); // 形象的特效片段也一起释放(雪碧图解码后单条可达 ~180MB)
  },
  /* 逐帧绘制:manifest 的 dx/dy 把每帧对齐回公共画布(素材管线同款锚点)。
   * 可选 fit={s0,s1,x0,x1,y0,y1}:首末帧线性插值的缩放+落点校正——
   * 治"素材批次间人物尺寸漂移"(实测睡觉链比待机大 3.2%,入睡渐涨):
   * 过渡段渐变、循环段恒定,边界零跳变,呼吸等帧内形变原样保留 */
  draw(name, frame) {
    const m = Persona.manifest?.[name];
    const img = this.images[name];
    if (!m || !img) return;
    const { cols, fw, fh, dx = 0, dy = 0, canvasW, canvasH, fit } = m;
    if (this.canvas.width !== canvasW) { this.canvas.width = canvasW; this.canvas.height = canvasH; }
    const col = frame % cols, row = Math.floor(frame / cols);
    this.ctx.clearRect(0, 0, canvasW, canvasH);
    // 可选 tone={b0,b1,sa0,sa1}:同一套首末帧插值做色彩校正(亮度/饱和度)——
    // 素材批次偏色同款病(睡觉链偏暗 8%/过饱和 58%);乘法校正,红宝石等本色同步还原
    const k = m.frames > 1 ? frame / (m.frames - 1) : 0;
    const tn = m.tone;
    this.ctx.filter = tn
      ? `brightness(${(tn.b0 + (tn.b1 - tn.b0) * k).toFixed(3)}) saturate(${(tn.sa0 + (tn.sa1 - tn.sa0) * k).toFixed(3)})`
      : 'none';
    if (fit) {
      const s = fit.s0 + (fit.s1 - fit.s0) * k;
      this.ctx.drawImage(img, col * fw, row * fh, fw, fh,
        fit.x0 + (fit.x1 - fit.x0) * k, fit.y0 + (fit.y1 - fit.y0) * k, fw * s, fh * s);
    } else {
      this.ctx.drawImage(img, col * fw, row * fh, fw, fh, dx, dy, fw, fh);
    }
    this.ctx.filter = 'none';
  },
};

