/* ============================================================
 408 题库刷题 · 前端（原生 JS，挂载到全局 QUIZ）
 依赖：app.js 暴露的 esc / api / post / abs / toast / SUB_COLOR
 ============================================================ */
(function () {
  const SUB_COLOR = window.SUB_COLOR || { ds: 'var(--ds)', co: 'var(--co)', os: 'var(--os)', cn: 'var(--cn)' };
  const SUB_SHORT = { ds: '数据结构', co: '组成原理', os: '操作系统', cn: '计网' };
  const TYPE_LABEL = {
    SINGLE: '单选', MULTIPLE: '多选', JUDGE: '判断', FILL: '填空',
    SHORT: '简答', COMPOSITE: '综合'
  };
  const DIFF_LABEL = { EASY: '简单', MEDIUM: '中等', HARD: '困难' };

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = window.esc || ((s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const api = window.api;
  const post = window.post;
  const toast = window.toast;

  const state = {
    view: 'start',          // start / practice / report / collection
    tab: 'bank',            // bank / exam / insights
    overview: null,
    examList: null,
    session: null,
    exam: null,             // 当前真题卷元信息
    examState: null,
    index: 0,
    question: null,
    answer: null,
    note: '',
    statuses: [],
    selected: {},
    revealed: false,
    qElapsed: 0,
    elapsed: 0,
    timer: null,
    paused: false,
    countdown: 0,           // 真题剩余秒
    syncPolling: false,
    skipped: new Set(),
    doubtful: new Set(),
    cardFilter: 'all',
    similar: null,
    aiText: '',
    aiLoading: false,
    aiError: '',
    lastFilters: null
  };

  function modeLabel(mode) {
    return {
      random: '随机组卷', sequence: '顺序练习', wrong: '错题重练',
      favorite: '收藏练习', exam: '真题模考'
    }[mode] || '练习';
  }

  // ---------- Markdown + KaTeX 渲染 ----------
  function renderMath(node) {
    if (!window.katex || !node) return;
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, null);
    const mathSpans = [];
    let current;
    while ((current = walker.nextNode())) {
      if (/[$]/.test(current.nodeValue)) mathSpans.push(current);
    }
    mathSpans.forEach((textNode) => {
      const value = textNode.nodeValue;
      const frag = document.createDocumentFragment();
      const re = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$|\\\[([\s\S]+?)\\\]|\\\(([^\n]+?)\\\)/g;
      let last = 0, match;
      let hasMath = false;
      while ((match = re.exec(value))) {
        if (match.index > last) frag.appendChild(document.createTextNode(value.slice(last, match.index)));
        hasMath = true;
        const tex = match[1] || match[2] || match[3] || match[4];
        const display = Boolean(match[1] || match[3]);
        try {
          const span = document.createElement('span');
          window.katex.render(tex, span, { throwOnError: false, displayMode: display });
          frag.appendChild(span);
        } catch (_) {
          frag.appendChild(document.createTextNode(match[0]));
        }
        last = re.lastIndex;
      }
      if (hasMath) {
        if (last < value.length) frag.appendChild(document.createTextNode(value.slice(last)));
        textNode.parentNode.replaceChild(frag, textNode);
      }
    });
  }

  function renderMdToHtml(md) {
    let h = esc(md);
    h = h.replace(/&lt;br\s*\/?&gt;/gi, '\n');
    h = h.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)(?:\s*\{[^}]*width\s*=\s*(\d+)%[^}]*\})?/g,
      (_, alt, src, width) => `<img class="q-inline-img" src="${src}" alt="${alt}"${width ? ` style="max-width:${Math.min(100, Number(width))}%"` : ''}>`);
    h = h.replace(/`([^`\n]+)`/g, '<code class="md-code">$1</code>');
    h = h.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    h = h.replace(/^&gt;\s?(.*)$/gm, '<div class="md-quote">$1</div>');
    const lines = h.split('\n');
    const out = [];
    const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
    const isSep = (l) => /^\s*\|?[-: |]+\|?\s*$/.test(l) && l.includes('-');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) { out.push('<div class="md-gap"></div>'); continue; }
      if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
        const head = line.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim());
        const rows = [];
        let j = i + 2;
        while (j < lines.length && isRow(lines[j])) {
          rows.push(lines[j].trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim()));
          j++;
        }
        out.push('<div class="md-table"><table><thead><tr>' +
          head.map((c) => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>' +
          rows.map((r) => '<tr>' + r.map((c) => '<td>' + c + '</td>').join('') + '</tr>').join('') +
          '</tbody></table></div>');
        i = j - 1;
        continue;
      }
      const hm = line.match(/^(#{1,6})\s+(.*)$/);
      if (hm) { out.push('<div class="md-h lv' + hm[1].length + '">' + hm[2] + '</div>'); continue; }
      if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { out.push('<div class="md-hr"></div>'); continue; }
      if (/^[\u2022\-\u2023]\s/.test(line)) { out.push('<div class="md-li">' + line + '</div>'); continue; }
      out.push('<div class="md-p">' + line + '</div>');
    }
    return out.join('');
  }

  function md(html) {
    const div = document.createElement('div');
    div.innerHTML = renderMdToHtml(html);
    renderMath(div);
    return div.innerHTML;
  }

  function plainWithMath(text) {
    const div = document.createElement('div');
    div.innerHTML = renderMdToHtml(String(text || ''));
    renderMath(div);
    return div.innerHTML;
  }

  function stripMd(text) {
    return String(text || '').replace(/\*\*/g, '').replace(/`/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  }

  function fmtClock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function pct(correct, total) {
    return total ? Math.round((correct / total) * 100) : null;
  }

  function accClass(acc) {
    if (acc === null || acc === undefined) return '';
    if (acc >= 80) return 'ok';
    if (acc >= 60) return 'warn';
    return 'bad';
  }

  function doubtfulKey(sessionId) { return 'qzd:' + sessionId; }
  function loadDoubtful(sessionId) {
    try {
      const raw = localStorage.getItem(doubtfulKey(sessionId));
      return new Set(raw ? JSON.parse(raw) : []);
    } catch (_) { return new Set(); }
  }
  function saveDoubtful(sessionId) {
    try {
      localStorage.setItem(doubtfulKey(sessionId), JSON.stringify([...state.doubtful]));
    } catch (_) {}
  }
  // ============================================================
  //  开始页：题库组卷 / 历年真题 / 数据洞察
  // ============================================================
  async function renderStart() {
    const v = $('#view');
    v.innerHTML = '<div class="card"><div class="skel" style="width:40%"></div><div class="skel mt" style="width:80%"></div><div class="skel mt" style="width:65%"></div></div>';
    const o = await api('/api/quiz/overview');
    state.overview = o;
    if (state.tab === 'exam' && !state.examList) {
      try { state.examList = await api('/api/exam/overview'); } catch (_) { state.examList = { ready: false, papers: [] }; }
    }
    v.innerHTML = `
      <div class="q-tabs">
        <button data-tab="bank" class="${state.tab === 'bank' ? 'on' : ''}">题库组卷</button>
        <button data-tab="exam" class="${state.tab === 'exam' ? 'on' : ''}">历年真题<span class="q-tab-num">16 套</span></button>
        <button data-tab="insights" class="${state.tab === 'insights' ? 'on' : ''}">数据洞察</button>
      </div>
      <div id="tabBody"></div>`;
    $$('.q-tabs button').forEach((b) => b.addEventListener('click', async () => {
      state.tab = b.dataset.tab;
      $$('.q-tabs button').forEach((x) => x.classList.toggle('on', x === b));
      if (state.tab === 'exam' && !state.examList) {
        try { state.examList = await api('/api/exam/overview'); } catch (_) { state.examList = { ready: false, papers: [] }; }
      }
      paintTab();
    }));
    paintTab();
  }

  function paintTab() {
    if (state.tab === 'exam') return paintExamTab();
    if (state.tab === 'insights') return paintInsightsTab();
    return paintBankTab();
  }

  // ---------------- 题库组卷 ----------------
  function paintBankTab() {
    const o = state.overview;
    const body = $('#tabBody');
    if (!body) return;
    const sync = o.sync || {};
    const ready = o.ready && o.total > 0;

    const subRows = o.subjects.map((s) => `
      <div class="qsub" data-sub="${s.id}">
        <span class="dotc" style="background:${SUB_COLOR[s.id]}"></span>
        <span class="nm">${esc(s.short || s.name)}</span>
        <span class="sub-count">${s.total}</span>
      </div>`).join('');

    const chapterOpts = o.chapters.map((c) => {
      const subject = o.subjects.find((s) => s.id === c.subjectKey);
      return `<option value="${c.id}" data-sub="${c.subjectKey}">${esc(subject?.short || '')} · ${esc(c.name)}（${c.total}）</option>`;
    }).join('');

    const recentRows = (o.sessions || []).slice(0, 6).map((s) => {
      const acc = s.answered ? Math.round((s.correct / Math.max(1, s.answered)) * 100) : null;
      const when = (s.startedAt || '').slice(0, 16).replace('T', ' ');
      const tag = s.status === 'completed'
        ? '<span class="tag ok">已完成</span>'
        : s.answered > 0
          ? '<span class="tag warn">进行中</span>'
          : '<span class="tag">未开始</span>';
      return `<div class="row">
        <span class="dotc" style="background:${SUB_COLOR[s.mode === 'wrong' ? 'os' : s.mode === 'favorite' ? 'cn' : 'ds']}"></span>
        <div class="grow">
          <div class="t">${tag} ${esc(modeLabel(s.mode))} · ${s.answered}/${s.total}</div>
          <div class="s">${esc(when)}${acc !== null ? ' · 正确率 ' + acc + '%' : ''}</div>
        </div>
        <button class="btn sm" data-history="${esc(s.id)}">${s.status === 'completed' ? '查看报告' : '继续练习'}</button>
      </div>`;
    }).join('');

    const weakChips = (o.weak || []).slice(0, 6).map((w) => `
      <button class="btn sm weak-chip" data-point="${esc(w.pointId)}"
        title="${esc(w.pointId)} · ${esc(w.subjectName)}${w.chapterName ? ' · ' + esc(w.chapterName) : ''}">${esc(w.name)} (${w.p}%)</button>`).join('');

    body.innerHTML = `
    <div class="grid g2" style="align-items:start">
      <div class="card">
        <h3><span class="dot"></span>题库概览 <span class="small muted2" style="margin-left:auto;font-weight:400">采纳自 408 研岛题库</span></h3>
        <div class="qstat-row">
          <div class="qstat"><div class="v">${o.total}</div><div class="k">可刷题量</div></div>
          <div class="qstat"><div class="v">${o.practiced}</div><div class="k">已练习</div></div>
          <div class="qstat"><div class="v">${o.accuracy !== null ? o.accuracy + '%' : '—'}</div><div class="k">正确率</div></div>
          <div class="qstat"><div class="v" style="color:var(--bad)">${o.wrongCount}</div><div class="k">错题</div></div>
          <div class="qstat"><div class="v" style="color:var(--warn)">${o.favoriteCount}</div><div class="k">收藏</div></div>
        </div>
        <div class="qsubs">${subRows}</div>
        <div class="mt small muted">题库覆盖四科：数据结构、计算机组成原理、操作系统、计算机网络；${o.chapters.length} 个章节 / ${o.sectionsCount || 0} 个小节；题型含单选 / 多选 / 判断 / 填空 / 简答，每题都带详细解析。未做过的题还有 <b>${o.unseenCount}</b> 道。</div>
      </div>

      <div class="card">
        <h3><span class="dot"></span>组卷练习</h3>
        <div class="field"><label>练习科目</label>
          <div class="seg" id="qSubject">
            <button data-v="" class="on">全部</button>
            ${o.subjects.map((s) => `<button data-v="${s.id}">${esc(s.short || s.name)}</button>`).join('')}
          </div>
        </div>
        <div class="qgrid">
          <div class="field"><label>章节</label><select id="qChapter"><option value="">不限</option>${chapterOpts}</select></div>
          <div class="field"><label>小节</label><select id="qSection"><option value="">不限</option></select></div>
          <div class="field"><label>题型</label>
            <select id="qType"><option value="">不限</option>${o.types.filter((t) => t.total).map((t) => `<option value="${t.id}">${t.name}（${t.total}）</option>`).join('')}</select>
          </div>
          <div class="field"><label>难度</label>
            <select id="qDiff"><option value="">不限</option>${o.difficulties.filter((d) => d.total).map((d) => `<option value="${d.id}">${d.name}（${d.total}）</option>`).join('')}</select>
          </div>
          <div class="field"><label>题量</label><input id="qCount" type="number" min="1" max="100" value="20"></div>
          <div class="field"><label>题干关键词（可选）</label><input id="qKeyword" type="text" placeholder="如：缓存、银行家算法"></div>
        </div>
        <div class="field"><label>出题方式</label>
          <div class="seg" id="qMode">
            <button data-v="random" class="on">随机</button>
            <button data-v="sequence">顺序</button>
          </div>
        </div>
        <label class="qcheck"><input type="checkbox" id="qUnseen"> 只练没做过的题</label>
        ${weakChips ? `<div class="field mt"><label>薄弱点快练（按当前掌握度）</label>
          <div class="weak-chips">${weakChips}</div></div>` : ''}
        <div style="display:flex;gap:9px;flex-wrap:wrap" class="mt">
          <button class="btn pri" id="startPractice">开始练习</button>
          <button class="btn" data-mode="wrong" id="startWrong">只练错题本</button>
          <button class="btn" data-mode="favorite" id="startFav">只练收藏夹</button>
        </div>
      </div>
    </div>

    ${ready ? '' : `<div class="card mt2 q-sync">尚未同步题库：请先点击「同步题库」拉取最新题目（约 7000 题，首次需要几分钟）。<button class="btn pri sm" id="syncNow2">同步题库</button></div>`}

    ${recentRows ? `<div class="card mt2">
      <h3><span class="dot"></span>最近练习</h3>
      <div class="rows">${recentRows}</div>
    </div>` : ''}

    <div class="grid g3 mt2">
      <div class="card qact"><h3><span class="dot"></span>错题本</h3><div class="small muted">做错的题会自动归档，支持反复重练。</div><button class="btn sm mt" data-mode="wrong" id="goWrong">进入错题本</button></div>
      <div class="card qact"><h3><span class="dot"></span>收藏夹</h3><div class="small muted">练习时点收藏，随时回看重点题（当前 ${o.favoriteCount} 题）。</div><button class="btn sm mt" data-mode="favorite" id="goFav">进入收藏夹</button></div>
      <div class="card qact"><h3><span class="dot"></span>同步题库</h3>
        <div class="small muted">上次同步：${sync.lastSyncAt ? esc(sync.lastSyncAt.slice(0, 16).replace('T', ' ')) : '从未'}（库内 ${Number(o.bankTotal || o.total).toLocaleString()} 题）</div>
        <button class="btn sm mt" id="syncNow">${ready ? '重新同步' : '同步题库'}</button>
      </div>
    </div>
    `;

    if (!ready) $('#syncNow').classList.add('pri');
    if (o.syncing) pollSync();

    const sectionFill = () => {
      const chapterId = $('#qChapter').value;
      const sub = $('#qSubject .on').dataset.v;
      const sel = $('#qSection');
      const list = (o.sections || []).filter((s) =>
        (!sub || s.subjectKey === sub) && (!chapterId || s.chapterId === chapterId));
      sel.innerHTML = '<option value="">不限</option>' + list
        .map((s) => `<option value="${esc(s.name)}">${esc(s.name)}（${s.total}）</option>`).join('');
    };

    $('#qSubject').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      $$('#qSubject button').forEach((x) => x.classList.toggle('on', x === b));
      const sub = b.dataset.v;
      const ch = $('#qChapter');
      [...ch.options].forEach((opt) => { opt.hidden = Boolean(sub && opt.dataset.sub && opt.dataset.sub !== sub); });
      if (ch.value && ch.selectedOptions[0] && ch.selectedOptions[0].hidden) ch.value = '';
      sectionFill();
    });
    $('#qChapter').addEventListener('change', sectionFill);
    $('#qMode').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      $$('#qMode button').forEach((x) => x.classList.toggle('on', x === b));
    });
    sectionFill();

    $('#startPractice').addEventListener('click', () => startSession({
      subject: $('#qSubject .on').dataset.v,
      chapter: $('#qChapter').value,
      section: $('#qSection').value,
      type: $('#qType').value,
      difficulty: $('#qDiff').value,
      keyword: $('#qKeyword').value.trim(),
      unseenOnly: $('#qUnseen').checked,
      count: Number($('#qCount').value || 20),
      mode: $('#qMode .on').dataset.v
    }));
    $('#startWrong').addEventListener('click', () => startSession({ mode: 'wrong' }));
    $('#startFav').addEventListener('click', () => startSession({ mode: 'favorite' }));
    $$('.weak-chip').forEach((b) => b.addEventListener('click', () => {
      startSession({ pointId: b.dataset.point, count: 8, mode: 'random' });
    }));
    $$('[data-history]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.history;
      const item = (state.overview.sessions || []).find((s) => String(s.id) === id);
      if (item && item.status === 'completed') {
        try {
          const r = item.mode === 'exam'
            ? await api('/api/exam/report?sessionId=' + encodeURIComponent(id))
            : await api('/api/quiz/report?sessionId=' + encodeURIComponent(id));
          stopTimer();
          state.view = 'report';
          renderReport(r);
        } catch (e) { toast('无法打开报告：' + e.message, false); }
      } else {
        await resumeSession(id);
      }
    }));
    $('#goWrong').addEventListener('click', () => renderCollection('wrong'));
    $('#goFav').addEventListener('click', () => renderCollection('favorite'));
    $('#syncNow').addEventListener('click', () => syncBank());
    const s2 = $('#syncNow2'); if (s2) s2.addEventListener('click', () => syncBank());
  }

  async function syncBank() {
    try {
      const r = await post('/api/quiz/sync', { force: false });
      if (!r.started) { toast(r.message || '同步进行中', false); return; }
      toast('题库同步已开始，完成后会自动刷新');
      pollSync();
    } catch (e) { toast('失败：' + e.message, false); }
  }

  function pollSync() {
    if (state.syncPolling) return;
    state.syncPolling = true;
    const tick = async () => {
      try {
        const r = await api('/api/quiz/sync');
        if (!r.syncing) {
          state.syncPolling = false;
          await renderStart();
          toast(r.progress && r.progress.error ? '题库同步失败：' + r.progress.error : '题库同步完成', !(r.progress && r.progress.error));
          return;
        }
        const p = r.progress || {};
        toast(`${p.phase || '正在同步'}：${(p.done || 0)} / ${(p.total || 0)}（${p.subject || '全部'}）`);
        setTimeout(tick, 2500);
      } catch (e) {
        state.syncPolling = false;
        toast('同步状态读取失败：' + e.message, false);
      }
    };
    setTimeout(tick, 2000);
  }
  // ---------------- 历年真题 ----------------
  function paintExamTab() {
    const body = $('#tabBody');
    if (!body) return;
    const list = state.examList || { ready: false, papers: [] };
    const papers = list.papers || [];

    if (!list.ready || !papers.length) {
      body.innerHTML = `<div class="card"><h3><span class="dot"></span>历年真题</h3>
        <div class="empty">还没有真题数据。${list.ready ? '请运行脚本把真题卷同步到本地：' : '先同步题库，再同步真题卷：'}
        <div class="small muted mt">node scripts/sync-exams.js</div></div></div>`;
      return;
    }

    const done = papers.filter((p) => p.lastScore !== null && p.lastScore !== undefined);
    const avg = done.length ? Math.round(done.reduce((n, p) => n + p.lastScore, 0) / done.length * 10) / 10 : null;

    body.innerHTML = `
    <div class="card">
      <h3><span class="dot"></span>真题模考 <span class="small muted2" style="margin-left:auto;font-weight:400">2009—2025 · 16 套 · 752 题</span></h3>
      <div class="qstat-row" style="grid-template-columns:repeat(4,minmax(0,1fr))">
        <div class="qstat"><div class="v">${papers.length}</div><div class="k">可用套数</div></div>
        <div class="qstat"><div class="v">${done.length}</div><div class="k">已做过</div></div>
        <div class="qstat"><div class="v">${avg !== null ? avg : '—'}</div><div class="k">平均得分 / 150</div></div>
        <div class="qstat"><div class="v">${papers[0].durationMin}</div><div class="k">考试时长（分钟）</div></div>
      </div>
      <div class="mt small muted">整套限时模考：${papers[0].questionCount} 题、${papers[0].durationMin} 分钟，客观题自动判分，综合应用题按自评折算，合计 ${papers[0].totalScore} 分。综合题在源题库按 10 分/题计入参考分，与实际卷面分值可能略有差异。</div>
    </div>

    <div class="card mt2">
      <h3><span class="dot"></span>选择年份</h3>
      <div class="exam-grid">
        ${papers.map((p) => {
          const score = p.lastScore;
          const scored = score !== null && score !== undefined;
          return `<div class="exam-card" data-exam="${p.examId}">
            <div class="exam-yr">${p.year}</div>
            <div class="exam-meta">${p.questionCount} 题 · ${p.durationMin} 分钟</div>
            <div class="exam-sec">${(p.sections || []).map((s) => esc(s.name.replace(/^[一二三四五六七八九十]+、/, '')) + ' ' + s.count).join(' · ')}</div>
            <div class="exam-foot">
              ${scored ? `<span class="tag ${score >= 105 ? 'ok' : score >= 75 ? 'warn' : 'bad'}">上次 ${score} 分</span>`
                : p.lastSessionId ? '<span class="tag warn">未做完</span>' : '<span class="tag">未开始</span>'}
              <button class="btn sm ${scored || p.lastSessionId ? '' : 'pri'}" data-start="${p.examId}">${p.lastSessionId ? '继续模考' : '开始模考'}</button>
              ${scored ? `<button class="btn sm ghost" data-exam-report="${p.lastSessionId}">成绩</button>` : ''}
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`;

    $$('[data-start]').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const p = papers.find((x) => String(x.examId) === b.dataset.start);
      if (p && p.lastSessionId && p.lastStatus !== 'completed') return resumeSession(p.lastSessionId);
      return startExam(p.examId);
    }));
    $$('[data-exam-report]').forEach((b) => b.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const r = await api('/api/exam/report?sessionId=' + encodeURIComponent(b.dataset.examReport));
        stopTimer();
        state.view = 'report';
        renderReport(r);
      } catch (err) { toast('无法打开成绩：' + err.message, false); }
    }));
  }

  // ---------------- 数据洞察 ----------------
  function paintInsightsTab() {
    const body = $('#tabBody');
    if (!body) return;
    const o = state.overview || {};
    const ins = o.insights || { chapterHeat: [], types: [], subjects: [], avgSeconds: null, wrongBuckets: {} };
    if (!o.practiced) {
      body.innerHTML = `<div class="card"><h3><span class="dot"></span>数据洞察</h3>
        <div class="empty">还没有练习记录。先做几组题，这里会出现章节正确率热力、题型正确率与答题速度。</div>
        <div class="mt" style="display:flex;justify-content:center"><button class="btn pri" id="toBank">去组卷</button></div></div>`;
      const b = $('#toBank');
      if (b) b.addEventListener('click', () => { state.tab = 'bank'; renderStart(); });
      return;
    }

    const heat = ins.chapterHeat.map((c) => `
      <div class="heat-row">
        <span class="dotc" style="background:${SUB_COLOR[c.subjectKey]}"></span>
        <div class="grow">
          <div class="heat-name">${esc(c.name)} <span class="small muted2">${c.correct}/${c.total}</span></div>
          <div class="bar sm"><i class="${accClass(c.accuracy)}" style="width:${c.accuracy ?? 0}%"></i></div>
        </div>
        <div class="heat-val ${accClass(c.accuracy)}">${c.accuracy !== null ? c.accuracy + '%' : '—'}</div>
      </div>`).join('');

    const typeRows = ins.types.map((t) => `
      <div class="row"><div class="grow"><div class="t">${esc(t.name)}</div>
        <div class="s">${t.correct}/${t.total} 题</div></div>
        <div class="right"><b class="${accClass(t.accuracy)}">${t.accuracy !== null ? t.accuracy + '%' : '—'}</b></div></div>`).join('');

    const wrong = ins.wrongBuckets || {};
    const w1 = Number(wrong['1'] || 0);
    const w2 = Number(wrong['2'] || 0);
    const w3 = Number(wrong['3'] || 0);

    body.innerHTML = `
    <div class="grid g2" style="align-items:start">
      <div class="card">
        <h3><span class="dot"></span>章节正确率热力 <span class="small muted2" style="margin-left:auto;font-weight:400">最弱 ${ins.chapterHeat.length} 项</span></h3>
        <div class="heat-list">${heat || '<div class="empty">暂无数据</div>'}</div>
      </div>
      <div>
        <div class="card">
          <h3><span class="dot"></span>题型正确率</h3>
          <div class="rows">${typeRows || '<div class="empty">暂无数据</div>'}</div>
        </div>
        <div class="card mt2">
          <h3><span class="dot"></span>答题节奏与错题分层</h3>
          <div class="qstat-row" style="grid-template-columns:repeat(2,minmax(0,1fr))">
            <div class="qstat"><div class="v">${ins.avgSeconds !== null ? ins.avgSeconds + 's' : '—'}</div><div class="k">平均每题用时</div></div>
            <div class="qstat"><div class="v">${w1 + w2 + w3}</div><div class="k">待攻克错题</div></div>
          </div>
          <div class="rows mt">
            <div class="row"><div class="grow"><div class="t">错 1 次</div><div class="s">刚暴露的薄弱点，趁热订正</div></div><div class="right"><b>${w1}</b></div></div>
            <div class="row"><div class="grow"><div class="t">错 2 次</div><div class="s">需要回看知识点</div></div><div class="right"><b class="warn">${w2}</b></div></div>
            <div class="row"><div class="grow"><div class="t">错 3 次及以上</div><div class="s">重点攻坚，优先专项练</div></div><div class="right"><b class="bad">${w3}</b></div></div>
          </div>
          <div class="mt" style="display:flex;gap:9px;flex-wrap:wrap">
            <button class="btn sm pri" id="insWrong">练错题本</button>
            <button class="btn sm" id="insUnseen">练没做过的题</button>
          </div>
        </div>
      </div>
    </div>`;
    const a = $('#insWrong'); if (a) a.addEventListener('click', () => startSession({ mode: 'wrong' }));
    const b = $('#insUnseen'); if (b) b.addEventListener('click', () => startSession({ unseenOnly: true, count: 20 }));
  }
  // ============================================================
  //  会话：普通练习 / 真题模考
  // ============================================================
  async function startSession(filters) {
    try {
      stopTimer();
      state.lastFilters = filters;
      const r = await post('/api/quiz/session', filters);
      enterSession(r.session, r.question, r.answer, r.statuses, 0, null);
    } catch (e) { toast('无法开始：' + e.message, false); }
  }

  async function startExam(examId) {
    try {
      stopTimer();
      const r = await post('/api/exam/start', { examId });
      enterSession(r.session, r.question, r.answer, r.statuses, 0, r.exam);
      state.examState = null;
      state.view = 'practice';
      await loadExamState();
      renderPractice();
    } catch (e) { toast('无法开始模考：' + e.message, false); }
  }

  function enterSession(session, question, answer, statuses, index, examMeta) {
    state.session = session;
    state.index = index || 0;
    state.question = question;
    state.answer = answer;
    state.statuses = statuses || [];
    state.note = '';
    state.view = 'practice';
    state.qElapsed = 0;
    state.elapsed = 0;
    state.selected = {};
    state.skipped = new Set();
    state.doubtful = loadDoubtful(session.id);
    state.revealed = Boolean(answer);
    state.similar = null;
    state.aiText = '';
    state.aiError = '';
    state.aiLoading = false;
    state.paused = false;
    state.countdown = examMeta ? Number(examMeta.durationMin || 180) * 60 : 0;
    state.exam = examMeta || null;
    renderPractice();
  }

  async function loadExamState() {
    if (!state.session) return null;
    try {
      const s = await api('/api/exam/state?sessionId=' + encodeURIComponent(state.session.id));
      state.examState = s;
      if (s) {
        state.exam = s.paper;
        state.countdown = s.remainingSeconds;
      }
    } catch (_) { state.examState = null; }
    return state.examState;
  }

  function startTimerIfNeeded() {
    if (state.timer) return;
    state.timer = setInterval(() => {
      if (state.paused) return;
      state.elapsed += 1000;
      state.qElapsed += 1000;
      const el = $('#qTimer');
      if (el) el.textContent = fmtClock(state.elapsed);
      const qe = $('#qQTimer');
      if (qe) qe.textContent = fmtClock(state.qElapsed);
      if (state.exam) {
        state.countdown = Math.max(0, state.countdown - 1);
        const cd = $('#qCountdown');
        if (cd) {
          cd.textContent = fmtClock(state.countdown * 1000);
          cd.classList.toggle('urgent', state.countdown <= 300);
        }
        if (state.countdown === 0) { stopTimer(); autoSubmitExam(); }
      }
    }, 1000);
  }
  function stopTimer() { if (state.timer) { clearInterval(state.timer); state.timer = null; } }

  async function autoSubmitExam() {
    toast('考试时间到，正在自动交卷', false);
    await finish();
  }

  function examScorePreview() {
    if (!state.exam) return null;
    const items = state.statuses || [];
    return items;
  }

  // ============================================================
  //  练习页
  // ============================================================
  async function renderPractice() {
    startTimerIfNeeded();
    const q = state.question;
    const s = state.session;
    const v = $('#view');
    const ans = state.answer;
    if (!q) return;

    const isExam = Boolean(state.exam);
    const pctDone = s.total ? Math.round((s.answered / s.total) * 100) : 0;
    const givenKeys = ans ? (Array.isArray(ans.answer) ? ans.answer : [ans.answer])
      .flatMap((x) => String(x || '').toUpperCase().match(/[A-H]/g) || []) : [];

    const optHtml = (q.options || []).map((o) => {
      const chosen = Boolean(state.selected[o.key]) || givenKeys.includes(o.key);
      const isCorrect = Boolean(ans && ans.correctKeys && ans.correctKeys.includes(o.key));
      const wrongChosen = Boolean(ans && ans.needsSelfGrade === false && ans.correct === false && chosen && !isCorrect);
      return `<div class="qopt${chosen ? ' on' : ''}${isCorrect ? ' correct' : ''}${wrongChosen ? ' wrong' : ''}" data-key="${o.key}">
        <span class="qopt-key">${o.key}</span><span class="qopt-text">${md(o.content)}</span>
      </div>`;
    }).join('');

    const filteredCells = () => {
      const list = state.statuses || [];
      return list.map((st, i) => {
        const doubtful = state.doubtful.has(i);
        const cls = [
          'qcell',
          st.answered ? (st.correct === 1 ? 'ok' : st.correct === 0 ? 'bad' : 'self') : state.skipped.has(i) ? 'skip' : '',
          doubtful ? 'doubt' : '',
          i === state.index ? 'now' : ''
        ].filter(Boolean).join(' ');
        const passFilter = state.cardFilter === 'all'
          || (state.cardFilter === 'unanswered' && !st.answered)
          || (state.cardFilter === 'wrong' && st.correct === 0)
          || (state.cardFilter === 'doubt' && doubtful);
        return `<button class="${cls}${passFilter ? '' : ' dim'}" data-idx="${i}">${i + 1}</button>`;
      }).join('');
    };

    const examBar = isExam ? `
      <div class="exam-bar">
        <span class="tag brand">${esc(state.exam.title || '真题模考')}</span>
        <span class="exam-countdown" id="qCountdown">${fmtClock((state.countdown || 0) * 1000)}</span>
        <span class="small muted">满分 ${state.exam.totalScore} · 共 ${s.total} 题</span>
        <button class="btn sm" id="pauseBtn" style="margin-left:auto">${state.paused ? '继续' : '暂停'}</button>
      </div>` : '';

    v.innerHTML = `
    ${examBar}
    <div class="qbar">
      <button class="btn sm" id="quitPractice">退出</button>
      <button class="btn sm" id="prevBtn" ${state.index === 0 ? 'disabled' : ''}>上一题</button>
      <div class="qbar-mid">
        <span class="tag ${q.subjectKey}">${esc(q.subjectName)}</span>
        <span class="tag">${TYPE_LABEL[q.type] || q.type}</span>
        <span class="tag ${q.difficulty === 'HARD' ? 'bad' : q.difficulty === 'MEDIUM' ? 'warn' : 'ok'}">${DIFF_LABEL[q.difficulty] || q.difficulty}</span>
        ${q.chapterName ? `<span class="tag">${esc(q.chapterName)}</span>` : ''}
        ${q.sectionName ? `<span class="tag">${esc(q.sectionName)}</span>` : ''}
        ${isExam && q.orderNo ? `<span class="tag brand">第 ${q.orderNo} 题 · ${q.paperScore} 分</span>` : ''}
        <span id="qTimer" class="q-timer" title="本次练习总用时">${fmtClock(state.elapsed)}</span>
        <span id="qQTimer" class="q-timer" title="本题用时">${fmtClock(state.qElapsed)}</span>
      </div>
      <div class="qbar-right">${s.answered}/${s.total} 已答</div>
    </div>
    <div class="bar qbar-progress" style="margin:-6px 0 14px"><i style="width:${pctDone}%"></i></div>

    <div class="grid g2" style="align-items:start">
      <div class="card">
        <h3><span class="dot"></span>第 ${state.index + 1} 题
          <span style="margin-left:auto;display:flex;gap:6px">
            <button class="btn sm ${state.doubtful.has(state.index) ? 'warn' : ''}" id="doubtBtn">${state.doubtful.has(state.index) ? '已标记存疑' : '标记存疑'}</button>
            <button class="btn sm" id="noteBtn">笔记${state.note ? '（已写）' : ''}</button>
            <button class="btn sm" id="bookmarkBtn">${q.bookmarked ? '已收藏' : '收藏'}</button>
          </span>
        </h3>
        <div class="qtitle">${md(q.content || q.title)}</div>
        ${q.options && q.options.length ? `<div class="qopts">${optHtml}</div>
          <div class="qhint small muted">${q.type === 'MULTIPLE' ? '多选题，可多选；选全对才得分。' : q.type === 'JUDGE' ? '判断题，选「正确」或「错误」。' : '单选题，点选一个选项。'} 也可直接按 A/B/C/D 键作答。</div>`
        : `<div class="qfree"><label>在此作答（客观题可填关键词，主观题可写要点）</label>
            <textarea id="freeAnswer" rows="6" placeholder="例如：≥300 bit">${ans && ans.needsSelfGrade ? esc(stripMd(ans.answer)) : ''}</textarea></div>`}
        <div id="noteBox"></div>
        <div class="qactions">
          ${ans ? `<button class="btn" id="revealBtn">${state.revealed ? '隐藏解析' : '显示解析'}</button>
            <button class="btn pri" id="nextBtn">${state.index + 1 >= s.total ? (isExam ? '交卷' : '完成练习') : '下一题'}</button>`
          : `<button class="btn pri" id="submitBtn">提交答案</button>
            <button class="btn" id="skipBtn">${state.index + 1 >= s.total ? '跳过并交卷' : '跳过这题'}</button>`}
        </div>
      </div>

      <div class="card">
        <h3><span class="dot"></span>答题卡</h3>
        <div class="seg qcard-filter" id="cardFilter">
          <button data-f="all" class="${state.cardFilter === 'all' ? 'on' : ''}">全部</button>
          <button data-f="unanswered" class="${state.cardFilter === 'unanswered' ? 'on' : ''}">未答</button>
          <button data-f="wrong" class="${state.cardFilter === 'wrong' ? 'on' : ''}">错题</button>
          <button data-f="doubt" class="${state.cardFilter === 'doubt' ? 'on' : ''}">存疑</button>
        </div>
        <div class="qcard">${filteredCells()}</div>
        <div class="qlegend small muted"><span class="qcell ok mini"></span>对 <span class="qcell bad mini"></span>错 <span class="qcell self mini"></span>待自评 <span class="qcell skip mini"></span>跳过 <span class="qcell doubt mini"></span>存疑 <span class="qcell mini"></span>未答</div>
        ${isExam ? `<div class="mt"><button class="btn sm pri" id="handIn">提前交卷</button></div>` : ''}
      </div>
    </div>

    <div id="answerArea"></div>
    ${state.similar ? renderSimilar() : ''}
    `;

    renderAnswerArea();
    bindPractice();
  }

  function renderSimilar() {
    const sim = state.similar;
    if (!sim || !sim.items || !sim.items.length) return '';
    return `<div class="card mt2">
      <h3><span class="dot"></span>举一反三 <span class="small muted2" style="margin-left:auto;font-weight:400">${esc(sim.basis || '')} · 同考点未做过的题</span></h3>
      <div class="rows">${sim.items.map((x, i) => `
        <div class="row">
          <span class="dotc" style="background:${SUB_COLOR[x.subjectKey]}"></span>
          <div class="grow"><div class="t">${esc(x.title)}</div>
          <div class="s">${esc(x.subjectName)} · ${TYPE_LABEL[x.type] || x.type}${x.sectionName ? ' · ' + esc(x.sectionName) : ''}</div></div>
          <button class="btn sm" data-sim="${i}">练这道</button>
        </div>`).join('')}</div>
      <div class="mt"><button class="btn sm" data-sim-all="1">连做这 ${sim.items.length} 道同类题</button></div>
    </div>`;
  }

  function renderAnswerArea() {
    const box = $('#answerArea');
    if (!box) return;
    const q = state.question;
    const ans = state.answer;
    if (!ans || !state.revealed) { box.innerHTML = ''; return; }
    const isExam = Boolean(state.exam);
    const selfGrade = ans.needsSelfGrade
      ? `<div class="advice info"><div class="h">该题需要你自评</div>
          <div class="b">对照下方解析，判断自己是否答到要点。${isExam && ans.paperScore ? ' 本题卷面 ' + ans.paperScore + ' 分，可按实际完成度打分。' : ''}</div>
          <div class="b mt">你的作答：${esc(stripMd(Array.isArray(ans.answer) ? ans.answer.join('、') : ans.answer))}</div>
          <div class="qactions">${isExam && ans.paperScore ? `<input type="number" id="selfScore" min="0" max="${ans.paperScore}" step="0.5" value="${ans.paperScore}" style="width:80px" class="q-score-input"><span class="small muted">/ ${ans.paperScore} 分</span>` : ''}
            <button class="btn pri sm" id="selfRight">满分 / 答对</button><button class="btn sm" id="selfWrong">0 分 / 答错</button></div></div>`
      : '';

    box.innerHTML = `<div class="card mt2" id="answerPanel">
      ${ans.autoGraded ? `<div class="advice ${ans.correct ? 'ok' : 'bad'}"><div class="h">${ans.correct ? '回答正确' : '回答错误'}</div>
        <div class="b">你的答案：${esc(Array.isArray(ans.answer) ? ans.answer.join('、') : stripMd(ans.answer))}<br>正确答案：${ans.correctOptions.map((o) => o.key + '. ' + plainWithMath(o.content)).join('；')}</div></div>`
      : selfGrade}
      <div class="qexplain-head">
        <h4>详细解析</h4>
        <button class="btn sm" id="askAiBtn">追问 AI 讲透这题</button>
      </div>
      <div class="qexplain">${md(q.explanation && q.explanation.trim()
        ? q.explanation
        : (ans.referenceAnswer && !/^请对照详细解析/.test(ans.referenceAnswer)
          ? ans.referenceAnswer
          : '源题未提供详细解析，可对照参考答案判断作答，或追问 AI 讲解。'))}</div>
      <div id="aiBox">${state.aiText || state.aiError ? renderAiBox() : ''}</div>
      <div class="mt" style="display:flex;gap:9px;flex-wrap:wrap">
        <button class="btn sm" id="similarBtn">举一反三</button>
        ${q.sourceUrl ? `<a class="btn sm" href="${esc(q.sourceUrl)}" target="_blank" rel="noopener">查看原题与讨论</a>` : ''}
      </div>
    </div>`;

    $$('.qopt-text img').forEach((img) => img.addEventListener('click', () => {
      if (typeof window.openModal === 'function') {
        window.openModal(`<h3>题目插图</h3><img src="${esc(img.src)}" style="max-width:100%;border-radius:10px"><div class="actions"><button class="btn pri" id="imgClose">关闭</button></div>`);
        const c = $('#imgClose'); if (c) c.addEventListener('click', window.closeModal);
      }
    }));

    const sr = $('#selfRight'); const sw = $('#selfWrong');
    if (sr) sr.addEventListener('click', () => {
      const scoreEl = $('#selfScore');
      selfGradeSubmit(true, scoreEl ? Number(scoreEl.value) : undefined);
    });
    if (sw) sw.addEventListener('click', () => selfGradeSubmit(false, 0));

    const ai = $('#askAiBtn');
    if (ai) ai.addEventListener('click', () => askAi('请把这道题的解析讲得更细一些，重点讲清为什么选这个选项'));
    const sim = $('#similarBtn');
    if (sim) sim.addEventListener('click', async () => {
      try {
        state.similar = await api(`/api/quiz/similar?sourceId=${q.sourceId}&limit=6`);
        renderPractice();
      } catch (e) { toast('获取同类题失败：' + e.message, false); }
    });
  }

  function renderAiBox() {
    if (state.aiError) return `<div class="advice bad mt"><div class="h">AI 讲解失败</div><div class="b">${esc(state.aiError)}</div></div>`;
    return `<div class="advice info mt"><div class="h">AI 讲解${state.aiLoading ? '（生成中…）' : ''}</div>
      <div class="b md-stream">${md(state.aiText || '')}</div></div>`;
  }

  async function askAi(question) {
    const q = state.question;
    state.aiLoading = true;
    state.aiText = '';
    state.aiError = '';
    renderAnswerArea();
    try {
      const res = await fetch(window.abs('/api/quiz/explain'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId: q.sourceId, question })
      });
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const chunk of parts) {
          const line = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          let payload;
          try { payload = JSON.parse(line.slice(6)); } catch (_) { continue; }
          if (payload.delta) {
            state.aiText += payload.delta;
            const box = $('#aiBox');
            if (box) box.innerHTML = renderAiBox();
          }
          if (payload.error) throw new Error(payload.error);
        }
      }
    } catch (e) {
      state.aiError = e.message;
    } finally {
      state.aiLoading = false;
      const box = $('#aiBox');
      if (box) box.innerHTML = renderAiBox();
      else renderAnswerArea();
    }
  }

  function bindPractice() {
    $$('.qopt').forEach((opt) => opt.addEventListener('click', () => {
      const key = opt.dataset.key;
      const q = state.question;
      if (state.answer || state.revealed || state.paused) return;
      if (q.type === 'MULTIPLE') {
        state.selected[key] = !state.selected[key];
        opt.classList.toggle('on', state.selected[key]);
      } else {
        state.selected = { [key]: true };
        $$('.qopt').forEach((o) => o.classList.toggle('on', o.dataset.key === key));
      }
    }));

    const submit = $('#submitBtn');
    if (submit) submit.addEventListener('click', submitCurrent);

    const reveal = $('#revealBtn');
    if (reveal) reveal.addEventListener('click', () => {
      state.revealed = !state.revealed;
      renderPractice();
    });

    const next = $('#nextBtn');
    if (next) next.addEventListener('click', async () => {
      if (state.index + 1 >= state.session.total) { await finish(); return; }
      await gotoIndex(state.index + 1);
    });

    const prev = $('#prevBtn');
    if (prev) prev.addEventListener('click', () => gotoIndex(Math.max(0, state.index - 1)));

    const skip = $('#skipBtn');
    if (skip) skip.addEventListener('click', async () => {
      state.skipped.add(state.index);
      if (state.index + 1 >= state.session.total) await finish();
      else await gotoIndex(state.index + 1);
    });

    const bm = $('#bookmarkBtn');
    if (bm) bm.addEventListener('click', async () => {
      try {
        const r = await post('/api/quiz/bookmark', { sourceId: state.question.sourceId, bookmarked: !state.question.bookmarked });
        state.question.bookmarked = r.bookmarked;
        toast(r.bookmarked ? '已收藏' : '已取消收藏');
        bm.textContent = r.bookmarked ? '已收藏' : '收藏';
      } catch (e) { toast('失败：' + e.message, false); }
    });

    const doubt = $('#doubtBtn');
    if (doubt) doubt.addEventListener('click', () => {
      const i = state.index;
      if (state.doubtful.has(i)) state.doubtful.delete(i); else state.doubtful.add(i);
      saveDoubtful(state.session.id);
      renderPractice();
    });

    const noteBtn = $('#noteBtn');
    if (noteBtn) noteBtn.addEventListener('click', () => {
      const box = $('#noteBox');
      if (!box) return;
      if (box.innerHTML) { box.innerHTML = ''; return; }
      box.innerHTML = `<div class="qnote">
        <label>这道题的笔记（只自己可见，可写易错点、解题套路）</label>
        <textarea id="noteText" rows="3" placeholder="例如：注意区分 B 树的阶与关键字个数">${esc(state.note || '')}</textarea>
        <div class="qactions"><button class="btn pri sm" id="noteSave">保存笔记</button><button class="btn sm" id="noteCancel">收起</button></div>
      </div>`;
      const save = $('#noteSave');
      if (save) save.addEventListener('click', async () => {
        const text = $('#noteText').value;
        try {
          const r = await post('/api/quiz/note', { sourceId: state.question.sourceId, note: text });
          state.note = r.note;
          toast(r.note ? '笔记已保存' : '笔记已清空');
          renderPractice();
        } catch (e) { toast('保存失败：' + e.message, false); }
      });
      const cancel = $('#noteCancel');
      if (cancel) cancel.addEventListener('click', () => { box.innerHTML = ''; });
    });

    document.querySelectorAll('.qcell').forEach((cell) => cell.addEventListener('click', () => gotoIndex(Number(cell.dataset.idx))));

    $('#quitPractice').addEventListener('click', async () => {
      if (state.session && state.session.answered > 0) {
        if (!confirm('退出后本次作答会保留，可稍后从「最近练习」继续。确定退出？')) return;
      }
      stopTimer(); renderStart();
    });

    const pauseBtn = $('#pauseBtn');
    if (pauseBtn) pauseBtn.addEventListener('click', () => {
      state.paused = !state.paused;
      pauseBtn.textContent = state.paused ? '继续' : '暂停';
      document.body.classList.toggle('q-paused', state.paused);
      toast(state.paused ? '已暂停计时' : '继续计时');
    });

    const handIn = $('#handIn');
    if (handIn) handIn.addEventListener('click', async () => {
      if (!confirm('提前交卷？未作答的题按 0 分计入。')) return;
      await finish();
    });

    const filter = $('#cardFilter');
    if (filter) filter.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      state.cardFilter = b.dataset.f;
      $$('#cardFilter button').forEach((x) => x.classList.toggle('on', x === b));
      const card = $('.qcard');
      if (card) card.innerHTML = '';
      renderPractice();
    });

    $$('[data-sim]').forEach((b) => b.addEventListener('click', async () => {
      const item = state.similar.items[Number(b.dataset.sim)];
      try {
        const r = await post('/api/quiz/session', { sourceIds: [item.sourceId], count: 1, mode: 'random' });
        enterSession(r.session, r.question, r.answer, r.statuses, 0, null);
      } catch (e) { toast('无法开始：' + e.message, false); }
    }));
    const simAll = $('[data-sim-all]');
    if (simAll) simAll.addEventListener('click', async () => {
      const ids = state.similar.items.map((x) => x.sourceId);
      try {
        const r = await post('/api/quiz/session', { sourceIds: ids, count: ids.length, mode: 'random' });
        enterSession(r.session, r.question, r.answer, r.statuses, 0, null);
      } catch (e) { toast('无法开始：' + e.message, false); }
    });

    const input = $('#freeAnswer');
    if (input && state.answer && state.answer.needsSelfGrade) input.disabled = true;
  }
  async function submitCurrent() {
    const q = state.question;
    let answer;
    if (q.options && q.options.length) {
      const keys = Object.keys(state.selected).filter((k) => state.selected[k]).sort();
      if (!keys.length) { toast('请先选择答案', false); return; }
      answer = q.type === 'MULTIPLE' ? keys : keys[0];
    } else {
      const free = ($('#freeAnswer') ? $('#freeAnswer').value : '').trim();
      if (!free) { toast('请先填写答案', false); return; }
      answer = free;
    }
    try {
      const r = await post('/api/quiz/answer', {
        sessionId: state.session.id, sourceId: q.sourceId, answer, elapsedMs: state.qElapsed
      });
      state.answer = r.answer;
      state.session = r.session;
      state.statuses = await loadStatuses();
      state.revealed = true;
      state.selected = {};
      state.qElapsed = 0;
      state.similar = null;
      renderPractice();
    } catch (e) { toast('失败：' + e.message, false); }
  }

  async function selfGradeSubmit(correct, score) {
    try {
      const body = { sessionId: state.session.id, sourceId: state.question.sourceId, correct };
      if (score !== undefined && score !== null) body.score = score;
      const r = await post('/api/quiz/self-grade', body);
      state.answer = r.answer;
      state.session = r.session;
      state.statuses = await loadStatuses();
      renderPractice();
    } catch (e) { toast('失败：' + e.message, false); }
  }

  async function loadStatuses() {
    const r = await api(`/api/quiz/session?sessionId=${encodeURIComponent(state.session.id)}&index=${state.index}`);
    state.note = r.note || state.note;
    return r.statuses;
  }

  async function gotoIndex(index) {
    try {
      const r = await api(`/api/quiz/session?sessionId=${encodeURIComponent(state.session.id)}&index=${index}`);
      state.index = index;
      state.question = r.question;
      state.answer = r.answer;
      state.note = r.note || '';
      state.statuses = r.statuses;
      state.revealed = Boolean(r.answer);
      state.selected = {};
      state.qElapsed = 0;
      state.similar = null;
      state.aiText = '';
      state.aiError = '';
      renderPractice();
    } catch (e) { toast('失败：' + e.message, false); }
  }

  async function resumeSession(sessionId) {
    try {
      const r = await api(`/api/quiz/session?sessionId=${encodeURIComponent(sessionId)}&index=0`);
      const firstUnanswered = (r.statuses || []).findIndex((st) => !st.answered);
      const target = firstUnanswered >= 0 ? firstUnanswered : Math.max(0, (r.statuses || []).length - 1);
      const cur = target === 0
        ? r
        : await api(`/api/quiz/session?sessionId=${encodeURIComponent(sessionId)}&index=${target}`);
      const isExam = r.session.mode === 'exam';
      enterSession(cur.session, cur.question, cur.answer, r.statuses, cur.index || 0, null);
      if (isExam) {
        await loadExamState();
        renderPractice();
      }
    } catch (e) { toast('无法继续该练习：' + e.message, false); }
  }

  async function finish() {
    try {
      const isExam = state.session.mode === 'exam';
      const report = await post('/api/quiz/finish', { sessionId: state.session.id });
      const full = isExam
        ? await api('/api/exam/report?sessionId=' + encodeURIComponent(state.session.id))
        : report;
      stopTimer();
      state.view = 'report';
      renderReport(full);
    } catch (e) { toast('失败：' + e.message, false); }
  }
  // ============================================================
  //  报告页（普通练习 + 真题模考）
  // ============================================================
  function renderReport(report) {
    const s = report.session;
    const v = $('#view');
    const isExam = Boolean(report.exam);
    const subRows = (report.subjects || []).map((x) => {
      const name = x.name || (window.SUB_COLOR && x.subjectKey ? (SUB_COLOR_SHORT(x.subjectKey)) : x.id);
      const total = x.total || 0;
      const correct = x.correct || 0;
      return `<div class="row"><span class="dotc" style="background:${SUB_COLOR[x.id || x.subjectKey]}"></span>
        <div class="grow"><div class="t">${esc(name)}</div>
        <div class="s">${correct}/${total} 对${x.score !== undefined ? ' · 得分 ' + Math.round(x.score * 10) / 10 : ''}</div></div>
        <div class="right"><b>${x.accuracy !== null && x.accuracy !== undefined ? x.accuracy + '%' : '—'}</b></div></div>`;
    }).join('');

    const examHeader = isExam ? `
      <div class="exam-score">
        <div class="exam-score-main">
          <div class="v">${report.score}<small> / ${report.fullScore}</small></div>
          <div class="k">总分</div>
        </div>
        <div class="exam-score-sections">
          ${(report.sections || []).map((sec) => `
            <div class="exam-sec-row">
              <div class="grow"><div class="t">${esc(sec.name)}</div>
                <div class="bar sm"><i class="${sec.score / Math.max(1, sec.full) >= 0.8 ? 'ok' : sec.score / Math.max(1, sec.full) >= 0.6 ? 'warn' : 'bad'}" style="width:${Math.round(sec.score / Math.max(1, sec.full) * 100)}%"></i></div>
              </div>
              <div class="right"><b>${sec.score}</b> / ${sec.full}</div>
            </div>`).join('')}
        </div>
      </div>` : '';

    v.innerHTML = `
    <div class="card">
      <h3><span class="dot"></span>${isExam ? esc(report.exam.title) + ' · 成绩报告' : '练习报告'}</h3>
      ${examHeader}
      <div class="grid g4">
        <div class="stat hl"><div class="k">完成题数</div><div class="v">${report.scored}<small>/ ${s.total}</small></div><div class="d">用时约 ${Math.round((s.durationMs || 0) / 60000)} 分钟</div></div>
        <div class="stat"><div class="k">正确率</div><div class="v">${report.accuracy !== null ? report.accuracy + '%' : '—'}</div><div class="d">对 ${report.correct} · 错 ${report.wrong}</div></div>
        <div class="stat"><div class="k">待自评</div><div class="v">${report.pendingSelfGrade}</div><div class="d">主观题未判定</div></div>
        <div class="stat"><div class="k">已关联知识点</div><div class="v">${report.mappedCount}</div><div class="d">回写掌握度</div></div>
      </div>
      ${report.pendingSelfGrade > 0 ? `<div class="mt small muted">有 ${report.pendingSelfGrade} 道主观题尚未自评，可在交卷前返回答题卡完成；未自评按 0 分计。</div>` : ''}
      ${subRows ? `<div class="mt"><div class="rows">${subRows}</div></div>` : ''}
      <div class="mt" style="display:flex;gap:9px;flex-wrap:wrap">
        <button class="btn" id="backStart">返回题库</button>
        ${isExam ? `<button class="btn" id="retakeExam">再模考一次</button>` : ''}
        <button class="btn" id="reWrong">重练错题</button>
        <button class="btn" id="openWrongBook">打开错题本</button>
      </div>
    </div>
    ${report.wrongItems && report.wrongItems.length ? `<div class="card mt2">
      <h3><span class="dot"></span>本次错题 <span class="small muted2" style="margin-left:auto;font-weight:400">已自动收入错题本</span></h3>
      <div class="rows">${report.wrongItems.map((w) => `
        <div class="row"><div class="grow"><div class="t"><span class="tag ${w.subjectKey}">${esc(SUB_COLOR_SHORT(w.subjectKey))}</span> ${esc(w.title)}</div>
        <div class="s">${esc(w.chapterName || '')}${w.pointName ? ' · ' + esc(w.pointName) : ''}</div></div>
        <button class="btn sm" data-open-wrong="${w.sourceId}">查看</button></div>`).join('')}</div>
      <div class="mt"><button class="btn pri sm" id="redoSessionWrong">只练本次错题</button></div>
    </div>` : '<div class="card mt2"><h3><span class="dot"></span>本次全部正确，继续保持</h3></div>'}
    `;
    $('#backStart').addEventListener('click', () => { state.exam = null; state.view = 'start'; renderStart(); });
    const retake = $('#retakeExam');
    if (retake) retake.addEventListener('click', () => startExam(report.exam.examId));
    $('#reWrong').addEventListener('click', () => { state.exam = null; startSession({ mode: 'wrong' }); });
    $('#openWrongBook').addEventListener('click', () => { state.exam = null; renderCollection('wrong'); });
    const redo = $('#redoSessionWrong');
    if (redo) redo.addEventListener('click', () => {
      state.exam = null;
      startSession({ sourceIds: report.wrongItems.map((x) => x.sourceId), count: Math.min(report.wrongItems.length, 50), mode: 'random' });
    });
    $$('[data-open-wrong]').forEach((b) => b.addEventListener('click', () => {
      const item = report.wrongItems.find((x) => String(x.sourceId) === b.dataset.openWrong);
      if (item) showWrongDetail(item);
    }));
  }

  function showWrongDetail(item) {
    if (typeof window.openModal !== 'function') return;
    window.openModal(`
      <h3><span class="dot"></span>错题复盘</h3>
      <div class="qtitle">${md(item.content || item.title)}</div>
      ${item.pointName ? `<div class="mt small"><span class="tag warn">知识点：${esc(item.pointName)}</span></div>` : ''}
      <h4 class="mt">解析</h4>
      <div class="qexplain">${md((item.explanation && item.explanation.trim()) || (item.answerText && item.answerText.trim()) || '该题暂无详细解析，可对照原题讨论。')}</div>
      <div class="actions"><button class="btn pri" id="closeWrong">关闭</button></div>
    `);
    const c = $('#closeWrong');
    if (c) c.addEventListener('click', () => window.closeModal());
  }

  function SUB_COLOR_SHORT(key) {
    return SUB_SHORT[key] || key;
  }
  // ============================================================
  //  错题本 / 收藏夹
  // ============================================================
  async function renderCollection(kind) {
    const v = $('#view');
    v.innerHTML = '<div class="card"><div class="skel" style="width:40%"></div><div class="skel mt" style="width:80%"></div></div>';
    const r = await api('/api/quiz/collection?kind=' + kind + '&limit=200');
    const title = kind === 'favorite' ? '收藏夹' : '错题本';
    const items = r.items;
    v.innerHTML = `
    <div class="qbar" style="margin-bottom:14px">
      <button class="btn sm" id="collBack">返回题库</button>
      <div class="qbar-mid"><span class="tag brand">${title}</span><span class="small muted">${items.length} 道已加载</span></div>
      <button class="btn sm pri" id="startCollection">开始练习</button>
    </div>
    <div class="grid g2" style="align-items:start">
      <div class="card">
        <h3><span class="dot"></span>${title} <span class="small muted2" style="margin-left:auto;font-weight:400">${r.total} 题</span></h3>
        <div class="rows">${items.length ? items.map((q) => `
          <div class="row"><span class="dotc" style="background:${SUB_COLOR[q.subjectKey]}"></span>
            <div class="grow"><div class="t">${esc(q.title)}</div>
            <div class="s">${esc(q.subjectName)} · ${TYPE_LABEL[q.type] || q.type} · ${DIFF_LABEL[q.difficulty] || q.difficulty}${q.chapterName ? ' · ' + esc(q.chapterName) : ''}${q.sectionName ? ' / ' + esc(q.sectionName) : ''}</div></div>
            <button class="btn sm" data-open="${q.sourceId}">做题</button></div>`).join('')
          : '<div class="empty">还没有内容，去题库练习吧</div>'}
        </div>
      </div>
      <div class="card" id="collDetail">
        <h3><span class="dot"></span>题目详情</h3>
        <div class="empty">选择左侧题目查看解析</div>
      </div>
    </div>`;
    $('#collBack').addEventListener('click', () => { state.view = 'start'; renderStart(); });
    $('#startCollection').addEventListener('click', () => startSession({ mode: kind }));
    $$('[data-open]').forEach((b) => b.addEventListener('click', () => showCollDetail(items.find((x) => String(x.sourceId) === b.dataset.open), kind)));
  }

  async function showCollDetail(q, kind) {
    const panel = $('#collDetail');
    if (!panel || !q) return;
    panel.innerHTML = `
      <h3><span class="dot"></span>题目详情
        <button class="btn sm" id="collBm" style="margin-left:auto">${q.bookmarked ? '已收藏' : '收藏'}</button></h3>
      <div class="qtitle">${md(q.content || q.title)}</div>
      ${q.options && q.options.length ? `<div class="qopts">${q.options.map((o) => `<div class="qopt ${q.correctKeys && q.correctKeys.includes(o.key) ? 'correct' : ''}"><span class="qopt-key">${o.key}</span><span class="qopt-text">${md(o.content)}</span></div>`).join('')}</div>` : ''}
      ${q.referenceAnswer ? `<div class="advice info mt"><div class="h">参考答案</div><div class="b">${md(q.referenceAnswer)}</div></div>` : ''}
      <h4 class="mt">解析</h4>
      <div class="qexplain">${md(q.explanation && q.explanation.trim()
        ? q.explanation
        : (q.referenceAnswer && !/^请对照详细解析/.test(q.referenceAnswer)
          ? q.referenceAnswer
          : '源题未提供详细解析，可参考原题讨论。'))}</div>
      <div class="mt" style="display:flex;gap:9px;flex-wrap:wrap">
        <button class="btn sm" id="collSimilar">举一反三</button>
        ${q.sourceUrl ? `<a class="btn sm" href="${esc(q.sourceUrl)}" target="_blank" rel="noopener">查看原题</a>` : ''}
        <button class="btn sm pri" id="collDo">单独练这道</button>
      </div>
      <div id="collSimBox"></div>`;
    const bm = $('#collBm');
    if (bm) bm.addEventListener('click', async () => {
      const r = await post('/api/quiz/bookmark', { sourceId: q.sourceId, bookmarked: !q.bookmarked });
      q.bookmarked = r.bookmarked; bm.textContent = r.bookmarked ? '已收藏' : '收藏';
    });
    const sim = $('#collSimilar');
    if (sim) sim.addEventListener('click', async () => {
      try {
        const r = await api(`/api/quiz/similar?sourceId=${q.sourceId}&limit=6`);
        const box = $('#collSimBox');
        box.innerHTML = r.items.length ? `<h4 class="mt">同类题（${esc(r.basis || '')}）</h4>
          <div class="rows">${r.items.map((x, i) => `<div class="row"><div class="grow"><div class="t">${esc(x.title)}</div>
            <div class="s">${esc(x.sectionName || '')}</div></div><button class="btn sm" data-sim1="${i}">练这道</button></div>`).join('')}</div>`
          : '<div class="empty">没有找到同类题</div>';
        $$('[data-sim1]').forEach((b) => b.addEventListener('click', async () => {
          const item = r.items[Number(b.dataset.sim1)];
          const s = await post('/api/quiz/session', { sourceIds: [item.sourceId], count: 1, mode: 'random' });
          enterSession(s.session, s.question, s.answer, s.statuses, 0, null);
        }));
      } catch (e) { toast('失败：' + e.message, false); }
    });
    const doIt = $('#collDo');
    if (doIt) doIt.addEventListener('click', async () => {
      const s = await post('/api/quiz/session', { sourceIds: [q.sourceId], count: 1, mode: 'random' });
      enterSession(s.session, s.question, s.answer, s.statuses, 0, null);
    });
  }

  // ---------- 键盘快捷键 ----------
  document.addEventListener('keydown', (e) => {
    if (state.view !== 'practice' || !state.session) return;
    const tag = (e.target && e.target.tagName) || '';
    if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const key = String(e.key || '').toUpperCase();
    if (/^[A-H]$/.test(key) && state.question && state.question.options && state.question.options.length) {
      const opt = state.question.options.find((o) => o.key === key);
      if (!opt || state.answer) return;
      e.preventDefault();
      if (state.question.type === 'MULTIPLE') {
        state.selected[key] = !state.selected[key];
        const el = $(`.qopt[data-key="${key}"]`);
        if (el) el.classList.toggle('on', state.selected[key]);
      } else {
        state.selected = { [key]: true };
        $$('.qopt').forEach((o) => o.classList.toggle('on', o.dataset.key === key));
        if (!state.answer) submitCurrent();
      }
      return;
    }
    if (key === 'ENTER' && !e.shiftKey) {
      const next = $('#nextBtn'); const submit = $('#submitBtn');
      if (next) { e.preventDefault(); next.click(); }
      else if (submit) { e.preventDefault(); submit.click(); }
      return;
    }
    if (key === 'ARROWLEFT') { const p = $('#prevBtn'); if (p && !p.disabled) { e.preventDefault(); p.click(); } return; }
    if (key === 'ARROWRIGHT') { const n = $('#nextBtn'); if (n) { e.preventDefault(); n.click(); } return; }
    if (key === 'M') { const d = $('#doubtBtn'); if (d) { e.preventDefault(); d.click(); } return; }
  });

  // ---------- 路由入口 ----------
  function render() {
    if (state.view === 'practice') renderPractice();
    else if (state.view === 'report') return;
    else if (state.view === 'collection') renderCollection(state.collectionKind || 'wrong');
    else renderStart();
  }

  async function openQuiz(page) {
    if (page === 'collection') {
      state.view = 'collection';
      return render();
    }
    state.view = 'start';
    state.exam = null;
    return renderStart();
  }

  window.QUIZ = {
    renderStart, renderPractice, renderReport, renderCollection, openQuiz, finish,
    startWithFilters: startSession,
    startExam,
    setTab: (t) => { state.tab = t; },
    setCollectionKind: (k) => { state.collectionKind = k; },
    getState: () => state
  };
})();
