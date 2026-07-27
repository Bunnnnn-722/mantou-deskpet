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
  { key: 'slack_daze', label: '摸鱼·神游', cat: '自习', loop: true, feature: '一条 slack_ 都没有(也没睡觉动画)时,它自习就不会摸鱼' },
  { key: 'slack_play', label: '摸鱼·玩小物', cat: '自习', loop: true, feature: '' },
  { key: 'busted', label: '摸鱼被抓包', cat: '自习', loop: true, feature: '' },
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

/* ================= 工坊 UI(挂在形象卡片「动画工坊」按钮上) ================= */
const PackStudio = {
  busy: false,

  async show(id, name) {
    const det = document.getElementById('persona-detail');
    const data = await window.pet.personaManifest(id);
    if (!data) return;
    const man = data.manifest;
    const CATS = [...new Set(PACK_SLOTS.map((s) => s.cat))];
    let html = `<div style="font-size:12px;font-weight:600;color:var(--ink-hi);margin:14px 0 2px;">
      「${name}」动画工坊 · 每个槽位传一段绿/蓝/品红底视频,自动抠图入包</div>
      <div class="tip" style="margin:4px 0 6px;">循环槽位的视频尽量首尾是同一姿势;首尾对不上也没关系,
      工坊会自动找循环切点或倒放补循环。传完先点「预览」看效果,不满意重传即可覆盖。</div>
      <table class="anim-map"><tr><th>槽位</th><th>状态</th><th style="width:260px;"></th></tr>`;
    for (const cat of CATS) {
      html += `<tr><td colspan="3" style="color:var(--accent);font-weight:600;padding-top:8px;">${cat}</td></tr>`;
      for (const s of PACK_SLOTS.filter((x) => x.cat === cat)) {
        const m = man[s.key];
        html += `<tr data-slot="${s.key}">
          <td>${s.label} <span style="color:var(--muted-2);font-family:ui-monospace,monospace;">${s.key}</span>${s.must ? ' <span class="tag-ok">●必传</span>' : ''}
            ${s.feature ? `<div style="font-size:10px;color:var(--muted-2);">${s.feature}</div>` : ''}</td>
          <td class="ps-status">${m ? `<span class="tag-ok">✓ ${m.frames} 帧 @ ${(+m.fps).toFixed(0)}fps</span>` : '<span class="tag-miss">未上传</span>'}</td>
          <td class="ps-acts">
            <button class="live-btn" data-up="${s.key}">${m ? '重新上传' : '上传视频'}</button>
            ${m ? `<button class="live-btn" data-pv="${s.key}" style="margin-left:6px;">预览</button>
                   <button class="live-btn" data-del="${s.key}" style="margin-left:6px;">删除</button>` : ''}
          </td></tr>`;
      }
    }
    html += `</table><input type="file" id="ps-file" accept="video/mp4,video/webm,video/quicktime" style="display:none;">`;
    det.innerHTML = html;
    det.scrollIntoView({ behavior: 'smooth', block: 'start' });

    const fileInput = det.querySelector('#ps-file');
    det.querySelectorAll('[data-up]').forEach((b) => b.addEventListener('click', () => {
      if (this.busy) { alert('上一条还在处理,稍等'); return; }
      fileInput.onchange = () => {
        if (fileInput.files[0]) this.upload(id, name, b.dataset.up, fileInput.files[0]);
        fileInput.value = '';
      };
      fileInput.click();
    }));
    det.querySelectorAll('[data-pv]').forEach((b) => b.addEventListener('click', async () => {
      const fresh = await window.pet.personaManifest(id);
      if (fresh?.manifest?.[b.dataset.pv]) PersonaUI.playPreview(id, b.dataset.pv, fresh.manifest[b.dataset.pv]);
    }));
    det.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      const k = b.dataset.del;
      if (!confirm(`删除「${k}」这条动画?`)) return;
      const r = await window.pet.personaRemoveAnim(id, k);
      if (!r.ok) { alert('删除失败:' + r.err); return; }
      await PersonaUI.refresh();
      this.show(id, name);
    }));
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
