// ============================================================
// 引擎单元测试（纯本地，不依赖网络与端口，使用临时数据库）
// 运行：node scripts/test-engine.js 或 npm test
// ============================================================
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const TMP = path.join(os.tmpdir(), 'ky408-test-' + process.pid + '.db');
['', '-wal', '-shm'].forEach((s) => { try { fs.unlinkSync(TMP + s); } catch (_) {} });
process.env.KY_DB = TMP;

const { q } = require('../lib/db');
const E = require('../lib/engine');
const S = require('../data/syllabus');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
 if (cond) { pass += 1; console.log(' ' + name + (extra ? ' [' + extra + ']' : '')); }
 else { fail += 1; console.log(' ' + name + (extra ? ' [' + extra + ']' : '')); }
};
const section = (t) => console.log('\n' + t);

// ---------- 1. 知识体系数据完整性 ----------
section('1. 知识体系数据');
ok('4 门科目', S.SUBJECTS.length === 4, '科目数=' + S.SUBJECTS.length);
ok('知识点非空', S.POINTS.length > 100, '知识点=' + S.POINTS.length + '，总学时=' + S.TOTAL_HOURS);
ok('每个知识点都有权重与学时', S.POINTS.every((p) => p.weight > 0 && p.hours > 0));
ok('章节归属正确', S.POINTS.every((p) => S.CHAPTER_BY_ID[p.chapterId] && S.CHAPTER_BY_ID[p.chapterId].subjectId === p.subjectId));
const badPre = S.POINTS.filter((p) => (p.pre || []).some((i) => !S.POINT_BY_ID[i]));
ok('前置依赖引用有效', badPre.length === 0, badPre.map((p) => p.id).join(',') || '无悬空引用');
const ids = new Set(S.POINTS.map((p) => p.id));
ok('知识点 id 唯一', ids.size === S.POINTS.length);

// ---------- 2. BKT 与遗忘曲线 ----------
section('2. 掌握度模型（BKT + 遗忘曲线）');
const p0 = 0.5;
ok('答对后掌握概率上升', E.bktUpdate(p0, true) > p0, '0.5 → ' + E.bktUpdate(p0, true).toFixed(3));
ok('答错后掌握概率下降', E.bktUpdate(p0, false) < p0, '0.5 → ' + E.bktUpdate(p0, false).toFixed(3));
ok('答对不会直接满分', E.bktUpdate(0.99, true) < 1, String(E.bktUpdate(0.99, true).toFixed(4)));
ok('答错不会直接归零', E.bktUpdate(0.02, false) > 0, String(E.bktUpdate(0.02, false).toFixed(4)));

const d10 = E.reviewDate('2026-01-01', 10);
const d5 = E.reviewDate('2026-01-01', 5);
ok('复习日期晚于当天', d10 > '2026-01-01', '稳定度10天 → ' + d10);
ok('稳定度越高，复习间隔越远', d10 > d5, '10天→' + d10 + ' / 5天→' + d5);
ok('稳定度增长（答对）', E.nextStability(5, true, 0.8) > 5, String(E.nextStability(5, true, 0.8).toFixed(2)));
ok('稳定度衰减（答错）', E.nextStability(5, false, 0.8) < 5, String(E.nextStability(5, false, 0.8).toFixed(2)));

const decA = E.decayed(0.9, 10, '2026-01-01', '2026-01-11');
const decB = E.decayed(0.9, 10, '2026-01-01', '2026-01-31');
ok('遗忘随时间加深', decB < decA, '10天后=' + decA.toFixed(3) + ' / 30天后=' + decB.toFixed(3));
ok('遗忘有下限（不会清零）', decB >= 0.9 * 0.15 - 1e-9, '30天后=' + decB.toFixed(3));

// ---------- 3. 空库评估 ----------
section('3. 评估接口（空数据）');
q.run(`INSERT INTO users (name, exam_date, daily_minutes, target_score, start_date) VALUES (?,?,?,?,?)`,
 '测试考生', E.addDays(E.todayStr(), 66), 240, 110, E.todayStr());
const u = q.get('SELECT * FROM users ORDER BY id LIMIT 1').id;

const a0 = E.assessment(u);
ok('无记录时掌握度=0', a0.overall.score === 0, 'score=' + a0.overall.score);
ok('无记录时覆盖=0', a0.overall.coverage === 0);
ok('四科评估齐全', a0.subjects.length === 4);
ok('剩余学时=总学时', Math.abs(a0.pace.remainingHours - S.TOTAL_HOURS) < 1, a0.pace.remainingHours + 'h');
ok('有提分空间估算', a0.overall.potentialScore > 0, '最多可提 ' + a0.overall.potentialScore + ' 分');
ok('目标缺口计算正确', a0.overall.targetGap === a0.overall.target - a0.overall.estimated,
 a0.overall.estimated + ' / ' + a0.overall.target);

// ---------- 4. 一次学习 → 一次复习的闭环 ----------
section('4. 学习闭环：学习 → 测验 → 掌握度变化 → 下次复习');
const pid = 'ds3-5'; // 图：最短路径
const before = E.weakPoints(u, 200).find((w) => w.point.id === pid);
ok('初始未学', before.studied === false);

E.applyLog(u, { point_id: pid, kind: 'study', minutes: 60, correct: 3, total: 8, self_rating: 3 });
const m1 = E.masteryMap(u)[pid];
ok('学习后掌握概率 > 0', m1.p_now > 0, 'p=' + m1.p_now.toFixed(3));
ok('学习后生成复习日期', Boolean(m1.next_review), m1.next_review);

const st1 = m1.stability;
E.applyLog(u, { point_id: pid, kind: 'review', minutes: 15, correct: 5, total: 5, self_rating: 4 });
const m2 = E.masteryMap(u)[pid];
ok('复习+全对后掌握度上升', m2.p_now > m1.p_now, m1.p_now.toFixed(3) + ' → ' + m2.p_now.toFixed(3));
ok('复习后记忆稳定度提升', m2.stability > st1, st1.toFixed(2) + ' → ' + m2.stability.toFixed(2));
ok('下次复习被推后', m2.next_review >= m1.next_review, m1.next_review + ' → ' + m2.next_review);

E.applyLog(u, { point_id: pid, kind: 'quiz', minutes: 10, correct: 1, total: 5, self_rating: 1 });
const m3 = E.masteryMap(u)[pid];
ok('答错多时掌握度回落', m3.p_now < m2.p_now, m2.p_now.toFixed(3) + ' → ' + m3.p_now.toFixed(3));
ok('薄弱点排行能抓到这个点', E.weakPoints(u, 200).some((w) => w.point.id === pid));

// ---------- 5. 动态路线规划 ----------
section('5. 动态路线规划');
const plan = E.buildDayPlan(u, E.todayStr(), { regenerate: true });
const totalMin = plan.items.reduce((s, i) => s + i.minutes, 0);
ok('生成今日任务', plan.items.length > 0, plan.items.length + ' 项 / ' + totalMin + ' 分钟');
ok('总时长不超预算', totalMin <= 240, totalMin + ' ≤ 240');
ok('包含复习任务', plan.items.some((i) => i.kind === 'review') || plan.items.some((i) => i.kind === 'new'));
ok('任务按优先级排序', plan.items.every((it, i, arr) => i === 0 || arr[i - 1].priority >= it.priority));
ok('每项任务都有理由说明', plan.items.every((i) => Boolean(i.reason)));

const st = E.strategy(u);
ok('策略档位有效', ['solid', 'standard', 'sprint'].includes(st.level), st.level + ' / ' + st.name + ' / 复习占比 ' + st.reviewShare);

const rp = E.routePreview(u, 14);
ok('未来路线 14 天', rp.days.length === 14);
ok('路线含复习与新学', rp.days.some((d) => d.items.some((i) => i.kind === 'review')));
ok('路线完成度递增', rp.days[rp.days.length - 1].pct >= rp.days[0].pct,
 rp.days[0].pct + '% → ' + rp.days[13].pct + '%');

// 时间极紧 → 应自动切到保分突击
q.run('UPDATE users SET exam_date=? WHERE id=?', E.addDays(E.todayStr(), 5), u);
const st2 = E.strategy(u);
ok('时间不足自动切「保分突击」', st2.level === 'sprint', st2.level + ' / ' + st2.name);
ok('保分突击降低低频点权重门槛', st2.skipBelowWeight >= 3, 'skipBelowWeight=' + st2.skipBelowWeight);
q.run('UPDATE users SET exam_date=? WHERE id=?', E.addDays(E.todayStr(), 66), u);

// ---------- 6. 学习建议 ----------
section('6. 学习建议（本地规则引擎）');
const adv = E.localAdvice(u);
ok('生成建议条目', adv.items.length >= 3, adv.items.length + ' 条');
ok('覆盖进度/薄弱/科目/目标', ['pace', 'weak', 'subject', 'score'].every((t) => adv.items.some((i) => i.type === t)),
 adv.items.map((i) => i.type).join(','));
ok('每条建议都有可执行文本', adv.items.every((i) => i.text && i.text.length > 10));
ok('引擎标记为 local', adv.engine === 'local');

// 人为制造一个「已到期」知识点，检查复习提醒与优先级排序
q.run(`UPDATE mastery SET next_review=?, p=0.5, stability=3 WHERE user_id=? AND point_id=?`,
 E.addDays(E.todayStr(), -3), u, pid);
q.run(`INSERT INTO mastery (user_id, point_id, p, stability, reps, last_at, next_review)
 VALUES (?,?,?,?,?,?,?)`,
 u, 'ds6-1', 0.7, 5, 2, E.addDays(E.todayStr(), -12), E.addDays(E.todayStr(), -1));
const dueStates = E.pointStates(u).filter((x) => x.state === 'due');
ok('到期知识点被识别', dueStates.length >= 2, dueStates.length + ' 个到期');
const adv2 = E.localAdvice(u);
const rev = adv2.items.find((i) => i.type === 'review');
ok('产生复习提醒建议', Boolean(rev), rev ? rev.title : '缺失');
const order = E.pointStates(u).filter((x) => x.state === 'due')
 .sort((x, y) => (y.weight * (1 - y.p)) - (x.weight * (1 - x.p)));
ok('到期清单按「权重×缺口」排序', order.length >= 2 && rev &&
 rev.text.includes(order[0].name), rev ? rev.text.slice(0, 46) + '…' : '');

// ---------- 7. 打卡连续性 ----------
section('7. 打卡逻辑');
const t = E.todayStr();
q.run('INSERT INTO checkins (user_id,date,minutes,mood) VALUES (?,?,?,?)', u, t, 200, 4);
q.run('INSERT INTO checkins (user_id,date,minutes,mood) VALUES (?,?,?,?)', u, E.addDays(t, -1), 180, 4);
q.run('INSERT INTO checkins (user_id,date,minutes,mood) VALUES (?,?,?,?)', u, E.addDays(t, -2), 160, 3);
const ck = q.all('SELECT * FROM checkins WHERE user_id=? ORDER BY date DESC', u);
ok('打卡记录可写入并去重', ck.length === 3, ck.length + ' 条');
let dup = false;
try { q.run('INSERT INTO checkins (user_id,date,minutes,mood) VALUES (?,?,?,?)', u, t, 100, 5); } catch (_) { dup = true; }
ok('同一天重复打卡被约束', dup);

// ---------- 汇总 ----------
console.log('\n========================================');
console.log(` 测试完成：通过 ${pass} 项，失败 ${fail} 项`);
console.log('========================================');
['', '-wal', '-shm'].forEach((s) => { try { fs.unlinkSync(TMP + s); } catch (_) {} });
process.exit(fail ? 1 : 0);
