// ============================================================
//  智能体大脑：意图 → 工具执行（真实读写）→ 结构化回复
// ============================================================
const S = require('../data/syllabus');
const QB = require('../data/quizbank');
const E = require('./engine');
const llm = require('./llm');
const { q } = require('./db');
const A = require('./agent');

const today = () => E.todayStr();
const pct = (x) => Math.round(x * 100);

function calcStreak(userId) {
  const rows = q.all('SELECT date FROM checkins WHERE user_id=? ORDER BY date DESC LIMIT 400', userId);
  const set = new Set(rows.map((r) => r.date));
  let cur = 0;
  let d = today();
  if (!set.has(d)) d = E.addDays(d, -1);
  while (set.has(d)) { cur += 1; d = E.addDays(d, -1); }
  return { current: cur, total: rows.length };
}

// ---------- 工具：真实数据操作 ----------
const ACT = {
  // 打卡（真实写库）
  check_in(userId, { minutes = 0, mood = 4, note = null }) {
    const date = today();
    const min = Math.max(0, Math.min(900, Math.round(Number(minutes) || 0)));
    q.run(`INSERT INTO checkins (user_id,date,minutes,mood,note) VALUES (?,?,?,?,?)
           ON CONFLICT(user_id,date) DO UPDATE SET minutes=excluded.minutes, mood=excluded.mood,
             note=COALESCE(excluded.note, checkins.note)`, userId, date, min, mood, note);
    const st = calcStreak(userId);
    return { ok: true, minutes: min, mood, date, streak: st.current, total: st.total };
  },

  // 登记学习/测验记录（真实写库 + 更新掌握度）
  log_study(userId, { point, kind = 'study', minutes = 20, correct = 0, total = 0, self_rating = 0 }) {
    const pt = typeof point === 'string' ? A.findPoint(point) : point;
    if (!pt) return { ok: false, error: '没听懂是哪个知识点：' + point };
    const date = today();
    q.run(`INSERT INTO logs (user_id,point_id,date,minutes,kind,correct,total,self_rating,note)
           VALUES (?,?,?,?,?,?,?,?,?)`,
      userId, pt.id, date, minutes, kind, correct, total, self_rating, '（智能体记录）');
    // 从未接触过的点先做测验：先记一次「学过」的量（接触先验），再叠加答题结果
    const seen = q.get('SELECT 1 x FROM mastery WHERE user_id=? AND point_id=?', userId, pt.id);
    if (!seen) {
      E.applyLog(userId, { point_id: pt.id, date, kind: 'study', minutes: Math.min(15, minutes || 15),
        correct: 0, total: 0, self_rating: 0 });
    }
    const m = E.applyLog(userId, { point_id: pt.id, date, kind, minutes, correct, total, self_rating });
    q.run(`UPDATE plan SET status='done' WHERE user_id=? AND date=? AND point_id=? AND status='todo'`, userId, date, pt.id);
    const ck = q.get('SELECT * FROM checkins WHERE user_id=? AND date=?', userId, date);
    if (ck) q.run('UPDATE checkins SET minutes=minutes+? WHERE id=?', minutes, ck.id);
    else q.run('INSERT INTO checkins (user_id,date,minutes,mood,note) VALUES (?,?,?,?,?)', userId, date, minutes, 4, '（由学习记录自动生成）');
    const after = E.masteryMap(userId)[pt.id];
    return { ok: true, point: { id: pt.id, name: pt.name, subject: pt.subjectName, chapter: pt.chapterName },
      kind, p: pct(after.p_now), stability: after.stability, nextReview: after.next_review };
  },

  // 重排今日计划
  replan(userId, { minutes = null, regenerate = true }) {
    const before = E.buildDayPlan(userId, today());
    const beforeItems = before.items.filter((i) => i.status === 'todo');
    if (minutes) {
      const cur = q.get('SELECT * FROM users WHERE id=?', userId);
      const d = Math.max(30, Math.min(900, Math.round(Number(minutes))));
      const old = cur.daily_minutes;
      q.run('UPDATE users SET daily_minutes=? WHERE id=?', d, userId);
      const r = E.buildDayPlan(userId, today(), { regenerate: true });
      q.run('UPDATE users SET daily_minutes=? WHERE id=?', Math.max(old, d), userId); // 只影响今天：恢复原设定
      return { ok: true, capacity: d, before: beforeItems.length, items: r.items.length,
        totalMinutes: r.items.reduce((s, i) => s + i.minutes, 0), strategy: r.strategy, adjustedFrom: old };
    }
    const r = E.buildDayPlan(userId, today(), { regenerate });
    return { ok: true, before: beforeItems.length, items: r.items.length,
      totalMinutes: r.items.reduce((s, i) => s + i.minutes, 0), strategy: r.strategy };
  },

  // 抽背：挑题
  quiz_me(userId, { point = null, subject = null }) {
    const mm = E.masteryMap(userId);
    let pool = QB.BANK.slice();
    let target = null;
    if (point) {
      target = typeof point === 'string' ? A.findPoint(point) : point;
      if (target) pool = pool.filter((x) => x.pointId === target.id);
    } else if (subject) {
      pool = pool.filter((x) => S.POINT_BY_ID[x.pointId].subjectId === subject);
    }
    if (!pool.length) {
      // 该点没题 → 换一个相邻的高权重点出题
      const alt = E.weakPoints(userId, 60).find((w) => QB.BY_POINT[w.point.id] && w.point.weight >= 4);
      if (alt) { target = alt.point; pool = QB.BY_POINT[alt.point.id].slice(); }
      else pool = QB.BANK.slice(0, 5);
    }
    if (!target) {
      // 按「薄弱 + 高频 + 有题」优先，同时保证一定新鲜度
      // 优先「已学过但薄弱」的高频点：检验遗忘、判分后掌握度变化可感知；
      // 若完全没有学过的可选，再考未学点（起探查作用）
      const cand = E.weakPoints(userId, 80)
        .filter((w) => QB.BY_POINT[w.point.id] && w.point.weight >= 4)
        .map((w) => ({ w, score: w.loss * 10 + (w.studied ? 8 : 0) + Math.random() * 4 }))
        .sort((a, b) => b.score - a.score);
      target = cand.length ? cand[0].w.point : S.POINT_BY_ID[pool[0].pointId];
      pool = QB.BY_POINT[target.id] ? QB.BY_POINT[target.id].slice() : pool;
    }
    const item = pool[Math.floor(Math.random() * pool.length)];
    const m = mm[target.id];
    return { ok: true, question: item, point: target,
      mastery: m ? pct(m.p_now) : 0, studied: Boolean(m) };
  },

  // 判分（关键词命中率 → BKT 更新）
  grade_answer(userId, { pointId, answer, keywords }) {
    const t = String(answer || '');
    const hits = [];
    const misses = [];
    (keywords || []).forEach((k) => {
      const kk = String(k);
      const variants = kk.split('/').map((x) => x.trim()).filter(Boolean);
      const ok = variants.some((v) => t.includes(v) || t.replace(/\s/g, '').includes(v.replace(/\s/g, '')));
      (ok ? hits : misses).push(kk);
    });
    const rate = keywords && keywords.length ? hits.length / keywords.length : 0;
    // 命中率映射到「几道题对几道」（用于 BKT）：>=0.7 判为掌握，0.4-0.7 部分
    const total = Math.max(1, Math.min(4, keywords ? keywords.length : 1));
    let correct = 0;
    if (rate >= 0.75) correct = total;
    else if (rate >= 0.5) correct = Math.max(1, Math.round(total * 0.5));
    else if (rate >= 0.25) correct = Math.max(1, Math.round(total * 0.25));
    else correct = 0;
    return { rate, hits, misses, total, correct };
  },

  // 状态差 → 最小启动方案
  rest_directive(userId, { minutes = 40 }) {
    const min = Math.max(20, Math.min(180, Math.round(Number(minutes) || 40)));
    const before = E.buildDayPlan(userId, today());
    const items = before.items.filter((i) => i.status === 'todo')
      .sort((a, b) => (b.priority - a.priority));
    // 只保留 1-2 项最小任务，总量收敛到 min
    const picked = [];
    let used = 0;
    for (const it of items) {
      const cost = Math.min(it.minutes, 15);
      if (used + cost > min) break;
      used += cost;
      picked.push({ ...it, minutes: cost, point: S.POINT_BY_ID[it.point_id] });
      if (picked.length >= Math.max(1, Math.floor(min / 15))) break;
    }
    return { ok: true, minutes: min, tasks: picked, totalMinutes: used,
      strategy: E.strategy(userId) };
  }
};

// ---------- 数据查询（只读，供回复取材）----------
const READ = {
  progress(userId, subject) {
    const a = E.assessment(userId);
    const st = E.strategy(userId);
    const base = { overall: a.overall, pace: a.pace, strategy: st, streak: calcStreak(userId) };
    if (subject) {
      const sub = a.subjects.find((s) => s.id === subject);
      return { ...base, subject: sub };
    }
    return base;
  },
  weak(userId, limit = 8) {
    return E.weakPoints(userId, limit).map((w) => ({
      id: w.point.id, name: w.point.name, subject: w.point.subjectName, chapter: w.point.chapterName,
      weight: w.point.weight, diff: w.point.diff, tags: w.point.tags || [],
      p: pct(w.p), studied: w.studied, accuracy: w.accuracy, loss: w.loss
    }));
  },
  due(userId) {
    const mm = E.masteryMap(userId);
    const now = today();
    return S.POINTS.map((pt) => ({ pt, m: mm[pt.id] }))
      .filter((x) => x.m && x.m.next_review && x.m.next_review <= now)
      .map((x) => ({ id: x.pt.id, name: x.pt.name, subject: x.pt.subjectName, weight: x.pt.weight,
        p: pct(x.m.p_now), overdueDays: Math.abs(E.daysBetween(now, x.m.next_review)) || 0,
        nextReview: x.m.next_review }))
      .sort((a, b) => (b.weight * (100 - b.p)) - (a.weight * (100 - a.p)));
  },
  plan(userId) {
    const r = E.buildDayPlan(userId, today());
    return { strategy: r.strategy, items: r.items.map((i) => ({ ...i, point: S.POINT_BY_ID[i.point_id] })) };
  },
  route(userId, days = 7) {
    const r = E.routePreview(userId, days);
    return { strategy: r.strategy, days: r.days.map((d) => ({
      date: d.date, newCount: d.items.filter((i) => i.kind === 'new').length,
      reviewCount: d.items.filter((i) => i.kind === 'review').length,
      drillCount: d.items.filter((i) => i.kind === 'drill').length,
      pct: d.pct, names: d.items.slice(0, 5).map((i) => S.POINT_BY_ID[i.id]?.name).filter(Boolean)
    })) };
  }
};

module.exports = { ACT, READ, calcStreak, pct, today };
