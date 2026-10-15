// ============================================================
//  生成演示数据（答辩一键填充）
//  用法：先把服务跑起来 npm start，然后 npm run seed
//       也可指定：node scripts/seed-demo.js 45
//  会覆盖当前学习记录，建议先备份 data/kaoyan.db
// ============================================================
const days = Number(process.argv[2] || 60);
const base = process.env.KY_BASE || 'http://127.0.0.1:4080';

(async () => {
  const r = await fetch(base + '/api/demo/seed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ days })
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  const o = await (await fetch(base + '/api/overview')).json();
  const a = o.assessment;
  console.log('演示数据已生成：' + j.logs + ' 条学习记录 / 模拟 ' + j.days + ' 天');
  console.log('  整体掌握度 ' + j.summary.mastery + '/100　知识点覆盖 ' + j.summary.coverage + '%　预估 ' + j.summary.estimated + ' 分');
  console.log('  连续打卡 ' + o.streak.current + ' 天（最长 ' + o.streak.max + '）　待复习 ' + o.dueCount + ' 个　策略：' + o.strategy.name);
  console.log('  今日任务 ' + o.todayPlan.length + ' 项（新学 ' + o.todayPlan.filter((i) => i.kind === 'new').length +
    ' / 复习 ' + o.todayPlan.filter((i) => i.kind === 'review').length +
    ' / 专练 ' + o.todayPlan.filter((i) => i.kind === 'drill').length + '）');
  a.subjects.forEach((s) => console.log('  · ' + s.name + '：掌握 ' + s.score + '/100，覆盖 ' + s.coverage + '%，风险 ' + s.risk));
  console.log('打开 ' + base + ' 查看');
})().catch((e) => { console.error('失败：' + e.message + '（请先运行 npm start）'); process.exit(1); });
