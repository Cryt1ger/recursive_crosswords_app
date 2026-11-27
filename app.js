(() => {
  'use strict';

  const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
  const puzzle = window.PUZZLE || { text: '', answers: {} };

  const el = (id) => document.getElementById(id);
  const puzzleEl = el('puzzle');
  const composerEl = el('composer');
  const progressEl = el('progress');
  const clueEl = el('clue');
  const answerEl = el('answer');
  const feedbackEl = el('feedback');
  const hintTextEl = el('hintText');
  const hint1El = el('hint1');
  const hint2El = el('hint2');
  const scoreEl = el('score');
  const timerEl = el('timer');
  const logSectionEl = el('logSection');
  const logEl = el('log');
  const toastEl = el('toast');
  const completeEl = el('complete');

  let tree = [];
  let nodesByPath = new Map();
  let order = [];
  let solved = new Map();
  let hintLevel = new Map();
  let score = 100;
  let selected = null;
  let hintsAllowed = false;
  let toastTimer = null;
  let elapsedMs = 0;
  let startedAt = null;
  let timerTick = null;
  let finished = false;

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function normalize(value) {
    return String(value).trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
  }

  function parseBrackets(text) {
    const root = [];
    const stack = [{ nodes: root, path: '' }];
    const source = String(text);

    const append = (value) => {
      const current = stack[stack.length - 1];
      const last = current.nodes[current.nodes.length - 1];
      if (last && last.type === 'text') last.text += value;
      else current.nodes.push({ type: 'text', text: value });
    };

    for (let i = 0; i < source.length; i++) {
      const ch = source[i];

      if (ch === '\\' && (source[i + 1] === '[' || source[i + 1] === ']')) {
        append(source[i + 1]);
        i++;
        continue;
      }

      const current = stack[stack.length - 1];
      if (ch === '[') {
        const index = current.nodes.filter((node) => node.type === 'bracket').length;
        const path = current.path ? current.path + '.' + index : String(index);
        const node = { type: 'bracket', path, children: [] };
        current.nodes.push(node);
        stack.push({ nodes: node.children, path });
      } else if (ch === ']') {
        if (stack.length > 1) stack.pop();
      } else {
        append(ch);
      }
    }

    return root;
  }

  function indexBrackets(nodes) {
    nodes.forEach((node) => {
      if (node.type !== 'bracket') return;
      nodesByPath.set(node.path, node);
      order.push(node.path);
      indexBrackets(node.children);
    });
  }

  function hasUnsolved(node) {
    return node.children.some((child) => child.type === 'bracket' && !solved.has(child.path));
  }

  function firstLeaf(path) {
    const node = nodesByPath.get(path);
    if (!node) return null;
    if (!hasUnsolved(node)) return path;
    for (const child of node.children) {
      if (child.type === 'bracket' && !solved.has(child.path)) {
        const leaf = firstLeaf(child.path);
        if (leaf) return leaf;
      }
    }
    return null;
  }

  function updateProgress() {
    progressEl.textContent = solved.size + ' / ' + order.length;
  }

  function renderNodes(nodes) {
    return nodes.map((node) => {
      if (node.type === 'text') return escapeHtml(node.text);

      if (solved.has(node.path)) {
        return '<span class="answer-inline">' + escapeHtml(solved.get(node.path)) + '</span>';
      }

      const state = hasUnsolved(node) ? 'locked' : 'open';
      const active = selected === node.path ? ' selected' : '';
      const inner = renderNodes(node.children);
      return '<span role="button" tabindex="0" class="clue ' + state + active +
        '" data-path="' + escapeHtml(node.path) + '">' + inner + '</span>';
    }).join('');
  }

  function plainText(nodes) {
    return nodes.map((node) => {
      if (node.type === 'text') return node.text;
      if (solved.has(node.path)) return solved.get(node.path);
      return plainText(node.children);
    }).join('');
  }

  function entryFor(path) {
    return (puzzle.answers || {})[path] || {};
  }

  function acceptedFor(path) {
    const accepted = entryFor(path).accepted;
    return Array.isArray(accepted) ? accepted : [];
  }

  function answerMatches(path, value) {
    const entry = entryFor(path);
    const accepted = acceptedFor(path).concat(entry.full ? [entry.full] : []);
    return accepted.some((item) => normalize(item) === value);
  }

  function findAvailableMatch(value) {
    return order.find((path) => {
      const node = nodesByPath.get(path);
      return node && !solved.has(path) && !hasUnsolved(node) && answerMatches(path, value);
    }) || null;
  }

  function findLockedMatch(value) {
    return order.find((path) => {
      const node = nodesByPath.get(path);
      return node && !solved.has(path) && hasUnsolved(node) && answerMatches(path, value);
    }) || null;
  }

  function findSolvedMatch(value) {
    return order.find((path) => solved.has(path) && answerMatches(path, value)) || null;
  }

  function renderExtensions() {
    const layer = puzzleEl.querySelector('.clue-extensions');
    if (!layer) return;

    layer.textContent = '';
    const base = puzzleEl.getBoundingClientRect();
    const right = base.left + puzzleEl.clientWidth;
    const rows = new Map();
    const textRects = [];
    const walker = document.createTreeWalker(puzzleEl, NodeFilter.SHOW_TEXT);

    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!node.nodeValue.trim()) continue;
      if (node.parentElement && node.parentElement.closest('.clue, .answer-inline, .clue-extensions')) continue;

      const range = document.createRange();
      range.selectNodeContents(node);
      Array.from(range.getClientRects()).forEach((rect) => {
        if (rect.width > 0) textRects.push(rect);
      });
    }

    puzzleEl.querySelectorAll('.clue, .answer-inline').forEach((target) => {
      Array.from(target.getClientRects()).forEach((rect) => {
        const key = Math.round(rect.top) + '|' + Math.round(rect.height);
        if (!rows.has(key)) rows.set(key, { top: rect.top, height: rect.height, items: [] });
        rows.get(key).items.push({ rect, target });
      });
    });

    rows.forEach((row) => {
      let last = row.items[0];
      row.items.forEach((item) => {
        if (item.rect.right >= last.rect.right) last = item;
      });
      if (last.rect.right >= right - 1) return;

      const textAfter = textRects.some((rect) =>
        rect.top < row.top + row.height &&
        rect.bottom > row.top &&
        rect.right > last.rect.right + 1
      );
      if (textAfter) return;

      const isAnswer = last.target.classList.contains('answer-inline');
      const locked = last.target.classList.contains('locked');
      const extension = document.createElement('span');
      extension.className = isAnswer
        ? 'answer-extension'
        : 'clue-extension' + (locked ? ' locked' : '');
      extension.style.left = (last.rect.right - base.left - 2) + 'px';
      extension.style.top = (row.top - base.top) + 'px';
      extension.style.width = (right - last.rect.right + 2) + 'px';
      extension.style.height = row.height + 'px';
      layer.appendChild(extension);
    });
  }

  function watchExtensions() {
    renderExtensions();
    requestAnimationFrame(watchExtensions);
  }

  function renderPuzzle() {
    puzzleEl.innerHTML = renderNodes(tree);
    const layer = document.createElement('div');
    layer.className = 'clue-extensions';
    puzzleEl.appendChild(layer);
    renderExtensions();
  }

  function updateScore() {
    scoreEl.textContent = String(score);
  }

  function formatTime(ms) {
    const total = Math.floor(ms / 1000);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const clock = String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
    return hours ? hours + ':' + clock : clock;
  }

  function currentElapsed() {
    return elapsedMs + (startedAt === null ? 0 : Date.now() - startedAt);
  }

  function renderTimer() {
    timerEl.textContent = formatTime(currentElapsed());
  }

  function startTimer() {
    if (finished || startedAt !== null) return;
    startedAt = Date.now();
    if (!timerTick) timerTick = setInterval(renderTimer, 500);
    renderTimer();
  }

  function stopTimer() {
    if (startedAt !== null) {
      elapsedMs += Date.now() - startedAt;
      startedAt = null;
    }
    if (timerTick) {
      clearInterval(timerTick);
      timerTick = null;
    }
    renderTimer();
    return elapsedMs;
  }

  function addLog(clue, answer) {
    logSectionEl.hidden = false;

    const item = document.createElement('li');
    item.className = 'log-item';

    const clueNode = document.createElement('span');
    clueNode.className = 'log-clue';
    clueNode.textContent = String(clue).replace(/\s+/g, ' ').trim();

    const answerNode = document.createElement('span');
    answerNode.className = 'log-answer';
    answerNode.textContent = answer;

    item.append(clueNode, answerNode);
    logEl.prepend(item);
  }

  function haptic(kind) {
    if (!tg || !tg.HapticFeedback) return;
    try {
      if (kind === 'success') tg.HapticFeedback.notificationOccurred('success');
      if (kind === 'error') tg.HapticFeedback.notificationOccurred('error');
    } catch (_) { /* ignore */ }
  }

  function toast(message) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 1800);
  }

  function updateComposerState() {
    composerEl.classList.toggle('composer--open', !!selected);
  }

  function closeComposer() {
    selected = null;
    hintsAllowed = false;
    answerEl.value = '';
    answerEl.classList.remove('shake');
    feedbackEl.textContent = '';
    feedbackEl.classList.remove('error');
    clueEl.innerHTML = '';
    updateHint();
    updateComposerState();
    renderPuzzle();
  }

  function activateClue(path) {
    if (!path) {
      toast('Все вложенные загадки уже решены');
      return;
    }
    if (selected === path && composerEl.classList.contains('composer--open')) {
      closeComposer();
    } else {
      selectClue(path, true);
    }
  }

  function updateHint() {
    const level = hintLevel.get(selected, 0);
    const entry = entryFor(selected);
    const accepted = acceptedFor(selected);
    const first = entry.first || (accepted.length ? accepted[0].charAt(0) : '');
    const full = entry.full || (accepted.length ? accepted[0] : '');

    hint1El.disabled = !hintsAllowed || level >= 1;
    hint2El.disabled = !hintsAllowed || level < 1 || level >= 2;
    hintTextEl.textContent = level === 1
      ? 'Первая буква: ' + String(first).charAt(0)
      : level >= 2 ? 'Ответ: ' + full : '';
  }

  function selectClue(path, allowHints = false) {
    const node = nodesByPath.get(path);
    if (!node) return;

    selected = path;
    hintsAllowed = allowHints;
    clueEl.innerHTML = renderNodes(node.children);
    answerEl.value = '';
    answerEl.classList.remove('shake');
    feedbackEl.textContent = '';
    feedbackEl.classList.remove('error');
    updateHint();
    updateComposerState();
    renderPuzzle();

    if (tg && tg.MainButton) {
      tg.MainButton.setText('Ответить');
      tg.MainButton.enable();
      tg.MainButton.show();
    } else {
      setTimeout(() => answerEl.focus(), 50);
    }
  }

  function useHint(level) {
    if (!selected || !hintsAllowed) return;
    const accepted = acceptedFor(selected);
    if (!accepted.length) return;
    if (hintLevel.get(selected, 0) >= level) return;

    hintLevel.set(selected, level);
    score = Math.max(0, score - (level === 1 ? 10 : 25));
    updateScore();
    updateHint();
    haptic('error');

    if (level === 2) {
      answerEl.value = entryFor(selected).full || accepted[0];
      checkAnswer();
    }
  }

  function solvePath(path) {
    const entry = entryFor(path);
    const accepted = acceptedFor(path).concat(entry.full ? [entry.full] : []);
    const shown = entry.full || accepted[0];
    const node = nodesByPath.get(path);
    const clue = node ? plainText(node.children) : '';
    solved.set(path, shown);
    addLog(clue, shown);
    haptic('success');

    closeComposer();
    updateProgress();

    if (order.every((item) => solved.has(item))) finish();
  }

  function markInvalid(message) {
    if (!selected) {
      toast(message);
      return;
    }
    feedbackEl.textContent = message;
    feedbackEl.classList.add('error');
    answerEl.classList.remove('shake');
    void answerEl.offsetWidth;
    answerEl.classList.add('shake');
  }

  function checkAnswer() {
    const value = normalize(answerEl.value);
    if (!value) return;

    const available = findAvailableMatch(value);
    if (available) {
      solvePath(available);
      return;
    }

    if (findSolvedMatch(value)) {
      markInvalid('Эта загадка уже решена');
      return;
    }

    if (findLockedMatch(value)) {
      markInvalid('Сначала реши внутренние загадки');
      return;
    }

    score = Math.max(0, score - 5);
    updateScore();
    haptic('error');
    markInvalid('Неверно · −5');
  }

  function finish() {
    const time = stopTimer();
    finished = true;
    const revealed = puzzle.resultText || plainText(tree).replace(/\s+/g, ' ').trim();
    el('finishText').textContent = revealed;
    el('finishScore').textContent = String(score);
    el('finishTime').textContent = formatTime(time);
    completeEl.hidden = false;
    if (tg && tg.MainButton) tg.MainButton.hide();
    haptic('success');
  }

  function themeColor(name, fallback) {
    const value = tg && tg.themeParams ? tg.themeParams[name] : null;
    return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  }

  function initTelegram() {
    if (!tg) return;
    document.body.classList.add('in-telegram');
    tg.ready();
    tg.expand();
    try {
      if (tg.setHeaderColor) tg.setHeaderColor(themeColor('secondary_bg_color', '#D5F0FF'));
      if (tg.setBackgroundColor) tg.setBackgroundColor(themeColor('bg_color', '#D5F0FF'));
    } catch (_) { /* ignore */ }
    if (tg.MainButton) {
      if (typeof tg.MainButton.setParams === 'function') {
        try {
          tg.MainButton.setParams({ color: '#FF87FF', text_color: '#1B1B2A' });
        } catch (_) { /* ignore */ }
      }
      tg.MainButton.setText('Ответить');
      tg.MainButton.enable();
      tg.MainButton.show();
      tg.MainButton.onClick(checkAnswer);
    }
  }

  puzzleEl.addEventListener('click', (event) => {
    const target = event.target.closest('.clue[data-path]');
    if (!target) return;
    activateClue(firstLeaf(target.dataset.path));
  });

  puzzleEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const target = event.target.closest('.clue[data-path]');
    if (!target) return;
    event.preventDefault();
    activateClue(firstLeaf(target.dataset.path));
  });

  toastEl.addEventListener('click', () => {
    if (toastTimer) clearTimeout(toastTimer);
    toastEl.hidden = true;
  });

  el('form').addEventListener('submit', (event) => {
    event.preventDefault();
    checkAnswer();
  });

  hint1El.addEventListener('click', () => useHint(1));
  hint2El.addEventListener('click', () => useHint(2));
  el('again').addEventListener('click', () => location.reload());

  document.addEventListener('visibilitychange', () => {
    if (finished) return;
    if (document.hidden) stopTimer();
    else startTimer();
  });

  requestAnimationFrame(watchExtensions);
  window.addEventListener('resize', renderExtensions);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(renderExtensions).observe(puzzleEl);
  }

  tree = parseBrackets(puzzle.text);
  indexBrackets(tree);
  renderPuzzle();
  updateScore();
  updateProgress();
  initTelegram();
  startTimer();
  updateHint();
  updateComposerState();
})();
