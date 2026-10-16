/* ============================================================
 408 考研学习助手 · 前端
 ============================================================ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SUB_COLOR = { ds: 'var(--ds)', co: 'var(--co)', os: 'var(--os)', cn: 'var(--cn)' };
const SUB_TAG = { ds: 'ds', co: 'co', os: 'os', cn: 'cn' };
const STATE_TEXT = { mastered: '已掌握', familiar: '较熟练', learning: '学习中', due: '待复习', notstarted: '未开始' };

// 部署基址自适应：根路径("/")与子路径("/kaoyan/")部署都能正确请求
const API_BASE = (() => {
 try { return new URL('./', document.baseURI).pathname; } catch (_) { return '/'; }
})();
const abs = (p) => (/^https?:/i.test(p) ? p : API_BASE + String(p).replace(/^\//, ''));
const api = async (p, opts) => {
 const r = await fetch(abs(p), opts);
 const t = await r.text();
 let j; try { j = JSON.parse(t); } catch (_) { throw new Error('响应异常: ' + t.slice(0, 120)); }
 if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
 return j;
};
const post = (p, b) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) });

// 流式对话：SSE 逐段回调；返回最终 done 数据
const streamChat = async (message, handlers = {}) => {
  // 老浏览器 / 不支持流式读取时，回退到一次性接口（功能不受影响）
  if (typeof TextDecoder === 'undefined' || !window.ReadableStream) {
    const r = await post('/api/agent/chat', { message });
    if (handlers.onDelta && r.reply) handlers.onDelta(r.reply);
    return r;
  }
  const res = await fetch(abs('/api/agent/stream'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message })
  });
  if (!res.ok || !res.body) {
    // SSE 不可用 → 回退
    const r = await post('/api/agent/chat', { message });
    if (handlers.onDelta && r.reply) handlers.onDelta(r.reply);
    return r;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let done = null;
  for (;;) {
    const { done: fin, value } = await reader.read();
    if (fin) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop();
    for (const blk of parts) {
      const line = blk.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch (_) { continue; }
      if (ev.type === 'delta') { if (handlers.onDelta) handlers.onDelta(ev.text); }
      else if (ev.type === 'done') done = ev;
      else if (ev.type === 'error') throw new Error(ev.error || 'stream error');
    }
  }
  if (!done) throw new Error('流式响应未完成');
  return done;
};

let toastTimer;
function toast(msg, ok = true) {
 const t = $('#toast');
 t.textContent = msg;
 t.style.background = ok ? '#1a2233' : '#c0392b';
 t.classList.add('on');
 clearTimeout(toastTimer);
 toastTimer = setTimeout(() => t.classList.remove('on'), 2400);
}
const fmtDate = (s) => { if (!s) return '—'; const d = new Date(s.slice(0, 10) + 'T00:00:00'); return `${d.getMonth() + 1}月${d.getDate()}日`; };
const wd = (s) => ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(s.slice(0, 10) + 'T00:00:00').getDay()];
const todayStr = () => { const x = new Date(Date.now() - new Date().getTimezoneOffset() * 60000); return x.toISOString().slice(0, 10); };

/* ---------------- 全局状态 ---------------- */
let S = { overview: null, page: 'dashboard', states: null, advice: null, plan: null, route: null, hot: null, heat: null, logs: [],
 agentMsgs: null, agentPending: null, agentDraft: '', agentTools: [], agentBusy: false };

/* ---------------- 骨架 ---------------- */
async function boot() {
 bindNav();
 await refreshCore();
 render();
}

function bindNav() {
 $$('#nav button').forEach((b) => b.addEventListener('click', () => {
 $$('#nav button').forEach((x) => x.classList.remove('on'));
 b.classList.add('on');
 S.page = b.dataset.page;
 render();
 }));
 $('#btnSeed').addEventListener('click', async () => {
 if (!confirm('载入演示数据？会覆盖当前的学习记录、掌握度与计划（用于答辩展示）。建议先备份 data/kaoyan.db。')) return;
 toast('正在生成演示数据…');
 try {
 const r = await post('/api/demo/seed', { days: 60 });
 toast(`已生成：${r.logs} 条学习记录，掌握度 ${r.summary.mastery}/100，预估 ${r.summary.estimated} 分`);
 S.advice = null; S.plan = null; S.route = null; S.hot = null; S.states = null; S.heat = null;
 await refreshCore();
 render();
 } catch (e) { toast('失败：' + e.message, false); }
 });
 $('#btnCheckinQuick').addEventListener('click', () => openCheckinModal());
}

async function refreshCore() {
 S.overview = await api('/api/overview');
 const o = S.overview;
 $('#sideDays').innerHTML = o.assessment.pace.daysLeft + ' <small style="font-size:12px;font-weight:500;color:var(--ink3)">天</small>';
 $('#sideExam').textContent = '考试日 ' + o.user.exam_date + '（' + (o.examLabel || '') + '）';
 const lt = $('#llmTag');
 const L = o.llm || {};
 lt.classList.remove('hide');
 if (L.healthy) { lt.textContent = 'AI 增强已启用'; lt.className = 'tag ok'; }
 else if (L.enabled) { lt.textContent = 'AI 增强暂不可用'; lt.className = 'tag warn'; lt.title = L.reason || ''; }
 else { lt.textContent = '本地规则引擎'; lt.className = 'tag'; lt.title = L.note || ''; }
 const badge = $('#navPlanBadge');
 const todo = (o.todayPlan || []).filter((x) => x.status === 'todo').length;
 if (todo) { badge.textContent = todo; badge.classList.remove('hide'); } else badge.classList.add('hide');
}

/* ---------------- 路由渲染 ---------------- */
function render() {
 const titles = {
 dashboard: ['学习驾驶舱', '今天该学什么、学得怎么样、下一步怎么走'],
 agent: ['AI 督导', '能对话、会调工具、真改数据的 408 智能体'],
 plan: ['今日计划', '按剩余时间、遗忘曲线与掌握情况动态生成'],
 checkin: ['打卡与记录', '连续打卡、学习时长与知识点记录'],
 mastery: ['掌握度评估', '143 个知识点逐点追踪，知道分丢在哪'],
 route: ['学习路线', '未来 14 天的动态路线预览'],
 trend: ['进度追踪', '学习强度、覆盖推进与掌握度变化'],
 hot: ['考研热点', '官方资讯 + 全网热搜中的考研/计算机相关'],
 about: ['关于与设置', '个人信息、目标分与大模型增强']
 };
 $('#pgTitle').textContent = titles[S.page][0];
 $('#pgSub').textContent = titles[S.page][1];
 const v = $('#view');
 v.innerHTML = '<div class="card"><div class="skel" style="width:40%"></div><div class="skel mt" style="width:80%"></div><div class="skel mt" style="width:65%"></div></div>';
 const fn = { dashboard: renderDashboard, agent: renderAgent, plan: renderPlan, checkin: renderCheckin, mastery: renderMastery,
 route: renderRoute, trend: renderTrend, hot: renderHot, about: renderAbout }[S.page];
 Promise.resolve(fn()).catch((e) => { v.innerHTML = `<div class="card"><div class="empty">加载失败：${esc(e.message)}</div></div>`; });
}

/* ============================================================
 AI 督导：与智能体对话（智能体真实读写学习数据）
 ============================================================ */

// 轻量 Markdown → 安全 HTML（先转义，再套标签，纯字符串替换，不用 innerHTML 拼接用户内容）
function mdToHtml(md) {
 let h = esc(md);
 h = h.replace(/\{\u5c0f\u5b57\}([\s\S]*?)\{\/\u5c0f\u5b57\}/g, '<span class="md-sub">$1</span>');
 // 行内代码 `x`
 h = h.replace(/`([^`\n]+)`/g, '<code class="md-code">$1</code>');
 h = h.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
 // 文本进度条 █░░ 渲染为真实进度条（\u2588 在中文界面会糊成黑块）
 h = h.replace(/[\u2588\u2591]{4,}/g, (seg) => {
 const full = (seg.match(/\u2588/g) || []).length;
 const empty = (seg.match(/\u2591/g) || []).length;
 const pct = Math.round((full / Math.max(1, full + empty)) * 100);
 return '<span class="md-bar"><i style="width:' + pct + '%"></i></span>';
 });
 h = h.replace(/^&gt;\s?(.*)$/gm, '<span class="md-quote">$1</span>');
 const lines = h.split('\n');
 const out = [];
 const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
 const isSep = (l) => /^\s*\|[-: \t|]+\|\s*$/.test(l) && l.includes('-');
 const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim());
 for (let i = 0; i < lines.length; i++) {
 const line = lines[i];
 if (!line.trim()) { out.push('<div class="md-gap"></div>'); continue; }
 // 表格：表头行 + |---| 分隔行
 if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
 const head = cells(line);
 const rows = [];
 let j = i + 2;
 while (j < lines.length && isRow(lines[j])) { rows.push(cells(lines[j])); j++; }
 out.push('<div class="md-table"><table><thead><tr>' + head.map((c) => '<th>' + c + '</th>').join('') +
 '</tr></thead><tbody>' + rows.map((r) => '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('') +
 '</tbody></table></div>');
 i = j - 1;
 continue;
 }
 // 标题 ## / ###
 const hm = line.match(/^(#{1,6})\s+(.*)$/);
 if (hm) { out.push('<div class="md-h lv' + hm[1].length + '">' + hm[2] + '</div>'); continue; }
 // 分隔线 --- / ***
 if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { out.push('<div class="md-hr"></div>'); continue; }
 if (/^[\u2022-]\s/.test(line)) { out.push('<div class="md-li">' + line + '</div>'); continue; }
 if (/^\d+\.\s/.test(line)) { out.push('<div class="md-li">' + line + '</div>'); continue; }
 out.push('<div class="md-p">' + line + '</div>');
 }
 return out.join('');
}

const AGENT_CHIPS = [
 '我的进度怎么样',
 '最该补哪里',
 '抽背我几个知识点',
 '今天要复习什么',
 '我学不动了，今天只有 40 分钟',
 '重排今天的计划',
 '未来一周路线'
];

function bubble(m) {
 if (m.role === 'user') return `<div class="msg user"><div class="bd">${esc(m.content)}</div></div>`;
 const tools = (m.trace || []).filter((t) => t && t.tool);
 const toolBar = tools.length ? `<div class="trace">${tools.map((t) =>
 `<span class="tt" title="${esc(t.label || '')}"> ${esc(t.tool)}${t.label ? ' · ' + esc(t.label) : ''}</span>`).join('')}</div>` : '';
 return `<div class="msg agent"><div class="av">AI</div><div class="bd">
 <div class="md">${mdToHtml(m.content)}</div>${toolBar}</div></div>`;
}

async function renderAgent() {
 if (!S.agentMsgs) {
 const h = await api('/api/agent/history');
 S.agentMsgs = h.items || [];
 S.agentTools = h.tools || [];
 S.agentPending = h.pending;
 S.agentLlm = h.llm;
 }
 const msgs = S.agentMsgs;
 const empty = !msgs.length;
 const wrap = `
 <div class="agent-wrap">
 <div class="agent-side">
 <div class="card">
 <h3><span class="dot"></span>智能体能力</h3>
 <div class="small muted" style="margin-bottom:9px">它不只会聊，还能<b>直接读写你的学习数据</b>：</div>
 <div class="cap-list">
 <div class="cap"><b>查</b>进度 / 薄弱 / 到期复习 / 路线</div>
 <div class="cap"><b>写</b>打卡 / 记录学习 / 重排计划</div>
 <div class="cap"><b>考</b>抽背出题 → 判分 → 更新掌握度</div>
 <div class="cap"><b>推</b>考研热点与官方资讯</div>
 </div>
 <div class="small muted" style="margin-top:10px;padding-top:9px;border-top:1px solid var(--line)">
 已注册工具 <b>${S.agentTools.length}</b> 个　·　引擎：<b>${S.agentLlm && S.agentLlm.healthy ? '大模型增强 + 本地引擎' : '本地规则引擎（完全可用）'}</b>
 </div>
 <button class="btn sm mt" id="agClear" style="width:100%">清空对话</button>
 </div>
 <div class="card mt">
 <h3><span class="dot"></span>已注册工具 <span class="small muted2" style="margin-left:auto;font-weight:400">Agent Tools</span></h3>
 <div class="tool-list">${S.agentTools.map((t) => `<div class="tool"><code>${esc(t.name)}</code><span>${esc(t.desc)}</span></div>`).join('')}</div>
 </div>
 </div>
 <div class="card agent-chat">
 <h3><span class="dot"></span>408 学习督导 <span class="tag brand" style="margin-left:auto">可在对话中改数据</span></h3>
 <div class="chat" id="chatBox">
 ${empty ? `<div class="chat-welcome">
 <div class="w-av">AI</div>
 <div class="w-t">我是你的 408 学习督导</div>
 <div class="w-s">试试下面这些（每一句都会真的影响你的计划与掌握度）：</div>
 <div class="chips">${AGENT_CHIPS.map((c) => `<button class="chip">${esc(c)}</button>`).join('')}</div>
 </div>` : msgs.map(bubble).join('')}
 ${S.agentBusy ? '<div class="msg agent typing"><div class="av">AI</div><div class="bd">思考中…</div></div>' : ''}
 </div>
 ${S.agentPending ? `<div class="pending-tip">当前有 1 道待答题目：直接输入答案即可判分，「不知道」也可以。</div>` : ''}
 <div class="composer">
 <textarea id="agInput" rows="2" placeholder="说点什么…例如「抽背我几个知识点」「我学完了最小生成树，花了 40 分钟」">${esc(S.agentDraft)}</textarea>
 <button class="btn pri" id="agSend">发送</button>
 </div>
 <div class="chips quick">${AGENT_CHIPS.map((c) => `<button class="chip">${esc(c)}</button>`).join('')}</div>
 </div>
 </div>`;

 $('#view').innerHTML = wrap;
 bindAgent();
}

function bindAgent() {
 const box = $('#chatBox');
 if (box) box.scrollTop = box.scrollHeight;
 const input = $('#agInput');
  const send = async () => {
    const text = (input.value || '').trim();
    if (!text || S.agentBusy) return;
    S.agentDraft = '';
    S.agentBusy = true;
    S.agentMsgs = S.agentMsgs || [];
    S.agentMsgs.push({ role: 'user', content: text, trace: [] });
    render();

    // 流式接收中的临时气泡：直接改 DOM，避免整页重渲染导致闪烁
    let live = null;
    S.agentStreamText = '';
    const ensureLive = () => {
      if (live) return live;
      const box = $('#chatBox');
      if (!box) return null;
      // 首个增量到达：移除"思考中…"占位，避免两个气泡并存
      const typing = box.querySelector('.msg.typing');
      if (typing) typing.remove();
      const el = document.createElement('div');
      el.className = 'msg agent streaming';
      el.innerHTML = '<div class="av">AI</div><div class="bd"><div class="md"></div></div>';
      box.appendChild(el);
      box.scrollTop = box.scrollHeight;
      live = el;
      return el;
    };
    const onDelta = (chunk) => {
      const el = ensureLive();
      if (!el) return;
      S.agentStreamText += chunk;
      const md = el.querySelector('.md');
      if (md) md.innerHTML = mdToHtml(S.agentStreamText) + '<span class="caret"></span>';
      const box = $('#chatBox');
      if (box) box.scrollTop = box.scrollHeight;
    };

    try {
      const r = await streamChat(text, { onDelta });
      S.agentMsgs.push({ role: 'agent', content: r.reply, trace: r.trace || [] });
      S.agentPending = r.pending;
    } catch (e) {
      S.agentMsgs.push({ role: 'agent', content: '出错了：' + e.message, trace: [] });
    }
    S.agentStreamText = '';
    S.agentBusy = false;
    await refreshCore();
    render();
  };
 if (input) {
 input.addEventListener('input', () => { S.agentDraft = input.value; });
 input.addEventListener('keydown', (e) => {
 if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
 });
 input.focus();
 }
 const btn = $('#agSend');
 if (btn) btn.addEventListener('click', send);
 const clr = $('#agClear');
 if (clr) clr.addEventListener('click', async () => {
 if (!confirm('清空所有对话记录？（学习数据不会被删除）')) return;
 await post('/api/agent/clear', {});
 S.agentMsgs = null; S.agentPending = null; S.agentDraft = '';
 toast('对话已清空');
 render();
 });
 // 快捷提问：点击即发送
 $$('.chip').forEach((c) => c.addEventListener('click', () => {
 if (!input) return;
 input.value = c.textContent;
 S.agentDraft = c.textContent;
 send();
 }));
}

/* ---------------- 通用组件 ---------------- */
const bar = (pct, cls = '') => `<div class="bar ${cls}"><i style="width:${Math.max(0, Math.min(100, pct))}%"></i></div>`;
function ringSVG(pct, color = 'var(--brand)', label = '掌握度') {
 const R = 54, C = 2 * Math.PI * R, off = C * (1 - Math.max(0, Math.min(100, pct)) / 100);
 return `<div class="ring"><svg width="132" height="132">
 <circle cx="66" cy="66" r="${R}" fill="none" stroke="#eef2f8" stroke-width="11"/>
 <circle cx="66" cy="66" r="${R}" fill="none" stroke="${color}" stroke-width="11" stroke-linecap="round"
 stroke-dasharray="${C}" stroke-dashoffset="${off}"/>
 </svg><div class="mid"><b>${pct}<small style="font-size:13px">%</small></b><span>${label}</span></div></div>`;
}
const adviceBox = (a) => `<div class="advice ${a.level || 'info'}"><div class="h">${esc(a.title)}</div><div class="b">${esc(a.text)}</div></div>`;

/* ---------------- 1. 驾驶舱 ---------------- */
async function renderDashboard() {
 const o = S.overview, a = o.assessment, p = a.pace;
 if (!S.advice) S.advice = await api('/api/advice');
 const adv = S.advice;

 const subRows = a.subjects.map((s) => `
 <div class="row">
 <span class="dotc" style="background:${SUB_COLOR[s.id]};width:10px;height:10px"></span>
 <div class="grow">
 <div class="t">${esc(s.name)} <span class="small muted2">分值 ${s.score}｜${s.mastered}/${s.total} 点已掌握</span></div>
 <div style="margin-top:5px">${bar(s.score, 'sm')}</div>
 </div>
 <div class="right" style="min-width:112px">
 <div style="font-weight:650">${s.score}<small class="muted2">/100</small></div>
 <div class="small muted2">覆盖 ${s.coverage}%</div>
 </div>
 <span class="tag ${s.risk > 85 ? 'bad' : s.risk > 70 ? 'warn' : 'ok'}">风险 ${s.risk}</span>
 </div>`).join('');

 $('#view').innerHTML = `
 <div class="grid g4">
 <div class="stat hl">
 <div class="k">预估当前水平</div>
 <div class="v">${a.overall.estimated}<small>/150 分</small></div>
 <div class="d">目标 ${a.overall.target} 分${a.overall.targetGap > 0 ? `，还差 ${a.overall.targetGap} 分` : '，已达标'}</div>
 </div>
 <div class="stat">
 <div class="k">整体掌握度</div>
 <div class="v">${a.overall.score}<small>/100</small></div>
 <div class="d">已学 ${a.overall.studied}/${a.overall.total} 个知识点</div>
 </div>
 <div class="stat">
 <div class="k">距初试</div>
 <div class="v">${p.daysLeft}<small>天</small></div>
 <div class="d">未消化约 ${p.remainingHours} 学时</div>
 </div>
 <div class="stat">
 <div class="k">连续打卡</div>
 <div class="v">${o.streak.current}<small>天</small></div>
 <div class="d">累计 ${o.streak.total} 天｜最长 ${o.streak.max} 天</div>
 </div>
 </div>

 <div class="grid g2 mt2" style="align-items:start">
 <div class="card">
 <h3><span class="dot"></span>今日计划 · ${fmtDate(o.assessment.now)} ${wd(o.assessment.now)}
 <span class="tag ${o.strategy.level === 'sprint' ? 'warn' : 'brand'}" style="margin-left:auto">${o.strategy.name}</span></h3>
 ${o.todayPlan.length ? `<div class="rows">${o.todayPlan.slice(0, 6).map(planRow).join('')}</div>
 ${o.todayPlan.length > 6 ? `<div class="small muted mt">… 还有 ${o.todayPlan.length - 6} 项，见「今日计划」</div>` : ''}
 <div class="mt" style="display:flex;gap:8px">
 <button class="btn sm pri" data-goto="plan">查看完整计划</button>
 <button class="btn sm" data-goto="plan">标记完成</button>
 </div>` : `<div class="empty">今天还没有计划<br><button class="btn sm pri mt" id="genPlan">生成今日计划</button></div>`}
 </div>

 <div class="card">
 <h3><span class="dot"></span>学习建议 <span class="small muted2" style="margin-left:auto;font-weight:400">引擎：${esc(adv.engine)}</span></h3>
 ${adv.llmNote ? `<div class="small" style="color:var(--warn);margin-bottom:8px">${esc(adv.llmNote)}</div>` : ''}
 ${adv.items.slice(0, 5).map(adviceBox).join('')}
 <button class="btn sm" id="reAdvice">重新生成建议（调用大模型）</button>
 </div>
 </div>

 <div class="grid g2 mt2" style="align-items:start">
 <div class="card">
 <h3><span class="dot"></span>四科掌握情况</h3>
 <div class="rows">${subRows}</div>
 <div class="mt small muted">风险 = 该科未掌握内容的分值权重占比，越高越需要优先投入。</div>
 </div>
 <div class="card">
 <h3><span class="dot"></span>整体进度</h3>
 <div style="display:flex;gap:20px;align-items:center;flex-wrap:wrap">
 ${ringSVG(a.overall.score)}
 <div style="flex:1;min-width:190px">
 <div class="row" style="border:0;padding:5px 0"><div class="grow"><div class="t">知识点覆盖</div></div><div class="right"><b>${a.overall.coverage}%</b></div></div>
 ${bar(a.overall.coverage, 'sm')}
 <div class="row" style="border:0;padding:5px 0"><div class="grow"><div class="t">掌握扎实</div></div><div class="right"><b>${a.overall.mastered}</b> / ${a.overall.total}</div></div>
 ${bar(Math.round(a.overall.mastered / a.overall.total * 100), 'sm')}
 <div class="mt small muted">提分空间：把薄弱环节补到 85% 掌握，最多可再提约 <b style="color:var(--ok)">${a.overall.potentialScore}</b> 分</div>
 </div>
 </div>
 <div class="mt" style="display:flex;gap:8px;flex-wrap:wrap">
 <button class="btn sm" data-goto="mastery">查看知识图谱</button>
 <button class="btn sm" data-goto="route">未来路线</button>
 <button class="btn sm" data-goto="hot">今日热点</button>
 </div>
 </div>
 </div>`;

 $$('[data-goto]').forEach((b) => b.addEventListener('click', () => {
 $$('#nav button').forEach((x) => x.classList.toggle('on', x.dataset.page === b.dataset.goto));
 S.page = b.dataset.goto; render();
 }));
 const gp = $('#genPlan'); if (gp) gp.addEventListener('click', genPlan);
 $('#reAdvice').addEventListener('click', async (e) => {
 e.target.disabled = true; e.target.textContent = '生成中…';
 try { S.advice = await api('/api/advice?llm=1'); toast('建议已更新' + (S.advice.engine.startsWith('llm') ? '（大模型）' : '')); }
 catch (err) { toast('失败：' + err.message, false); }
 render();
 });
 $$('.chk').forEach(bindChk);
}

function planRow(i) {
 const kindTag = { new: '<span class="tag brand">新学</span>', review: '<span class="tag warn">复习</span>', drill: '<span class="tag bad">专练</span>' }[i.kind] || '';
 return `<div class="row ${i.status === 'done' ? 'done' : ''}">
 <div class="chk ${i.status === 'done' ? 'on' : ''}" data-plan-id="${i.id}">${i.status === 'done' ? '' : ''}</div>
 <div class="grow">
 <div class="t">${esc(i.point?.name || i.point_id)}</div>
 <div class="s">${kindTag} ${i.minutes} 分钟 · ${esc(i.reason || '')}</div>
 </div>
 <div class="right small muted2">${esc((i.point?.subjectName || '').slice(0, 2))}</div>
 </div>`;
}

function bindChk(el) {
 el.addEventListener('click', async () => {
 const id = el.dataset.planId;
 const done = !el.classList.contains('on');
 el.classList.toggle('on'); el.textContent = done ? '' : '';
 try {
 await post('/api/plan/status', { id: Number(id), status: done ? 'done' : 'todo' });
 const item = S.overview.todayPlan.find((x) => x.id === Number(id));
 if (item) item.status = done ? 'done' : 'todo';
 await refreshCore();
 } catch (e) { toast('失败：' + e.message, false); }
 });
}

async function genPlan() {
 try { await post('/api/plan/regenerate', { date: todayStr() }); toast('今日计划已生成'); S.overview = await api('/api/overview'); render(); }
 catch (e) { toast('失败：' + e.message, false); }
}

/* ---------------- 2. 今日计划 ---------------- */
async function renderPlan() {
 S.plan = await api('/api/plan?date=' + todayStr());
 const p = S.plan;
 $('#view').innerHTML = `
 <div class="grid g3">
 <div class="stat"><div class="k">今日任务</div><div class="v">${p.items.length}<small>项</small></div>
 <div class="d">新学 ${p.items.filter((i) => i.kind === 'new').length} · 复习 ${p.items.filter((i) => i.kind === 'review').length} · 专练 ${p.items.filter((i) => i.kind === 'drill').length}</div></div>
 <div class="stat"><div class="k">计划时长</div><div class="v">${p.totalMinutes}<small>分钟</small></div>
 <div class="d">你的上限 ${S.overview.user.daily_minutes} 分钟</div></div>
 <div class="stat"><div class="k">完成度</div><div class="v">${p.progress}<small>%</small></div>
 <div class="d">已完成 ${p.doneMinutes} 分钟</div></div>
 </div>
 <div class="card mt2">
 <h3><span class="dot"></span>${fmtDate(p.date)} ${wd(p.date)} 任务清单
 <span class="tag ${p.strategy.level === 'sprint' ? 'warn' : 'brand'}" style="margin-left:auto">${p.strategy.name}</span>
 <button class="btn sm" id="regen" style="margin-left:8px">重新生成</button></h3>
 <div class="small muted" style="margin-bottom:10px">${esc(p.strategy.note)}</div>
 ${p.items.length ? `<div class="rows">${p.items.map(planRowFull).join('')}</div>` : '<div class="empty">暂无任务，点击「重新生成」</div>'}
 </div>`;
 $('#regen').addEventListener('click', async () => {
 try { await post('/api/plan/regenerate', { date: todayStr() }); toast('已按最新掌握情况重排'); await refreshCore(); render(); }
 catch (e) { toast(e.message, false); }
 });
 $$('.chk').forEach(bindChk);
 $$('[data-log]').forEach((b) => b.addEventListener('click', () => openLogModal(b.dataset.log, b.dataset.kind)));
}

function planRowFull(i) {
 const kindTag = { new: '<span class="tag brand">新学</span>', review: '<span class="tag warn">记忆复习</span>', drill: '<span class="tag bad">薄弱专练</span>' }[i.kind] || '';
 const s = i.point || {};
 return `<div class="row ${i.status === 'done' ? 'done' : ''}">
 <div class="chk ${i.status === 'done' ? 'on' : ''}" data-plan-id="${i.id}">${i.status === 'done' ? '' : ''}</div>
 <div class="grow">
 <div class="t">${kindTag} ${esc(s.name || i.point_id)}</div>
 <div class="s">${esc(s.subjectName || '')} · ${esc(s.chapterName || '')} · 权重 ${s.weight || '—'}｜难度 ${s.diff || '—'}｜${i.minutes} 分钟</div>
 <div class="s" style="color:var(--ink2)">${esc(i.reason || '')}</div>
 </div>
 <div class="right" style="display:flex;gap:6px">
 <button class="btn sm" data-log="${i.point_id}" data-kind="${i.kind}">记一笔</button>
 </div>
 </div>`;
}

/* ---------------- 3. 打卡与记录 ---------------- */
async function renderCheckin() {
 const [ck, lg, heat] = await Promise.all([api('/api/checkins?limit=45'), api('/api/logs?limit=28'), api('/api/heatmap?days=90')]);
 S.heat = heat;
 const st = ck.streak;
 const recent = ck.items.slice(0, 30);
 const maxMin = Math.max(300, ...recent.map((r) => r.minutes));
 $('#view').innerHTML = `
 <div class="grid g4">
 <div class="stat hl"><div class="k">连续打卡</div><div class="v">${st.current}<small>天</small></div><div class="d">最长 ${st.max} 天</div></div>
 <div class="stat"><div class="k">累计打卡</div><div class="v">${st.total}<small>天</small></div><div class="d">近 90 天</div></div>
 <div class="stat"><div class="k">今日状态</div><div class="v">${S.overview.todayCheckin ? S.overview.todayCheckin.minutes + '<small>分钟</small>' : '未打卡'}</div>
 <div class="d">${S.overview.todayCheckin ? '已记录' : '点右上角快速打卡'}</div></div>
 <div class="stat"><div class="k">学习记录</div><div class="v">${lg.items.length}<small>条</small></div><div class="d">最近 28 条</div></div>
 </div>

 <div class="grid g2 mt2" style="align-items:start">
 <div class="card">
 <h3><span class="dot"></span>最近打卡时长</h3>
 <div style="display:flex;align-items:flex-end;gap:3px;height:120px;padding-top:6px">
 ${recent.slice().reverse().map((r) => `<div title="${r.date} ${r.minutes}分钟" style="flex:1;min-width:4px;background:${r.minutes > 240 ? 'var(--ok)' : r.minutes > 120 ? '#7bc47f' : 'var(--warn)'};height:${Math.round(r.minutes / maxMin * 100)}%;border-radius:3px 3px 0 0;opacity:.85"></div>`).join('')}
 </div>
 <div class="small muted2 mt" style="display:flex;justify-content:space-between"><span>${recent.length ? fmtDate(recent.at(-1).date) : ''}</span><span>${recent.length ? fmtDate(recent[0].date) : ''}</span></div>
 <div class="mt" style="display:flex;gap:14px;flex-wrap:wrap" class="small">
 <span class="small muted"><i style="display:inline-block;width:8px;height:8px;background:var(--ok);border-radius:2px"></i> 4h 以上</span>
 <span class="small muted"><i style="display:inline-block;width:8px;height:8px;background:#7bc47f;border-radius:2px"></i> 2-4h</span>
 <span class="small muted"><i style="display:inline-block;width:8px;height:8px;background:var(--warn);border-radius:2px"></i> 2h 以下</span>
 </div>
 </div>

 <div class="card">
 <h3><span class="dot"></span>知识点学习记录</h3>
 <div class="rows">
 ${lg.items.length ? lg.items.slice(0, 12).map((r) => `<div class="row">
 <span class="tag ${SUB_TAG[r.subjectId] || ''}">${esc((r.subjectId || '').toUpperCase())}</span>
 <div class="grow">
 <div class="t">${esc(r.pointName || r.point_id)}</div>
 <div class="s">${fmtDate(r.date)} · ${r.kind === 'study' ? '学习' : r.kind === 'review' ? '复习' : '测试'} · ${r.minutes} 分钟${r.total ? ` · 答对 ${r.correct}/${r.total}` : ''}</div>
 </div>
 ${r.total ? `<span class="tag ${r.correct / r.total >= 0.8 ? 'ok' : r.correct / r.total >= 0.6 ? 'warn' : 'bad'}">${Math.round(r.correct / r.total * 100)}%</span>` : ''}
 </div>`).join('') : '<div class="empty">还没有记录，去计划页点「记一笔」</div>'}
 </div>
 </div>
 </div>

 <div class="card mt2">
 <h3><span class="dot"></span>打卡热力图 <span class="small muted2" style="margin-left:auto;font-weight:400">最近 90 天</span></h3>
 <div class="heat">
 ${Array.from({ length: 90 }, (_, i) => {
 const d = new Date(Date.now() - (89 - i) * 86400000);
 const key = d.toISOString().slice(0, 10);
 const rec = heat.data[key];
 const lvl = !rec || !rec.minutes ? 0 : rec.minutes < 90 ? 1 : rec.minutes < 180 ? 2 : rec.minutes < 300 ? 3 : 4;
 return `<i class="h${lvl}" title="${key} ${rec ? rec.minutes + ' 分钟' : '未学习'}"></i>`;
 }).join('')}
 </div>
 <div class="small muted2 mt" style="display:flex;gap:12px;align-items:center">
 <span>少</span><i class="h0" style="width:11px;height:11px;border-radius:3px;display:inline-block"></i>
 <i class="h1" style="width:11px;height:11px;border-radius:3px;display:inline-block"></i>
 <i class="h2" style="width:11px;height:11px;border-radius:3px;display:inline-block"></i>
 <i class="h3" style="width:11px;height:11px;border-radius:3px;display:inline-block"></i>
 <i class="h4" style="width:11px;height:11px;border-radius:3px;display:inline-block"></i><span>多</span>
 </div>
 </div>`;
}
/* ---------------- 4. 掌握度评估 ---------------- */
async function renderMastery() {
 const a = await api('/api/assessment');
 S.assessment = a;
 const states = a.states;
 const byId = Object.fromEntries(states.map((s) => [s.id, s]));
 const cnt = (st) => states.filter((s) => s.state === st).length;

 const subjectBlocks = (await api('/api/syllabus')).subjects.map((sub) => {
 const subStats = a.assessment.subjects.find((x) => x.id === sub.id);
 const chapters = sub.chapters.map((ch) => {
 const pts = ch.points;
 const avg = pts.length ? Math.round(pts.reduce((s, p) => s + (p.p || 0), 0) / pts.length * 100) : 0;
 return `<div class="chap">
 <div class="ch-hd"><span class="dotc" style="background:${SUB_COLOR[sub.id]}"></span><span class="nm">${esc(ch.name)}</span>
 <span class="sp">${pts.filter((p) => p.state !== 'notstarted').length}/${pts.length} · ${avg}%</span></div>
 <div class="pts">
 ${pts.map((p) => `<div class="pt" data-point="${p.id}" title="${esc(p.name)}｜权重${p.weight}｜难度${p.diff}｜${STATE_TEXT[p.state]}">
 <span class="dotc d-${p.state}"></span>
 <span class="nm">${esc(p.name)}</span>
 ${p.tags.includes('必考') ? '<span class="tag bad" style="padding:0 4px;font-size:10px">必考</span>' : ''}
 <span class="w">${Math.round((p.p || 0) * 100)}%</span></div>`).join('')}
 </div>
 </div>`;
 }).join('');
 return `<div class="tree-sub">
 <div class="hd">
 <span class="dotc" style="background:${SUB_COLOR[sub.id]};width:10px;height:10px"></span>
 <span class="nm">${esc(sub.name)}</span>
 <span class="tag">分值 ${sub.score}</span>
 <span class="sp">
 <span>掌握 ${subStats.score}/100</span><span>覆盖 ${subStats.coverage}%</span>
 <span class="tag ${subStats.risk > 85 ? 'bad' : subStats.risk > 70 ? 'warn' : 'ok'}">风险 ${subStats.risk}</span>
 </span>
 </div>
 <div class="chapters">${chapters}</div>
 </div>`;
 }).join('');

 const weakRows = a.weak.slice(0, 10).map((w) => `<div class="row">
 <div class="grow">
 <div class="t">${esc(w.point.name)}</div>
 <div class="s">${esc(w.point.subjectName)} · ${esc(w.point.chapterName)} · 权重 ${w.point.weight}｜难度 ${w.point.diff}</div>
 </div>
 <div class="right" style="min-width:130px">
 <div style="font-weight:620;color:${w.p < 0.4 ? 'var(--bad)' : 'var(--warn)'}">${Math.round(w.p * 100)}%</div>
 <div class="small muted2">${w.attempts ? `正确率 ${w.accuracy}%（${w.attempts}题）` : '尚未练习'}</div>
 </div>
 <button class="btn sm" data-quicklog="${w.point.id}">去练</button>
 </div>`).join('');

 const levelRows = [
 ['mastered', '已掌握', 'ok', '掌握度 ≥85%，能稳定做对'],
 ['familiar', '较熟练', 'brand', '掌握度 60-85%，需要巩固'],
 ['learning', '学习中', 'warn', '掌握度 <60%，建议优先突破'],
 ['due', '待复习', 'bad', '已到复习节点，正在遗忘'],
 ['notstarted', '未开始', '', '还没有学习记录']
 ].map(([k, t, cls, d]) => `<div class="row">
 <span class="dotc d-${k}"></span>
 <div class="grow"><div class="t">${t}</div><div class="s">${d}</div></div>
 <div class="right"><b>${cnt(k)}</b> <span class="small muted2">个</span></div>
 </div>`).join('');

 $('#view').innerHTML = `
 <div class="grid g4">
 <div class="stat hl"><div class="k">整体掌握度</div><div class="v">${a.assessment.overall.score}<small>/100</small></div><div class="d">加权计算（按考频权重）</div></div>
 <div class="stat"><div class="k">知识点覆盖</div><div class="v">${a.assessment.overall.coverage}<small>%</small></div><div class="d">${a.assessment.overall.studied}/${states.length} 个已学</div></div>
 <div class="stat"><div class="k">待复习</div><div class="v">${cnt('due')}<small>个</small></div><div class="d">已到遗忘临界点</div></div>
 <div class="stat"><div class="k">掌握扎实</div><div class="v">${cnt('mastered')}<small>个</small></div><div class="d">掌握度 ≥85%</div></div>
 </div>

 <div class="grid g2 mt2" style="align-items:start">
 <div class="card">
 <h3><span class="dot"></span>当前最该补的 10 个点 <span class="small muted2" style="margin-left:auto;font-weight:400">按「权重×缺口」排序</span></h3>
 <div class="rows">${weakRows}</div>
 </div>
 <div class="card">
 <h3><span class="dot"></span>知识点状态分布</h3>
 <div class="rows">${levelRows}</div>
 <div class="mt small muted">点击下方知识点的圆点可查看详情并补记学习记录；掌握度会随每次答题与复习动态更新。</div>
 </div>
 </div>

 <div class="card mt2">
 <h3><span class="dot"></span>408 知识图谱 · 143 个知识点逐点追踪
 <button class="btn sm" id="expandAll" style="margin-left:auto">展开/收起</button></h3>
 ${subjectBlocks}
 </div>`;

 $('#expandAll').addEventListener('click', () => {
 $$('.chapters').forEach((c) => c.classList.toggle('hide'));
 });
 $$('[data-point]').forEach((el) => el.addEventListener('click', () => openPointModal(el.dataset.point, byId[el.dataset.point])));
 $$('[data-quicklog]').forEach((b) => b.addEventListener('click', () => openLogModal(b.dataset.quicklog, 'quiz')));
}

/* ---------------- 5. 学习路线 ---------------- */
async function renderRoute() {
 const r = await api('/api/route?days=14');
 S.route = r;
 const s = r.strategy;
 $('#view').innerHTML = `
 <div class="grid g3">
 <div class="stat hl"><div class="k">当前策略</div><div class="v" style="font-size:21px">${s.name}</div><div class="d">系统按剩余时间与你的真实速度自动切换</div></div>
 <div class="stat"><div class="k">剩余可用时间</div><div class="v">${s.capacityHours}<small>学时</small></div><div class="d">${S.overview.assessment.pace.daysLeft} 天 × 日均 ${S.overview.user.daily_minutes} 分钟</div></div>
 <div class="stat"><div class="k">需要消化</div><div class="v">${s.needHours}<small>学时</small></div>
 <div class="d">${s.feasible ? '<span style="color:var(--ok)">时间够用，可稳扎稳打</span>' : '<span style="color:var(--bad)">时间偏紧，已自动取舍低频考点</span>'}</div></div>
 </div>

 <div class="card mt2">
 <h3><span class="dot"></span>策略说明</h3>
 <div class="advice ${s.feasible ? 'ok' : 'warn'}"><div class="h">${s.name}</div><div class="b">${esc(s.note)}</div></div>
 <div class="small muted">动态性体现在：① 每天按复习到期情况重排；② 学习速度低于需要值时自动切换到「保分突击」并降低低频点权重；③ 复习压力大时提高复习占比、减少新内容，避免「边学边忘」。</div>
 </div>

 <div class="card mt2">
 <h3><span class="dot"></span>未来 14 天路线预览</h3>
 <div class="tl">
 ${r.days.map((d) => `<div class="tl-item">
 <div class="tl-date"><b>${fmtDate(d.date).replace('月', '/').replace('日', '')}</b>${wd(d.date)}</div>
 <div class="tl-body">
 <div style="display:flex;gap:9px;align-items:center;flex-wrap:wrap">
 <span class="tag brand">新学 ${d.newCount}</span>
 <span class="tag warn">复习 ${d.reviewCount}</span>
 <span class="small muted2">累计完成 ${d.pct}%</span>
 <div style="flex:1;min-width:90px">${bar(d.pct, 'sm')}</div>
 </div>
 <div class="tl-chips">
 ${d.items.slice(0, 8).map((i) => `<span class="tag ${i.kind === 'new' ? 'brand' : 'warn'}" title="${esc(i.subject || '')}">${esc((i.name || '').slice(0, 16))}</span>`).join('')}
 ${d.items.length > 8 ? `<span class="tag">+${d.items.length - 8}</span>` : ''}
 </div>
 </div>
 </div>`).join('')}
 </div>
 </div>`;
}

/* ---------------- 6. 进度追踪 ---------------- */
async function renderTrend() {
 const [adv, a, heat, lg] = await Promise.all([api('/api/advice'), api('/api/assessment'), api('/api/heatmap?days=90'), api('/api/logs?limit=60')]);
 const p = a.assessment.pace;
 // 每日学习强度（近 30 天）
 const days = [];
 for (let i = 29; i >= 0; i--) {
 const d = new Date(Date.now() - i * 86400000);
 const key = d.toISOString().slice(0, 10);
 days.push({ key, v: heat.data[key]?.items || 0, m: heat.data[key]?.minutes || 0 });
 }
 const maxItems = Math.max(1, ...days.map((d) => d.v));
 const subTrend = a.assessment.subjects.map((s) => `<div class="row">
 <div class="grow"><div class="t">${esc(s.name)}</div>${bar(s.score, 'sm')}</div>
 <div class="right"><b>${s.score}</b><span class="small muted2">/100</span></div></div>`).join('');

 $('#view').innerHTML = `
 <div class="grid g4">
 <div class="stat hl"><div class="k">学习节奏</div><div class="v">${p.dailyAvg}<small>分钟/天</small></div><div class="d">近 14 天日均</div></div>
 <div class="stat"><div class="k">需要达到</div><div class="v">${p.needDailyMinutes}<small>分钟/天</small></div>
 <div class="d">${p.onTrack ? '<span style="color:var(--ok)">当前速度达标</span>' : `<span style="color:var(--bad)">还差 ${p.shortfallMinutes} 分钟/天</span>`}</div></div>
 <div class="stat"><div class="k">有效学习天数</div><div class="v">${p.daysWithWork}<small>/14 天</small></div><div class="d">有学习记录或打卡</div></div>
 <div class="stat"><div class="k">未消化学时</div><div class="v">${p.remainingHours}<small>学时</small></div><div class="d">距初试 ${p.daysLeft} 天</div></div>
 </div>

 <div class="grid g2 mt2" style="align-items:start">
 <div class="card">
 <h3><span class="dot"></span>近 30 天学习强度</h3>
 <div style="display:flex;align-items:flex-end;gap:3px;height:130px">
 ${days.map((d) => `<div title="${d.key} ${d.v} 条记录" style="flex:1;background:${d.v ? 'var(--brand)' : '#e9eef6'};height:${d.v ? Math.max(6, Math.round(d.v / maxItems * 100)) : 4}%;border-radius:3px 3px 0 0;opacity:${d.v ? .8 : 1}"></div>`).join('')}
 </div>
 <div class="small muted2" style="display:flex;justify-content:space-between;margin-top:5px"><span>30 天前</span><span>今天</span></div>
 </div>
 <div class="card">
 <h3><span class="dot"></span>四科进度对比</h3>
 <div class="rows">${subTrend}</div>
 <div class="mt small muted">掌握度按月对比：继续打卡与复习，下周再看这个数字的变化。</div>
 </div>
 </div>

 <div class="card mt2">
 <h3><span class="dot"></span>建议与诊断 <span class="small muted2" style="margin-left:auto;font-weight:400">引擎：${esc(adv.engine)}</span></h3>
 ${adv.items.map(adviceBox).join('')}
 </div>

 <div class="card mt2">
 <h3><span class="dot"></span>最近学习记录</h3>
 <table><thead><tr><th>日期</th><th>知识点</th><th>类型</th><th class="num">时长</th><th class="num">正确率</th></tr></thead><tbody>
 ${lg.items.slice(0, 20).map((r) => `<tr><td>${fmtDate(r.date)}</td><td>${esc(r.pointName || r.point_id)}</td>
 <td>${r.kind === 'study' ? '学习' : r.kind === 'review' ? '复习' : '测试'}</td>
 <td class="num">${r.minutes} 分钟</td>
 <td class="num">${r.total ? Math.round(r.correct / r.total * 100) + '%' : '—'}</td></tr>`).join('')}
 </tbody></table>
 </div>`;
}

/* ---------------- 7. 考研热点 ---------------- */
async function renderHot() {
 if (!S.hot) S.hot = await api('/api/hot');
 const h = S.hot;
 const groups = [
 ['official', '研招网官方资讯', '', h.official],
 ['tip', '408 高频考点提醒', '', h.tips]
 ];
 $('#view').innerHTML = `
 <div class="grid g2" style="align-items:start">
 ${groups.map(([k, title, ic, list]) => `<div class="card">
 <h3><span class="dot"></span>${ic} ${title} <span class="small muted2" style="margin-left:auto;font-weight:400">${list.length} 条</span></h3>
 <div class="rows">${list.map((x) => `<div class="row">
 <div class="grow"><div class="t">${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a>` : esc(x.title)}</div>
 <div class="s">${esc(x.source || '')}</div></div></div>`).join('')}</div>
 </div>`).join('')}
 </div>

 <div class="card mt2">
 <h3><span class="dot"></span>全网热搜中的考研 / 计算机相关
 <span class="small muted2" style="margin-left:auto;font-weight:400">从知乎/微博/头条/抖音热榜实时筛选</span>
 <button class="btn sm" id="reHot" style="margin-left:8px">刷新</button></h3>
 ${h.hot.length ? `<div class="rows">${h.hot.map((x) => `<div class="row">
 <span class="tag ${x.category === '考研相关' ? 'brand' : ''}">${esc(x.category)}</span>
 <div class="grow"><div class="t">${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a>` : esc(x.title)}</div>
 <div class="s">${esc(x.source)} · 匹配关键词：${esc((x.matched || []).join('、'))}</div></div>
 </div>`).join('')}</div>` : '<div class="empty">当前热搜里没有匹配到考研相关内容，稍后再刷新试试</div>'}
 <div class="mt small muted2">抓取时间：${new Date(h.generatedAt).toLocaleString('zh-CN')}${h.cached ? '（缓存）' : ''}${h.degraded ? '（网络受限，已显示内置考点提醒）' : ''}</div>
 </div>`;
 $('#reHot').addEventListener('click', async () => { S.hot = await api('/api/hot?force=1'); toast('已刷新'); render(); });
}

/* ---------------- 8. 关于与设置 ---------------- */
async function renderAbout() {
 const o = S.overview;
 const u = o.user;
 $('#view').innerHTML = `
 <div class="grid g2" style="align-items:start">
 <div class="card">
 <h3><span class="dot"></span>个人信息与目标</h3>
 <div class="field"><label>称呼</label><input id="fName" value="${esc(u.name)}"></div>
 <div class="field"><label>初试日期</label><input id="fExam" type="date" value="${esc(u.exam_date)}">
 <div class="hint">当前距考 ${o.assessment.pace.daysLeft} 天，计划按此日期倒推。</div></div>
 <div class="field"><label>每天可投入时间（分钟）</label><input id="fMin" type="number" min="30" max="900" step="10" value="${u.daily_minutes}"></div>
 <div class="field"><label>408 目标分（满分 150）</label><input id="fScore" type="number" min="60" max="150" value="${u.target_score}">
 <div class="hint">参考：计算机考研 408 平均分约 85-95，985 院校通常需 110+。</div></div>
 <div class="actions"><button class="btn pri" id="saveUser">保存设置</button></div>
 </div>

 <div class="card">
 <h3><span class="dot"></span>AI 增强与数据</h3>
 <div class="advice info">
 <div class="h">大模型状态：${o.llm.healthy ? '连接正常' : (o.llm.enabled ? '已配置但当前不可用' : '未配置（使用本地规则引擎）')}</div>
 <div class="b">${o.llm.healthy
 ? `当前模型 <b>${esc(o.llm.model)}</b>，用于生成更专业的个性化学习建议。所有掌握度计算、计划排布均由本地算法完成，不依赖网络。`
 : (o.llm.enabled
 ? `已配置模型 <b>${esc(o.llm.model)}</b>，但当前调用失败：<b>${esc(o.llm.reason || '未知原因')}</b>。系统已自动回退本地规则引擎，<b>全部功能不受影响</b>。`
 : '设置环境变量 KY_LLM_KEY（或在 ~/.bailian/config.json 配置百炼 Key）后，学习建议会自动升级为大模型生成。')}</div>
 </div>
 <div class="rows mt">
 <div class="row"><div class="grow"><div class="t">知识体系规模</div><div class="s">4 门课 · ${o.syllabus.chapters} 章 · ${o.syllabus.points} 个知识点 · ${o.syllabus.hours} 学时</div></div></div>
 <div class="row"><div class="grow"><div class="t">打卡记录</div><div class="s">累计 ${o.streak.total} 天，最长连续 ${o.streak.max} 天</div></div></div>
 <div class="row"><div class="grow"><div class="t">数据存储</div><div class="s">本地 SQLite（data/kaoyan.db），全部离线可用</div></div></div>
 </div>
 <div class="mt" style="display:flex;gap:9px;flex-wrap:wrap">
 <button class="btn" id="btnSeed2">载入演示数据</button>
 <button class="btn" id="btnReset" style="color:var(--bad)">清空我的数据</button>
 </div>
 <div class="mt small muted2">清空只影响当前用户的学习记录，知识体系不变。</div>
 </div>
 </div>

 <div class="card mt2">
 <h3><span class="dot"></span>这套助手是怎么评估和规划的</h3>
 <div class="grid g2">
 <div>
 <div style="font-weight:600;margin-bottom:6px">① 掌握度模型</div>
 <div class="small muted">采用贝叶斯知识追踪（BKT）：每次答题后按「答对可能是真会、也可能是蒙对」的概率模型更新掌握概率；再叠加艾宾浩斯遗忘曲线（记忆稳定度半衰期），随时间自然衰减。所以「一个月前学过」和「昨天复习过」的同一个知识点，掌握度是不同的。</div>
 </div>
 <div>
 <div style="font-weight:600;margin-bottom:6px">② 动态路线规划</div>
 <div class="small muted">每天按「复习到期压力 → 高频薄弱点专练 → 新知识点（含前置依赖）」的优先级排产；时间不足时自动降级低频考点。计划未完成会自动重排，不做无效焦虑的打卡表。</div>
 </div>
 <div class="mt">
 <div style="font-weight:600;margin-bottom:6px">③ 评估与分数映射</div>
 <div class="small muted">以考纲权重为系数聚合知识点掌握度，形成科目/章节/全局三级评分；并用经验曲线把掌握度映射到 408 满分 150 的预估分（掌握度 50% ≈ 95 分，85% ≈ 135 分）。</div>
 </div>
 <div class="mt">
 <div style="font-weight:600;margin-bottom:6px">④ 热点推送</div>
 <div class="small muted">聚合研招网官方资讯，并从知乎/微博/头条/抖音热榜中按关键词实时筛选考研与计算机相关内容，避免信息噪音。</div>
 </div>
 </div>
 </div>`;

 $('#saveUser').addEventListener('click', async () => {
 try {
 await post('/api/user', { name: $('#fName').value, exam_date: $('#fExam').value,
 daily_minutes: Number($('#fMin').value), target_score: Number($('#fScore').value) });
 toast('已保存'); S.plan = null; S.route = null; S.advice = null;
 await refreshCore(); render();
 } catch (e) { toast(e.message, false); }
 });
 $('#btnSeed2').addEventListener('click', () => $('#btnSeed').click());
 $('#btnReset').addEventListener('click', async () => {
 if (!confirm('确定清空所有学习记录、掌握度与计划？')) return;
 await post('/api/reset'); S.advice = null; S.plan = null; S.route = null; S.states = null;
 await refreshCore(); render(); toast('已清空');
 });
}

/* ---------------- 弹窗 ---------------- */
function closeModal() { $('#modalHolder').innerHTML = ''; }
function openModal(html) {
 $('#modalHolder').innerHTML = `<div class="mask" id="mask"><div class="modal">${html}</div></div>`;
 $('#mask').addEventListener('click', (e) => { if (e.target.id === 'mask') closeModal(); });
}

function openCheckinModal(preset = {}) {
 const t = S.overview?.todayCheckin;
 openModal(`
 <h3> 今日打卡</h3>
 <div class="field"><label>今天学习时长（分钟）</label><input id="mMin" type="number" min="0" step="10" value="${preset.minutes ?? t?.minutes ?? 180}"></div>
 <div class="field"><label>今天的状态</label>
 <div class="stars" id="mMood">${[1, 2, 3, 4, 5].map((i) => `<i data-v="${i}" class="${i <= (preset.mood ?? t?.mood ?? 4) ? 'on' : ''}"></i>`).join('')}</div>
 <div class="hint">1=很疲惫，5=状态极佳。状态低时系统会建议「最小启动」而不是硬扛。</div></div>
 <div class="field"><label>今天学了什么 / 心得（可选）</label><textarea id="mNote" rows="2" placeholder="例如：数据结构图论部分，最小生成树还是不清楚">${esc(t?.note || '')}</textarea></div>
 <div class="actions"><button class="btn" id="mCancel">取消</button><button class="btn pri" id="mSave">保存打卡</button></div>`);
 let mood = preset.mood ?? t?.mood ?? 4;
 $$('#mMood i').forEach((el) => el.addEventListener('click', () => {
 mood = Number(el.dataset.v);
 $$('#mMood i').forEach((x) => x.classList.toggle('on', Number(x.dataset.v) <= mood));
 }));
 $('#mCancel').addEventListener('click', closeModal);
 $('#mSave').addEventListener('click', async () => {
 try {
 await post('/api/checkin', { minutes: Number($('#mMin').value), mood, note: $('#mNote').value });
 closeModal(); toast('打卡成功，继续保持！');
 await refreshCore();
 if (S.page === 'checkin' || S.page === 'trend' || S.page === 'dashboard') render();
 } catch (e) { toast(e.message, false); }
 });
}

function openLogModal(pointId, kind) {
 const pt = (S.assessment?.states || []).find((x) => x.id === pointId);
 const name = pt?.name || pointId;
 const defaultKind = kind === 'review' ? 'review' : kind === 'drill' ? 'quiz' : 'study';
 openModal(`
 <h3>记一笔学习记录</h3>
 <div class="field"><label>知识点</label><input value="${esc(name)}" disabled></div>
 <div class="field"><label>类型</label>
 <div class="seg" id="lKind">
 <button data-v="study" class="${defaultKind === 'study' ? 'on' : ''}">学习新知识</button>
 <button data-v="review" class="${defaultKind === 'review' ? 'on' : ''}">复习</button>
 <button data-v="quiz" class="${defaultKind === 'quiz' ? 'on' : ''}">做测试/真题</button>
 </div></div>
 <div class="field"><label>学习时长（分钟）</label><input id="lMin" type="number" min="0" step="5" value="30"></div>
 <div class="field"><label>做题情况（可选，填了才能更准确评估）</label>
 <div style="display:flex;gap:9px;align-items:center">
 <input id="lCorrect" type="number" min="0" style="flex:1" placeholder="答对题数">
 <span class="muted">/</span>
 <input id="lTotal" type="number" min="0" style="flex:1" placeholder="总题数">
 </div>
 <div class="hint">这是掌握度评估的关键输入：做对越多，掌握度与记忆稳定度提升越快；做错会触发更高的复习频率。</div></div>
 <div class="field"><label>自评掌握程度</label>
 <div class="stars" id="lSelf">${[1, 2, 3, 4, 5].map((i) => `<i data-v="${i}" class="${i <= 3 ? 'on' : ''}"></i>`).join('')}</div></div>
 <div class="actions"><button class="btn" id="lCancel">取消</button><button class="btn pri" id="lSave">保存</button></div>`);
 let k = defaultKind, self = 3;
 $$('#lKind button').forEach((b) => b.addEventListener('click', () => {
 k = b.dataset.v; $$('#lKind button').forEach((x) => x.classList.toggle('on', x === b));
 }));
 $$('#lSelf i').forEach((el) => el.addEventListener('click', () => {
 self = Number(el.dataset.v);
 $$('#lSelf i').forEach((x) => x.classList.toggle('on', Number(x.dataset.v) <= self));
 }));
 $('#lCancel').addEventListener('click', closeModal);
 $('#lSave').addEventListener('click', async () => {
 const total = Number($('#lTotal').value || 0), correct = Number($('#lCorrect').value || 0);
 if (total && correct > total) return toast('答对数不能大于总题数', false);
 try {
 const r = await post('/api/log', { point_id: pointId, kind: k, minutes: Number($('#lMin').value || 0),
 correct, total, self_rating: self });
 closeModal();
 toast(`${r.point} 已记录，掌握度更新为 ${Math.round(r.mastery.p * 100)}%，下次复习建议 ${r.mastery.next_review}`);
 S.assessment = null; S.advice = null; S.plan = null;
 await refreshCore();
 render();
 } catch (e) { toast(e.message, false); }
 });
}

function openPointModal(id, st) {
 const p = st || {};
 const stateText = STATE_TEXT[p.state] || '未知';
 openModal(`
 <h3>${esc(p.name || id)}</h3>
 <div class="rows" style="margin-bottom:12px">
 <div class="row"><div class="grow"><div class="t">所属</div></div><div class="right small muted">${esc(p.subjectName || '')} · ${esc(p.chapterName || '')}</div></div>
 <div class="row"><div class="grow"><div class="t">考频权重 / 难度</div></div><div class="right small muted">${p.weight || '—'} / ${p.diff || '—'}</div></div>
 <div class="row"><div class="grow"><div class="t">当前掌握度</div></div><div class="right"><b>${Math.round((p.p || 0) * 100)}%</b> <span class="tag ${p.state === 'mastered' ? 'ok' : p.state === 'due' ? 'bad' : 'warn'}">${stateText}</span></div></div>
 <div class="row"><div class="grow"><div class="t">练习正确率</div></div><div class="right small muted">${p.accuracy !== null && p.accuracy !== undefined ? p.accuracy + '%（' + (p.attempts || 0) + ' 题）' : '尚未练习'}</div></div>
 <div class="row"><div class="grow"><div class="t">下次建议复习</div></div><div class="right small muted">${p.nextReview ? fmtDate(p.nextReview) : '—'}</div></div>
 </div>
 ${p.tags && p.tags.length ? p.tags.map((t) => `<span class="tag ${t === '必考' ? 'bad' : t === '难点' ? 'warn' : 'brand'}">${esc(t)}</span> `).join('') : ''}
 <div class="actions">
 <button class="btn" id="pClose">关闭</button>
 <button class="btn pri" id="pLog">记录一次学习 / 测试</button>
 </div>`);
 $('#pClose').addEventListener('click', closeModal);
 $('#pLog').addEventListener('click', () => { closeModal(); openLogModal(id, 'quiz'); });
}

boot().catch((e) => { document.body.innerHTML = '<div class="empty">启动失败：' + esc(e.message) + '</div>'; });
