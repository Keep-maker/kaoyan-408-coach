// ============================================================
//  核心引擎
//   1) 掌握度模型：贝叶斯知识追踪（BKT） + 遗忘曲线（稳定度半衰期）
//   2) 掌握情况评估：科目/章节/全局 三级评估 + 风险评估 + 提分空间估算
//   3) 动态路线规划：按剩余天数、实际学习速度、遗忘压力动态生成日计划
//   4) 学习建议：本地规则引擎生成（可选叠加 LLM）
// ============================================================
const { q } = require('./db');
const S = require('../data/syllabus');

// ---------- 参数 ----------
const P = {
  slip: 0.12,        // 真会却答错
  guess: 0.25,       // 不会却蒙对
  learn: 0.28,       // 学一遍后的初始掌握增益
  targetRetention: 0.85,   // 复习目标保持率
  reviewShare: 0.45  // 每日时间中复习占比上限
};

const todayStr = (d = new Date()) => {
  const x = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return x.toISOString().slice(0, 10);
};
const addDays = (dateStr, n) => {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return todayStr(d);
};
const daysBetween = (a, b) =>
  Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// ---------- 1. 掌握度模型 ----------
// 单次测验后的后验更新
function bktUpdate(p, correct) {
  if (correct) {
    const num = p * (1 - P.slip);
    const den = num + (1 - p) * P.guess;
    return clamp(num / (den || 1e-9), 0, 1);
  }
  const num = p * P.slip;
  const den = num + (1 - p) * (1 - P.guess);
  return clamp(num / (den || 1e-9), 0, 1);
}

// 记忆稳定度（天）：答对大幅增长，答错衰减
function nextStability(stability, correct, p) {
  if (correct) return clamp(stability * (1.7 + 0.6 * p) + 0.4, 0.5, 400);
  return clamp(stability * 0.35, 0.3, 400);
}

// 给定稳定度，算“保持率达到目标”的复习日期（半衰期模型）
function reviewDate(fromDate, stability, retentionTarget = P.targetRetention) {
  // retention = 2^(-t/halflife)，令 retention = target
  const t = stability * Math.log2(1 / retentionTarget);
  return addDays(fromDate, Math.max(1, Math.round(t)));
}

// 遗忘：从上次接触到现在，掌握度按遗忘曲线衰减
function decayed(p, stability, lastAt, now = todayStr()) {
  if (!lastAt || stability <= 0) return p * 0.7;
  const t = Math.max(0, daysBetween(lastAt.slice(0, 10), now));
  const retention = Math.pow(2, -t / Math.max(stability, 0.3));
  // 掌握度向 0 衰减但保留最低痕迹
  return clamp(p * (0.15 + 0.85 * retention), 0, 1);
}

// 记录一次学习/复习/测验，更新掌握状态
function applyLog(userId, log) {
  const now = log.date || todayStr();
  let row = q.get('SELECT * FROM mastery WHERE user_id=? AND point_id=?', userId, log.point_id);
  let p = row ? row.p : 0;
  let stability = row ? row.stability : 0;
  let reps = row ? row.reps : 0;
  let streak = row ? row.streak : 0;
  let attempts = row ? row.attempts : 0;
  let correct = row ? row.correct : 0;
  let wrong = row ? row.wrong : 0;

  // 先按遗忘衰减到当前
  if (row && row.last_at) p = decayed(p, stability, row.last_at, now);

  const kind = log.kind || 'study';
  if (kind === 'study') {
    // 学新知识
    p = clamp(p + P.learn * (1 - p), 0, 0.97);
    stability = clamp(stability + 1.0, 0.5, 400);
    reps += 1;
  } else if (kind === 'review') {
    p = clamp(p + 0.18 * (1 - p), 0, 0.99);
    stability = nextStability(stability || 0.8, true, p);
    reps += 1;
    streak += 1;
  }

  if (log.total > 0) {
    const acc = log.correct / log.total;
    attempts += log.total;
    correct += log.correct;
    wrong += log.total - log.correct;
    // 多次答题：按整体正确率平滑更新
    for (let i = 0; i < log.total; i++) p = bktUpdate(p, i < log.correct);
    const ok = acc >= 0.6;
    stability = nextStability(stability || 1, ok, p);
    streak = ok ? streak + 1 : 0;
    if (ok) p = clamp(p + 0.10 * (1 - p), 0, 0.995);
    else p = clamp(p - 0.06 * (1 - p), 0.02, 1);
  }

  if (log.self_rating > 0) {
    const target = (log.self_rating - 1) / 4; // 0-1
    p = clamp(p * 0.7 + target * 0.3, 0, 0.99);
    if (stability <= 0) stability = 1;
  }

  const next = reviewDate(now, stability || 1);
  const payload = { p, stability, reps, streak, attempts, correct, wrong, last_at: now, next_review: next };
  if (row) {
    q.run(`UPDATE mastery SET p=?, stability=?, reps=?, streak=?, attempts=?, correct=?, wrong=?,
           last_at=?, next_review=?, updated_at=datetime('now','localtime')
           WHERE user_id=? AND point_id=?`,
      payload.p, payload.stability, payload.reps, payload.streak, payload.attempts,
      payload.correct, payload.wrong, payload.last_at, payload.next_review, userId, log.point_id);
  } else {
    q.run(`INSERT INTO mastery (user_id, point_id, p, stability, reps, streak, attempts, correct, wrong, last_at, next_review)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      userId, log.point_id, payload.p, payload.stability, payload.reps, payload.streak,
      payload.attempts, payload.correct, payload.wrong, payload.last_at, payload.next_review);
  }
  return payload;
}

// ---------- 2. 掌握情况评估 ----------
function masteryMap(userId, now = todayStr()) {
  const rows = q.all('SELECT * FROM mastery WHERE user_id=?', userId);
  const map = {};
  rows.forEach((r) => {
    map[r.point_id] = { ...r, p_now: decayed(r.p, r.stability, r.last_at, now) };
  });
  return map;
}

function assessment(userId) {
  const now = todayStr();
  const mm = masteryMap(userId, now);
  const user = q.get('SELECT * FROM users WHERE id=?', userId);

  const levels = (pts, mmx) => {
    let wsum = 0, wmastered = 0, studied = 0, hours = 0, masteredCount = 0;
    let riskWeight = 0, riskSum = 0;
    pts.forEach((pt) => {
      const m = mmx[pt.id];
      const p = m ? m.p_now : 0;
      wsum += pt.weight;
      wmastered += pt.weight * p;
      hours += pt.hours;
      if (m) studied += 1;
      if (p >= 0.75) masteredCount += 1;
      // 风险：权重大且掌握低
      riskWeight += pt.weight;
      riskSum += pt.weight * (1 - p);
    });
    return {
      score: wsum ? Math.round((wmastered / wsum) * 100) : 0,
      studied, total: pts.length,
      coverage: pts.length ? Math.round((studied / pts.length) * 100) : 0,
      mastered: masteredCount,
      hours: Math.round(hours * 10) / 10,
      risk: riskWeight ? Math.round((riskSum / riskWeight) * 100) : 100
    };
  };

  const subjects = S.SUBJECTS.map((sub) => {
    const pts = S.POINTS.filter((p) => p.subjectId === sub.id);
    const base = levels(pts, mm);
    const chapters = sub.chapters.map((ch) => {
      const cpts = S.POINTS.filter((p) => p.chapterId === ch.id);
      return { id: ch.id, name: ch.name, ...levels(cpts, mm) };
    });
    return { id: sub.id, name: sub.name, color: sub.color, score: sub.score, ...base, chapters };
  });

  const all = levels(S.POINTS, mm);

  // 提分空间：按权重把掌握度补到 0.85 的加权缺口，折算成 408 满分 150 的可提升分
  let gapWeighted = 0, totalWeight = 0;
  S.POINTS.forEach((pt) => {
    const p = mm[pt.id] ? mm[pt.id].p_now : 0;
    totalWeight += pt.weight;
    gapWeighted += pt.weight * Math.max(0, 0.85 - p);
  });
  const potentialScore = Math.round((gapWeighted / totalWeight) * 150 * 0.85);

  // 预估分数：以 408 试卷难度估计，掌握度 0.85 视为满分水平，含基础送分
  // 标定：掌握度 0.30≈62分 / 0.50≈95分 / 0.70≈118分 / 0.85≈134分（本科基础 + 复习程度的经验曲线）
  const est_p = all.score / 100;
  const estimated = Math.round(150 * (0.35 * est_p + 0.65 * Math.sqrt(est_p)));
  const target = user?.target_score || 110;

  // 学习速度：近 14 天
  const from = addDays(now, -13);
  const speedRows = q.all(
    `SELECT date, SUM(minutes) m, COUNT(*) c FROM logs WHERE user_id=? AND date>=? GROUP BY date`,
    userId, from);
  const checkRows = q.all('SELECT * FROM checkins WHERE user_id=? AND date>=?', userId, from);
  const daysWithWork = new Set([...speedRows.map((r) => r.date), ...checkRows.map((r) => r.date)]).size;
  const minutes14 = speedRows.reduce((s, r) => s + (r.m || 0), 0) +
    checkRows.reduce((s, r) => s + (r.minutes || 0), 0);
  const dailyAvg = Math.round(minutes14 / 14);
  const activeDailyAvg = daysWithWork ? Math.round(minutes14 / daysWithWork) : 0;

  // 进度压力
  const dLeft = user ? Math.max(0, daysBetween(now, user.exam_date)) : 0;
  const remainingHours = S.POINTS.reduce((s, pt) => {
    const p = mm[pt.id] ? mm[pt.id].p_now : 0;
    return s + pt.hours * (p >= 0.85 ? 0.15 : p > 0 ? 0.5 : 1);
  }, 0);
  const needDailyMinutes = dLeft > 0 ? Math.round((remainingHours * 60) / dLeft) : 9999;

  return {
    now, user,
    overall: { ...all, scoreAll: all.score, potentialScore, estimated, target,
      targetGap: target - estimated },
    subjects,
    pace: {
      daysLeft: dLeft,
      remainingHours: Math.round(remainingHours * 10) / 10,
      needDailyMinutes,
      dailyAvg,
      activeDailyAvg,
      daysWithWork,
      onTrack: dailyAvg >= needDailyMinutes * 0.85,
      shortfallMinutes: Math.max(0, needDailyMinutes - dailyAvg)
    }
  };
}

// 薄弱点排行
function weakPoints(userId, limit = 12) {
  const mm = masteryMap(userId);
  const list = S.POINTS.map((pt) => {
    const m = mm[pt.id];
    const p = m ? m.p_now : 0;
    return {
      point: pt,
      p,
      studied: Boolean(m),
      attempts: m?.attempts || 0,
      accuracy: m && m.attempts ? Math.round((m.correct / m.attempts) * 100) : null,
      lastAt: m?.last_at || null,
      nextReview: m?.next_review || null,
      // 亏损分：权重 × 缺口，考虑难度
      loss: Math.round(pt.weight * (1 - p) * 10) / 10
    };
  }).sort((a, b) => b.loss - a.loss);
  return list.slice(0, limit);
}

// 知识点状态分类
function pointStates(userId) {
  const mm = masteryMap(userId);
  const now = todayStr();
  return S.POINTS.map((pt) => {
    const m = mm[pt.id];
    const p = m ? m.p_now : 0;
    let st = 'notstarted';
    if (m) {
      if (m.next_review && m.next_review <= now) st = 'due';
      else if (p >= 0.85) st = 'mastered';
      else if (p >= 0.6) st = 'familiar';
      else st = 'learning';
    }
    return { id: pt.id, name: pt.name, subjectId: pt.subjectId, chapterId: pt.chapterId,
      chapterName: pt.chapterName, weight: pt.weight, diff: pt.diff, hours: pt.hours,
      tags: pt.tags, p: Math.round(p * 1000) / 1000, state: st,
      nextReview: m?.next_review || null, lastAt: m?.last_at || null,
      attempts: m?.attempts || 0, accuracy: m && m.attempts ? Math.round((m.correct / m.attempts) * 100) : null };
  });
}

// ---------- 3. 动态路线规划 ----------
// 策略档位：稳扎稳打 / 标准 / 保分突击
function strategy(userId, mode = 'auto') {
  const a = assessment(userId);
  const dLeft = a.pace.daysLeft;
  const need = a.pace.remainingHours; // 剩余净学时
  const daily = a.pace.dailyAvg || a.user?.daily_minutes || 180;
  const capacityHours = (dLeft * daily) / 60;
  let level = 'standard';
  if (mode === 'auto') {
    if (dLeft > 0 && capacityHours < need * 0.8) level = 'sprint';
    else if (capacityHours > need * 1.6) level = 'solid';
  } else level = mode;

  const cfg = {
    solid:   { name: '稳扎稳打', skipBelowWeight: 0,  reviewShare: 0.35, note: '时间相对充裕，全部知识点都要吃透，重点补难点。' },
    standard:{ name: '标准推进', skipBelowWeight: 0,  reviewShare: 0.45, note: '按大纲权重取舍，重难点优先，低频点快速过。' },
    sprint:  { name: '保分突击', skipBelowWeight: 3,  reviewShare: 0.55, note: '时间紧张：放弃权重≤2的低频点，只保高频与已学内容的稳定，优先拿基础分。' }
  }[level];
  return { level, ...cfg, capacityHours: Math.round(capacityHours), needHours: Math.round(need),
    feasible: capacityHours >= need };
}

// 生成某天的计划（动态：复习优先、按权重与前置依赖排新内容）
function buildDayPlan(userId, date = todayStr(), { regenerate = false } = {}) {
  const user = q.get('SELECT * FROM users WHERE id=?', userId);
  if (!user) throw new Error('NO_USER');
  const st = strategy(userId);
  const mm = masteryMap(userId, date);

  if (regenerate) q.run('DELETE FROM plan WHERE user_id=? AND date=?', userId, date);

  const existing = q.all('SELECT * FROM plan WHERE user_id=? AND date=?', userId, date);
  const doneIds = new Set(existing.filter((r) => r.status === 'done').map((r) => r.point_id + '|' + r.kind));
  const base = existing.length ? existing : [];
  if (base.length) return { items: base, strategy: st, reused: true };

  const dailyMinutes = user.daily_minutes;
  const items = [];

  // (a) 复习任务：到期 + 即将到期的高权重点
  const dueList = S.POINTS.map((pt) => {
    const m = mm[pt.id];
    if (!m) return null;
    const overdue = Boolean(m.next_review && m.next_review <= date);
    const soon = m.next_review && daysBetween(date, m.next_review) <= 2;
    if (!overdue && !soon) return null;
    const urgency = (overdue ? 2 : 1) * pt.weight * (1 - m.p_now);
    return { pt, m, urgency, overdue };
  }).filter(Boolean).sort((a, b) => (b.overdue - a.overdue) || (b.urgency - a.urgency));

  let budget = dailyMinutes;
  const reviewBudget = Math.min(budget * st.reviewShare, budget);
  let used = 0;
  dueList.forEach(({ pt, m, overdue }) => {
    const min = overdue ? 15 : 10;
    if (used + min > reviewBudget) return;
    used += min;
    items.push({
      point_id: pt.id, kind: 'review', minutes: min,
      priority: overdue ? 90 : 70,
      reason: overdue
        ? `已到复习节点（掌握度 ${Math.round(m.p_now * 100)}%，${daysBetween(m.next_review, date) === 0 ? '今天到期' : '已推迟 ' + Math.abs(daysBetween(m.next_review, date)) + ' 天'}）`
        : `即将遗忘（记忆稳定度 ${Math.round(m.stability * 10) / 10} 天）`
    });
  });

  // (b) 限时专练：高权重但正确率低/未掌握
  const drill = weakPoints(userId, 40).filter((w) => w.studied && w.p < 0.6 && w.point.weight >= 4);
  for (const w of drill) {
    if (items.some((i) => i.point_id === w.point.id)) continue;
    if (budget - used < 20) break;
    if (used + 20 > budget * 0.7) break;
    used += 20;
    items.push({ point_id: w.point.id, kind: 'drill', minutes: 20, priority: 85,
      reason: `高频薄弱点（权重 ${w.point.weight}，当前掌握 ${Math.round(w.p * 100)}%）` });
  }

  // (c) 新内容：按前置依赖 + 章节顺序 + 权重
  const newBudget = budget - used;
  const candidates = S.POINTS
    .filter((pt) => !mm[pt.id] && pt.weight > st.skipBelowWeight)
    .sort((a, b) => (b.weight - a.weight) || (a.order - b.order));
  let newUsed = 0;
  for (const pt of candidates) {
    // 前置检查：前置点已学（有记录）才推荐深入，否则先补前置
    const unmet = (pt.pre || []).filter((id) => !mm[id]);
    if (unmet.length && newUsed > 0) continue;
    const min = Math.round(clamp(pt.hours * 60 * 0.5, 20, 60));
    if (newUsed + min > newBudget) continue;
    newUsed += min;
    items.push({ point_id: pt.id, kind: 'new', minutes: min, priority: 50 + pt.weight * 5,
      reason: `新知识点（权重 ${pt.weight}｜难度 ${pt.diff}｜建议 ${pt.hours}h）` +
        (unmet.length ? `；需先补前置：${unmet.map((i) => S.POINT_BY_ID[i].name).join('、')}` : '') });
    if (items.filter((i) => i.kind === 'new').length >= 4) break;
  }

  q.tx(() => {
    items.forEach((it) => {
      q.run(`INSERT OR IGNORE INTO plan (user_id,date,point_id,kind,minutes,priority,reason)
             VALUES (?,?,?,?,?,?,?)`,
        userId, date, it.point_id, it.kind, it.minutes, it.priority, it.reason);
    });
  });

  return {
    items: q.all('SELECT * FROM plan WHERE user_id=? AND date=? ORDER BY priority DESC', userId, date),
    strategy: st, reused: false
  };
}

// 未来 N 天路线预览（动态路线）
function routePreview(userId, days = 14) {
  const user = q.get('SELECT * FROM users WHERE id=?', userId);
  const st = strategy(userId);
  const mm = masteryMap(userId);
  const today = todayStr();
  // 模拟：不落库，仅预测
  const sim = {};
  Object.entries(mm).forEach(([k, v]) => { sim[k] = { p: v.p_now, stability: v.stability, next: v.next_review }; });
  const out = [];
  for (let d = 0; d < days; d++) {
    const date = addDays(today, d);
    const items = [];
    let budget = user.daily_minutes;
    // 复习（单日最多 60% 预算，保证新内容能推进）
    const reviewCap = Math.round(user.daily_minutes * 0.6);
    let reviewUsed = 0;
    Object.entries(sim).forEach(([id, v]) => {
      if (reviewUsed + 12 > reviewCap) return;
      if (!v.next || v.next <= date) {
        const pt = S.POINT_BY_ID[id];
        if (!pt) return;
        const min = 12;
        if (budget - min < 0) return;
        budget -= min;
        reviewUsed += min;
        items.push({ id, kind: 'review' });
        sim[id].p = clamp(sim[id].p + 0.2 * (1 - sim[id].p), 0, 0.99);
        sim[id].stability = nextStability(sim[id].stability || 1, true, sim[id].p);
        sim[id].next = reviewDate(date, sim[id].stability);
      }
    });
    // 新内容
    const pend = S.POINTS.filter((pt) => !sim[pt.id] && pt.weight > st.skipBelowWeight)
      .sort((a, b) => (b.weight - a.weight) || (a.order - b.order));
    for (const pt of pend) {
      const min = Math.round(clamp(pt.hours * 60 * 0.5, 20, 60));
      if (budget - min < 0) break;
      budget -= min;
      items.push({ id: pt.id, kind: 'new' });
      sim[pt.id] = { p: 0.42, stability: 2.5, next: reviewDate(date, 2.5) };
      if (items.filter((i) => i.kind === 'new').length >= 4) break;
    }
    const remain = S.POINTS.filter((pt) => !sim[pt.id]).length;
    out.push({
      date, items,
      newCount: items.filter((i) => i.kind === 'new').length,
      reviewCount: items.filter((i) => i.kind === 'review').length,
      remainingPoints: remain,
      donePoints: S.POINTS.length - remain,
      pct: Math.round(((S.POINTS.length - remain) / S.POINTS.length) * 100)
    });
    if (remain === 0) break;
  }
  return { strategy: st, days: out };
}

// ---------- 4. 学习建议（本地规则引擎） ----------
function localAdvice(userId) {
  const a = assessment(userId);
  const weak = weakPoints(userId, 6);
  const st = strategy(userId);
  const due = pointStates(userId)
    .filter((p) => p.state === 'due')
    .sort((x, y) => (y.weight * (1 - y.p)) - (x.weight * (1 - x.p)));
  const out = [];
  const { pace, overall } = a;

  out.push({
    type: 'pace', level: pace.onTrack ? 'ok' : 'warn',
    title: pace.onTrack ? '进度在轨' : '进度落后，需要加量',
    text: pace.onTrack
      ? `按当前速度（日均 ${pace.dailyAvg} 分钟）能覆盖剩余 ${pace.remainingHours} 学时（需日均 ${pace.needDailyMinutes} 分钟）。`
      : `剩余 ${pace.daysLeft} 天、约 ${pace.remainingHours} 学时未消化，需要日均 ${pace.needDailyMinutes} 分钟，你现在日均 ${pace.dailyAvg} 分钟，每天还差约 ${pace.shortfallMinutes} 分钟。` +
        (st.level === 'sprint' ? '已自动切换为「保分突击」路线：优先高频考点 + 已学内容的抗遗忘复习。' : '')
  });

  if (due.length) {
    out.push({ type: 'review', level: 'warn', title: `有 ${due.length} 个知识点已到复习节点`,
      text: `最容易产生「学了就忘」的漏洞。建议今天先处理：${due.slice(0, 5).map((d) => d.name).join('、')}${due.length > 5 ? ' 等' : ''}。` });
  }

  if (weak.length && weak[0].loss > 0.5) {
    const byW = weak.slice(0, 3);
    out.push({ type: 'weak', level: 'warn', title: '当前最该补的薄弱点',
      text: byW.map((w) => `${w.point.name}（权重 ${w.point.weight}，掌握 ${Math.round(w.p * 100)}%${w.accuracy !== null ? `，正确率 ${w.accuracy}%` : '，尚未练习'}）`).join('；') + '。' });
  }

  const worstSub = [...a.subjects].sort((x, y) => x.score - y.score)[0];
  const bestSub = [...a.subjects].sort((x, y) => y.score - x.score)[0];
  if (worstSub) {
    out.push({ type: 'subject', level: 'info', title: `科目侧重：${worstSub.name}`,
      text: `${worstSub.name}当前掌握度 ${worstSub.score}/100、覆盖 ${worstSub.coverage}%，是四科中最弱的一科；` +
        (worstSub.chapters.length ? `其中最弱的章节是「${[...worstSub.chapters].sort((x, y) => x.score - y.score)[0].name}」。` : '') +
        `相对而言「${bestSub.name}」是你的优势项，可减少投入、维持复习节奏即可。` });
  }

  out.push({ type: 'score', level: overall.targetGap > 0 ? 'warn' : 'ok',
    title: `目标 ${overall.target} 分：预估当前水平 ${overall.estimated} 分`,
    text: (overall.targetGap > 0
      ? `距离目标还差约 ${overall.targetGap} 分。按权重缺口测算，把当前薄弱环节补到 85% 掌握，最多可提升约 ${overall.potentialScore} 分。`
      : `已达到目标水平，继续按当前节奏巩固，重点转向保持稳定与难题突破。`) });

  const daysNoCheckin = a.user ? Math.max(0, daysBetween(q.get('SELECT MAX(date) d FROM checkins WHERE user_id=?', userId)?.d || a.user.start_date || a.now, a.now)) : 0;
  if (daysNoCheckin >= 2) {
    out.push({ type: 'habit', level: 'warn', title: `已连续 ${daysNoCheckin} 天没有打卡`,
      text: '节奏比强度更重要：建议今天就做「最小启动」——只学 25 分钟，把计划表里的第一个任务做完就算达标。' });
  }
  if (st.level === 'sprint') {
    out.push({ type: 'strategy', level: 'info', title: '已启用保分突击策略',
      text: '系统已自动调低低频知识点（权重≤2）的优先级，把时间集中到高频考点和抗遗忘复习上。这是动态路线的一部分，后续学习速度回升会自动切回标准模式。' });
  }
  return { generatedAt: new Date().toISOString(), engine: 'local', items: out };
}

module.exports = {
  P, todayStr, addDays, daysBetween, clamp,
  applyLog, masteryMap, assessment, weakPoints, pointStates,
  strategy, buildDayPlan, routePreview, localAdvice,
  bktUpdate, decayed, reviewDate, nextStability
};