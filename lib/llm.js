// ============================================================
//  大模型接入（可选增强；未配置或调用失败时自动回退本地规则引擎）
//  - 百炼 / DashScope OpenAI 兼容模式（默认）
//  - 任意 OpenAI 兼容端点（DeepSeek / 自建 等）
//  - 配置优先级：环境变量 > 项目 config/llm.json > ~/.bailian/config.json
//  - 带真实健康探测：前端据此如实展示「AI 是否真的可用」
// ============================================================
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function detectKey() {
  if (process.env.KY_LLM_KEY) return process.env.KY_LLM_KEY;
  if (process.env.DASHSCOPE_API_KEY) return process.env.DASHSCOPE_API_KEY;
  // 项目内配置（config/llm.json，优先级高于全局 CLI 配置；已被 .gitignore 忽略）
  try {
    const f = path.join(__dirname, '..', 'config', 'llm.json');
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j.api_key) return j.api_key;
    }
  } catch (_) {}
  // 复用本机百炼 CLI 配置
  try {
    const f = path.join(os.homedir(), '.bailian', 'config.json');
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j.api_key) return j.api_key;
    }
  } catch (_) {}
  return null;
}

function fileConf() {
  try {
    const f = path.join(__dirname, '..', 'config', 'llm.json');
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')) || {};
  } catch (_) {}
  return {};
}
const fc = fileConf();

const cfg = {
  apiKey: detectKey(),
  baseUrl: process.env.KY_LLM_BASE || fc.base_url || fc.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: process.env.KY_LLM_MODEL || fc.model || 'qwen-plus',
  timeoutMs: Number(process.env.KY_LLM_TIMEOUT || fc.timeout_ms || 45000)
};

function available() { return Boolean(cfg.apiKey); }

// ---------------- 健康状态（带 TTL，可自愈） ----------------
const PROBE_TTL = Number(process.env.KY_LLM_PROBE_TTL || 600000); // 10 分钟
const cleanReason = (s) => String(s || '')
  .replace(/^LLM_ERROR:\s*/, '')
  .replace(/https?:\/\/\S+/g, '')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 150);

let healthCache = { at: 0, ok: false, status: 'unknown', reason: '尚未探测' };

function health() {
  if (!available()) return { status: 'not_configured', ok: false, reason: '未配置 API Key', at: 0 };
  // 失败状态过期后重新探测，账号恢复可自动生效，无需重启
  if (healthCache.status === 'unavailable' && Date.now() - healthCache.at > PROBE_TTL) {
    return { status: 'unknown', ok: false, reason: '待重新探测', at: healthCache.at };
  }
  return healthCache;
}

function mark(ok, reason) {
  healthCache = { at: Date.now(), ok, status: ok ? 'ok' : 'unavailable',
    reason: ok ? '连接正常' : (cleanReason(reason) || '调用失败') };
  return healthCache;
}

const NOTE = {
  ok: '大模型连接正常，用于开放域问答与建议生成；掌握度与计划仍由本地算法计算。',
  unavailable: '大模型当前不可用，智能体已自动切换为本地规则引擎，功能不受影响。',
  not_configured: '未配置大模型，全部功能由本地规则引擎完成。',
  unknown: '尚未探测连通性，首次调用时会自动尝试。'
};

function info() {
  const h = health();
  return {
    enabled: available(),
    model: cfg.model,
    baseUrl: cfg.baseUrl.replace(/\/\/[^@]*@/, '//'),
    keyMasked: cfg.apiKey ? cfg.apiKey.slice(0, 6) + '****' + cfg.apiKey.slice(-4) : null,
    status: h.status,
    healthy: h.status === 'ok',
    reason: h.reason,
    note: NOTE[h.status] || ''
  };
}

async function chat(messages, { temperature = 0.6, maxTokens = 1200, timeoutMs = null } = {}) {
  if (!available()) throw new Error('LLM_NOT_CONFIGURED');
  const ac = new AbortController();
  const limit = timeoutMs || cfg.timeoutMs;
  const t = setTimeout(() => ac.abort(), limit);
  try {
    const res = await fetch(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      signal: ac.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false
      })
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch (_) { throw new Error('LLM_BAD_RESPONSE: ' + text.slice(0, 200)); }
    if (!res.ok || json.error) {
      throw new Error('LLM_ERROR: ' + (json.error?.message || json.message || res.status));
    }
    mark(true);
    return json.choices?.[0]?.message?.content ?? '';
  } catch (e) {
    const msg = String(e && e.message || e);
    if (/aborted|abort/i.test(msg) && !/LLM_ERROR/.test(msg)) mark(false, '请求超时（' + Math.round(limit / 1000) + 's）');
    else mark(false, msg);
    throw e;
  } finally { clearTimeout(t); }
}

// 真实探测一次可用性（启动时后台调用；首次开放域问答也会触发）
async function probe(force = false) {
  if (!available()) return health();
  const h = health();
  if (!force && h.status !== 'unknown') return h;
  try {
    await chat([{ role: 'user', content: 'ping' }], { temperature: 0, maxTokens: 1 });
  } catch (_) { /* 失败原因已由 chat 记入 health */ }
  return health();
}

module.exports = { chat, available, info, cfg, health, probe };
