'use strict';
/* 馒头桌宠 renderer 主逻辑(2026-07 从前身桌宠 fork，零素材程序化馒头)
 * 浏览器预览模式:window.pet 不存在时使用 mock(无穿透/截屏/持久化)
 */
'use strict';

// 注意:#pet 这个 DOM id 会让浏览器把元素挂到 window.pet(named access),
// Electron 里 contextBridge 的注入优先级更高不受影响;浏览器预览必须排除元素
const API = (window.pet && !(window.pet instanceof Element)) ? window.pet : {
  setIgnore: async () => {},
  dragBy: () => {},
  captureScreen: async () => null,
  getConfig: async () => JSON.parse(localStorage.getItem('cfg') || 'null'),
  setConfig: async (c) => localStorage.setItem('cfg', JSON.stringify(c)),
  getStore: async (n) => JSON.parse(localStorage.getItem('st_' + n) || 'null'),
  setStore: async (n, d) => localStorage.setItem('st_' + n, JSON.stringify(d)),
  musicAppRunning: async () => true,
  nowPlaying: async () => '',
  moveToDisplay: async () => null,
  onExternalSay: () => {},
  getWeather: async () => null,
  getAutostart: async () => false,
  setAutostart: async () => false,
  personaList: async () => [],
  personaImport: async () => ({ ok: false, err: 'mock' }),
  personaDelete: async () => false,
  personaActivate: async () => false,
  personaFile: async () => null,
  personaManifest: async () => null,
  quit: () => {},
};

/* ================= 服务商预设 =================
 * 一个服务商 = 协议(openai/anthropic 组包方式) + Base 预填 + 模型示例 + "关思考"方言。
 * think 方言(各家 API 关思考的姿势完全不同,这是"默认关思考没生效"的根因):
 *   thinking         → {thinking:{type:'disabled'}}   DeepSeek/智谱/火山/Anthropic系
 *   enable_thinking  → {enable_thinking:false}        通义/硅基流动
 *   reasoning_effort → {reasoning_effort:'none'}      Gemini 的 OpenAI 兼容层
 *   none             → 不发任何参数                    OpenAI 等(乱发严格端点会 400) */
const PROVIDERS = [
  { id: 'zhipu', name: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', protocol: 'openai', think: 'thinking', eg: 'glm-4.7-flash' },
  { id: 'deepseek', name: 'DeepSeek', base: 'https://api.deepseek.com', protocol: 'openai', think: 'thinking', eg: 'deepseek-chat' },
  { id: 'volces', name: '豆包(火山方舟)', base: 'https://ark.cn-beijing.volces.com/api/v3', protocol: 'openai', think: 'thinking', eg: 'doubao-seed-1-6-flash-250828' },
  { id: 'moonshot', name: 'Kimi(月之暗面开放平台)', base: 'https://api.moonshot.cn/v1', protocol: 'openai', think: 'none', eg: 'kimi-k2-0905-preview' },
  { id: 'kimi-coding', name: 'Kimi For Coding(会员套餐)', base: 'https://api.kimi.com/coding', protocol: 'anthropic', think: 'thinking', eg: 'k3' },
  { id: 'qwen', name: '通义千问(阿里百炼)', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', protocol: 'openai', think: 'enable_thinking', eg: 'qwen-flash' },
  { id: 'siliconflow', name: '硅基流动(聚合平台)', base: 'https://api.siliconflow.cn/v1', protocol: 'openai', think: 'enable_thinking', eg: 'Qwen/Qwen3-14B' },
  { id: 'openai', name: 'OpenAI(ChatGPT)', base: 'https://api.openai.com/v1', protocol: 'openai', think: 'none', eg: 'gpt-5-mini' },
  { id: 'anthropic', name: 'Anthropic(Claude)', base: 'https://api.anthropic.com', protocol: 'anthropic', think: 'thinking', eg: 'claude-haiku-4-5' },
  { id: 'gemini', name: 'Google Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai', protocol: 'openai', think: 'reasoning_effort', eg: 'gemini-2.5-flash' },
  { id: 'custom-openai', name: '自定义(OpenAI 兼容)', base: '', protocol: 'openai', think: 'none', eg: '' },
  { id: 'custom-anthropic', name: '自定义(Anthropic 兼容)', base: '', protocol: 'anthropic', think: 'thinking', eg: '' },
];
function providerOf(a) { return PROVIDERS.find((p) => p.id === (a && a.provider)) || null; }
/* 旧配置没存 provider:按 Base URL 猜一个(迁移期兜底,boot 会写回) */
function inferProvider(a) {
  if (!a || !a.base) return null;
  const b = a.base;
  if (/bigmodel/i.test(b)) return 'zhipu';
  if (/deepseek/i.test(b)) return 'deepseek';
  if (/volces/i.test(b)) return 'volces';
  if (/api\.kimi\.com/i.test(b)) return 'kimi-coding';
  if (/moonshot/i.test(b)) return 'moonshot';
  if (/dashscope/i.test(b)) return 'qwen';
  if (/siliconflow/i.test(b)) return 'siliconflow';
  if (/googleapis/i.test(b)) return 'gemini';
  if (/api\.openai\.com/i.test(b)) return 'openai';
  if (/anthropic\.com/i.test(b)) return 'anthropic';
  return a.protocol === 'anthropic' ? 'custom-anthropic' : 'custom-openai';
}
/* API 走哪种协议:provider 优先,老字段 protocol 兜底 */
function apiProto(a) {
  const p = providerOf(a);
  if (p) return p.protocol;
  return a && a.protocol === 'anthropic' ? 'anthropic' : 'openai';
}
/* 按服务商方言生成"关思考"请求体片段(受设置里"禁用模型思考"开关控制) */
function thinkBody(a) {
  if (CFG.disableThinking === false) return {};
  const p = providerOf(a) || PROVIDERS.find((x) => x.id === inferProvider(a));
  switch (p && p.think) {
    case 'thinking': return { thinking: { type: 'disabled' } };
    case 'enable_thinking': return { enable_thinking: false };
    case 'reasoning_effort': return { reasoning_effort: 'none' };
    default: return {};
  }
}

/* ================= 配置 ================= */
const DEFAULT_CFG = {
  petName: '馒馒',
  personality: 'cold',
  customPersonality: '',
  // 人设+名字按形象包绑定:{ '<personaId>'|'mantou': { petName, customPersonality } }
  // petName/customPersonality 两个旧全局键保留为 mantou 绑定的镜像(兼容旧读取路径)
  personaBindings: {},
  // provider 空串=未设置(apiProto/thinkBody 会按 base/protocol 推断兜底):
  // 默认值若写死某家,旧配置 merge 进来会被错误地盖上该服务商,协议就路由错了
  chatApi: { provider: '', key: '', base: '', model: '' },
  chatApi2: { provider: '', key: '', base: '', model: '' }, // 副对话API(可选):主API连不上时自动顶上
  visionApi: { provider: '', key: '', base: '', model: '', protocol: 'openai' }, // protocol 为旧字段,provider 优先
  screenLevel: 3,      // 1快~5慢
  nightSleep: true,    // 深夜睡觉(时间驱动:到点就困，催主人睡)
  sleepStart: 23,      // 睡觉时段起点(整点小时，支持跨午夜)
  sleepEnd: 7,         // 睡觉时段终点;起点=终点视为不启用
  sensitivity: 3,      // 摸鱼判定灵敏度
  ctxLimit: 50,        // 聊天携带的上下文条数(1~500)
  darkMode: false,       // 暗色模式(黑曜馒头):本体黑玻璃+UI 黑玻璃,html.dark 令牌切换
  disableThinking: true, // 禁用模型思考(桌宠场景不需要，省时省钱;思考型模型不关会吃光 max_tokens)
  visionCanChat: false,  // 视觉模型也有对话能力:锐评走单段直答(带人设+上下文)，省一次往返
  journalMode: false,    // 随机屏摄日记:无待办也定期看一眼记录在做什么(不判摸鱼)，可凭记录生成日报
  agentShare: true,      // 观察记录分享给 Agent(~/agent_pet/ 活动级摘要导出，查岗用;只出文本不出截图)
  danceBpm: 89,         // 点头素材原生 BPM(可用 节奏校准器.html 实测后修改)
  healthReminder: true, // 整点起身喝水提醒
  morningWeather: true, // 每天首次启动播报天气
  silentFocus: false,  // 专注时保持静音
  musicMode: false,    // 听歌点头
  studyMode: false,    // 自习室:它也有自己的研究待办(追踪时同桌自习+摸鱼+抓包)
  studyGoal: '',       // 它的当前大目标(空=study.js 里的默认命题;研究线列表在 store)
  webSearch: false,    // 联网检索开关(默认关:检索拼回的内容不可控反拖效果,用户拍板 07-26;开了按服务商适配)
  searchKey: '',       // 联网检索 Key(智谱;对话 API 就是智谱时留空自动复用)
};
let CFG = { ...DEFAULT_CFG };

/* 配置深合并:API 子对象逐个并入(浅合并会丢子字段)。新增 API 子对象只需改这里 */
function mergeCfg(base, patch) {
  if (!patch) return { ...base };
  const out = { ...base, ...patch };
  for (const k of ['chatApi', 'chatApi2', 'visionApi']) out[k] = { ...base[k], ...patch[k] };
  return out;
}

/* 默认人设 = 身份定式 + 性格文案(设置面板"人设"框的默认底稿;
 * {petName} 运行时代入名字。与角色包系统的 Persona 对象无关) */
const DEFAULT_PERSONA = '你是桌宠「{petName}」，一只白色半透明的玻璃小馒头(圆滚滚，只有两只大眼睛，软软的会 duang duang 弹)，待在用户屏幕右下角。你清冷淡漠，话少，句子短，语气平静疏离，但句句在点子上。偶尔流露一丝不易察觉的在意。';

/* 当前生效的人设文本(按形象包绑定:激活包用包的绑定,馒头本体用 mantou
 * 绑定;绑定为空=默认底稿)，名字已代入 */
function personaText() {
  const t = (Persona.binding().customPersonality || '').trim() || DEFAULT_PERSONA;
  return t.split('{petName}').join(Persona.petName());
}

/* ---- 配置后台:默认值在 prompts_defaults.js,CFG.prompts 可覆盖(设置→开发者模式) ---- */
function P(key, vars = {}) {
  let t = (CFG.prompts && CFG.prompts[key]) || DEFAULT_PROMPTS[key] || '';
  // 形象联动:激活包时，system_rules 里"馒头专属"的标签清单/施法行整段撤下，
  // 换成 capabilityAddendum() 按包实际能力生成的协议(见 systemPrompt)。
  // 边界标记常量见下，改 prompts_defaults.js 时要同步。
  if (Persona.active && key === 'system_rules') {
    t = t.replace(/^- 在句子前用 \[emo:标签\][\s\S]*?^- 只输出台词本身/m, '- 只输出台词本身');
    t = t.replace(/除 \[emo:xxx\] 和 \[fx:xxx\] 外[,，]/m, ''); // 兼容用户覆盖里的旧半角逗号版本
    t = t.replace(/^- 你有一个真实的施法能力[^\n]*\n/m, '');
    t = t.replace(/^- 示例: \[emo:[^\n]*\n?/m, '');
  }
  for (const [k, v] of Object.entries(vars)) t = t.split('{' + k + '}').join(v);
  return t;
}

/* 截屏统一入口:主进程返回 {ok,data|err}，权限缺失给出可操作提示 */
async function captureScreenSafe() {
  const r = await API.captureScreen();
  if (typeof r === 'string') return r;
  if (r && r.ok) return r.data;
  if (r && r.err === 'no-permission') {
    API.openPrivacy?.('screen'); // 直接替用户跳到开关面前
    throw new Error('缺屏幕录制权限，已帮你打开设置页:允许 Electron 后【重启桌宠】生效');
  }
  throw new Error((r && r.err) || '截屏失败');
}

/* ---- LLM 调试日志:每次请求/响应都记一笔，配置后台可查 ---- */
function logLLM(kind, request, response) {
  S.llmLog.push({ t: Date.now(), kind, request: String(request).slice(0, 6000), response: String(response).slice(0, 2000) });
  // 高频技术记录(拾音自愈)单独限 6 条:20s 一条的死循环能把 40 条总上限
  // 刷满,锐评/盯梢记录全被挤掉,调试日志形同虚设(真机实锤)
  let extra = S.llmLog.filter((e) => e.kind === 'audio').length - 6;
  if (kind === 'audio' && extra > 0)
    S.llmLog = S.llmLog.filter((e) => e.kind !== 'audio' || extra-- <= 0);
  if (S.llmLog.length > 40) S.llmLog.shift();
  clearTimeout(logLLM._t);
  logLLM._t = setTimeout(() => API.setStore('llmlog', S.llmLog), 800);
}

/* Base URL 容错:把完整接口路径(…/chat/completions 或 …/v1/messages)填进
 * Base URL 是很自然的直觉,自动剥掉尾巴,两种填法都认(否则拼出双层路径 404) */
function apiBase(url) {
  return String(url || '').trim()
    .replace(/\/+$/, '')
    .replace(/\/(chat\/completions|v1\/messages)$/i, '');
}

/* 对话 API 列表:主 API + 副 API(填了才算)。故障转移按这个顺序试 */
function chatApiList() {
  const list = [CFG.chatApi];
  if (CFG.chatApi2 && CFG.chatApi2.key && CFG.chatApi2.base) list.push(CFG.chatApi2);
  return list;
}
/* 统一组包:调用方一律写 openai 形状 {model,messages,stream?,max_tokens?},
 * 这里按服务商协议翻译成实际请求(anthropic = system 拆出+同角色合并+/v1/messages),
 * 关思考方言(thinkBody)也在这一层拼进去,调用方不用关心各家差异 */
function chatRequest(a, body) {
  if (apiProto(a) === 'anthropic') {
    const sys = body.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const hist = [];
    for (const m of body.messages.filter((m) => m.role !== 'system')) {
      const last = hist[hist.length - 1];
      if (last && last.role === m.role) last.content += '\n' + m.content;
      else hist.push({ role: m.role, content: m.content });
    }
    return {
      url: `${apiBase(a.base)}/v1/messages`,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': a.key,
        Authorization: `Bearer ${a.key}`, // 兼容只认 Bearer 的代理端点
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: {
        model: body.model, max_tokens: body.max_tokens || 1024, // anthropic 必填
        ...(body.stream ? { stream: true } : {}),
        ...(sys ? { system: sys } : {}),
        messages: hist, ...thinkBody(a),
      },
    };
  }
  return {
    url: `${apiBase(a.base)}/chat/completions`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${a.key}` },
    body: { ...body, ...thinkBody(a) },
  };
}
/* 非流式响应取正文:openai(choices)/anthropic(content 块)双形状兼容 */
function chatText(data) {
  if (Array.isArray(data.content))
    return data.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  return data.choices?.[0]?.message?.content || '';
}

/* 带故障转移的对话请求:每个 API 内部先重试(llmFetch)，整个 API 挂了换下一个。
   makeBody(api) 按各家 base/model 现做请求体(openai 形状)。成功返回 {resp, api} */
async function chatFetchFailover(makeBody, label) {
  const apis = chatApiList();
  let lastErr = null;
  for (let i = 0; i < apis.length; i++) {
    const a = apis[i];
    try {
      const req = chatRequest(a, makeBody(a));
      const resp = await llmFetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body),
      }, { label });
      if (!resp.ok) {
        // 把响应体里的具体原因带出来(欠费/限流说明都在 body 里，光 HTTP 码看不出)
        const detail = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status} ${detail.slice(0, 200)}`);
      }
      if (i > 0) logLLM(label, '(故障转移)', `主API失败，副API(${a.model})顶上成功`);
      return { resp, api: a };
    } catch (err) {
      lastErr = err;
      if (i < apis.length - 1) logLLM(label, '(故障转移)', `主API彻底失败(${err.message})，切换副API`);
    }
  }
  throw lastErr;
}

/* ---- 统一 LLM 请求:防失败层 ----
   网络抖动(Failed to fetch/超时)和 429/5xx 自动重试(退避 800ms→2.4s),
   整个请求兜底 60s 超时(防连接挂死永远转圈)。4xx 业务错误不重试。 */
async function llmFetch(url, options, { retries = 2, label = 'llm' } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    if (i) await new Promise((r) => setTimeout(r, 800 * Math.pow(3, i - 1)));
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(60000), ...options });
      if ((resp.status === 429 || resp.status >= 500) && i < retries) {
        lastErr = new Error(`HTTP ${resp.status}`);
        logLLM(label, '(自动重试)', `HTTP ${resp.status},${800 * Math.pow(3, i)}ms 后第 ${i + 1} 次重试`);
        continue;
      }
      return resp;
    } catch (err) {
      lastErr = err;
      if (i < retries) logLLM(label, '(自动重试)', `${err.message}，第 ${i + 1} 次重试`);
    }
  }
  throw lastErr;
}
/* 把底层错误翻译成人话(区分欠费/密钥/网络，别一律"连不上") */
function friendlyLLMError(err) {
  const m = String(err && err.message || err);
  if (/402|insufficient|balance|欠费|余额/i.test(m)) return '模型余额好像不足了…去充值看看?';
  if (/401|invalid.*key|authentication/i.test(m)) return 'API Key 好像不对…检查一下设置?';
  if (/failed to fetch|timed?\s?out|network|abort/i.test(m)) return '网络抖了一下，自动重试了几次还是没连上…稍后再和我说话吧。';
  return `连不上模型(${m.slice(0, 60)})…检查一下设置?`;
}
/* 屏摄兜底台词已外置到台词后台(fb_catch/fb_work/fb_unsure):
   一行一条随机取(旧版按性格预设 4 行取，预设已随人设自由文本化废除) */
function fbMsg(kind) {
  const rows = P('fb_' + kind).split('\n').filter(Boolean);
  return rows[Math.floor(Math.random() * rows.length)] || '';
}

/* ---- 视觉请求统一入口:按 visionApi.protocol 组包 ----
 * openai(默认) = {base}/chat/completions + image_url data URL
 * anthropic    = {base}/v1/messages + image source 块(Kimi For Coding / Claude 系端点)
 * 可选 system(人设)与 history(纯文本上下文，单段锐评用);
 * 返回纯文本回复;API 报错直接 throw(调用方 catch 里已有 logLLM) */
async function visionChat({ text, imageB64, mime = 'image/jpeg', maxTokens = 150, label, system = null, history = [], retries = 2 }) {
  const { key, base, model } = CFG.visionApi;
  const protocol = apiProto(CFG.visionApi); // provider 优先,旧 protocol 字段兜底
  if (!key) throw new Error('未填 Key');
  const b = apiBase(base);
  // 相邻同角色消息合并(anthropic 要求 user/assistant 交替;openai 合并也无害)
  const hist = [];
  for (const m of history) {
    const last = hist[hist.length - 1];
    if (last && last.role === m.role) last.content += '\n' + m.content;
    else hist.push({ role: m.role, content: m.content });
  }
  if (protocol === 'anthropic') {
    const resp = await llmFetch(`${b}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        Authorization: `Bearer ${key}`,             // 兼容只认 Bearer 的代理端点
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true', // 官方 API 浏览器直连需要
      },
      body: JSON.stringify({
        model, max_tokens: maxTokens,
        // 思考型模型(如 k3)不关思考会把 max_tokens 全花在思考上，正文空响应
        ...thinkBody(CFG.visionApi),
        ...(system ? { system } : {}),
        messages: [...hist, { role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: imageB64 } },
          { type: 'text', text },
        ] }],
      }),
    }, { label, retries });
    const data = await resp.json();
    if (data.error) throw new Error(data.error.message || data.error.type || 'API错误');
    return (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  }
  const resp = await llmFetch(`${b}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model, max_tokens: maxTokens, ...thinkBody(CFG.visionApi),
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...hist,
        { role: 'user', content: [
          { type: 'text', text },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${imageB64}` } },
        ] },
      ],
    }),
  }, { label, retries });
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message || 'API错误');
  return data.choices?.[0]?.message?.content || '';
}
