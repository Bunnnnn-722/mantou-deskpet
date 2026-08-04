'use strict';
/* ================= 雪碧图工坊(配置后台·形象页) =================
 * 免费视频模型的平替生产线:用户按槽位上传绿/蓝/品红底视频,浏览器端
 * 拆帧→彩幕色键抠图→循环对齐→拼雪碧图→写进角色包,全程零外部依赖。
 * 抠图算法是生产线 video2frames.py 的 JS 移植(纯色键+unmix 去污+全局去溢色);
 * 循环对齐是免费模型专项:首尾帧没锚定时,后段找与首帧最小残差的切点,
 * 残差仍大则自动倒放(ping-pong),保证循环无跳变。 */

/* ---- 槽位目录(与生产线 slots.py 对齐;feature=缺了会关掉的桌宠能力) ---- */
const PACK_SLOTS = [
  { key: 'idle', label: '待机', cat: '核心', loop: true, must: true, feature: '启用形象的底线,没有它整个形象开不了' },
  { key: 'appear', label: '开机浮现', cat: '核心', loop: false, feature: '' },
  { key: 'touch_head', label: '摸头', cat: '点击', loop: true, feature: '没有点击类动画时,点它不会有反应' },
  { key: 'touch_body', label: '点身体', cat: '点击', loop: true, feature: '' },
  { key: 'touch_hand', label: '点手', cat: '点击', loop: true, feature: '' },
  { key: 'emo_happy', label: '表情·开心', cat: '表情', loop: true, feature: '缺的表情不进对话词表(能聊天,只是演不出这个情绪)' },
  { key: 'emo_angry', label: '表情·生气', cat: '表情', loop: true, feature: '' },
  { key: 'emo_sad', label: '表情·悲伤', cat: '表情', loop: true, feature: '' },
  { key: 'emo_speechless', label: '表情·无语', cat: '表情', loop: true, feature: '' },
  { key: 'emo_gloomy', label: '表情·阴沉', cat: '表情', loop: true, feature: '' },
  { key: 'emo_surprise', label: '表情·惊讶', cat: '表情', loop: true, feature: '' },
  { key: 'emo_blackline', label: '表情·黑线', cat: '表情', loop: true, feature: '' },
  { key: 'dance_nod', label: '听歌点头', cat: '功能', loop: true, feature: '缺了「听歌点头」开关置灰' },
  { key: 'think', label: '思考中', cat: '功能', loop: true, feature: '缺了照样能研究/拆解,只是不播思考动画' },
  // 摸鱼是个池子:桌宠端自习时在所有 slack_ 前缀动画里随机抽,想做几条做几条
  // (下面三条是提示词模板里给了成品的,不够就用分类下方的「+ 新增槽位」加)
  { key: 'slack_fish', label: '摸鱼·接鱼', cat: '自习', loop: true, feature: '一条 slack_ 都没有(也没睡觉动画)时,它自习就不会摸鱼' },
  { key: 'slack_bubble', label: '摸鱼·鱼形泡泡', cat: '自习', loop: true, feature: '' },
  { key: 'slack_fishhalo', label: '摸鱼·小鱼绕头', cat: '自习', loop: true, feature: '' },
  { key: 'busted', label: '摸鱼被抓包', cat: '自习', loop: true, feature: '被抓包时播;缺了用 surprise 表情顶' },
  { key: 'sleep_in', label: '入睡', cat: '睡眠', loop: false, feature: '' },
  { key: 'sleep', label: '睡觉循环', cat: '睡眠', loop: true, feature: '缺了「深夜睡觉」开关置灰' },
  { key: 'sleep_out', label: '睡醒', cat: '睡眠', loop: false, feature: '' },
  { key: 'egg_yawn', label: '打哈欠', cat: '彩蛋', loop: true, feature: '彩蛋都是选配,待机时随机播' },
  { key: 'egg_breeze', label: '风吹', cat: '彩蛋', loop: true, feature: '' },
  { key: 'egg_fx1', label: '特效彩蛋一', cat: '彩蛋', loop: true, feature: '' },
  { key: 'egg_fx2', label: '特效彩蛋二', cat: '彩蛋', loop: true, feature: '' },
];

/* ================= 处理管线(纯函数区,selftest 可单测) ================= */
const PackPipe = {
  CANVAS_H: 630, COLS: 7, SAMPLE_FPS: 24, OUT_FPS: 12,
  KEY_LO: 20, KEY_HI: 60,
  SEAM_JUMP: 3.0,      // 残差低于它:循环直跳肉眼不可见(video2frames 同款阈值)
  SEAM_PINGPONG: 14.0, // 残差高于它:切点救不回来,自动倒放

  // MessageChannel 而非 setTimeout:窗口最小化/被遮住时定时器被节流到 1s/次,
  // 抠图会从十几秒变十几分钟(实测);port 消息不受节流,照样让出事件循环
  tick() {
    return new Promise((r) => {
      const c = new MessageChannel();
      c.port1.onmessage = () => r();
      c.port2.postMessage(0);
    });
  },

  /* 幕色主导度(单像素):green=G-max(R,B) / blue=B-max(R,G) / magenta=min(R,B)-G */
  dom(r, g, b, mode) {
    if (mode === 'blue') return b - Math.max(r, g);
    if (mode === 'magenta') return Math.min(r, b) - g;
    return g - Math.max(r, b);
  },

  /* 画面四边采样背景色(中位数)+判定幕色;判不出返回 null(不是三色幕) */
  detectChroma(img) {
    const { data: d, width: w, height: h } = img;
    const m = Math.max(4, Math.round(Math.min(w, h) * 0.04));
    const rs = [], gs = [], bs = [];
    const grab = (x, y) => { const i = (y * w + x) * 4; rs.push(d[i]); gs.push(d[i + 1]); bs.push(d[i + 2]); };
    for (let x = 0; x < w; x += 3) for (let y = 0; y < m; y++) { grab(x, y); grab(x, h - 1 - y); }
    for (let y = 0; y < h; y += 3) for (let x = 0; x < m; x++) { grab(x, y); grab(w - 1 - x, y); }
    const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
    const r = med(rs), g = med(gs), b = med(bs);
    let mode = null;
    if (g - Math.max(r, b) > 50) mode = 'green';
    else if (b - Math.max(r, g) > 50) mode = 'blue';
    else if (Math.min(r, b) - g > 50) mode = 'magenta';
    return mode ? { mode, bg: [r, g, b] } : null;
  },

  /* 帧间残差:RGB 平均绝对差(步进采样,免缩略图);量循环接缝/相邻运动用 */
  frameDiff(a, b, stride = 4) {
    const da = a.data, db = b.data;
    let sum = 0, n = 0;
    for (let y = 0; y < a.height; y += stride) {
      let i = y * a.width * 4;
      for (let x = 0; x < a.width; x += stride, i += 4 * stride) {
        sum += Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
        n += 3;
      }
    }
    return sum / n;
  },

  /* 循环切点:后 40% 找与首帧残差最小的帧(video2frames.best_loop_cut 移植) */
  loopCut(frames) {
    const f0 = frames[0];
    let best = frames.length - 1, bd = Infinity;
    for (let i = Math.floor(frames.length * 0.6); i < frames.length; i++) {
      const d = this.frameDiff(f0, frames[i]);
      if (d < bd) { bd = d; best = i; }
    }
    return { cut: best, seam: bd };
  },

  /* 单帧色键+去污(in place)。返回该帧背景色(角落中位数,unmix 反解用了它) */
  keyFrame(img, mode) {
    const { data: d, width: w } = img;
    // 本帧背景色:左上角 30×30 中位数(逐帧取,幕色亮度漂移也能对上)
    const rs = [], gs = [], bs = [];
    for (let y = 0; y < 30; y++) for (let x = 0; x < 30; x++) {
      const i = (y * w + x) * 4; rs.push(d[i]); gs.push(d[i + 1]); bs.push(d[i + 2]);
    }
    const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
    const bg = [med(rs), med(gs), med(bs)];
    const { KEY_LO: lo, KEY_HI: hi } = this;
    for (let i = 0; i < d.length; i += 4) {
      let r = d[i], g = d[i + 1], b = d[i + 2];
      const dom = this.dom(r, g, b, mode);
      let a = Math.max(0, Math.min(255, Math.round((hi - dom) * 255 / (hi - lo))));
      if (a < 16) a = 0; // alpha 地板:压缩噪点的散星像素归零(不清会把裁切 bbox 撑爆)
      // 半透明像素数学去污(unmix):观测色=前景*α+幕色*(1-α),幕色已知反解前景
      if (a > 12 && a < 250) {
        const fa = Math.max(a / 255, 0.18);
        r = Math.max(0, Math.min(255, (r - bg[0] * (1 - fa)) / fa));
        g = Math.max(0, Math.min(255, (g - bg[1] * (1 - fa)) / fa));
        b = Math.max(0, Math.min(255, (b - bg[2] * (1 - fa)) / fa));
        // 绿/品红反解残差都落在 G 通道:压回 (R+B)/2+6,光雾不再泛绿罩
        if (mode !== 'blue') g = Math.min(g, (r + b) / 2 + 6);
      }
      // 全局去溢色:绿幕零容忍(G 压到 R/B 均值);蓝/品红温和版只压超出 +12 的过量
      if (mode === 'green') {
        if (g > Math.max(r, b)) g = (r + b) / 2;
      } else if (mode === 'blue') {
        const ex = b - Math.max(r, g) - 12;
        if (ex > 0) b -= ex;
      } else {
        const ex = Math.min(r, b) - g - 12;
        if (ex > 0) { r -= ex; b -= ex; }
      }
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a;
    }
    return bg;
  },

  /* 边缘内缩 1px(3×3 取 alpha 最小):蓝/品红幕不能零容忍去污,内缩是
   * 它们的杂边防线(生产线同款口径) */
  erodeAlpha(img) {
    const { data: d, width: w, height: h } = img;
    const src = new Uint8ClampedArray(h * w);
    for (let i = 0; i < h * w; i++) src[i] = d[i * 4 + 3];
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x;
        let m = src[p];
        m = Math.min(m, src[p - 1], src[p + 1], src[p - w], src[p + w],
          src[p - w - 1], src[p - w + 1], src[p + w - 1], src[p + w + 1]);
        d[p * 4 + 3] = m;
      }
    }
  },

  /* 结尾 nf 帧向首帧交叉淡化(接缝残差中等档的补救) */
  crossfade(frames) {
    const nf = Math.min(4, frames.length >> 2);
    const f0 = frames[0].data;
    for (let k = 1; k <= nf; k++) {
      const wgt = k / (nf + 1);
      const f = frames[frames.length - (nf + 1 - k)].data;
      for (let i = 0; i < f.length; i++) f[i] = f[i] * (1 - wgt) + f0[i] * wgt;
    }
    return nf;
  },

  /* 静止悬浮块清除(平台水印专项):与角色主体不连通、且整段"帧帧都在+
   * 纹丝不动"的色块=烧在视频里的水印(豆包"AI生成"角标实锤),全帧抹掉。
   * 游走的小鱼/泡泡等道具在自己的位置上只出现一部分帧,不会误伤 */
  removeStaticGhosts(frames) {
    const { width: w, height: h } = frames[0];
    const n = frames.length;
    const union = new Uint8Array(w * h);
    for (const f of frames) {
      const d = f.data;
      for (let p = 0; p < w * h; p++) if (d[p * 4 + 3] > 32) union[p] = 1;
    }
    // 并集连通块(4 连通 BFS),记每块像素与最大块
    const label = new Int32Array(w * h).fill(-1);
    const comps = [];
    const stack = new Int32Array(w * h);
    for (let p = 0; p < w * h; p++) {
      if (!union[p] || label[p] >= 0) continue;
      const id = comps.length, px = [];
      let top = 0;
      stack[top++] = p; label[p] = id;
      while (top) {
        const q = stack[--top];
        px.push(q);
        const x = q % w;
        if (x > 0 && union[q - 1] && label[q - 1] < 0) { label[q - 1] = id; stack[top++] = q - 1; }
        if (x < w - 1 && union[q + 1] && label[q + 1] < 0) { label[q + 1] = id; stack[top++] = q + 1; }
        if (q >= w && union[q - w] && label[q - w] < 0) { label[q - w] = id; stack[top++] = q - w; }
        if (q < w * (h - 1) && union[q + w] && label[q + w] < 0) { label[q + w] = id; stack[top++] = q + w; }
      }
      comps.push(px);
    }
    if (comps.length < 2) return 0;
    const mainId = comps.reduce((b, c, i) => (c.length > comps[b].length ? i : b), 0);
    let cleared = 0;
    for (let i = 0; i < comps.length; i++) {
      if (i === mainId || comps[i].length < 12) continue;
      // 时域统计:出现率(alpha>32 的帧占比)与颜色波动(相对首个可见帧)
      let present = 0, dev = 0, devN = 0;
      for (const p of comps[i]) {
        let cnt = 0, r0 = -1, g0 = 0, b0 = 0;
        for (let k = 0; k < n; k++) {
          const d = frames[k].data, o = p * 4;
          if (d[o + 3] > 32) {
            cnt++;
            if (r0 < 0) { r0 = d[o]; g0 = d[o + 1]; b0 = d[o + 2]; }
            else { dev += (Math.abs(d[o] - r0) + Math.abs(d[o + 1] - g0) + Math.abs(d[o + 2] - b0)) / 3; devN++; }
          }
        }
        present += cnt / n;
      }
      present /= comps[i].length;
      const avgDev = devN ? dev / devN : 0;
      if (present >= 0.9 && avgDev < 10) {
        for (const p of comps[i]) for (let k = 0; k < n; k++) frames[k].data[p * 4 + 3] = 0;
        cleared++;
      }
    }
    return cleared;
  },

  /* 全序列 alpha 并集 bbox(pad 8):统一裁切保证跨动画锚点一致 */
  unionBox(frames, pad = 8) {
    const { width: w, height: h } = frames[0];
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (const f of frames) {
      const d = f.data;
      for (let y = 0; y < h; y++) {
        let rowHit = false;
        for (let x = 0; x < w; x++) {
          if (d[(y * w + x) * 4 + 3] > 8) {
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            rowHit = true;
          }
        }
        if (rowHit) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
    }
    if (x1 < 0) return null; // 全透明:抠没了
    x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
    x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(h - 1, y1 + pad);
    return { x0, y0, fw: x1 - x0 + 1, fh: y1 - y0 + 1 };
  },

  crop(f, box) {
    const out = new ImageData(box.fw, box.fh);
    const src = f.data, dst = out.data, w = f.width;
    for (let y = 0; y < box.fh; y++) {
      const s = ((y + box.y0) * w + box.x0) * 4;
      dst.set(src.subarray(s, s + box.fw * 4), y * box.fw * 4);
    }
    return out;
  },

  /* 主流程:File → { dataUrl(雪碧图 webp), entry(manifest 条目), report } */
  async process(file, slotDef, onProgress) {
    const say = (s) => { if (onProgress) onProgress(s); };
    // ---- 拆帧(24fps 采样,画面等比缩到 630 高的公共画布) ----
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.src = url;
    try {
      await new Promise((res, rej) => {
        v.onloadedmetadata = res;
        v.onerror = () => rej(new Error('视频解码失败(换 mp4/webm 试试)'));
      });
      const dur = Math.min(v.duration || 0, 12);
      if (!dur || !v.videoHeight) throw new Error('读不到视频画面');
      const ch = this.CANVAS_H;
      const cw = Math.max(2, Math.round(v.videoWidth * ch / v.videoHeight));
      const n = Math.max(4, Math.floor(dur * this.SAMPLE_FPS));
      const cv = document.createElement('canvas');
      cv.width = cw; cv.height = ch;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      let frames = [];
      for (let i = 0; i < n; i++) {
        await new Promise((res) => {
          v.addEventListener('seeked', res, { once: true });
          // 首帧也要给个非零时刻:currentTime 原地不动不触发 seeked(会卡死)
          v.currentTime = Math.max(0.001, Math.min(dur - 0.01, i / this.SAMPLE_FPS));
        });
        ctx.drawImage(v, 0, 0, cw, ch);
        frames.push(ctx.getImageData(0, 0, cw, ch));
        if (i % 8 === 0) { say(`拆帧 ${i + 1}/${n}`); await this.tick(); }
      }
      // ---- 幕色判定 ----
      const det = this.detectChroma(frames[0]);
      if (!det) throw new Error('背景不是纯绿/蓝/品红幕,没法自动抠图(生成时提示词里写明纯色背景)');
      say(`检测到${{ green: '绿', blue: '蓝', magenta: '品红' }[det.mode]}幕,找循环切点…`);
      await this.tick();

      // ---- 循环对齐(免费模型专项) ----
      const report = { mode: det.mode, loopPlan: '非循环片段,整段保留' };
      let seam = -1;
      if (slotDef.loop !== false) {
        const r = this.loopCut(frames);
        seam = r.seam;
        if (seam > this.SEAM_PINGPONG) {
          report.loopPlan = `首尾差异大(残差 ${seam.toFixed(1)}),自动倒放补循环`;
        } else {
          frames = frames.slice(0, r.cut + 1);
          report.loopPlan = `循环切点第 ${r.cut} 帧(残差 ${seam.toFixed(1)})`;
        }
      }
      // ---- 降采样到 12fps ----
      const step = Math.max(1, Math.round(this.SAMPLE_FPS / this.OUT_FPS));
      frames = frames.filter((_, i) => i % step === 0);
      const fps = this.SAMPLE_FPS / step;
      // ---- 逐帧抠图 ----
      for (let i = 0; i < frames.length; i++) {
        this.keyFrame(frames[i], det.mode);
        if (det.mode !== 'green') this.erodeAlpha(frames[i]);
        if (i % 4 === 0) { say(`抠图 ${i + 1}/${frames.length}`); await this.tick(); }
      }
      // 平台水印清除(豆包等会把"AI生成"角标烧进画面,色键后变成悬空文字)
      const ghosts = this.removeStaticGhosts(frames);
      if (ghosts) report.watermark = `清掉 ${ghosts} 个静止悬浮块(平台水印)`;
      // 倒放补循环:正放到底再倒回首帧(掐头去尾防端点连打两帧)。
      // 必须放在抠图之后——拼接复用的是同一批 ImageData 引用,放前面会被
      // 二次色键(去污后的背景 dom≈0,整帧变实心,实测翻车)
      if (slotDef.loop !== false && seam > this.SEAM_PINGPONG) {
        frames = frames.concat(frames.slice(1, -1).reverse());
        report.pingpong = true;
      }
      // ---- 接缝淡化(切点残差中等档;倒放/非循环不需要) ----
      if (slotDef.loop !== false && !report.pingpong && seam >= this.SEAM_JUMP) {
        let adj = Infinity;
        for (let i = 0; i + 1 < frames.length; i++)
          adj = Math.min(adj, this.frameDiff(frames[i], frames[i + 1]));
        if (seam >= Math.max(adj, this.SEAM_JUMP)) {
          const nf = this.crossfade(frames);
          report.loopPlan += `,结尾 ${nf} 帧向首帧淡化`;
        }
      }
      // ---- 裁切+拼雪碧图 ----
      say('拼雪碧图…'); await this.tick();
      const box = this.unionBox(frames);
      if (!box) throw new Error('抠完全透明了:检查视频里角色是否与幕色同色系');
      const cropped = frames.map((f) => this.crop(f, box));
      const rows = Math.ceil(cropped.length / this.COLS);
      const sheet = document.createElement('canvas');
      sheet.width = this.COLS * box.fw; sheet.height = rows * box.fh;
      if (sheet.width > 16000 || sheet.height > 16000) throw new Error('雪碧图超尺寸(视频太长,剪到 8 秒内)');
      const sctx = sheet.getContext('2d');
      cropped.forEach((f, i) => sctx.putImageData(f, (i % this.COLS) * box.fw, Math.floor(i / this.COLS) * box.fh));
      const dataUrl = sheet.toDataURL('image/webp', 0.92);
      if (!dataUrl.startsWith('data:image/webp')) throw new Error('webp 编码失败');
      const entry = {
        frames: cropped.length, cols: this.COLS, fw: box.fw, fh: box.fh,
        fps, dx: box.x0, dy: box.y0, canvasW: frames[0].width, canvasH: frames[0].height,
      };
      return { dataUrl, entry, firstFrame: frames[0], report };
    } finally { URL.revokeObjectURL(url); }
  },

  /* 首尾帧残差(按槽位映射校验用):把雪碧图的第 0 帧和最后一帧缩到 160px 宽再比。
   * 实测标定(两套自制包共 48 条):循环动画 0.5~3.0,入睡/睡醒过渡 5.9~21.6,
   * 中间这道 4.5 的缝把两类分得干干净净 */
  ENDS_SAME: 4.5,
  async measureEnds(id, key, m) {
    const url = await window.pet.personaFile(id, key + '.webp');
    if (!url) return null;
    const img = new Image();
    // onload 而非 decode():大雪碧图 decode() 在部分 Chromium 环境会挂死(实测)
    await new Promise((r) => { img.onload = r; img.onerror = r; img.src = url; });
    if (!img.width) return null;
    const W = 160, H = Math.max(1, Math.round(m.fh * W / m.fw));
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const grab = (i) => {
      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(img, (i % m.cols) * m.fw, Math.floor(i / m.cols) * m.fh, m.fw, m.fh, 0, 0, W, H);
      return ctx.getImageData(0, 0, W, H);
    };
    const a = grab(0), b = grab(Math.max(0, m.frames - 1));
    img.src = '';                      // 早点松开解码后的位图(单张可达上百 MB)
    return this.frameDiff(a, b, 1);
  },

  /* 首帧一致性:新动画首帧 vs 待机首帧(公共画布坐标系,64 格采样)。
   * 轮廓 IoU 低/交集色差大 → 切换动画会跳变,提醒但不拦(用户自己定夺) */
  compareFirstFrames(a, b) {
    const N = 64;
    const samp = (img) => {
      const out = [];
      for (let gy = 0; gy < N; gy++) for (let gx = 0; gx < N; gx++) {
        const x = Math.min(img.width - 1, Math.round(gx * img.width / N));
        const y = Math.min(img.height - 1, Math.round(gy * img.height / N));
        const i = (y * img.width + x) * 4;
        out.push([img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]]);
      }
      return out;
    };
    const A = samp(a), B = samp(b);
    let inter = 0, uni = 0, cd = 0;
    for (let i = 0; i < A.length; i++) {
      const ia = A[i][3] > 32, ib = B[i][3] > 32;
      if (ia || ib) uni++;
      if (ia && ib) {
        inter++;
        cd += (Math.abs(A[i][0] - B[i][0]) + Math.abs(A[i][1] - B[i][1]) + Math.abs(A[i][2] - B[i][2])) / 3;
      }
    }
    const iou = uni ? inter / uni : 1;
    const colorDiff = inter ? cd / inter : 0;
    return { iou, colorDiff, ok: iou >= 0.7 && colorDiff <= 32 };
  },
};

/* 按前缀抽池子的分类:这几类的槽位数量不限,工坊给「+ 新增槽位」入口 */
const CAT_POOL = { 表情: 'emo_', 点击: 'touch_', 彩蛋: 'egg_', 自习: 'slack_' };

/* ================= 工坊 UI(挂在形象卡片「动画工坊」按钮上) ================= */
const PackStudio = {
  busy: false,

  /* 槽位 → 实际动画(persona.json 的 slotMap;没配就是同名) */
  srcOf(slot) { const m = this.ctx.map; return slot in m ? m[slot] : slot; },
  /* 目录槽位 + 用户自建槽位(persona.json extraSlots) */
  slotList(persona) {
    const extra = (persona.extraSlots || []).map((s) => ({ ...s, loop: true, feature: '', custom: true }));
    return PACK_SLOTS.concat(extra);
  },

  statusHtml(m) {
    return (m ? `<span class="tag-ok">✓ ${m.frames} 帧 @ ${(+m.fps).toFixed(0)}fps</span>`
              : '<span class="tag-miss">未上传</span>')
      + '<div class="ps-check" style="font-size:10px;margin-top:2px;"></div>';
  },
  actsHtml(s, m) {
    const off = this.ctx.offEggs.includes(s.key);
    return `<button class="live-btn" data-up="${s.key}">${m ? '重新上传' : '上传视频'}</button>`
      + (m ? `<button class="live-btn" data-pv="${s.key}" style="margin-left:6px;">预览</button>
             <button class="live-btn" data-live="${s.key}" style="margin-left:6px;" title="在桌宠上真机播放">▶ 桌宠</button>
             <button class="live-btn" data-del="${s.key}" style="margin-left:6px;">删除</button>` : '')
      + (s.key.startsWith('egg_') && m ? `<button class="live-btn" data-eggtoggle="${s.key}" style="margin-left:6px;"
          title="禁用的彩蛋不进待机随机池">${off ? '启用' : '禁用'}</button>` : '')
      + (s.custom ? `<button class="live-btn" data-rmslot="${s.key}" style="margin-left:6px;">移除槽位</button>` : '');
  },
  optsHtml(sel) {
    return ['<option value="">(空着 · 没有这个动作)</option>']
      .concat(this.ctx.assets.map((k) => `<option value="${k}" ${sel === k ? 'selected' : ''}>${k}</option>`)).join('');
  },
  rowHtml(s) {
    const cur = this.srcOf(s.key), m = this.ctx.man[cur];
    return `<tr data-slot="${s.key}">
      <td>${s.label} <span style="color:var(--muted-2);font-family:ui-monospace,monospace;">${s.key}</span>${s.must ? ' <span class="tag-ok">●必传</span>' : ''}${s.custom ? ' <span class="tag-ok">自建</span>' : ''}
        ${s.feature ? `<div style="font-size:10px;color:var(--muted-2);">${s.feature}</div>` : ''}</td>
      <td><select class="ps-map" data-slot="${s.key}">${this.optsHtml(m ? cur : '')}</select></td>
      <td class="ps-status">${this.statusHtml(m)}</td>
      <td class="ps-acts">${this.actsHtml(s, m)}</td></tr>`;
  },
  // 换完下拉/传完视频后就地刷新一行(状态+按钮都得跟着变,不然还显示「未上传」)
  refreshRow(slot) {
    const tr = document.querySelector(`#persona-detail tr[data-slot="${slot}"]`);
    const s = this.ctx.slots.find((x) => x.key === slot);
    if (!tr || !s) return;
    const m = this.ctx.man[this.srcOf(slot)];
    tr.querySelector('.ps-status').innerHTML = this.statusHtml(m);
    tr.querySelector('.ps-acts').innerHTML = this.actsHtml(s, m);
  },

  async show(id, name) {
    const det = document.getElementById('persona-detail');
    const data = await window.pet.personaManifest(id);
    if (!data) return;
    const persona = data.persona;
    this.ctx = {
      id, name, persona,
      man: data.manifest,
      map: { ...(persona.slotMap || {}) },
      offEggs: persona.disabledEggs || [],
      assets: Object.keys(data.manifest),
      slots: this.slotList(persona),
    };
    const CATS = [...new Set(this.ctx.slots.map((s) => s.cat))];
    const usedBySlot = new Set(this.ctx.slots.map((s) => this.srcOf(s.key)));
    const orphan = this.ctx.assets.filter((k) => !usedBySlot.has(k));

    let html = `<div style="font-size:12px;font-weight:600;color:var(--ink-hi);margin:14px 0 2px;">
      「${name}」动画工坊 · 传视频自动抠图入包;每个槽位用哪条动画也在这里改</div>
      <div class="tip" style="margin:4px 0 6px;">「用哪条动画」是一张映射表:想把彩蛋和摸鱼对调,
      直接在两行的下拉里互换即可,不用改文件名。上传视频会写进<b>本槽位同名</b>的动画并把映射复位。
      表情/点击/彩蛋/摸鱼在桌宠端都是按前缀抽的池子,想做几条就用分类下方的<b>「+ 新增槽位」</b>加。
      <b>动画预览窗在页面最底部</b>,上传/点预览后会自动滚过去。</div>
      <table class="anim-map"><tr><th style="width:31%;">槽位</th><th style="width:22%;">用哪条动画</th>
        <th>状态</th><th style="width:270px;"></th></tr>`;
    for (const cat of CATS) {
      html += `<tr><td colspan="4" style="color:var(--accent);font-weight:600;padding-top:8px;">${cat}</td></tr>`;
      for (const s of this.ctx.slots.filter((x) => x.cat === cat)) html += this.rowHtml(s);
      if (CAT_POOL[cat]) {
        html += `<tr><td colspan="4" style="padding-bottom:6px;">
          <button class="live-btn" data-addslot="${cat}">＋ 新增${cat}槽位</button>
          <span style="font-size:10px;color:var(--muted-2);margin-left:8px;">
            自动加 ${CAT_POOL[cat]} 前缀 —— 桌宠就是按这个前缀抽池子的</span>
          ${cat === '点击' ? '<button class="live-btn" data-hitzone="1" style="margin-left:10px;">配置点击区域</button>' : ''}</td></tr>`;
      }
    }
    if (orphan.length) {
      html += `<tr><td colspan="4" style="color:var(--accent);font-weight:600;padding-top:8px;">
        目录外的动画(没有槽位在用,可以在上面的下拉里指过去)</td></tr>`;
      for (const k of orphan) {
        const m = this.ctx.man[k];
        html += `<tr><td colspan="2"><span style="font-family:ui-monospace,monospace;">${k}</span></td>
          <td><span class="tag-ok">✓ ${m.frames} 帧 @ ${(+m.fps).toFixed(0)}fps</span></td>
          <td><button class="live-btn" data-pvraw="${k}">预览</button>
              <button class="live-btn" data-delraw="${k}" style="margin-left:6px;">删除</button></td></tr>`;
      }
    }
    html += `</table>
      <div id="ps-map-r" style="font-size:11px;color:var(--success);margin-top:6px;min-height:15px;"></div>
      <div id="ps-hitzone"></div>
      <input type="file" id="ps-file" accept="video/mp4,video/webm,video/quicktime" style="display:none;">`;
    const fx = persona.fx || [];
    html += `<div style="font-size:11px;color:var(--muted);margin-top:8px;">全屏特效:` +
      (fx.length ? fx.map((f) => `<span class="tag-ok">[fx:${f}] ✓</span>`).join(' ')
                 : '<span class="tag-miss">无(由码绘寒潮兜底)</span>') + '</div>';
    html += PersonaUI.emoProtocolHtml(this.ctx.man, persona);
    det.innerHTML = html;
    det.scrollIntoView({ behavior: 'smooth', block: 'start' });
    PersonaUI.bindEmoProtocol(id);
    this.bind();
    this.checkEnds();
  },

  say(msg, bad) {
    const r = document.getElementById('ps-map-r');
    if (!r) return;
    r.textContent = msg;
    r.style.color = bad ? 'var(--gem)' : 'var(--success)';
  },
  async saveMap() {
    const ok = await window.pet.personaSetMeta?.(this.ctx.id, { slotMap: this.ctx.map });
    this.say(ok ? '✓ 已保存,桌宠已热应用' : '✗ 保存失败', !ok);
    return ok;
  },

  /* 事件全部委托到容器上:行内容会被就地重绘,挂在按钮上的监听会掉。
   * 用 on* 属性而不是 addEventListener——show() 会重跑,监听器不能叠加 */
  bind() {
    const det = document.getElementById('persona-detail');
    const file = det.querySelector('#ps-file');
    det.onchange = async (ev) => {
      const sel = ev.target.closest('.ps-map');
      if (!sel) return;
      const slot = sel.dataset.slot;
      if (sel.value === slot) delete this.ctx.map[slot]; else this.ctx.map[slot] = sel.value;
      if (await this.saveMap()) this.say(`✓ 「${slot}」已指向 ${sel.value || '(空)'},桌宠已热应用`);
      this.refreshRow(slot);            // ← 状态/按钮跟着换,否则还写着「未上传」
      this.checkEnds();
    };
    det.onclick = async (ev) => {
      const b = ev.target.closest('button[data-up],button[data-pv],button[data-live],button[data-del],'
        + 'button[data-eggtoggle],button[data-rmslot],button[data-pvraw],button[data-delraw],'
        + 'button[data-addslot],button[data-hitzone]');
      if (!b) return;
      const d = b.dataset;
      const { id, name } = this.ctx;
      if (d.up) {
        if (this.busy) { alert('上一条还在处理,稍等'); return; }
        file.onchange = () => {
          if (file.files[0]) this.upload(id, name, d.up, file.files[0]);
          file.value = '';
        };
        file.click();
      } else if (d.pv || d.pvraw) {
        const key = d.pvraw || this.srcOf(d.pv);
        if (this.ctx.man[key]) PersonaUI.playPreview(id, key, this.ctx.man[key]);
      } else if (d.live) {
        window.pet.personaPreviewAnim?.(d.live);   // 真机播走槽位名,桌宠自己按映射解析
      } else if (d.del || d.delraw) {
        const key = d.delraw || this.srcOf(d.del);
        if (!confirm(`删除「${key}」这条动画?指向它的槽位会变成空的。`)) return;
        const r = await window.pet.personaRemoveAnim(id, key);
        if (!r.ok) { alert('删除失败:' + r.err); return; }
        await PersonaUI.refresh();
        this.show(id, name);
      } else if (d.eggtoggle) {
        const k = d.eggtoggle;
        const list = this.ctx.offEggs.includes(k)
          ? this.ctx.offEggs.filter((x) => x !== k) : [...this.ctx.offEggs, k];
        await window.pet.personaSetMeta?.(id, { disabledEggs: list });
        this.show(id, name);
      } else if (d.addslot) {
        this.addSlot(d.addslot);
      } else if (d.rmslot) {
        if (!confirm(`移除自建槽位「${d.rmslot}」?动画文件还在,只是不再占一行。`)) return;
        const extra = (this.ctx.persona.extraSlots || []).filter((s) => s.key !== d.rmslot);
        delete this.ctx.map[d.rmslot];
        await window.pet.personaSetMeta?.(id, { extraSlots: extra, slotMap: this.ctx.map });
        this.show(id, name);
      } else if (d.hitzone) {
        this.hitZoneEditor();
      }
    };
  },

  /* 新增槽位:前缀按分类自动补齐(桌宠端就是按前缀抽池子的,名字不带前缀等于白建) */
  async addSlot(cat) {
    const pre = CAT_POOL[cat];
    const raw = prompt(`新增${cat}槽位。输入英文短名(会自动补 ${pre} 前缀),例如 ${pre}coffee`);
    if (raw === null) return;
    let key = raw.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (!key) return;
    if (!key.startsWith(pre)) key = pre + key;
    if (!/^[a-z][a-z0-9_]{1,23}$/.test(key)) { alert('名字只能用小写字母、数字和下划线,最长 24 位'); return; }
    if (this.ctx.slots.some((s) => s.key === key)) { alert(`「${key}」已经有了`); return; }
    const label = (prompt('显示名称(中文即可)', key) || key).trim().slice(0, 20);
    const extra = [...(this.ctx.persona.extraSlots || []), { key, label, cat }];
    const ok = await window.pet.personaSetMeta?.(this.ctx.id, { extraSlots: extra });
    if (!ok) { alert('保存失败'); return; }
    await this.show(this.ctx.id, this.ctx.name);
    this.say(`✓ 已新增槽位「${label}」${key},传条视频给它吧`);
  },

  /* 点击命中区编辑器:在待机首帧上拉框,框到哪块就播哪条 touch_ 动画。
   * 坐标存成帧内百分比(与 Persona.hitZone 同约定),按序判定,小框放前面。 */
  async hitZoneEditor() {
    const host = document.getElementById('ps-hitzone');
    if (host.dataset.on) {
      host.dataset.on = ''; host.innerHTML = '';
      window.onmousemove = null; window.onmouseup = null; return;
    }
    host.dataset.on = '1';
    const { id, man, persona } = this.ctx;
    const idleKey = this.srcOf('idle');
    const m = man[idleKey];
    if (!m) { host.innerHTML = '<div class="tip">先给待机槽位传一条动画,才有底图可以框。</div>'; return; }
    const url = await window.pet.personaFile(id, idleKey + '.webp');
    const img = new Image();
    await new Promise((r) => { img.onload = r; img.onerror = r; img.src = url; });
    const W = 240, H = Math.round(m.fh * W / m.fw);
    const touchSlots = this.ctx.slots.filter((s) => s.key.startsWith('touch_') && man[this.srcOf(s.key)]);
    if (!touchSlots.length) { host.innerHTML = '<div class="tip">先给点击类槽位传动画,再来配区域。</div>'; return; }
    const zones = JSON.parse(JSON.stringify(persona.hitZones?.zones || []));
    let fb = persona.hitZones?.fallback ? { ...persona.hitZones.fallback } : null;
    const animOpts = (sel) => touchSlots
      .map((s) => `<option value="${s.key}" ${sel === s.key ? 'selected' : ''}>${s.label} · ${s.key}</option>`).join('');

    let s0 = null, ghost = null;
    const draw = () => {
      host.innerHTML = `<div style="font-size:12px;font-weight:600;color:var(--ink-hi);margin:12px 0 4px;">
        点击区域 · 在图上拖一个框,再选这块要播哪条动画</div>
        <div class="tip" style="margin:0 0 8px;">按从上到下的顺序判定,所以<b>小框放前面</b>(手在头框里侧的情况);
        都没框到就用兜底。不配的话走默认:上半身=摸头,其余=点身体。</div>
        <div style="display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap;">
        <div class="hz-wrap" id="hz-cv" style="width:${W}px;height:${H}px;">
          <canvas width="${W}" height="${H}" style="display:block;"></canvas>
          ${zones.map((z, i) => `<div class="hz-box" style="left:${z.x0 * W}px;top:${z.y0 * H}px;
            width:${(z.x1 - z.x0) * W}px;height:${(z.y1 - z.y0) * H}px;"><b>${i + 1}</b></div>`).join('')}
        </div>
        <div style="flex:1;min-width:330px;">
          <table class="anim-map"><tr><th style="width:26px;">#</th><th>触发的动画</th>
            <th style="width:88px;">部位名</th><th style="width:44px;"></th></tr>
          ${zones.map((z, i) => `<tr><td>${i + 1}</td>
            <td><select class="ps-map hz-anim" data-i="${i}">${animOpts(z.anim)}</select></td>
            <td><input class="emo-desc-in hz-part" data-i="${i}" value="${(z.part || '身体').replace(/"/g, '&quot;')}"></td>
            <td><button class="live-btn" data-hzdel="${i}">删</button></td></tr>`).join('')
            || '<tr><td colspan="4" style="color:var(--muted-2);">还没框,直接在左边图上拖一个</td></tr>'}
          <tr><td>兜底</td>
            <td><select class="ps-map hz-fb">${['<option value="">(不设,走默认判定)</option>', animOpts(fb?.anim)].join('')}</select></td>
            <td><input class="emo-desc-in hz-fbpart" value="${(fb?.part || '身体').replace(/"/g, '&quot;')}"></td>
            <td></td></tr></table>
          <button class="live-btn" id="hz-save" style="margin-top:8px;">保存点击区域</button>
          <button class="live-btn" id="hz-clear" style="margin-left:6px;">全部清掉</button>
          <span id="hz-r" style="font-size:11px;color:var(--success);margin-left:8px;"></span>
        </div></div>`;
      const cv = host.querySelector('canvas');
      cv.getContext('2d').drawImage(img, 0, 0, m.fw, m.fh, 0, 0, W, H);
      const wrap = host.querySelector('#hz-cv');
      wrap.onmousedown = (e) => {
        const r = wrap.getBoundingClientRect();
        s0 = [e.clientX - r.left, e.clientY - r.top];
        ghost = document.createElement('div');
        ghost.className = 'hz-box';
        wrap.appendChild(ghost);
      };
      window.onmousemove = (e) => {
        if (!s0 || !ghost) return;
        const r = wrap.getBoundingClientRect();
        const x = Math.max(0, Math.min(W, e.clientX - r.left)), y = Math.max(0, Math.min(H, e.clientY - r.top));
        Object.assign(ghost.style, { left: Math.min(s0[0], x) + 'px', top: Math.min(s0[1], y) + 'px',
          width: Math.abs(x - s0[0]) + 'px', height: Math.abs(y - s0[1]) + 'px' });
      };
      window.onmouseup = (e) => {
        if (!s0) return;
        const r = document.getElementById('hz-cv').getBoundingClientRect();
        const x = Math.max(0, Math.min(W, e.clientX - r.left)), y = Math.max(0, Math.min(H, e.clientY - r.top));
        const [x0, x1] = [Math.min(s0[0], x) / W, Math.max(s0[0], x) / W];
        const [y0, y1] = [Math.min(s0[1], y) / H, Math.max(s0[1], y) / H];
        s0 = null; ghost?.remove(); ghost = null;
        if (x1 - x0 < 0.04 || y1 - y0 < 0.04) return;   // 手滑点一下不算
        zones.push({ anim: touchSlots[0].key, part: '身体', x0, y0, x1, y1 });
        draw();
      };
      host.querySelectorAll('[data-hzdel]').forEach((b) => b.addEventListener('click', () => {
        zones.splice(+b.dataset.hzdel, 1); draw();
      }));
      host.querySelector('#hz-clear').addEventListener('click', () => { zones.length = 0; fb = null; draw(); });
      host.querySelector('#hz-save').addEventListener('click', async () => {
        host.querySelectorAll('.hz-anim').forEach((s) => { zones[+s.dataset.i].anim = s.value; });
        host.querySelectorAll('.hz-part').forEach((i) => { zones[+i.dataset.i].part = i.value.trim() || '身体'; });
        const fa = host.querySelector('.hz-fb').value;
        fb = fa ? { anim: fa, part: host.querySelector('.hz-fbpart').value.trim() || '身体' } : null;
        const ok = await window.pet.personaSetMeta?.(id, { hitZones: { zones, ...(fb ? { fallback: fb } : {}) } });
        const r = host.querySelector('#hz-r');
        r.textContent = ok ? '✓ 已保存并热应用' : '✗ 保存失败';
        r.style.color = ok ? 'var(--success)' : 'var(--gem)';
      });
    };
    draw();
  },

  /* 首尾帧校验(用户拍板的两条,其余一概不管):
   *  · 循环槽位 —— 首尾必须基本一样,否则循环播到接缝会跳;
   *  · 入睡/睡醒 —— 首尾必须不一样(睁眼→闭眼 / 闭眼→睁眼),一样说明放错了动画。
   * 只提醒不拦截。逐条串行量,量完就松开位图,免得几十张雪碧图一起占内存。 */
  async checkEnds() {
    const det = document.getElementById('persona-detail');
    const { id, man } = this.ctx;
    this._ends = this._ends || {};
    for (const s of this.ctx.slots) {
      const key = this.srcOf(s.key);
      const m = man[key];
      const cell = det.querySelector(`tr[data-slot="${s.key}"] .ps-check`);
      if (!cell) continue;
      if (!m) { cell.textContent = ''; continue; }
      const ck = id + ':' + key;
      if (this._ends[ck] === undefined) {
        cell.innerHTML = '<span style="color:var(--muted-2);">量首尾帧…</span>';
        this._ends[ck] = await PackPipe.measureEnds(id, key, m);
      }
      const d = this._ends[ck];
      if (d == null) { cell.textContent = ''; continue; }
      const same = d < PackPipe.ENDS_SAME;
      const trans = s.key === 'sleep_in' || s.key === 'sleep_out';
      let msg = `首尾残差 ${d.toFixed(1)} ✓`, color = 'var(--muted-2)';
      if (trans && same) {
        msg = `⚠ 首尾几乎一样(${d.toFixed(1)})——入睡/睡醒是过渡动画,首尾该是睁眼→闭眼,换一条`;
        color = 'var(--warn)';
      } else if (!trans && s.loop !== false && !same) {
        msg = `⚠ 首尾差得多(${d.toFixed(1)})——循环播到接缝会跳,换一条首尾同姿势的`;
        color = 'var(--warn)';
      }
      cell.innerHTML = `<span style="color:${color};">${msg}</span>`;
    }
  },

  async upload(id, name, slot, file) {
    const det = document.getElementById('persona-detail');
    const row = det.querySelector(`tr[data-slot="${slot}"]`);
    const stat = row?.querySelector('.ps-status');
    const say = (s) => { if (stat) stat.innerHTML = `<span style="color:var(--warn);">${s}</span>`; };
    this.busy = true;
    try {
      const sdef = PACK_SLOTS.find((s) => s.key === slot) || { loop: true };
      const r = await PackPipe.process(file, sdef, say);
      say('写入角色包…');
      const w = await window.pet.personaWriteAnim(id, slot, r.dataUrl, r.entry);
      if (!w.ok) throw new Error(w.err || '落盘失败');
      // 写的是本槽位同名动画:映射复位,否则传完还指着别人,用户会以为没生效
      const cur = await window.pet.personaManifest(id);
      const map = { ...(cur?.persona?.slotMap || {}) };
      if (slot in map) { delete map[slot]; await window.pet.personaSetMeta?.(id, { slotMap: map }); }
      delete (this._ends || {})[id + ':' + slot];   // 重传了,首尾残差得重量
      // 首帧一致性校验:与待机首帧比对,差太多提醒(切动画会跳变)
      let warn = '';
      if (slot !== 'idle' && slot !== 'appear') {
        const idleFirst = await this.idleFirstFrame(id);
        if (idleFirst) {
          const c = PackPipe.compareFirstFrames(r.firstFrame, idleFirst);
          if (!c.ok) warn = `⚠ 首帧与待机差异偏大(轮廓重合 ${(c.iou * 100).toFixed(0)}%`
            + (c.iou > 0 ? `,色差 ${c.colorDiff.toFixed(0)}` : '')
            + `),切换动画时可能跳变——建议生成视频时都用同一张立绘做首帧`;
        }
      }
      await PersonaUI.refresh();
      await this.show(id, name);
      const row2 = det.querySelector(`tr[data-slot="${slot}"] .ps-status`);
      if (row2) {
        row2.innerHTML += `<div style="font-size:10px;color:var(--muted-2);">${r.report.loopPlan}</div>`
          + (warn ? `<div style="font-size:10px;color:var(--warn);">${warn}</div>` : '');
      }
      const fresh = await window.pet.personaManifest(id);
      if (fresh?.manifest?.[slot]) PersonaUI.playPreview(id, slot, fresh.manifest[slot]);
    } catch (e) {
      say('✗ ' + (e.message || e));
      if (stat) stat.querySelector('span').style.color = 'var(--gem)';
    } finally { this.busy = false; }
  },

  /* 取待机动画首帧(公共画布坐标系 ImageData),没有待机返回 null */
  async idleFirstFrame(id) {
    const data = await window.pet.personaManifest(id);
    const m = data?.manifest?.idle;
    if (!m) return null;
    const url = await window.pet.personaFile(id, 'idle.webp');
    if (!url) return null;
    const img = new Image();
    // onload 而非 decode():大尺寸雪碧图 decode() 在部分 Chromium 环境会挂死(实测)
    await new Promise((res) => { img.onload = res; img.onerror = res; img.src = url; });
    if (!img.width) return null;
    const cv = document.createElement('canvas');
    cv.width = m.canvasW; cv.height = m.canvasH;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, m.fw, m.fh, m.dx || 0, m.dy || 0, m.fw, m.fh);
    return ctx.getImageData(0, 0, cv.width, cv.height);
  },
};
