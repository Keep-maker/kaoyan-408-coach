// ============================================================
//  408 考研学习助手 · 服务端（零依赖，Node 内置 http + sqlite）
// ============================================================
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { q, DB_FILE } = require('./lib/db');
const E = require('./lib/engine');
const S = require('./data/syllabus');
const hot = require('./lib/hot');
const llm = require('./lib/llm');
const agentBrain = require('./lib/agent-brain');
const agentReply = require('./lib/agent-reply');
const agentCore = require('./lib/agent');
const session = require('./lib/session');
const { stripEmoji } = require('./lib/text');
const { AsyncLocalStorage } = require('node:async_hooks');
const als = new AsyncLocalStorage();

const PORT = Number(process.env.PORT || 4080);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- 工具 ----------
const send = (res, code, body, type = 'application/json; charset=utf-8', extra = null) => {
  // 出口净化：递归去掉字符串中的 emoji（模型回复也无法绕过）
  const clean = (v) => {
    if (typeof v === 'string') return stripEmoji(v);
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === 'object') {
      const o = {};
      for (const k of Object.keys(v)) o[k] = clean(v[k]);
      return o;
    }
    return v;
  };
  const data = type.includes('json') ? JSON.stringify(clean(body)) : body;
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store' };
  if (extra) Object.assign(headers, extra);
  res.writeHead(code, headers);
  res.end(data);
};
const safeJson = (s) => { try { return JSON.parse(s); } catch (_) { return []; } };
const readBody = (req) => new Promise((resolve, reject) => {
  let b = '';
  req.on('data', (c) => { b += c; if (b.length > 2e6) req.destroy(); });
  req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { reject(e); } });
  req.on('error', reject);
});

// 创建一份全新的用户（每个访客一份独立数据空间）
function createUser() {
  q.run(`INSERT INTO users (name, exam_date, daily_minutes, target_score, start_date) VALUES (?,?,?,?,?)`,
    '考研同学', E.addDays(E.todayStr(), 66), 240, 110, E.todayStr());
  return q.get('SELECT * FROM users ORDER BY id DESC LIMIT 1');
}

// 当前请求的用户：由 Cookie 中的 sid 决定（数据隔离的核心）
// - 有合法 sid → 对应 user
// - 无 / 非法 sid → 新建用户并签发新 sid（在响应里 Set-Cookie）
function currentUser() {
  const ctx = als.getStore();
  if (ctx) {
    if (ctx.user) return ctx.user;
    let uid2 = session.userIdFor(ctx.sid);
    if (uid2) {
      const u = q.get('SELECT * FROM users WHERE id=?', uid2);
      if (u) { ctx.user = u; return u; }
    }
    // 新访客 / sid 失效 → 分配独立用户
    const nu = createUser();
    const sid = ctx.sid && !session.userIdFor(ctx.sid) ? ctx.sid : session.newSid();
    session.bind(sid, nu.id);
    ctx.sid = sid;
    ctx.newCookie = true;
    ctx.user = nu;
    return nu;
  }
  // 无请求上下文（脚本 / 启动自检）：退化为首个用户，没有则创建
  let u = q.get('SELECT * FROM users ORDER BY id LIMIT 1');
  if (!u) u = createUser();
  return u;
}
const uid = () => currentUser().id;

// ---------- 路由 ----------
const routes = {};
const route = (method, p, fn) => { routes[method + ' ' + p] = fn; };

// 概览
route('GET', '/api/overview', () => {
  const u = currentUser();
  const a = E.assessment(u.id);
  const st = E.strategy(u.id);
  const due = E.pointStates(u.id).filter((p) => p.state === 'due').length;
  const today = q.get('SELECT * FROM checkins WHERE user_id=? AND date=?', u.id, E.todayStr());
  const plan = q.all('SELECT * FROM plan WHERE user_id=? AND date=? ORDER BY priority DESC', u.id, E.todayStr())
    .map((i) => ({ ...i, point: S.POINT_BY_ID[i.point_id] }));
  const streak = calcStreak(u.id);
  const examYear = Number(String(u.exam_date).slice(0, 4)) + (Number(String(u.exam_date).slice(5, 7)) >= 10 ? 1 : 0);
  return {
    user: u, assessment: a, strategy: st, dueCount: due, todayCheckin: today || null,
    todayPlan: plan, streak, examLabel: examYear + ' 考研',
    syllabus: { points: S.POINTS.length, chapters: S.CHAPTERS.length, hours: S.TOTAL_HOURS },
    llm: llm.info()
  };
});

function calcStreak(userId) {
  const rows = q.all('SELECT date FROM checkins WHERE user_id=? ORDER BY date DESC LIMIT 400', userId).map((r) => r.date);
  if (!rows.length) return { current: 0, max: 0, total: 0 };
  const set = new Set(rows);
  let cur = 0;
  let d = E.todayStr();
  if (!set.has(d)) d = E.addDays(d, -1); // 今天还没打卡不算断
  while (set.has(d)) { cur += 1; d = E.addDays(d, -1); }
  // 最长连续
  const sorted = [...rows].sort();
  let max = 0, run = 0, prev = null;
  sorted.forEach((x) => {
    run = prev && E.daysBetween(prev, x) === 1 ? run + 1 : 1;
    max = Math.max(max, run); prev = x;
  });
  return { current: cur, max, total: rows.length };
}

// 用户设置
route('POST', '/api/user', async (req) => {
  const b = await readBody(req);
  const u = currentUser();
  q.run(`UPDATE users SET name=?, exam_date=?, daily_minutes=?, target_score=? WHERE id=?`,
    b.name ?? u.name, b.exam_date ?? u.exam_date,
    Number(b.daily_minutes ?? u.daily_minutes), Number(b.target_score ?? u.target_score), u.id);
  return { ok: true, user: q.get('SELECT * FROM users WHERE id=?', u.id) };
});

// 打卡
route('POST', '/api/checkin', async (req) => {
  const b = await readBody(req);
  const u = uid();
  const date = b.date || E.todayStr();
  const minutes = Number(b.minutes || 0);
  const mood = Number(b.mood || 3);
  q.run(`INSERT INTO checkins (user_id,date,minutes,mood,note) VALUES (?,?,?,?,?)
         ON CONFLICT(user_id,date) DO UPDATE SET minutes=excluded.minutes, mood=excluded.mood, note=excluded.note`,
    u, date, minutes, mood, b.note || null);
  return { ok: true, checkin: q.get('SELECT * FROM checkins WHERE user_id=? AND date=?', u, date), streak: calcStreak(u) };
});
route('GET', '/api/checkins', (req, url) => {
  const u = uid();
  const limit = Number(url.searchParams.get('limit') || 60);
  return { items: q.all('SELECT * FROM checkins WHERE user_id=? ORDER BY date DESC LIMIT ?', u, limit), streak: calcStreak(u) };
});

// 学习记录
route('POST', '/api/log', async (req) => {
  const b = await readBody(req);
  const u = uid();
  const pointId = b.point_id;
  if (!S.POINT_BY_ID[pointId]) throw new Error('未知知识点: ' + pointId);
  const date = b.date || E.todayStr();
  const kind = b.kind || 'study';
  const total = Number(b.total || 0);
  const correct = Number(b.correct || 0);
  const minutes = Number(b.minutes || 0);

  q.run(`INSERT INTO logs (user_id,point_id,date,minutes,kind,correct,total,self_rating,note)
         VALUES (?,?,?,?,?,?,?,?,?)`,
    u, pointId, date, minutes, kind, correct, total, Number(b.self_rating || 0), b.note || null);

  const m = E.applyLog(u, { point_id: pointId, date, kind, minutes, correct, total, self_rating: Number(b.self_rating || 0) });

  // 若今天计划里有该点，标记完成
  q.run(`UPDATE plan SET status='done' WHERE user_id=? AND date=? AND point_id=? AND status='todo'`, u, date, pointId);

  // 若忘记打卡，用学习记录自动补一条
  const ck = q.get('SELECT * FROM checkins WHERE user_id=? AND date=?', u, date);
  if (ck) q.run('UPDATE checkins SET minutes=minutes+? WHERE id=?', minutes, ck.id);
  else q.run('INSERT INTO checkins (user_id,date,minutes,mood,note) VALUES (?,?,?,?,?)', u, date, minutes, 3, '（由学习记录自动生成）');

  return { ok: true, mastery: m, point: S.POINT_BY_ID[pointId].name };
});
route('GET', '/api/logs', (req, url) => {
  const u = uid();
  const limit = Number(url.searchParams.get('limit') || 30);
  const rows = q.all('SELECT * FROM logs WHERE user_id=? ORDER BY id DESC LIMIT ?', u, limit);
  return { items: rows.map((r) => ({ ...r, pointName: S.POINT_BY_ID[r.point_id]?.name, subjectId: S.POINT_BY_ID[r.point_id]?.subjectId })) };
});

// 知识体系 + 掌握状态
route('GET', '/api/syllabus', () => {
  const u = uid();
  const states = E.pointStates(u);
  const byId = Object.fromEntries(states.map((s) => [s.id, s]));
  const subjects = S.SUBJECTS.map((sub) => ({
    id: sub.id, name: sub.name, color: sub.color, score: sub.score,
    chapters: sub.chapters.map((ch) => ({
      id: ch.id, name: ch.name,
      points: S.POINTS.filter((p) => p.chapterId === ch.id).map((p) => {
        const s = byId[p.id];
        return { id: p.id, name: p.name, weight: p.weight, diff: p.diff, hours: p.hours, tags: p.tags,
          p: s.p, state: s.state, nextReview: s.nextReview, accuracy: s.accuracy, attempts: s.attempts };
      })
    }))
  }));
  return { subjects, total: S.POINTS.length };
});

// 掌握情况评估
route('GET', '/api/assessment', () => {
  const u = uid();
  return { assessment: E.assessment(u), weak: E.weakPoints(u, 15), states: E.pointStates(u) };
});

// 今日计划 / 重新生成
route('GET', '/api/plan', (req, url) => {
  const u = uid();
  const date = url.searchParams.get('date') || E.todayStr();
  const r = E.buildDayPlan(u, date);
  const withNames = r.items.map((i) => ({ ...i, point: S.POINT_BY_ID[i.point_id] }));
  const totalMinutes = withNames.reduce((s, i) => s + i.minutes, 0);
  const doneMinutes = withNames.filter((i) => i.status === 'done').reduce((s, i) => s + i.minutes, 0);
  return { date, items: withNames, strategy: r.strategy, totalMinutes, doneMinutes,
    progress: totalMinutes ? Math.round((doneMinutes / totalMinutes) * 100) : 0 };
});
route('POST', '/api/plan/regenerate', async (req) => {
  const b = await readBody(req);
  const u = uid();
  const date = b.date || E.todayStr();
  const r = E.buildDayPlan(u, date, { regenerate: true });
  return { ok: true, count: r.items.length, strategy: r.strategy };
});
route('POST', '/api/plan/status', async (req) => {
  const b = await readBody(req);
  const u = uid();
  q.run('UPDATE plan SET status=? WHERE user_id=? AND id=?', b.status || 'done', u, Number(b.id));
  return { ok: true };
});

// 路线预览
route('GET', '/api/route', (req, url) => {
  const u = uid();
  const days = Number(url.searchParams.get('days') || 14);
  const r = E.routePreview(u, days);
  return { strategy: r.strategy, days: r.days.map((d) => ({
    ...d,
    items: d.items.map((i) => ({ ...i, name: S.POINT_BY_ID[i.id]?.name, subject: S.POINT_BY_ID[i.id]?.subjectName }))
  })) };
});

// 学习建议
route('GET', '/api/advice', async (req, url) => {
  const u = uid();
  const useLLM = url.searchParams.get('llm') === '1';
  const local = E.localAdvice(u);
  if (!useLLM || !llm.available()) {
    return { ...local, llmNote: useLLM ? '大模型未配置，已使用本地规则引擎' : null };
  }
  try {
    const a = E.assessment(u);
    const weak = E.weakPoints(u, 8);
    const prompt = `你是一位资深计算机考研（408）辅导老师。请基于以下学生数据，给出 4-6 条具体、可执行的学习建议。
数据：
- 目标分 ${a.overall.target}，预估当前 ${a.overall.estimated} 分
- 剩余 ${a.pace.daysLeft} 天，未消化约 ${a.pace.remainingHours} 学时，日均学习 ${a.pace.dailyAvg} 分钟，需要日均 ${a.pace.needDailyMinutes} 分钟
- 四科掌握度：${a.subjects.map((s) => `${s.name} ${s.score}/100（覆盖${s.coverage}%）`).join('；')}
- 最薄弱知识点：${weak.slice(0, 6).map((w) => `${w.point.name}(${w.point.subjectName},掌握${Math.round(w.p * 100)}%${w.accuracy !== null ? ',正确率' + w.accuracy + '%' : ',未练习'})`).join('；')}
要求：每条建议包含「做什么 + 为什么 + 具体做法」，针对 408 四门课的特点（数据结构算法题、组原理计算题、操作系统同步与置换、网络协议计算）。用中文，条理清晰，不要客套话。
严格按 JSON 数组输出，每项：{"title":"短标题","text":"建议正文","level":"ok|info|warn"}，不要输出其他内容。`;
    const raw = await llm.chat([
      { role: 'system', content: '你是严谨的计算机考研辅导老师，只输出合法 JSON。' },
      { role: 'user', content: prompt }
    ], { temperature: 0.5, maxTokens: 4000, timeoutMs: 150000 });
    const m = raw.match(/\[[\s\S]*\]/);
    const items = m ? JSON.parse(m[0]) : [];
    if (!items.length) throw new Error('LLM_EMPTY_ADVICE');   // 空/解析失败 → 走本地回退
    const merged = { generatedAt: new Date().toISOString(), engine: 'llm:' + llm.info().model,
      items: [...items, ...local.items], localItems: local.items };
    q.run('INSERT INTO advice_cache (user_id,date,content,engine) VALUES (?,?,?,?)', u, E.todayStr(), JSON.stringify(merged), merged.engine);
    return merged;
  } catch (e) {
    return { ...local, llmNote: '大模型调用失败（' + e.message + '），已回退本地规则引擎' };
  }
});

// 热点
route('GET', '/api/hot', async (req, url) => {
  const force = url.searchParams.get('force') === '1';
  const r = await hot.collect({ force });
  return r;
});

// 打卡日历热力（近 N 天）
route('GET', '/api/heatmap', (req, url) => {
  const u = uid();
  const days = Number(url.searchParams.get('days') || 120);
  const from = E.addDays(E.todayStr(), -days + 1);
  const ck = q.all('SELECT date, minutes FROM checkins WHERE user_id=? AND date>=?', u, from);
  const lg = q.all(`SELECT date, SUM(minutes) m, COUNT(*) c FROM logs WHERE user_id=? AND date>=? GROUP BY date`, u, from);
  const map = {};
  ck.forEach((r) => { map[r.date] = { minutes: r.minutes, items: 0 }; });
  lg.forEach((r) => {
    map[r.date] = map[r.date] || { minutes: 0, items: 0 };
    map[r.date].minutes = Math.max(map[r.date].minutes, r.m || 0);
    map[r.date].items = r.c;
  });
  return { from, to: E.todayStr(), data: map };
});

// 知识体系原始数据（前端画图用）
route('GET', '/api/syllabus/raw', () => ({ subjects: S.SUBJECTS, points: S.POINTS, totalHours: S.TOTAL_HOURS }));

// 演示数据（一键填充，便于答辩/演示）
route('POST', '/api/demo/seed', async (req) => {
  const b = await readBody(req);
  const u = uid();
  const days = Number(b.days || 60);
  const rnd = (seed) => { const x = Math.sin(seed * 12.9898) * 43758.5453; return x - Math.floor(x); };

  // 清空旧数据
  q.tx(() => {
    ['checkins', 'logs', 'mastery', 'plan', 'advice_cache'].forEach((t) => q.run(`DELETE FROM ${t} WHERE user_id=?`, u));
  });

  // 三档掌握水平的知识点（模拟一个复习到中期的考生）
  const strong = ['ds1-1','ds1-2','ds1-3','ds1-4','ds2-1','ds2-2','ds2-3','ds3-1','ds3-2','ds3-3','ds3-7','ds4-1','ds4-3','ds4-4','co1-1','co1-2','co2-1','co2-2','co2-3','co2-5','os1-1','os1-2','os1-3','os2-1','os2-2','cn1-1','cn1-2','cn1-3','cn1-4','cn2-1'];
  const medium = ['ds2-4','ds3-4','ds3-6','ds4-2','ds4-7','ds5-1','ds6-1','ds6-6','co2-7','co3-1','co3-2','co3-3','co4-1','co5-1','co5-2','os1-4','os2-3','os2-4','os2-5','os3-1','os4-1','cn2-2','cn2-3','cn3-1','cn3-7','cn5-1','cn5-2'];
  const weak = ['ds3-5','ds4-5','ds4-6','ds4-8','ds5-3','ds5-4','ds6-2','ds6-3','co2-4','co2-6','co3-5','co3-8','co5-5','co5-6','co7-2','co7-3','os2-8','os2-9','os2-12','os3-6','os4-4','os4-5','cn3-4','cn3-5','cn4-3','cn5-4','cn5-5','cn5-7'];

  const dayList = [];
  for (let i = days; i >= 0; i--) dayList.push(E.addDays(E.todayStr(), -i));
  const date = (back) => dayList[Math.max(0, dayList.length - 1 - back)];

  let logCount = 0;
  const learn = (id, plan) => {
    const pt = S.POINT_BY_ID[id];
    if (!pt) return;
    // plan: [{back, kind, acc, total}] 按时间顺序（back 从大到小）
    plan.forEach((step) => {
      const total = step.total || (5 + Math.floor(rnd(logCount + 1) * 5));
      const acc = Math.max(0.15, Math.min(0.98, step.acc + (rnd(logCount * 3.1) - 0.5) * 0.12));
      const correct = Math.max(0, Math.min(total, Math.round(total * acc)));
      const d = date(step.back);
      const minutes = step.kind === 'study' ? Math.round(pt.hours * 50) : Math.round(8 + rnd(logCount) * 10);
      q.run(`INSERT INTO logs (user_id,point_id,date,minutes,kind,correct,total,self_rating,note)
             VALUES (?,?,?,?,?,?,?,?,?)`,
        u, id, d, minutes, step.kind, correct, total, Math.round(acc * 5), null);
      E.applyLog(u, { point_id: id, date: d, kind: step.kind, minutes, correct, total, self_rating: Math.round(acc * 5) });
      logCount += 1;
    });
  };

  // 强项：早期学过 + 多轮复习 → 掌握扎实、稳定度高
  strong.forEach((id, i) => {
    const t0 = days - 6 - Math.floor(rnd(i + 2) * (days * 0.45));
    const gap = Math.max(3, Math.round((days - 6 - t0) / 3));
    const steps = [{ back: Math.max(0, t0), kind: 'study', acc: 0.62 }];
    let t = t0;
    while (t > 3) {
      t -= gap;
      if (t <= 0) break;
      steps.push({ back: Math.max(1, t), kind: 'review', acc: 0.88 });
    }
    steps.sort((a, b2) => b2.back - a.back);
    learn(id, steps);
  });

  // 中等：学过但复习少 → 掌握一般、部分即将到期
  medium.forEach((id, i) => {
    const t0 = Math.floor(days * 0.45) + Math.floor(rnd(i + 10) * (days * 0.35));
    const t1 = Math.max(2, Math.round(t0 * 0.5));
    learn(id, [
      { back: Math.max(2, t0), kind: 'study', acc: 0.6 },
      { back: Math.max(1, t1), kind: 'review', acc: 0.75 }
    ].sort((a, b2) => b2.back - a.back));
  });

  // 薄弱：只学过一遍、正确率低、久未复习 → 已到期需复习
  weak.forEach((id, i) => {
    const t0 = 12 + Math.floor(rnd(i + 30) * 20);
    learn(id, [{ back: t0, kind: 'study', acc: 0.42 }]);
  });

  // 打卡：约 82% 出勤率
  dayList.forEach((d, i) => {
    const isRecent = i >= dayList.length - 7;
    if (!isRecent && (i % 11 === 4 || i % 17 === 9)) return;
    const minutes = 150 + Math.round(rnd(i * 1.7) * 200);
    const mood = Math.max(1, Math.min(5, 3 + (i % 5 === 0 ? 1 : i % 7 === 3 ? -1 : 0)));
    q.run(`INSERT INTO checkins (user_id,date,minutes,mood,note) VALUES (?,?,?,?,?)
           ON CONFLICT(user_id,date) DO UPDATE SET minutes=excluded.minutes, mood=excluded.mood`,
      u, d, minutes, mood, null);
  });

  // 模拟“最近刚复习过”：把强项/中等项的复习记录拉近，避免全部积压成待复习
  const refresh = (ids, daysAgoMin, daysAgoMax, stab) => {
    ids.forEach((id, i) => {
      const r = q.get('SELECT * FROM mastery WHERE user_id=? AND point_id=?', u, id);
      if (!r) return;
      const back = daysAgoMin + Math.floor(rnd(i + 60) * (daysAgoMax - daysAgoMin + 1));
      const last = E.addDays(E.todayStr(), -back);
      const st = stab + rnd(i + 90) * 3;
      q.run('UPDATE mastery SET last_at=?, stability=?, next_review=? WHERE user_id=? AND point_id=?',
        last, st, E.reviewDate(last, st), u, id);
    });
  };
  refresh(strong, 1, 4, 12);   // 强项：最近 1-4 天复习过，稳定度高
  refresh(medium, 2, 7, 5);    // 中等：最近 2-7 天，部分即将到期

  // 生成今天与未来 6 天的计划
  E.buildDayPlan(u, E.todayStr(), { regenerate: true });
  for (let i = 1; i <= 6; i++) E.buildDayPlan(u, E.addDays(E.todayStr(), i));

  const a = E.assessment(u);
  return { ok: true, days, logs: logCount,
    summary: { mastery: a.overall.score, coverage: a.overall.coverage, estimated: a.overall.estimated,
      dueCount: E.pointStates(u).filter((x) => x.state === 'due').length },
    message: '演示数据已生成（含学习历史、复习轮次与打卡记录）' };
});

route('POST', '/api/reset', async () => {
  const u = uid();
  q.tx(() => {
    ['checkins', 'logs', 'mastery', 'plan', 'advice_cache'].forEach((t) => q.run(`DELETE FROM ${t} WHERE user_id=?`, u));
    q.run('UPDATE users SET start_date=? WHERE id=?', E.todayStr(), u);
  });
  return { ok: true };
});

// ---------- 智能体（Agent）：对话式督导，可读写真实数据 ----------
route('GET', '/api/agent/history', () => {
  const u = uid();
  const items = agentReply.history(u, 60);
  const pending = agentBrain.getPending(u);
  return {
    items: items.map((m) => ({
      id: m.id, role: m.role, content: m.content, at: m.created_at,
      trace: m.trace ? safeJson(m.trace) : []
    })),
    pending: pending ? { pointId: pending.pointId, q: pending.q } : null,
    tools: agentCore.TOOLS.map((t) => ({ name: t.name, desc: t.desc })),
    llm: llm.info()
  };
});

route('POST', '/api/agent/chat', async (req) => {
  const b = await readBody(req);
  const u = uid();
  const message = String(b.message || '').slice(0, 2000);
  if (!message.trim()) throw new Error('消息不能为空');
  const r = await agentBrain.runTurn(u, message);
  return { ok: true, reply: r.reply, trace: r.trace, tools: r.tools, pending: r.pending };
});

// ---------- 智能体流式对话（SSE）：大模型逐段推送，前端实时渲染 ----------
route('POST', '/api/agent/stream', async (req, _url, res) => {
  const b = await readBody(req);
  const u = uid();
  const message = String(b.message || '').slice(0, 2000);
  const ctx = als.getStore();
  const cookieHdr = ctx && ctx.newCookie && ctx.sid ? { 'Set-Cookie': session.cookieHeader(ctx.sid) } : null;
  if (!message.trim()) throw new Error('消息不能为空');

  // 建立 SSE 通道
  const headers = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  };
  if (cookieHdr) Object.assign(headers, cookieHdr);
  res.writeHead(200, headers);
  if (res.flushHeaders) res.flushHeaders();

  // 与 send() 一致：SSE 出口同样做 emoji 净化，避免流式绕过过滤
  const cleanStr = (v) => (typeof v === 'string' ? stripEmoji(v) : v);
  const sendEv = (type, data) => {
    const safe = { type };
    for (const k of Object.keys(data || {})) safe[k] = cleanStr(data[k]);
    try { res.write('data: ' + JSON.stringify(safe) + '\n\n'); } catch (_) {}
  };
  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15000);

  try {
    // 流式增量也逐段净化，保证前端实时渲染的内容同样无 emoji
    const r = await agentBrain.runTurn(u, message, (delta) => sendEv('delta', { text: delta }));
    sendEv('done', { reply: r.reply, trace: r.trace, tools: r.tools, pending: r.pending, interactive: r.interactive });
  } catch (e) {
    sendEv('error', { error: e.message });
  } finally {
    clearInterval(heartbeat);
    try { res.end(); } catch (_) {}
  }
});

route('POST', '/api/agent/clear', async () => {
  const u = uid();
  agentReply.clearHistory(u);
  agentBrain.clearPending(u);
  return { ok: true };
});

// ---------- 静态文件 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(filePath, (err, data) => {
    if (err) {
      const fb = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(fb, (e2, d2) => e2 ? send(res, 404, { error: 'not found' }) : send(res, 200, d2, MIME['.html']));
      return;
    }
    send(res, 200, data, MIME[path.extname(filePath)] || 'application/octet-stream');
  });
}

// ---------- 启动 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const key = req.method + ' ' + url.pathname;

  // —— 会话上下文：每个请求独立识别访客，实现数据隔离 ——
  const cookies = session.parseCookies(req);
  const ctx = { sid: cookies[session.COOKIE] || null, user: null, newCookie: false };
  if (ctx.sid) session.touch(ctx.sid);

  const setCookieIfNew = () => {
    if (ctx.newCookie && ctx.sid) {
      return { 'Set-Cookie': session.cookieHeader(ctx.sid) };
    }
    return null;
  };

  await als.run(ctx, async () => {
    const handler = routes[key];
    if (!handler) {
      if (url.pathname.startsWith('/api/')) {
        return send(res, 404, { error: '未知接口: ' + url.pathname }, undefined, setCookieIfNew());
      }
      return serveStatic(res, url.pathname);
    }
    try {
      // 流式接口自行接管响应（res.writableEnded 表示已处理）
      const out = await handler(req, url, res);
      if (res.writableEnded) return;
      send(res, 200, out, undefined, setCookieIfNew());
    } catch (e) {
      console.error('[API ERROR]', key, e.message);
      if (res.writableEnded) return;
      send(res, 400, { error: e.message }, undefined, setCookieIfNew());
    }
  });
});

if (require.main === module) {
  currentUser();
  // 后台真实探测大模型连通性（欠费/超时会如实反映到界面，不影响本地功能）
  llm.probe().then((h) => console.log('  大模型探测: ' + h.status + (h.reason ? ' — ' + h.reason : ''))).catch(() => {});
  server.listen(PORT, HOST, () => {
    console.log('===============================================');
    console.log('  408 考研学习助手已启动');
    console.log('  地址: http://' + HOST + ':' + PORT);
    console.log('  数据库: ' + DB_FILE);
    console.log('  大模型: ' + (llm.available() ? '已配置 (' + llm.info().model + ')，探测中…' : '未配置（使用本地规则引擎）'));
    console.log('===============================================');
  });
}
module.exports = { server, currentUser, calcStreak };