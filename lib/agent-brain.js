// ============================================================
// 智能体编排（Brain）：一轮对话的完整生命周期
// user msg → 有待答题?判分 : 意图解析 → 工具调用(真实读写) → 组装回复 → 落库
// ============================================================
const S = require('../data/syllabus');
const E = require('./engine');
const llm = require('./llm');
const hot = require('./hot');
const A = require('./agent');
const T = require('./agent-tools');
const R = require('./agent-reply');

const today = () => E.todayStr();
const PENDING = 'pending_quiz';
// 是否值得尝试大模型：已确认不可用时跳过（避免每次白等超时）；租约到期后自动重试（K 到期即恢复，无需重启）
const llmWorthTrying = () => llm.available() && llm.health().status !== 'unavailable';
const QSTATS = 'quiz_stats';

const fmtD = (s) => (s ? `${Number(s.slice(5, 7))}月${Number(s.slice(8, 10))}日` : '—');
const bar = R.bar;

// ---------- 会话状态辅助 ----------
function getPending(uid) { return A.getState(uid, PENDING); }
function setPending(uid, q) { A.setState(uid, PENDING, q); }
function clearPending(uid) { A.clearState(uid, PENDING); }
function bumpStats(uid, correct, total) {
 const s = A.getState(uid, QSTATS) || { asked: 0, correct: 0, total: 0 };
 s.asked += 1; s.correct += correct; s.total += total;
 A.setState(uid, QSTATS, s);
 return s;
}

// ---------- 出题 ----------
function askQuiz(uid, { point = null, subject = null } = {}) {
 const tr = [];
 const r = T.ACT.quiz_me(uid, { point, subject });
 tr.push({ tool: 'quiz_me', label: '按薄弱点×高频×有题库挑题' });
 const pt = r.point;
 setPending(uid, { pointId: pt.id, q: r.question.q, a: r.question.a, k: r.question.k });
 const lines = [
 ` **抽背 · ${pt.name}**`,
 `{小字}${pt.subjectName} · ${pt.chapterName}｜权重 ${pt.weight}｜你当前掌握度 ${r.mastery}%${r.studied ? '' : '（还没学过，先试试）'}{/小字}`,
 '',
 `**题目：${r.question.q}**`,
 '',
 '> 直接把答案打给我（想到多少说多少）；不会就回「不知道」，我给你参考答案并调整复习计划。'
 ];
 return { text: lines.join('\n'), trace: tr, interactive: true };
}

// ---------- 判分 + 真实更新掌握度 ----------
function gradeQuiz(uid, answer) {
 const tr = [];
 const p = getPending(uid);
 if (!p) return null;
 const pt = S.POINT_BY_ID[p.pointId];
 const mmBefore = E.masteryMap(uid);
 const before = mmBefore[p.pointId] ? Math.round(mmBefore[p.pointId].p_now * 100) : 0;
 const g = T.ACT.grade_answer(uid, { pointId: p.pointId, answer, keywords: p.k });
 tr.push({ tool: 'grade_answer', label: `关键词命中 ${g.hits.length}/${p.k.length}` });
 const lg = T.ACT.log_study(uid, { point: pt, kind: 'quiz', minutes: 5, correct: g.correct, total: g.total });
 tr.push({ tool: 'log_study', label: 'BKT 更新掌握度 + 重算复习间隔' });
 const stats = bumpStats(uid, g.correct, g.total);
 clearPending(uid);

 const verdict = g.rate >= 0.75 ? ' 全对' : g.rate >= 0.5 ? ' 基本正确' : g.rate >= 0.25 ? ' 部分正确' : ' 需要重学';
 const L = [];
 L.push(`${verdict}　命中 **${g.hits.length}/${p.k.length}** 个得分点`);
 L.push('');
 if (g.hits.length) L.push(` 说到：${g.hits.join('、')}`);
 if (g.misses.length) L.push(` 漏掉：${g.misses.join('、')}`);
 L.push('');
 L.push(`**参考答案**：${p.a}`);
 L.push('');
 const after = lg.ok ? lg.p : before;
 if (lg.ok) {
 const delta = after - before;
 L.push(`掌握度 **${before}% → ${after}%**（${delta >= 0 ? '+' : ''}${delta}）｜记忆稳定度 ${Math.round(lg.stability * 10) / 10} 天`);
 L.push(`下次复习：**${fmtD(lg.nextReview)}**`);
 }
 L.push('');
 if (g.rate >= 0.75) {
 L.push(`> 「${pt.name}」已计入你的掌握数据，复习间隔按记忆稳定度自动拉长。`);
 } else {
 L.push(`> 「${pt.name}」（权重 ${pt.weight}）已进入薄弱清单，系统**调高了它的复习频率**，接下来几天会反复出现在你的计划里。`);
 }
 if (stats.asked > 1) L.push(`> 本轮抽背：${stats.asked} 题，累计得分点命中率 ${Math.round((stats.correct / stats.total) * 100)}%。`);
 L.push('');
 L.push('继续抽背说「继续」，想看当前薄弱清单说「最该补哪里」。');
 return { text: L.join('\n'), trace: tr, interactive: true };
}

// ---------- 意图 → 工具 → 回复 ----------
async function dispatch(uid, msg, it) {
 const tr = [];
 const push = (tool, label) => tr.push({ tool, label: label || '' });
 const user = require('./db').q.get('SELECT * FROM users WHERE id=?', uid);
 const name = user?.name || '同学';

 switch (it.intent) {
 case 'about_self': { const r = R.WRITER.aboutSelf(llm.info()); r.trace = tr; return r; }
 case 'greet': { push('query_progress'); push('query_due'); const r = R.WRITER.greet(uid, name); r.trace = tr; return r; }
 case 'help': { const r = R.WRITER.help(); r.trace = tr; return r; }
 case 'thanks': { const r = R.WRITER.thanks(); r.trace = tr; return r; }

 case 'progress': { const r = R.WRITER.progress(uid, it.subject); r.trace = tr.concat(r.trace.map((t) => ({ tool: t }))); return r; }
 case 'weak': { const r = R.WRITER.weak(uid); r.trace = tr.concat(r.trace.map((t) => ({ tool: t }))); return r; }
 case 'due': { const r = R.WRITER.due(uid); r.trace = tr.concat(r.trace.map((t) => ({ tool: t }))); return r; }
 case 'plan': { const r = R.WRITER.plan(uid); r.trace = tr.concat(r.trace.map((t) => ({ tool: t }))); return r; }
 case 'route': {
 const days = 7;
 const r = R.WRITER.route(uid, days);
 r.trace = [{ tool: 'plan_route', label: `模拟未来 ${days} 天（不落库）` }];
 return r;
 }
 case 'hot': {
 let news = { official: [], hot: [] };
 try { news = await hot.collect({}); push('hot_news', '拉取研招网 + 热榜并过滤'); }
 catch (e) { push('hot_news', '拉取失败，用内置兜底'); }
 const r = R.WRITER.hot(uid, news);
 r.trace = tr;
 return r;
 }

 case 'replan': {
 const r = T.ACT.replan(uid, { minutes: null });
 push('replan', '按最新掌握情况重排今日计划');
 const p = T.READ.plan(uid);
 const todo = p.items.filter((i) => i.status === 'todo');
 const L = [` 已重排今天的计划（策略：**${r.strategy.name}**）`, '',
 `任务从 ${r.before} 项调整为 **${r.items} 项**，总时长 ${r.totalMinutes} 分钟。`, ''];
 todo.slice(0, 6).forEach((i) => {
 const k = i.kind === 'new' ? '' : i.kind === 'review' ? '' : '';
 L.push(`${k} **${i.point.name}**　${i.minutes} 分钟　{小字}${i.reason}{/小字}`);
 });
 if (todo.length > 6) L.push(`… 还有 ${todo.length - 6} 项，见「今日计划」页。`);
 L.push('');
 L.push('> 排期优先级：**到期复习 > 高频薄弱专练 > 新知识点**（按前置依赖顺序）。');
 return { text: L.join('\n'), trace: tr };
 }

 case 'tired': {
 const min = it.minutes || 40;
 const rp = T.ACT.replan(uid, { minutes: min });
 push('replan', `按 ${min} 分钟重排今日计划`);
 const rd = T.ACT.rest_directive(uid, { minutes: min });
 push('rest_directive', '削减为最小启动任务');
 const L = [` 收到，今天只有 **${min} 分钟**、状态也不在线——那就**只做最关键的**。`, '',
 `我已经把今天的计划压到 ${min} 分钟以内（原 ${rp.before} 项 → 现在 ${rp.items} 项）。`, '',
 '**只做这两件事就够了：**', ''];
 rd.tasks.slice(0, 3).forEach((t) => {
 const k = t.kind === 'new' ? ' 新学' : t.kind === 'review' ? ' 复习' : ' 专练';
 L.push(`• ${k} **${t.point ? t.point.name : t.point_id}**　≈${t.minutes} 分钟`);
 });
 if (!rd.tasks.length) L.push('• 今天没有到期任务，那就**只看一眼错题**，5 分钟也行。');
 L.push('');
 L.push(`合计约 ${rd.totalMinutes || 0} 分钟。`);
 L.push('');
 L.push('> 状态差的时候，**"开始"比"学多少"重要**。做完这两件就跟我说「我学完了 XXX」，我给你记上，连续打卡不会断。');
 return { text: L.join('\n'), trace: tr };
 }

 case 'quiz': {
 if (it.point) {
 const r = askQuiz(uid, { point: it.point });
 return r;
 }
 return askQuiz(uid, {});
 }

 case 'ask': {
 const pt = it.point;
 const mm = E.masteryMap(uid);
 const m = mm[pt.id];
 const p = m ? Math.round(m.p_now * 100) : 0;
 const qb = A.QB.BY_POINT[pt.id];
 push('query_progress', '取该点掌握情况');
 const L = [];
 L.push(` **${pt.name}**`);
 L.push(`{小字}${pt.subjectName} · ${pt.chapterName}｜权重 ${pt.weight}｜建议 ${pt.hours}h｜难度 ${pt.diff}/5{/小字}`);
 L.push('');
 L.push(`你当前掌握度：**${p}%**${m ? `｜下次复习 ${fmtD(m.next_review)}` : '（还没学过）'}`);
 L.push('');
 if (qb && qb.length) {
 L.push('**考法示例**（权威参考表述）：');
 qb.slice(0, 2).forEach((x, i) => {
 L.push(`${i + 1}. Q：${x.q}`);
 L.push(`　 A：${x.a}`);
 });
 L.push('');
 L.push('> 想要我**出题考你**，说「考考我 ' + pt.name + '」或「抽背这个」。');
 } else {
 L.push('> 这个点暂时没有题库示例。说「抽背」我可以按你的薄弱点挑有题的高频考点。');
 }
 push('quiz_me', '读题库参考表述');
 return { text: L.join('\n'), trace: tr };
 }

 case 'checkin': {
 const r = T.ACT.check_in(uid, { minutes: it.minutes || 0, mood: it.mood || 4 });
 push('check_in', '写入打卡表');
 const moodTxt = r.mood >= 4 ? '状态不错' : r.mood === 3 ? '状态一般' : '状态偏低';
 const L = [];
 if (r.minutes) L.push(`已打卡：今天 **${r.minutes} 分钟**，${moodTxt}。`);
 else L.push(`已打卡（今天还没填时长，说「打卡 120 分钟」我可以补上）。`);
 L.push('');
 L.push(`连续打卡 **${r.streak} 天**（累计 ${r.total} 天）`);
 const adv = T.READ.progress(uid);
 L.push(`当前掌握度 ${adv.overall.score}/100，预估 ${adv.overall.estimated} 分（目标 ${adv.overall.target}）`);
 L.push('');
 if (r.streak >= 7) L.push('> 连击保持得很好。今天要不要顺手**抽背一题**？说「抽背」就行。');
 else L.push('> 明天同一时间再来一次，连击就续上了。');
 return { text: L.join('\n'), trace: tr };
 }

 case 'studyLog': {
 const pt = it.point;
 if (!pt) {
 return { text: '我还没听清是哪个知识点。可以说「我学完了 **最小生成树**，花了 40 分钟」，或者直接说知识点全名。', trace: tr };
 }
 const kind = it.kind || 'study';
 const mins = it.minutes || 30;
 const before = E.masteryMap(uid)[pt.id] ? Math.round(E.masteryMap(uid)[pt.id].p_now * 100) : 0;
 const r = T.ACT.log_study(uid, { point: pt, kind, minutes: mins, self_rating: it.self_rating || 0 });
 push('log_study', `写入学习记录（${kind === 'review' ? '复习' : kind === 'quiz' ? '测验' : '新学'}）`);
 push('applyLog', 'BKT + 遗忘曲线更新掌握度');
 const kindTxt = kind === 'review' ? '复习' : kind === 'quiz' ? '测验' : '学习';
 const L = [`已记上：**${pt.name}**　${kindTxt} ${mins} 分钟`, '',
 `掌握度 **${before}% → ${r.p}%**${r.p > before ? '（↑）' : r.p < before ? '（↓，正常遗忘衰减）' : ''}`,
 `下次复习：**${fmtD(r.nextReview)}**（记忆稳定度 ${Math.round(r.stability * 10) / 10} 天）`, ''];
 const st = E.strategy(uid);
 L.push(`> 排期策略：**${st.name}**。本次已同步：今日计划打勾 + 打卡时长累加。`);
 const ck = require('./db').q.get('SELECT minutes FROM checkins WHERE user_id=? AND date=?', uid, today());
 if (ck) L.push(`> 今日累计学习 **${ck.minutes} 分钟**。`);
 L.push('');
 L.push(parseFloat(r.p) < 60 ? '> 这个点还偏弱，接下来会被排进**高频薄弱专练**。' : '> 保持住，复习间隔会自动拉长，把时间省给薄弱点。');
 return { text: L.join('\n'), trace: tr };
 }

 default: {
 // 开放域兜底：LLM 可用则增强，不可用给引导话术
 const ctx = T.READ.progress(uid);
 if (llmWorthTrying()) {
 try {
 const sys = '你是 408 计算机考研学习督导，回答简洁、给可执行的下一步。学生数据：' +
 `掌握度${ctx.overall.score}/100，覆盖${ctx.overall.coverage}%，预估${ctx.overall.estimated}分/150，` +
 `距初试${ctx.pace.daysLeft}天，连续打卡${ctx.streak.current}天，策略${ctx.strategy.name}。` +
 '只讲与该生考研复习有关的内容，不要编造他的学习数据。' +
 '注意：直接用中文作答，先给结论再展开，不要在思考过程里反复权衡。' +
            '全文禁止使用任何 emoji 表情或图标符号（如勾选、星号、火焰等），只用纯文本与中文标点。';
 // 带上最近几轮对话，否则追问（"它和 XX 的区别"）会因指代不明而答偏
 const hist = recentTurns(uid, 8);
 const msgs = [{ role: 'system', content: sys }, ...hist, { role: 'user', content: msg }];
 // maxTokens 必须给推理模型留足"思考"余量：过小会导致正文为空
 const ans = await llm.chat(msgs, { maxTokens: 3000, timeoutMs: 120000 });
 const clean = String(ans || '').trim();
 if (!clean) throw new Error('LLM_EMPTY_REPLY');
 push('llm_chat', '大模型增强回答（含上下文）');
 return { text: clean + '\n\n> 想问学习数据类的问题（进度/薄弱点/抽背/计划），我直接用你的真实数据回答会更准。', trace: tr };
 } catch (e) {
 push('llm_chat', '大模型不可用，回退本地引导');
 }
 }
 return { text: '这个问题我暂时没法用你的学习数据回答。我**最擅长这些**：\n\n' +
 '• 「我的进度怎么样」「最该补哪里」「今天学什么」\n' +
 '• 「抽背我几个知识点」「考考我 TCP 拥塞控制」\n' +
 '• 「打卡 120 分钟，状态 4 星」\n' +
 '• 「我学完了最小生成树，花了 40 分钟」\n' +
 '• 「我学不动了，今天只有 40 分钟」\n' +
 '• 「重排今天的计划」「未来一周路线」「考研热点」', trace: tr };
 }
 }
}

// 取最近 N 条历史对话，转成大模型可用的 messages（跳过工具轨迹与空内容）
function recentTurns(uid, limit = 8) {
 const rows = R.history(uid, limit) || [];
 const out = [];
 rows.forEach((r) => {
 const c = String(r.content || '').trim();
 if (!c) return;
 // 过滤掉大模型回复里附带的固定提示语，避免污染上下文
 const trimmed = c.split('\n> 想问学习数据类的问题')[0].trim();
 if (!trimmed) return;
 out.push({ role: r.role === 'user' ? 'user' : 'assistant', content: trimmed.slice(0, 800) });
 });
 // 去掉最后一条（就是本轮刚存进去的用户消息，单独再传）
 if (out.length && out[out.length - 1].role === 'user') out.pop();
 return out.slice(-6);
}

// ---------- 一轮对话入口 ----------
async function runTurn(uid, message) {
 const msg = String(message || '').trim();
 if (!msg) return { reply: '（我没收到内容，再说一次？）', trace: [] };
 R.saveMsg(uid, 'user', msg);

 let out;
 const pending = getPending(uid);
 const it = A.parseIntent(msg);
 const notSure = /^(不知道|不会|没印象|忘了|不记得|答不上|no idea|没想好|答不出)/.test(msg);
 const CONT = /^(继续|再来|下一题|换一题|再来一题|下一个|继续抽背|再来几个|下一道|再来一题|继续考)/;
 const KNOWN = new Set(['greet', 'help', 'thanks', 'about_self', 'progress', 'weak', 'due', 'plan', 'route', 'hot', 'replan', 'tired', 'checkin', 'studyLog']);

 if (pending && CONT.test(msg)) {
 // 明确要求换题 → 丢弃当前题
 clearPending(uid);
 out = askQuiz(uid, {});
 }
 if (!out && pending && KNOWN.has(it.intent)) {
 // 明确的新指令 → 结束当前题，不再纠缠
 clearPending(uid);
 }
 if (!out && pending && (it.intent === 'unknown' || it.intent === 'quiz' || notSure || A.RE.answerGiven.test(msg))) {
 out = gradeQuiz(uid, msg);
 }
 if (!out && !pending && CONT.test(msg)) {
 // 刚答完题又说「继续」→ 再来一题
 out = askQuiz(uid, {});
 }
 if (!out) {
 try { out = await dispatch(uid, msg, it); }
 catch (e) {
 out = { text: '我这边处理时出了点问题：' + e.message + '\n\n换个说法再试一次？', trace: [{ tool: 'error', label: e.message }] };
 }
 }
 if (!out) out = { text: '（没想好怎么回，换个说法？）', trace: [] };

 R.saveMsg(uid, 'agent', out.text, out.trace);
 return { reply: out.text, trace: out.trace || [], tools: (out.trace || []).map((t) => t.tool),
 pending: Boolean(getPending(uid)), interactive: Boolean(out.interactive) };
}

module.exports = { runTurn, askQuiz, gradeQuiz, getPending, clearPending };
