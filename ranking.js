// =====================================================
// たまいれらんぶ · プレイヤー登録 + TOP5 ランキング
// Firebase Firestore でデバイス横断の共通ランキング
// Firestoreが使えない場合は localStorage にフォールバック
// =====================================================
(() => {
  const STORAGE_NAME  = 'sweetsRush.player.v1';
  const STORAGE_RANK  = 'sweetsRush.ranking.v1'; // local cache / offline fallback
  const ANON = 'とくめい';
  const MAX_ENTRIES = 5;

  const firebaseConfig = {
    apiKey: "AIzaSyABYpRSJT-eyYaQlY0R7QytFmi4d4YfsBA",
    authDomain: "tamaire-game.firebaseapp.com",
    projectId: "tamaire-game",
    storageBucket: "tamaire-game.firebasestorage.app",
    messagingSenderId: "795678881439",
    appId: "1:795678881439:web:2ab260ca45a56ddca6d4aa",
    measurementId: "G-KPSGZ26K5C"
  };
  const FIREBASE_VERSION = '11.3.1';

  // ----- DOM refs -----
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

  // Firestore state (lazy-init)
  let firestoreReady = false;
  let docRef = null;
  let _setDoc = null;
  let _getDoc = null;

  // Cached ranks: shown instantly on load, replaced once Firestore returns.
  let cachedRanks = loadLocalRanks();

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
  function loadLocalRanks() {
    try {
      const raw = localStorage.getItem(STORAGE_RANK);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
  function saveLocalRanks(arr) {
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

  // ----- Rendering -----
  function renderRanks(ranks) {
    cachedRanks = Array.isArray(ranks) ? ranks : [];
    listEl.innerHTML = '';
    if (cachedRanks.length === 0) {
      const li = document.createElement('li');
      li.className = 'ranking__empty';
      li.innerHTML = '<span>まだ きろくが ないよ — 1いを めざそう！</span>';
      listEl.appendChild(li);
      return;
    }
    cachedRanks.forEach((r, i) => {
      const li = document.createElement('li');
      li.className = `ranking__item ranking__item--${i + 1}`;
      const date = new Date(r.at || Date.now());
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

  function mergeAndSort(list, entry) {
    const arr = Array.isArray(list) ? list.slice() : [];
    arr.push(entry);
    arr.sort((a, b) => (b.score - a.score) || ((a.at || 0) - (b.at || 0)));
    return arr.slice(0, MAX_ENTRIES);
  }

  async function tryRecord(score) {
    if (score <= 0) return;
    const entry = { name: player, score, at: Date.now() };

    // Try Firestore first (shared across all devices)
    if (firestoreReady && docRef && _getDoc && _setDoc) {
      try {
        const snap = await _getDoc(docRef);
        const existing = (snap.exists() && Array.isArray(snap.data().entries))
          ? snap.data().entries
          : [];
        const trimmed = mergeAndSort(existing, entry);
        await _setDoc(docRef, { entries: trimmed, updatedAt: Date.now() });
        saveLocalRanks(trimmed);
        // onSnapshot will also fire and re-render; we render now for immediate feedback
        renderRanks(trimmed);
        const placed = findPlaced(trimmed, entry);
        afterRecordToast(placed, score);
        return;
      } catch (e) {
        console.warn('[ranking] Firestore write failed, falling back to local', e);
      }
    }

    // Fallback: localStorage only (this device only)
    const trimmed = mergeAndSort(cachedRanks, entry);
    saveLocalRanks(trimmed);
    renderRanks(trimmed);
    const placed = findPlaced(trimmed, entry);
    afterRecordToast(placed, score);
  }

  function findPlaced(list, entry) {
    return list.findIndex(r =>
      r.at === entry.at && r.name === entry.name && r.score === entry.score
    );
  }

  function afterRecordToast(placed, score) {
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
  // MutationObserver で監視し、ゲーム終了（gameEnd イベント / RESET / 再START）で確定する。
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

  startBtn.addEventListener('click', commitSession);
  resetBtn.addEventListener('click', commitSession);
  window.addEventListener('beforeunload', commitSession);
  // ゲーム自動終了（3ミス）でも自動で確定。
  window.addEventListener('sweetsRush:gameEnd', commitSession);

  // ----- Clear -----
  clearBtn.addEventListener('click', async () => {
    if (!confirm('ベスト5 を ぜんぶ けしても いい？')) return;
    if (firestoreReady && docRef && _setDoc) {
      try {
        await _setDoc(docRef, { entries: [], updatedAt: Date.now() });
      } catch (e) {
        console.warn('[ranking] Firestore clear failed', e);
      }
    }
    saveLocalRanks([]);
    renderRanks([]);
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

  // ----- Init: cached local render + Firebase connect -----
  renderRanks(cachedRanks);

  (async () => {
    try {
      const [{ initializeApp }, fs] = await Promise.all([
        import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app.js`),
        import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-firestore.js`)
      ]);

      const app = initializeApp(firebaseConfig);
      const db = fs.getFirestore(app);
      docRef = fs.doc(db, 'rankings', 'global');
      _setDoc = fs.setDoc;
      _getDoc = fs.getDoc;
      firestoreReady = true;

      // Realtime: どこかのデバイスでランキングが更新されたら全員に反映される。
      fs.onSnapshot(docRef, (snap) => {
        if (snap.exists()) {
          const data = snap.data();
          const entries = Array.isArray(data.entries) ? data.entries : [];
          renderRanks(entries);
          saveLocalRanks(entries);
        } else {
          renderRanks([]);
        }
      }, (err) => {
        console.warn('[ranking] Firestore subscribe error, staying local', err);
        firestoreReady = false;
      });

      console.log('[ranking] Firestore connected — shared global ranking active');
    } catch (err) {
      console.warn('[ranking] Firebase load failed, using localStorage only', err);
      // cachedRanks はすでに表示済み。localStorageモードで続行。
    }
  })();
})();
