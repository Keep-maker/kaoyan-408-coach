// ============================================================
//  考研热点推送
//   来源：研招网官方资讯 + 全网热搜（关键词过滤出考研相关）+ 内置兜底
// ============================================================
const { q } = require('./db');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';

// 考研相关关键词（用于从热搜里筛选）
const KEYWORDS = [
  '考研', '研究生', '硕士', '初试', '复试', '调剂', '保研', '推免', '国家线', '上岸',
  '408', '计算机', '专业课', '大纲', '招生', '报考', '录取', '分数线', '专硕', '学硕',
  '统考', '研招', '真题', '调剂', '备考', '研考', '数学一', '英语一', '政治'
];
// 408 学科相关关键词
const TECH_KEYWORDS = [
  '数据结构', '算法', '操作系统', '计算机网络', '计算机组成', '编译', '数据库',
  '人工智能', '大模型', '芯片', 'CPU', 'GPU', '编程', '开源', '鸿蒙', '国产'
];

function hit(text, list) { return list.filter((k) => text.includes(k)); }

async function fetchText(url, timeout = 12000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA }, signal: ac.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

async function fetchJson(url, timeout = 12000) {
  const txt = await fetchText(url, timeout);
  return JSON.parse(txt);
}

// ---- 1. 研招网官方资讯 ----
async function officialNews(limit = 15) {
  try {
    const html = await fetchText('https://yz.chsi.com.cn/kyzx/');
    const out = [];
    const re = /<a[^>]*href="([^"]+)"[^>]*>([^<]{8,80})<\/a>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const title = m[2].trim().replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
      if (!title || title.length < 8) continue;
      if (/备案|版权|中心$|关于我们|联系方式|ICP|举报|投诉|营业执照|京公网安|京ICP|版权所有/.test(title)) continue;
      if (!/[一-龥A-Za-z]{6,}/.test(title)) continue;
      let url = m[1];
      if (url.startsWith('//')) url = 'https:' + url;
      else if (url.startsWith('/')) url = 'https://yz.chsi.com.cn' + url;
      if (out.some((o) => o.title === title)) continue;
      out.push({ title, url, source: '研招网', category: '考研资讯', hot: null });
      if (out.length >= limit) break;
    }
    return out;
  } catch (e) { return []; }
}

// ---- 2. 全网热搜中筛考研/计算机相关 ----
async function filteredHot() {
  const sources = [
    { key: 'zhihu', name: '知乎热榜', url: 'https://60s.viki.moe/v2/zhihu' },
    { key: 'weibo', name: '微博热搜', url: 'https://60s.viki.moe/v2/weibo' },
    { key: 'toutiao', name: '头条热榜', url: 'https://60s.viki.moe/v2/toutiao' },
    { key: 'douyin', name: '抖音热榜', url: 'https://60s.viki.moe/v2/douyin' }
  ];
  const out = [];
  await Promise.all(sources.map(async (s) => {
    try {
      const j = await fetchJson(s.url);
      const arr = Array.isArray(j?.data) ? j.data : [];
      arr.forEach((it, idx) => {
        const title = String(it.title || it.name || it.word || '').trim();
        if (!title || /^[一-龥]?s*[A-Z]*ICP/.test(title)) return;
        const kAll = hit(title, KEYWORDS);
        const kTech = hit(title, TECH_KEYWORDS);
        if (!kAll.length && !kTech.length) return;
        out.push({
          title,
          url: it.url || it.link || it.mobileUrl || null,
          source: s.name,
          category: kAll.length ? '考研相关' : '计算机相关',
          matched: [...new Set([...kAll, ...kTech])],
          rank: idx + 1,
          score: (kAll.length ? 10 : 4) - idx * 0.05 + (kTech.length ? 2 : 0)
        });
      });
    } catch (_) {}
  }));
  return out.sort((a, b) => b.score - a.score);
}

// ---- 3. 内置 408 高频备考热点（离线兜底，也用于演示） ----
function builtin() {
  const t = new Date().toISOString().slice(0, 10);
  return [
    { title: '408 大纲数据结构部分：图与排序仍是分值重灾区，优先吃透 Dijkstra / 关键路径 / 快排 Partiton', source: '内置考点', category: '408考点', url: null },
    { title: '组成原理高频：Cache 三种映射的地址划分 + 虚拟存储器三级访存综合题（每年必出大题）', source: '内置考点', category: '408考点', url: null },
    { title: '操作系统必背：信号量 P/V 操作解决经典同步问题、页面置换算法缺页率计算', source: '内置考点', category: '408考点', url: null },
    { title: '计算机网络必考：TCP 三次握手/四次挥手、拥塞控制窗口变化、子网划分与 CIDR 计算', source: '内置考点', category: '408考点', url: null },
    { title: '计算机考研主流院校专业课改考 408 趋势持续，选择目标院校前务必核对最新招生专业目录', source: '备考提醒', category: '考研资讯', url: 'https://yz.chsi.com.cn/' },
    { title: '每日一句：真题为王——近 10 年 408 真题至少刷 3 遍，错题按知识点归档复盘', source: '备考提醒', category: '学习建议', url: null }
  ].map((x) => ({ ...x, date: t }));
}

// ---- 汇总（带缓存） ----
async function collect({ force = false } = {}) {
  const cached = q.get(`SELECT * FROM hot_cache ORDER BY id DESC LIMIT 1`);
  const fresh = cached && (Date.now() - new Date(cached.fetched_at.replace(' ', 'T')).getTime()) < 1000 * 60 * 30;
  if (cached && fresh && !force) {
    try { return { ...JSON.parse(cached.payload), cached: true }; } catch (_) {}
  }
  const [news, hot] = await Promise.all([officialNews(), filteredHot()]);
  const payload = {
    generatedAt: new Date().toISOString(),
    official: news.length ? news : builtin().filter((x) => x.category === '考研资讯'),
    hot: hot.slice(0, 20),
    tips: builtin().filter((x) => x.category.includes('考点') || x.category === '学习建议'),
    degraded: news.length === 0 && hot.length === 0
  };
  try {
    q.run('INSERT INTO hot_cache (source, payload) VALUES (?,?)', 'all', JSON.stringify(payload));
    q.run(`DELETE FROM hot_cache WHERE id NOT IN (SELECT id FROM hot_cache ORDER BY id DESC LIMIT 20)`);
  } catch (_) {}
  return { ...payload, cached: false };
}

module.exports = { collect, officialNews, filteredHot, builtin };