/* ============================================================
 408 题库刷题 · 前端（原生 JS，挂载到全局 QUIZ）
 依赖：app.js 暴露的 esc / api / post / abs / toast / SUB_COLOR
 ============================================================ */
(function () {
  const SUB_COLOR = window.SUB_COLOR || { ds: 'var(--ds)', co: 'var(--co)', os: 'var(--os)', cn: 'var(--cn)' };
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
  const abs = window.abs;

  const state = {
    view: 'start',
    overview: null,
    session: null,
    index: 0,
    question: null,
    answer: null,
    statuses: [],
    selected: {},
    revealed: false,
    elapsed: 0,
    timer: null,
    syncPolling: false
  };

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

  // ---------- 题库开始页 ----------
  async function renderStart() {
    const v = $('#view');
    v.innerHTML = '<div class="card"><div class="skel" style="width:40%"></div><div class="skel mt" style="width:80%"></div><div class="skel mt" style="width:65%"></div></div>';
    const o = await api('/api/quiz/overview');
    state.overview = o;
    const sync = o.sync || {};
    const syncTotal = sync.counts?.total || o.total || 0;
    const ready = o.ready && o.total > 0;
    const subRows = o.subjects.map((s) =>
      `<div class="qsub" data-sub="${s.id}">
        <span class="dotc" style="background:${SUB_COLOR[s.id]}"></span>
        <span class="nm">${esc(s.short || s.name)}</span>
        <span class="sub-count">${s.total}</span>
      </div>`).join('');
    const chapterOpts = o.chapters.map((c) => {
      const subject = o.subjects.find((s) => s.id === c.subjectKey);
      return `<option value="${c.id}" data-sub="${c.subjectKey}">${esc(subject?.short || '')} · ${esc(c.name)}（${c.total}）</option>`;
    }).join('');

    v.innerHTML = `
    <div class="grid g2" style="align-items:start">
      <div class="card">
        <h3><span class="dot"></span>题库概览 <span class="small muted2" style="margin-left:auto;font-weight:400">采纳自 408 研岛题库</span></h3>
        <div class="qstat-row">
          <div class="qstat"><div class="v">${o.total}</div><div class="k">总题量</div></div>
          <div class="qstat"><div class="v">${o.practiced}</div><div class="k">已练习</div></div>
          <div class="qstat"><div class="v">${o.accuracy !== null ? o.accuracy + '%' : '—'}</div><div class="k">正确率</div></div>
          <div class="qstat"><div class="v" style="color:var(--bad)">${o.wrongCount}</div><div class="k">错题</div></div>
          <div class="qstat"><div class="v" style="color:var(--warn)">${o.favoriteCount}</div><div class="k">收藏</div></div>
        </div>
        <div class="qsubs">${subRows}</div>
        <div class="mt small muted">题库覆盖四科：数据结构、计算机组成原理、操作系统、计算机网络；题型含单选 / 多选 / 判断 / 填空 / 简答，每一题都带详细解析。</div>
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
          <div class="field"><label>章节（可选）</label><select id="qChapter"><option value="">不限</option>${chapterOpts}</select></div>
          <div class="field"><label>题型</label>
            <select id="qType"><option value="">不限</option>${o.types.filter((t) => t.total).map((t) => `<option value="${t.id}">${t.name}（${t.total}）</option>`).join('')}</select>
          </div>
          <div class="field"><label>难度</label>
            <select id="qDiff"><option value="">不限</option>${o.difficulties.filter((d) => d.total).map((d) => `<option value="${d.id}">${d.name}（${d.total}）</option>`).join('')}</select>
          </div>
          <div class="field"><label>题量</label><input id="qCount" type="number" min="1" max="50" value="20"></div>
        </div>
        <div class="field"><label>出题方式</label>
          <div class="seg" id="qMode">
            <button data-v="random" class="on">随机</button>
            <button data-v="sequence">顺序</button>
          </div>
        </div>
        <div style="display:flex;gap:9px;flex-wrap:wrap">
          <button class="btn pri" id="startPractice">开始练习</button>
          <button class="btn" data-mode="wrong" id="startWrong">只练错题本</button>
          <button class="btn" data-mode="favorite" id="startFav">只练收藏夹</button>
        </div>
      </div>
    </div>

    ${ready ? '' : `<div class="card mt2 q-sync">尚未同步题库：请先点击「同步题库」拉取最新题目（约 7000 题，首次需要几分钟）。<button class="btn pri sm" id="syncNow2">同步题库</button></div>`}

    <div class="grid g3 mt2">
      <div class="card qact"><h3><span class="dot"></span>错题本</h3><div class="small muted">做错的题会自动归档，支持反复重练。</div><button class="btn sm mt" data-mode="wrong" id="goWrong">进入错题本</button></div>
      <div class="card qact"><h3><span class="dot"></span>收藏夹</h3><div class="small muted">练习时点击收藏，随时回看重点题。</div><button class="btn sm mt" data-mode="favorite" id="goFav">进入收藏夹</button></div>
      <div class="card qact"><h3><span class="dot"></span>同步题库</h3>
        <div class="small muted">上次同步：${sync.lastSyncAt ? esc(sync.lastSyncAt.slice(0, 16).replace('T', ' ')) : '从未'}（含 ${Number(syncTotal).toLocaleString()} 题）</div>
        <button class="btn sm mt" id="syncNow">${ready ? '重新同步' : '同步题库'}</button>
      </div>
    </div>
    `;

    if (!ready) $('#syncNow').classList.add('pri');
    if (o.syncing) pollSync();

    $('#qSubject').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      $$('#qSubject button').forEach((x) => x.classList.toggle('on', x === b));
      const sub = b.dataset.v;
      const ch = $('#qChapter');
      [...ch.options].forEach((opt) => { opt.hidden = sub && opt.dataset.sub && opt.dataset.sub !== sub; });
      if (ch.value && ch.selectedOptions[0] && ch.selectedOptions[0].hidden) ch.value = '';
    });
    $('#qMode').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      $$('#qMode button').forEach((x) => x.classList.toggle('on', x === b));
    });
    $('#startPractice').addEventListener('click', () => startSession({
      subject: $('#qSubject .on').dataset.v,
      chapter: $('#qChapter').value,
      type: $('#qType').value,
      difficulty: $('#qDiff').value,
      count: Number($('#qCount').value || 20),
      mode: $('#qMode .on').dataset.v
    }));
    $('#startWrong').addEventListener('click', () => startSession({ mode: 'wrong' }));
    $('#startFav').addEventListener('click', () => startSession({ mode: 'favorite' }));
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

  async function startSession(filters) {
    try {
      const r = await post('/api/quiz/session', filters);
      state.session = r.session;
      state.index = 0;
      state.question = r.question;
      state.answer = r.answer;
      state.statuses = r.statuses;
      state.view = 'practice';
      state.elapsed = 0;
      renderPractice();
    } catch (e) { toast('无法开始：' + e.message, false); }
  }

  function startTimerIfNeeded() {
    if (state.timer) return;
    state.timer = setInterval(() => {
      state.elapsed += 1000;
      const el = $('#qTimer');
      if (el) el.textContent = fmtClock(state.elapsed);
    }, 1000);
  }
  function stopTimer() { if (state.timer) { clearInterval(state.timer); state.timer = null; } }
  function fmtClock(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  // ---------- 练习页 ----------
  async function renderPractice() {
    startTimerIfNeeded();
    const q = state.question;
    const s = state.session;
    const v = $('#view');
    const ans = state.answer;
    const pct = s.total ? Math.round(((s.answered) / s.total) * 100) : 0;
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

    v.innerHTML = `
    <div class="qbar">
      <button class="btn sm" id="quitPractice">退出</button>
      <div class="qbar-mid">
        <span class="tag ${q.subjectKey}">${esc(q.subjectName)}</span>
        <span class="tag">${TYPE_LABEL[q.type] || q.type}</span>
        <span class="tag ${q.difficulty === 'HARD' ? 'bad' : q.difficulty === 'MEDIUM' ? 'warn' : 'ok'}">${DIFF_LABEL[q.difficulty] || q.difficulty}</span>
        ${q.chapterName ? `<span class="tag">${esc(q.chapterName)}</span>` : ''}
        <span id="qTimer" class="q-timer">00:00</span>
      </div>
      <div class="qbar-right">${s.answered}/${s.total} 已答</div>
    </div>
    <div class="bar qbar-progress" style="margin:-6px 0 14px"><i style="width:${pct}%"></i></div>

    <div class="grid g2" style="align-items:start">
      <div class="card">
        <h3><span class="dot"></span>第 ${state.index + 1} 题
          <button class="btn sm" id="bookmarkBtn" style="margin-left:auto">${q.bookmarked ? '★ 已收藏' : '☆ 收藏'}</button>
        </h3>
        <div class="qtitle">${md(q.content || q.title)}</div>
        ${q.options && q.options.length ? `<div class="qopts">${optHtml}</div>
          <div class="qhint small muted">${q.type === 'MULTIPLE' ? '多选题，可多选；选全对才得分。' : q.type === 'JUDGE' ? '判断题，选「正确」或「错误」。' : '单选题，点选一个选项。'}</div>`
        : `<div class="qfree"><label>在此作答（客观题可填关键词，主观题可写要点）</label>
            <textarea id="freeAnswer" rows="6" placeholder="例如：≥300 bit">${ans && ans.needsSelfGrade ? esc(stripMd(ans.answer)) : ''}</textarea></div>`}
        <div class="qactions">
          ${ans ? `<button class="btn" id="revealBtn">${state.revealed ? '隐藏解析' : '显示解析'}</button>
            <button class="btn pri" id="nextBtn">${state.index + 1 >= s.total ? '完成练习' : '下一题'}</button>`
          : `<button class="btn pri" id="submitBtn">提交答案</button>
            <button class="btn" id="skipBtn">${state.index + 1 >= s.total ? '直接交卷' : '跳过这题'}</button>`}
        </div>
      </div>

      <div class="card">
        <h3><span class="dot"></span>答题卡</h3>
        <div class="qcard">${state.statuses.map((st, i) => `
          <button class="qcell ${st.answered ? (st.correct === 1 ? 'ok' : st.correct === 0 ? 'bad' : 'self') : ''} ${i === state.index ? 'now' : ''}" data-idx="${i}">${i + 1}</button>
        `).join('')}</div>
        <div class="qlegend small muted"><span class="qcell ok mini"></span>对 <span class="qcell bad mini"></span>错 <span class="qcell self mini"></span>待自评 <span class="qcell mini"></span>未答</div>
      </div>
    </div>

    ${state.revealed && ans ? `<div class="card mt2" id="answerPanel">
      ${ans.autoGraded ? `<div class="advice ${ans.correct ? 'ok' : 'bad'}"><div class="h">${ans.correct ? '回答正确' : '回答错误'}</div>
        <div class="b">你的答案：${esc(Array.isArray(ans.answer) ? ans.answer.join('、') : stripMd(ans.answer))}<br>正确答案：${ans.correctOptions.map((o) => o.key + '. ' + plainWithMath(o.content)).join('；')}</div></div>`
      : (ans.needsSelfGrade ? `<div class="advice info"><div class="h">该题需要你自评</div><div class="b">对照下方解析，判断自己是否答到要点。</div>
        <div class="b mt">你的作答：${esc(stripMd(Array.isArray(ans.answer) ? ans.answer.join('、') : ans.answer))}</div>
        <div class="qactions"><button class="btn pri sm" id="selfRight">我答对了</button><button class="btn sm" id="selfWrong">我答错了</button></div></div>`
      : '')}
      <h4 class="mt">详细解析</h4>
      <div class="qexplain">${md(q.explanation && q.explanation.trim()
        ? q.explanation
        : (ans.referenceAnswer && !/^请对照详细解析/.test(ans.referenceAnswer)
          ? ans.referenceAnswer
          : '源题未提供详细解析，可对照参考答案判断作答，或查看原题讨论。'))}</div>
      ${q.sourceUrl ? `<div class="mt small"><a href="${esc(q.sourceUrl)}" target="_blank" rel="noopener">查看原题与社区讨论 ↗</a></div>` : ''}
    </div>` : ''}`;

    bindPractice();
  }

  function stripMd(text) {
    return String(text || '').replace(/\*\*/g, '').replace(/`/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  }

  function bindPractice() {
    $$('.qopt').forEach((opt) => opt.addEventListener('click', () => {
      const key = opt.dataset.key;
      const q = state.question;
      if (state.answer || state.revealed) return;
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
      if (state.revealed && state.answer && state.answer.needsSelfGrade === false) state.answer = state.answer;
      renderPractice();
    });
    const next = $('#nextBtn');
    if (next) next.addEventListener('click', async () => {
      if (state.index + 1 >= state.session.total) await finish();
      else await gotoIndex(state.index + 1);
    });
    const skip = $('#skipBtn');
    if (skip) skip.addEventListener('click', async () => {
      if (state.index + 1 >= state.session.total) { await finish(); }
      else await gotoIndex(state.index + 1);
    });
    const bm = $('#bookmarkBtn');
    if (bm) bm.addEventListener('click', async () => {
      try {
        const r = await post('/api/quiz/bookmark', { sourceId: state.question.sourceId, bookmarked: !state.question.bookmarked });
        state.question.bookmarked = r.bookmarked;
        toast(r.bookmarked ? '已收藏' : '已取消收藏');
        bm.textContent = r.bookmarked ? '★ 已收藏' : '☆ 收藏';
      } catch (e) { toast('失败：' + e.message, false); }
    });
    const sr = $('#selfRight'); const sw = $('#selfWrong');
    if (sr) sr.addEventListener('click', () => selfGrade(true));
    if (sw) sw.addEventListener('click', () => selfGrade(false));
    $$('.qcell').forEach((cell) => cell.addEventListener('click', () => gotoIndex(Number(cell.dataset.idx))));
    $('#quitPractice').addEventListener('click', () => { stopTimer(); renderStart(); });
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
        sessionId: state.session.id, sourceId: q.sourceId, answer, elapsedMs: state.elapsed
      });
      state.answer = r.answer;
      state.session = r.session;
      state.statuses = await loadStatuses();
      state.revealed = true;
      state.selected = {};
      renderPractice();
    } catch (e) { toast('失败：' + e.message, false); }
  }

  async function selfGrade(correct) {
    try {
      const r = await post('/api/quiz/self-grade', {
        sessionId: state.session.id, sourceId: state.question.sourceId, correct
      });
      state.answer = r.answer;
      state.session = r.session;
      state.statuses = await loadStatuses();
      renderPractice();
    } catch (e) { toast('失败：' + e.message, false); }
  }

  async function loadStatuses() {
    const r = await api(`/api/quiz/session?sessionId=${encodeURIComponent(state.session.id)}&index=${state.index}`);
    return r.statuses;
  }

  async function gotoIndex(index) {
    try {
      const r = await api(`/api/quiz/session?sessionId=${encodeURIComponent(state.session.id)}&index=${index}`);
      state.index = index;
      state.question = r.question;
      state.answer = r.answer;
      state.statuses = r.statuses;
      state.revealed = Boolean(r.answer);
      state.selected = {};
      state.elapsed = 0;
      renderPractice();
    } catch (e) { toast('失败：' + e.message, false); }
  }

  async function finish() {
    try {
      const report = await post('/api/quiz/finish', { sessionId: state.session.id });
      stopTimer();
      state.view = 'report';
      renderReport(report);
    } catch (e) { toast('失败：' + e.message, false); }
  }

  // ---------- 报告页 ----------
  function renderReport(report) {
    const s = report.session;
    const v = $('#view');
    const subRows = report.subjects.map((x) =>
      `<div class="row"><span class="dotc" style="background:${SUB_COLOR[x.id]}"></span>
        <div class="grow"><div class="t">${esc(x.name)}</div><div class="s">${x.correct}/${x.total} 对</div></div>
        <div class="right"><b>${x.accuracy !== null ? x.accuracy + '%' : '—'}</b></div></div>`).join('');
    v.innerHTML = `
    <div class="card">
      <h3><span class="dot"></span>练习报告</h3>
      <div class="grid g4">
        <div class="stat hl"><div class="k">完成题数</div><div class="v">${report.scored}<small>/ ${s.total}</small></div><div class="d">用时约 ${Math.round((s.durationMs || 0) / 60000)} 分钟</div></div>
        <div class="stat"><div class="k">正确率</div><div class="v">${report.accuracy !== null ? report.accuracy + '%' : '—'}</div><div class="d">对 ${report.correct} · 错 ${report.wrong}</div></div>
        <div class="stat"><div class="k">待自评</div><div class="v">${report.pendingSelfGrade}</div><div class="d">主观题未判定</div></div>
        <div class="stat"><div class="k">已关联知识点</div><div class="v">${report.mappedCount}</div><div class="d">回写掌握度</div></div>
      </div>
      ${report.pendingSelfGrade > 0 ? `<div class="mt small muted">有 ${report.pendingSelfGrade} 道主观题尚未自评，可在交卷前返回答题卡完成。</div>` : ''}
      ${subRows ? `<div class="mt"><div class="rows">${subRows}</div></div>` : ''}
      <div class="mt" style="display:flex;gap:9px;flex-wrap:wrap">
        <button class="btn" id="backStart">返回题库</button>
        <button class="btn" id="reWrong">重练本次错题</button>
        <button class="btn" id="openWrongBook">打开错题本</button>
      </div>
    </div>
    ${report.wrongItems.length ? `<div class="card mt2">
      <h3><span class="dot"></span>本次错题 <span class="small muted2" style="margin-left:auto;font-weight:400">已自动收入错题本</span></h3>
      <div class="rows">${report.wrongItems.map((w, i) => `
        <div class="row"><div class="grow"><div class="t"><span class="tag ${w.subjectKey}">${esc(SUB_COLOR_SHORT(w.subjectKey))}</span> ${esc(w.title)}</div>
        <div class="s">${esc(w.chapterName || '')}</div></div></div>`).join('')}</div>
    </div>` : '<div class="card mt2"><h3><span class="dot"></span>本次全部正确，继续保持</h3></div>'}
    `;
    $('#backStart').addEventListener('click', () => renderStart());
    $('#reWrong').addEventListener('click', () => startSession({ mode: 'wrong' }));
    $('#openWrongBook').addEventListener('click', () => renderCollection('wrong'));
  }

  function SUB_COLOR_SHORT(key) {
    return { ds: '数据结构', co: '组成原理', os: '操作系统', cn: '计网' }[key] || key;
  }

  // ---------- 错题本 / 收藏 ----------
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
      <button class="btn sm" id="startCollection">开始练习</button>
    </div>
    <div class="grid g2" style="align-items:start">
      <div class="card">
        <h3><span class="dot"></span>${title} <span class="small muted2" style="margin-left:auto;font-weight:400">${r.total} 题</span></h3>
        <div class="rows">${items.length ? items.map((q, i) => `
          <div class="row"><span class="dotc" style="background:${SUB_COLOR[q.subjectKey]}"></span>
            <div class="grow"><div class="t">${esc(q.title)}</div>
            <div class="s">${esc(q.subjectName)} · ${TYPE_LABEL[q.type] || q.type} · ${DIFF_LABEL[q.difficulty] || q.difficulty}${q.chapterName ? ' · ' + esc(q.chapterName) : ''}</div></div>
            <button class="btn sm" data-open="${q.sourceId}">做题</button></div>`).join('')
          : '<div class="empty">还没有内容，去题库练习吧</div>'}
        </div>
      </div>
      <div class="card" id="collDetail">
        <h3><span class="dot"></span>题目详情</h3>
        <div class="empty">选择左侧题目查看解析</div>
      </div>
    </div>`;
    $('#collBack').addEventListener('click', () => renderStart());
    $('#startCollection').addEventListener('click', () => startSession({ mode: kind }));
    $$('[data-open]').forEach((b) => b.addEventListener('click', () => showCollDetail(items.find((x) => String(x.sourceId) === b.dataset.open), kind)));
  }

  async function showCollDetail(q, kind) {
    const panel = $('#collDetail');
    if (!panel || !q) return;
    panel.innerHTML = `
      <h3><span class="dot"></span>题目详情
        <button class="btn sm" id="collBm" style="margin-left:auto">${q.bookmarked ? '★ 已收藏' : '☆ 收藏'}</button></h3>
      <div class="qtitle">${md(q.content || q.title)}</div>
      ${q.options && q.options.length ? `<div class="qopts">${q.options.map((o) => `<div class="qopt ${q.correctKeys && q.correctKeys.includes(o.key) ? 'correct' : ''}"><span class="qopt-key">${o.key}</span><span class="qopt-text">${md(o.content)}</span></div>`).join('')}</div>` : ''}
      ${q.referenceAnswer ? `<div class="advice info mt"><div class="h">参考答案</div><div class="b">${md(q.referenceAnswer)}</div></div>` : ''}
      <h4 class="mt">解析</h4>
      <div class="qexplain">${md(q.explanation && q.explanation.trim()
        ? q.explanation
        : (q.referenceAnswer && !/^请对照详细解析/.test(q.referenceAnswer)
          ? q.referenceAnswer
          : '源题未提供详细解析，可参考原题讨论。'))}</div>
      ${q.sourceUrl ? `<div class="mt small"><a href="${esc(q.sourceUrl)}" target="_blank" rel="noopener">查看原题 ↗</a></div>` : ''}`;
    const bm = $('#collBm');
    if (bm) bm.addEventListener('click', async () => {
      const r = await post('/api/quiz/bookmark', { sourceId: q.sourceId, bookmarked: !q.bookmarked });
      q.bookmarked = r.bookmarked; bm.textContent = r.bookmarked ? '★ 已收藏' : '☆ 收藏';
    });
  }

  // ---------- 路由入口 ----------
  function render() {
    if (state.view === 'practice') renderPractice();
    else if (state.view === 'report') return;
    else if (state.view === 'collection') renderCollection(state.collectionKind || 'wrong');
    else renderStart();
  }

  async function openQuiz(page) {
    state.view = page === 'collection' ? 'collection' : 'start';
    render();
  }

  window.QUIZ = {
    renderStart, renderPractice, renderReport, renderCollection, openQuiz, finish,
    startWithFilters: startSession,
    setCollectionKind: (k) => { state.collectionKind = k; },
    getState: () => state
  };
})();
