// =====================================================
// SWEETS RUSH · Player register + TOP5 ranking
// game.js には一切触らず、DOM 監視で連携する
// =====================================================
(() => {
  const STORAGE_RANK = 'sweetsRush.ranking.v1';
  const STORAGE_NAME = 'sweetsRush.player.v1';
  const ANON = 'とくめい';
  const MAX_ENTRIES = 5;

  const scoreEl     = document.getElementById('score');
  const startBtn    = document.getElementById('startBtn');
  const resetBtn    = document.getElementById('resetBtn');
  const form        = document.getElementById('playerForm');
  const input       = document.getElementById('playerInput');
  const currentEl   = document.getElementById('playerCurrent');
  const listEl      = document.getElementById('rankingList');
  const clearBtn    = document.getElementById('clearRankBtn');
  const toast       = document.getElementById('toast');

  let player = loadPlayer();
  let lastSubmittedScore = -1;
  let sessionPeak = 0;
  let pendingSubmit = false;

  // ----- Storage helpers -----
  function loadPlayer() {
    try {
      const v = localStorage.getItem(STORAGE_NAME);
      return (v && v.trim()) ? v : ANON;
    } catch { return ANON; }
  }
  function savePlayer(name) {
    try { localStorage.setItem(STORAGE_NAME, name); } catch {}
  }
  function loadRanks() {
    try {
      const raw = localStorage.getItem(STORAGE_RANK);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
  function saveRanks(arr) {
    try { localStorage.setItem(STORAGE_RANK, JSON.stringify(arr)); } catch {}
  }

  // ----- Player register -----
  function setPlayer(raw) {
    const trimmed = (raw || '').trim().slice(0, 12);
    player = trimmed || ANON;
    savePlayer(player);
    currentEl.textContent = player;
    showToast(`ちょうせんしゃ: ${player}`, 'ok');
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    setPlayer(input.value);
    input.value = '';
    input.blur();
  });

  currentEl.textContent = player;

  // ----- Ranking -----
  function renderRanks() {
    const ranks = loadRanks();
    listEl.innerHTML = '';
    if (ranks.length === 0) {
      const li = document.createElement('li');
      li.className = 'ranking__empty';
      li.innerHTML = '<span>まだ きろくが ないよ — 1いを めざそう！</span>';
      listEl.appendChild(li);
      return;
    }
    ranks.forEach((r, i) => {
      const li = document.createElement('li');
      li.className = `ranking__item ranking__item--${i + 1}`;
      const date = new Date(r.at);
      const dateStr = `${date.getMonth() + 1}/${date.getDate()} ${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}`;
      const medal = ['🥇','🥈','🥉','🏅','🏅'][i] || '🏅';
      li.innerHTML = `
        <span class="ranking__rank">${medal}<b>#${i + 1}</b></span>
        <span class="ranking__name">${escapeHtml(r.name || ANON)}</span>
        <span class="ranking__score">${r.score}<i>てん</i></span>
        <span class="ranking__date">${dateStr}</span>
      `;
      listEl.appendChild(li);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[c]));
  }

  function tryRecord(score) {
    if (score <= 0) return;
    const ranks = loadRanks();
    const entry = { name: player, score, at: Date.now() };
    ranks.push(entry);
    ranks.sort((a, b) => b.score - a.score || a.at - b.at);
    const trimmed = ranks.slice(0, MAX_ENTRIES);
    const placed = trimmed.findIndex(r => r === entry);
    saveRanks(trimmed);
    renderRanks();
    if (placed >= 0) {
      flashRow(placed);
      showToast(`🎉 ${player} が ${placed + 1}いに はいったよ！ (${score}てん)`, 'win');
    } else {
      showToast(`きろく: ${score}てん — ベスト5には はいれなかったよ`, 'info');
    }
  }

  function flashRow(index) {
    const row = listEl.querySelectorAll('.ranking__item')[index];
    if (!row) return;
    row.classList.add('is-new');
    setTimeout(() => row.classList.remove('is-new'), 2400);
  }

  // ----- Score watcher -----
  // game.js は state.score を更新するたびに #score の textContent を書き換えるので
  // MutationObserver で監視し、START 後にゲームが終わる（RESET / 再START）タイミングで保存する。
  const obs = new MutationObserver(() => {
    const s = parseInt(scoreEl.textContent, 10) || 0;
    if (s > sessionPeak) sessionPeak = s;
    if (s > 0) pendingSubmit = true;
  });
  obs.observe(scoreEl, { childList: true, characterData: true, subtree: true });

  function commitSession() {
    // ランキングに のこすのは ランキングモードの スコアだけ。
    const isRanking = window.sweetsRushMode === 'ranking';
    if (isRanking && pendingSubmit && sessionPeak !== lastSubmittedScore) {
      lastSubmittedScore = sessionPeak;
      tryRecord(sessionPeak);
    }
    sessionPeak = 0;
    pendingSubmit = false;
  }

  startBtn.addEventListener('click', () => {
    // 既にプレイ中の得点があれば、再スタート前に確定する
    commitSession();
  });
  resetBtn.addEventListener('click', () => {
    commitSession();
  });
  window.addEventListener('beforeunload', commitSession);
  // ランキングモードで 3かい はずして ゲームオーバーに なったとき、
  // スタート / リセットを おさなくても じどうで きろくする。
  window.addEventListener('sweetsRush:gameEnd', commitSession);

  // ----- Clear -----
  clearBtn.addEventListener('click', () => {
    if (!confirm('ベスト5 を ぜんぶ けしても いい？')) return;
    saveRanks([]);
    renderRanks();
    showToast('ランキングを けしたよ', 'info');
  });

  // ----- Toast -----
  let toastTimer = null;
  function showToast(msg, kind = 'info') {
    toast.textContent = msg;
    toast.className = `toast is-show toast--${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.className = 'toast';
    }, 2600);
  }

  // ----- Init -----
  renderRanks();
})();
