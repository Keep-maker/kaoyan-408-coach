// ============================================================
//  智能体对话编排：一轮对话的完整生命周期
//   user msg → 意图 → (若有待答题)判分 → 工具调用 → 组装回复 → 落库
//  回复策略：本地结构化生成（保证数字准确、离线可用）；LLM 可用时润色/增强
// ============================================================
const S = require('../data/syllabus');
const E = require('./engine');
const llm = require('./llm');
const { q } = require('./db');
const A = require('./agent');
const T = require('./agent-tools');

const SUB = { ds: '数据结构', co: '计算机组成原理', os: '操作系统', cn: '计算机网络' };

// ---------- 会话落库 ----------
function saveMsg(userId, role, content, trace) {
  q.run('INSERT INTO agent_chat (user_id,role,content,trace) VALUES (?,?,?,?)',
    userId, role, content, trace ? JSON.stringify(trace) : null);
}
function history(userId, limit = 40) {
  return q.all('SELECT * FROM agent_chat WHERE user_id=? ORDER BY id DESC LIMIT ?', userId, limit).reverse();
}
function clearHistory(userId) { q.run('DELETE FROM agent_chat WHERE user_id=?', userId); }

// ---------- 额度/进度文案 ----------
function bar(p, width = 10) {
  const n = Math.max(0, Math.min(width, Math.round((p / 100) * width)));
  return '█'.repeat(n) + '░'.repeat(width - n);
}

// ============================================================
//  回复生成（每一类意图一个 writer，全部基于真实数据）
// ============================================================
const WRITER = {
  greet(userId, name) {
    const p = T.READ.progress(userId);
    const due = T.READ.due(userId);
    return {
      text: `你好，我是你的 **408 学习督导**。\n\n` +
        `现在是 ${p.pace.daysLeft} 天冲刺期，你的整体掌握度 **${p.overall.score}/100**（覆盖 ${p.overall.coverage}%），` +
        `预估 **${p.overall.estimated} 分**，目标 ${p.overall.target} 分，还差 ${p.overall.targetGap} 分。` +
        (due.length ? `\n\n今天有 **${due.length} 个知识点**到复习节点，最容易「学了就忘」。` : '') +
        `\n\n你可以直接跟我说：\n• 「我学不动了，今天只有 40 分钟」\n• 「抽背我几个知识点」\n• 「我的进度怎么样」「最该补哪里」`,
      trace: []
    };
  },

  help() {
    return {
      text: `我能实际**读写你的学习数据**，不只是聊天：\n\n` +
        `**📊 查情况**\n• 我的进度怎么样 / 数据结构学到哪了\n• 最薄弱的地方在哪 / 今天要复习什么\n• 今天学什么 / 未来一周路线\n\n` +
        `**✍️ 动手改数据**\n• 打卡 120 分钟，状态 4 星\n• 我学完了最小生成树，花了 40 分钟\n• 我学不动了，今天只有 40 分钟 → 自动降载重排\n• 重排今天的计划\n\n` +
        `**🎯 抽背出题**\n• 抽背我几个知识点（按你的薄弱点自动挑）\n• 考考我关键路径\n• 我答完题，你说「我答：……」我就判分并更新掌握度\n\n` +
        `**📰 其他**\n• 考研热点 / 报名资讯\n\n` +
        `> 每次考完，掌握度、复习间隔、薄弱点清单都会真的变化——这就是它和普通打卡表的区别。`,
      trace: []
    };
  },

  thanks() { return { text: '不客气。学不动的时候记得叫我，我会帮你把任务砍到最小，先动起来比什么都重要。', trace: [] }; },

  progress(userId, subject) {
    const p = T.READ.progress(userId, subject);
    const o = p.overall;
    const lines = [];
    if (subject && p.subject) {
      const s = p.subject;
      lines.push(`**${s.name}** 现在 ${s.score}/100（覆盖 ${s.coverage}%，风险 ${s.risk}）`);
      const weakCh = s.chapters.slice().sort((a, b) => b.risk - a.risk).slice(0, 3);
      lines.push('');
      lines.push('最该补的章节：');
      weakCh.forEach((c) => lines.push(`• ${c.name} —— 掌握 ${c.score}/100，风险 ${c.risk}`));
    } else {
      lines.push(`掌握度 ${bar(o.score)} **${o.score}/100**　预估 **${o.estimated} 分**（目标 ${o.target}，差 ${o.targetGap} 分）`);
      lines.push('');
      lines.push(`距初试 **${p.pace.daysLeft} 天**，未消化约 **${p.pace.remainingHours} 学时**，需要日均 **${p.pace.needDailyMinutes} 分钟**，你目前日均 **${p.pace.dailyAvg} 分钟**。`);
      lines.push('');
      lines.push('四科情况：');
      // 重新取完整四科
      const a = E.assessment(userId);
      a.subjects.forEach((s) => {
        lines.push(`• ${SUB[s.id]} ${bar(s.score, 8)} ${s.score}/100　覆盖 ${s.coverage}%　风险 ${s.risk}`);
      });
      lines.push('');
      lines.push(`连续打卡 **${p.streak.current} 天**（累计 ${p.streak.total} 天），当前策略：**${p.strategy.name}**。`);
      const riskiest = a.subjects.slice().sort((x, y) => y.risk - x.risk)[0];
      lines.push('');
      lines.push(`⚠️ 最可能丢分的是 **${riskiest.name}**（风险 ${riskiest.risk}）。`);
    }
    return { text: lines.join('\n'), trace: ['query_progress'] };
  },

  weak(userId) {
    const w = T.READ.weak(userId, 8);
    if (!w.length) return { text: '你已经没有明显薄弱点了，保持复习节奏即可。', trace: ['query_weak'] };
    const lines = ['按「考频权重 × 掌握缺口」排序，**现在最该补的 8 个点**：', ''];
    w.forEach((x, i) => {
      const acc = x.accuracy !== null ? `，历史正确率 ${x.accuracy}%` : '，还没练过';
      lines.push(`${i + 1}. **${x.name}**（${x.subject}·权重 ${x.weight}｜掌握 ${x.p}%${acc}）`);
    });
    lines.push('');
    lines.push(`> 提分逻辑：这些点权重高但掌握低，每补上一个，预估分都会往上走。要不要我**抽背**其中一道？（直接说「抽背」或「考考我 ${w[0].name}」）`);
    return { text: lines.join('\n'), trace: ['query_weak'] };
  },

  due(userId) {
    const d = T.READ.due(userId);
    if (!d.length) return { text: '今天没有到期的复习任务，可以放心推进新内容。', trace: ['query_due'] };
    const lines = [`今天有 **${d.length} 个**知识点到复习节点：`, ''];
    d.slice(0, 8).forEach((x) => {
      lines.push(`• **${x.name}**（${x.subject}｜权重 ${x.weight}｜掌握 ${x.p}%｜已推迟 ${x.overdueDays} 天）`);
    });
    if (d.length > 8) lines.push(`… 还有 ${d.length - 8} 个，见「今日计划」页。`);
    lines.push('');
    lines.push('> 这些点最容易「学了就忘」。要我**重排今天的计划**把复习排在前面吗？（说「重排计划」）');
    return { text: lines.join('\n'), trace: ['query_due'] };
  },

  plan(userId) {
    const p = T.READ.plan(userId);
    const todo = p.items.filter((i) => i.status === 'todo');
    const done = p.items.filter((i) => i.status === 'done');
    if (!p.items.length) return { text: '今天还没有计划，说「重排计划」我马上生成。', trace: ['query_plan'] };
    const lines = [`今天的计划（策略：**${p.strategy.name}**）`, ''];
    lines.push(`共 ${p.items.length} 项，已完成 ${done.length} 项。`);
    lines.push('');
    todo.slice(0, 10).forEach((i) => {
      const k = i.kind === 'new' ? '🆕 新学' : i.kind === 'review' ? '🔁 复习' : '🎯 专练';
      lines.push(`• ${k} **${i.point.name}**　${i.minutes} 分钟`);
      if (i.reason) lines.push(`　　${i.reason}`);
    });
    if (todo.length > 10) lines.push(`… 还有 ${todo.length - 10} 项`);
    lines.push('');
    lines.push('> 做完跟我说「我学完了 XXX，花了 40 分钟」，我帮你记账并更新掌握度。');
    return { text: lines.join('\n'), trace: ['query_plan'] };
  },

  hot(userId, news) {
    const lines = ['**考研热点 & 官方资讯**', ''];
    if (news.official && news.official.length) {
      lines.push('📌 官方（研招网）：');
      news.official.slice(0, 5).forEach((x) => lines.push(`• ${x.title}`));
      lines.push('');
    }
    if (news.hot && news.hot.length) {
      lines.push('🔥 全网热议（已按考研/计算机关键词过滤）：');
      news.hot.slice(0, 6).forEach((x) => lines.push(`• ${x.title}　（${x.source}）`));
      lines.push('');
    }
    lines.push('> 完整列表见左侧「考研热点」页。');
    return { text: lines.join('\n'), trace: ['hot_news'] };
  },

  route(userId, days = 7) {
    const r = T.READ.route(userId, days);
    const lines = [`未来 ${days} 天路线（策略：**${r.strategy.name}**）`, ''];
    r.days.slice(0, days).forEach((d) => {
      lines.push(`**${d.date.slice(5)}**　新学 ${d.newCount}｜复习 ${d.reviewCount}｜专练 ${d.drillCount}　累计完成 ${d.pct}%`);
      if (d.names.length) lines.push(`　　${d.names.slice(0, 4).join('、')}${d.names.length >= 4 ? ' …' : ''}`);
    });
    lines.push('');
    lines.push(`> 策略会随你的**真实速度**自动切换：${r.strategy.note}`);
    return { text: lines.join('\n'), trace: ['plan_route'] };
  }
};

module.exports = { WRITER, saveMsg, history, clearHistory, bar, SUB };
