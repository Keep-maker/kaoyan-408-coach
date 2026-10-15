// ============================================================
//  智能体核心（Agent）：意图理解 → 工具调用 → 真实数据变更 → 回复
//  设计原则：
//   1) 本地确定性意图解析（不依赖云端 LLM 也能完整工作）
//   2) LLM 可用时作为「大脑增强」：负责表达润色 + 开放域问答 + 意图兜底
//   3) 每个工具都真实读写数据库，回答里的数字全部来自引擎计算结果
// ============================================================
const S = require('../data/syllabus');
const QB = require('../data/quizbank');
const E = require('./engine');
const llm = require('./llm');

// ---------- 工具定义（可被 LLM 以 function calling 形式使用）----------
const TOOLS = [
  { name: 'query_progress', desc: '查询学习进度与掌握情况：整体掌握度、四科分数、剩余天数、速度是否达标',
    params: { subject: '可选，ds/co/os/cn' } },
  { name: 'query_weak', desc: '查询最薄弱的知识点排行（按权重×缺口）',
    params: { limit: '可选，默认8' } },
  { name: 'query_due', desc: '查询今天到期或已过期的复习清单',
    params: {} },
  { name: 'query_plan', desc: '查询今日学习计划',
    params: {} },
  { name: 'check_in', desc: '打卡：记录今天的学习时长与状态，可写笔记',
    params: { minutes: '分钟', mood: '1-5状态', note: '可选' } },
  { name: 'log_study', desc: '登记某知识点的学习/复习/测验记录',
    params: { point: '知识点名称或id', kind: 'study/review/quiz', minutes: '分钟', correct: '答对题数(quiz时)', total: '总题数(quiz时)' } },
  { name: 'replan', desc: '重新生成今日计划（例如状态差、时间被压缩时）',
    params: { minutes: '可选，今天实际可投入的分钟数' } },
  { name: 'quiz_me', desc: '抽背/出题：从题库中挑知识点向学生提问',
    params: { point: '可选，指定知识点；不填则按薄弱点自动挑', subject: '可选' } },
  { name: 'rest_directive', desc: '状态不佳时的最小启动方案（降低今日目标）',
    params: { minutes: '可投入分钟' } },
  { name: 'hot_news', desc: '查询考研热点与官方资讯',
    params: {} },
  { name: 'plan_route', desc: '查看未来若干天的动态路线',
    params: { days: '默认7' } }
];

// ---------- 知识点模糊匹配 ----------
//  统一打分：精确/包含 > 主名 > 括号别名 > 最长公共子串 > 分词
//  返回 [{ p, sc, why }]，findPoint 取最高分；rankPoints 供「消歧」使用
const NOISE = /(是什么|什么是|什么叫|啥意思|什么意思|有哪些|有哪几个|请解释|解释一下|解释|讲讲|说一下|介绍一下|介绍|如何|怎么|怎样|为什么|为啥|区别|联系|原理|作用|机制|的特点|是什么样|一下|来着|呢|吗|呀|啊|请问|帮我|我想知道|学的|学了|关于|相关|这个|那个|我|的|了)/g;

// 通用词：单独命中说明不了指向哪个知识点（避免「KMP 算法」被匹配成「调度算法」）
const GENERIC = new Set(['算法', '结构', '原理', '系统', '网络', '管理', '方式', '计算', '方法',
  '技术', '概念', '基本', '基础', '分析', '设计', '实现', '过程', '流程', '相关', '特点', '数据',
  '时间', '空间', '比较', '内容', '问题', '情况', '状态', '水平', '分数', '进度', '计划', '安排',
  '什么', '区别', '联系', '作用', '机制', '定义', '概述', '应用', '场景', '目标', '策略',
  '模型', '模式', '层次', '分类', '种类', '类型', '特性', '特征', '效果', '效率', '性能',
  '程序', '语言', '代码', '软件', '硬件', '设备', '命令', '指标', '参数', '表示', '描述']);
const isGeneric = (sub) => !sub || GENERIC.has(sub) || sub.length < 2;
// 纯英文字串要求整词命中：KMP 中的 "MP" 不应命中 ICMP
const asciiHit = (raw, sub) => {
  if (!/^[A-Za-z0-9+#.-]+$/.test(sub)) return true;
  const esc2 = sub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^A-Za-z0-9])' + esc2 + '([^A-Za-z0-9]|$)', 'i').test(raw);
};

function lcs(x, y) {
  let bestLen = 0, bestPos = 0;
  let prev = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i++) {
    const cur = new Array(y.length + 1).fill(0);
    for (let j = 1; j <= y.length; j++) {
      if (x[i - 1] === y[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > bestLen) { bestLen = cur[j]; bestPos = i - cur[j]; }
      }
    }
    prev = cur;
  }
  return { len: bestLen, sub: x.substr(bestPos, bestLen) };
}

function rankPoints(text) {
  if (!text) return [];
  const raw = String(text).trim();
  const low = raw.toLowerCase();
  // 剥离科目名 + 时长描述，避免"操作系统页表"被当成"操作系统结构"
  const SUBJ = /(数据结构|计算机组成原理|计算机组成|组成原理|计组|操作系统|计算机网络|计网|计算机专业|专业课)/g;
  const cleaned = raw.replace(NOISE, '').replace(SUBJ, '')
    .replace(/\d+\s*(分钟|min|小时|h|星|道|题|个)/g, '')
    .replace(/[\s、,，。？！?!.：:；;（）()【】\[\]]+/g, '');
  const tokens = raw.split(/[\s、,，。的（）()]+/).filter((x) => x.length >= 2);
  const out = [];

  S.POINTS.forEach((p) => {
    const nm = p.name;
    const main = nm.replace(/[（(][^）)]*[）)]/g, '').trim();
    let sc = 0, why = '';
    if (p.id === low) { sc = 900; why = 'id'; }
    else if (nm === raw) { sc = 1000; why = '全名'; }
    if (nm.includes(raw) && raw.length >= 2 && 500 + raw.length > sc) { sc = 500 + raw.length; why = '名字包含'; }
    if (raw.includes(nm) && 400 + nm.length > sc) { sc = 400 + nm.length; why = '整句含全名'; }
    if (main && main === raw && 700 > sc) { sc = 700; why = '主名'; }
    if (main.length >= 2 && raw.includes(main) && 350 + main.length * 4 > sc) { sc = 350 + main.length * 4; why = '整句含主名'; }
    // 括号别名 / 标签
    const paren = (nm.match(/[（(]([^）)]*)[）)]/g) || []).join(' ').replace(/[（()）]/g, ' ');
    const alias = (paren + ' ' + (p.tags || []).join(' ')).trim();
    if (alias) {
      let hit = 0;
      alias.split(/[\s、,，/／]+/).filter((x) => x.length >= 2 && !isGeneric(x) && asciiHit(raw, x)).forEach((x) => { if (raw.includes(x)) hit += 1; });
      if (hit && 200 + hit * 12 > sc) { sc = 200 + hit * 12; why = '别名/标签'; }
    }
    // 最长公共子串（去疑问词后）
    if (cleaned.length >= 2 && main.length >= 2) {
      const r = lcs(cleaned, main);
      if (r.len >= 2 && !isGeneric(r.sub) && asciiHit(raw, r.sub)) {
        const s2 = r.len * 20 + (p.weight || 0) + Math.round((r.sub.length / (main.length + 1)) * 12);
        if (s2 > sc) { sc = s2; why = '相似:' + r.sub; }
      }
    }
    // 分词命中
    if (tokens.length) {
      let s3 = 0;
      tokens.forEach((tk) => { if (nm.includes(tk) && !isGeneric(tk) && asciiHit(raw, tk)) s3 += tk.length * 3;
        if ((p.tags || []).some((g) => g.includes(tk))) s3 += 2; });
      if (s3 >= 4 && s3 > sc) { sc = s3; why = '分词'; }
    }
    if (sc > 0) out.push({ p, sc, why });
  });
  return out.sort((a, b) => b.sc - a.sc);
}

// 置信度阈值：低于此分说明"没有真正指向某个知识点"，应当引导而不是硬答
const LOW_CONF = 40;
function rankConfidence(text) {
  const r = rankPoints(text);
  if (!r.length) return { point: null, score: 0, second: 0 };
  return { point: r[0].p, score: r[0].sc, second: r[1] ? r[1].sc : 0 };
}

function findPoint(text) {
  if (!text) return null;
  const t = String(text).trim();
  if (S.POINT_BY_ID[t]) return S.POINT_BY_ID[t];
  const r = rankPoints(t);
  return r.length ? r[0].p : null;
}

// ---------- 意图解析（本地规则，覆盖高频表达）----------
const RE = {
  // 关于助手自身（"你是什么模型"等）——必须在知识点匹配前拦截
  about_self: [
    /你.*(什么|哪个|啥|是哪个).*模型/,
    /^你(是|叫|用的)/,
    /你(是|是不是)(AI|人工智能|机器人|程序|智能体)/i,
    /介绍(一下)?你自己|自我介绍|你是谁/,
    /你(的)?(原理|系统|机制)(是)?什么/,
    /你(会|能)(做|干)什么(模型|原理|机制)/,
    /你(背后|底层)是|你用的?(是|什么)(deepseek|qwen|通义|gpt|claude)/i
  ],
  greet: /^(你好|您好|在吗|hi|hello|嗨|早上好|晚上好|下午好)/i,
  help: /(你会什么|能做什么|怎么用|有什么功能|帮助|说明书|使用指南|help)/,
  progress: /(我的?进度|学得怎么样|掌握得?怎么样|掌握了?多少|现在什么水平|水平怎么样|能考多少|预估|估分|还剩|多少天|掌握度|什么情况|最近怎么样|汇报|学到哪|学到哪了|进度如何|怎么样了|怎么样|如何|什么水平|什么状态)/,
  weak: /(薄弱|短板|最差|弱项|哪里不行|差在哪|最该补|最需要补|漏洞|丢分)/,
  due: /(该复习|要复习|复习什么|到期|遗忘|快忘)/,
  plan: /(今天|今日).*(学什么|计划|任务)|计划呢|安排一下|今天怎么学/,
  checkin: /(打卡|签到)/,
  tired: /(学不动|没状态|好累|太累|不想学|状态差|坚持不|没动力|学不下去|焦虑|崩溃|效率低|学不进去|想放弃|摆烂|摸鱼)/,
  quiz: /(抽背|考考我|考我|出题|来几道|测一下|测测|提问|抽题|背一下|问我|抽查)/,
  hot: /(热点|资讯|新闻|报名|大纲|政策|招生|调剂|研招网)/,
  route: /(路线|规划|未来|后面怎么安排|长期|几周|下个月|整体计划)/,
  replan: /(重排|重新安排|调整计划|改一下计划|重新规划|换一下|重新来)/,
  answerGiven: /^(我?先?答|答案|我的?回答|不对|不知道|不会|好像是|应该是|差不多)/,
  thanks: /(谢谢|感谢|辛苦|好的?谢谢|多谢)/,
  reset: /(清空|重置|删除数据|重置数据)/
};

function parseIntent(text) {
  const t = String(text || '').trim();
  if (!t) return { intent: 'unknown' };
  if (RE.about_self.some((re) => re.test(t))) return { intent: 'about_self' };
  if (RE.greet.test(t) && t.length <= 12) return { intent: 'greet' };
  if (RE.help.test(t)) return { intent: 'help' };
  if (RE.thanks.test(t)) return { intent: 'thanks' };
  if (RE.tired.test(t)) {
    const m = t.match(/(\d+)\s*(分钟|min|小时|h|個|个)/);
    let min = null;
    if (m) { const v = Number(m[1]); min = /小时|h/.test(m[2]) ? Math.round(v * 60) : v; }
    return { intent: 'tired', minutes: min };
  }
  if (RE.quiz.test(t)) {
    return { intent: 'quiz', point: findPoint(t.replace(/.*?(抽背|考考我|考我|出题|问我|抽查|背一下|来几道|测一下|测测|测|提问)/, '')) };
  }
  if (RE.due.test(t)) return { intent: 'due' };
  if (RE.weak.test(t)) return { intent: 'weak' };
  if (RE.replan.test(t)) return { intent: 'replan' };   // 先于 plan：重排/调整计划是动作
  if (RE.plan.test(t)) return { intent: 'plan' };
  if (RE.route.test(t)) return { intent: 'route' };
  if (RE.hot.test(t)) return { intent: 'hot' };
  if (RE.progress.test(t)) {
    let subject = null;
    if (/数据结构/.test(t)) subject = 'ds';
    else if (/组成原理|计组/.test(t)) subject = 'co';
    else if (/操作系统|OS/i.test(t)) subject = 'os';
    else if (/计算机网络|计网|网络/.test(t)) subject = 'cn';
    return { intent: 'progress', subject };
  }
  if (RE.checkin.test(t)) {
    const m = t.match(/(\d+)\s*(分钟|min|小时|h)/);
    let minutes = null;
    if (m) { const v = Number(m[1]); minutes = /小时|h/.test(m[2]) ? Math.round(v * 60) : v; }
    const moodM = t.match(/(^|[^\d])(\d)\s*星/) || t.match(/状态\s*(\d)/);
    const moodRaw = moodM ? Number(moodM[2] || moodM[1]) : 4;
    return { intent: 'checkin', minutes, mood: Math.max(1, Math.min(5, moodRaw)) };
  }
  // 「我学完了 XXX，花了 40 分钟」——登记学习记录（真实写库）
  if (/(学完|学习完|看完|复习完|搞懂|刷完|过完|记完|做完了|做完了)/.test(t)) {
    const m = t.match(/(\d+)\s*(分钟|min|小时|h)/);
    let minutes = null;
    if (m) { const v = Number(m[1]); minutes = /小时|h/.test(m[2]) ? Math.round(v * 60) : v; }
    const kind = /复习|回顾|二刷|重做|过了一遍/.test(t) ? 'review'
      : /做题|刷题|真题|测验|测试|卷子|的题|题目/.test(t) ? 'quiz' : 'study';
    return { intent: 'studyLog', point: findPoint(t), minutes, kind };
  }
  if (/(学了|学习了|看过|做了|看了|花了)/.test(t) && /(\d+)\s*(分钟|min|小时|h)/.test(t)) {
    const m = t.match(/(\d+)\s*(分钟|min|小时|h)/);
    const v = Number(m[1]);
    const minutes = /小时|h/.test(m[2]) ? Math.round(v * 60) : v;
    const mm = t.match(/(^|[^\d])(\d)\s*星/) || t.match(/状态\s*(\d)/);
    return { intent: 'checkin', minutes, mood: mm ? Math.max(1, Math.min(5, Number(mm[2] || mm[1]))) : 4 };
  }
  // 直接问知识点内容 → 答疑（从题库取参考答案）
  if (/(是什么|什么是|什么叫|如何|怎么|为什么|为啥|解释|讲讲|说一下|介绍一下|什么意思|原理|区别)/.test(t)) {
    // 只在「确实指向某个知识点」时才本地答疑；否则交给开放域（大模型）回答
    const c = rankConfidence(t);
    // 本地知识体系里没有的点（算法/数据结构超纲内容），交给大模型
    const lowConf = /KMP|红黑树|B\+ 树|跳表|字典树|Trie|Manacher|后缀数组|线段树|树状数组|动态规划|贪心|回溯|分支限界/i.test(t);
    // 「A 与 B 的区别」类对比题：本地题库只能答单点，交给大模型更合适（除非强命中某个点）
    const compare = /(和|与|跟|同).{1,14}(的区别|区别|的差异|差异|对比|比较)/.test(t);
    if (c.point && c.score >= LOW_CONF && !lowConf && !(compare && c.score < 300)) {
      return { intent: 'ask', point: c.point };
    }
  }
  // 是否在回答上一道题
  return { intent: 'unknown' };
}

// ---------- 会话状态（跨轮次：当前题目等）----------
function getState(userId, key) {
  const r = require('./db').q.get('SELECT value FROM agent_state WHERE user_id=? AND key=?', userId, key);
  try { return r ? JSON.parse(r.value) : null; } catch (_) { return null; }
}
function setState(userId, key, value) {
  require('./db').q.run(`INSERT INTO agent_state (user_id,key,value,updated_at) VALUES (?,?,?,datetime('now','localtime'))
    ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  userId, key, JSON.stringify(value));
}
function clearState(userId, key) { require('./db').q.run('DELETE FROM agent_state WHERE user_id=? AND key=?', userId, key); }

module.exports = { TOOLS, findPoint, rankPoints, rankConfidence, LOW_CONF, parseIntent, getState, setState, clearState, RE, QB };
