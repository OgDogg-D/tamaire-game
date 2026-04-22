(() => {
  const canvas = document.getElementById('gameCanvas');
  let ctx = canvas.getContext('2d');
  const mainCtx = ctx;
  const scoreEl = document.getElementById('score');
  const shotsEl = document.getElementById('shots');
  const accuracyEl = document.getElementById('accuracy');
  const startBtn = document.getElementById('startBtn');
  const resetBtn = document.getElementById('resetBtn');

  const W = canvas.width;
  const H = canvas.height;

  const CAM_Y = 180;
  const FOCAL = 520;
  const HORIZON_Y = H * 0.58;

  function project(x, y, z) {
    const d = -z;
    if (d <= 1) return { x: 0, y: 0, scale: 0, visible: false };
    const scale = FOCAL / d;
    return {
      x: W / 2 + x * scale,
      y: HORIZON_Y - (y - CAM_Y) * scale,
      scale,
      visible: true,
    };
  }

  const state = {
    running: false,
    score: 0,
    shots: 0,
    hits: 0,
    beanbag: null,
    holding: null,
    particles: [],
    flash: 0,
    time: 0,
    celebrate: 0,      // frames remaining for celebration
    celebrateBursts: [], // {x, y, t0, color}
    winText: 0,
    slowmo: 0,         // frames of slow-motion remaining
    shockwave: 0,      // frames of radial shockwave animation
    shockX: 0, shockY: 0,
    ballType: 'beanbag',  // 'beanbag' | 'fruit' | 'poop_boy' | 'poop_girl'
    mode: 'free',         // 'free' (unlimited) | 'ranking' (3-miss game)
    maxMisses: 3,         // only enforced in ranking mode
    misses: 0,
    gameOver: 0,          // frames remaining for game-over overlay
    difficulty: 'medium', // 'easy' | 'medium' | 'hard' — scales hit-zone
  };
  window.sweetsRushMode = state.mode;

  // Hit-zone scale applied to the box's projected front face.
  // Tightened overall so every difficulty is noticeably harder than before.
  const DIFFICULTY_HITZONE = { easy: 1.2, medium: 0.82, hard: 0.55 };
  function hitZoneScale() {
    return DIFFICULTY_HITZONE[state.difficulty] || 0.82;
  }

  // Depth tolerance in front of the box face (world-z units).
  // Ball must arrive very close to the front plane to count.
  // Tightened per difficulty so depth judgement also matters.
  const DIFFICULTY_Z_FRONT = { easy: 18, medium: 10, hard: 5 };
  // How far past the front face the ball may be and still score.
  const DIFFICULTY_Z_BACK  = { easy: 36, medium: 22, hard: 12 };

  // Physical size of the catch box per difficulty.
  // easy = large, medium = standard, hard = small.
  const DIFFICULTY_BOX_SIZE = { easy: 195, medium: 150, hard: 110 };

  const FRUIT_EMOJI = ['🍎','🍊','🍇','🍓','🍑','🍋','🍉','🍍'];

  // Box orbits in a VERTICAL circle in front of the player.
  // The OPEN FACE of the box faces the player (front is open at z = box.z).
  const box = {
    centerX: 0,
    centerY: 260,
    z: -820,
    orbitR: 200,
    angle: Math.PI,
    omega: 0.010,
    size: 150,
  };

  function currentBoxPos() {
    return {
      x: box.centerX + Math.cos(box.angle) * box.orbitR,
      y: box.centerY + Math.sin(box.angle) * box.orbitR,
      z: box.z,
    };
  }

  // --- Input ---
  function getPointerPos(e) {
    const rect = canvas.getBoundingClientRect();
    const sx = W / rect.width;
    const sy = H / rect.height;
    const p = e.touches ? e.touches[0] : e;
    return { x: (p.clientX - rect.left) * sx, y: (p.clientY - rect.top) * sy };
  }

  function onDown(e) {
    if (!state.running || state.beanbag) return;
    e.preventDefault();
    const p = getPointerPos(e);
    if (p.y < H * 0.6) return;
    state.holding = {
      startX: p.x, startY: p.y,
      curX: p.x, curY: p.y,
      samples: [{ x: p.x, y: p.y, t: performance.now() }],
    };
  }
  function onMove(e) {
    if (!state.holding) return;
    e.preventDefault();
    const p = getPointerPos(e);
    const t = performance.now();
    state.holding.curX = p.x;
    state.holding.curY = p.y;
    state.holding.samples.push({ x: p.x, y: p.y, t });
    // keep last 200ms
    const cut = t - 200;
    while (state.holding.samples.length > 2 && state.holding.samples[0].t < cut) {
      state.holding.samples.shift();
    }
  }
  function onUp(e) {
    if (!state.holding) return;
    e.preventDefault();
    const h = state.holding;
    state.holding = null;
    const samples = h.samples;
    if (samples.length < 2) return;
    // Use the most recent window of samples to compute swipe VELOCITY (px/ms)
    const last = samples[samples.length - 1];
    // find sample ~80-120ms before last
    let first = samples[0];
    for (let i = samples.length - 1; i >= 0; i--) {
      if (last.t - samples[i].t >= 80) { first = samples[i]; break; }
    }
    let dt = last.t - first.t;
    if (dt < 16) dt = 16;
    const vxPx = (last.x - first.x) / dt;       // +right
    const vyPx = (first.y - last.y) / dt;       // +up
    if (vyPx < 0.25) return;                    // too slow to be a throw
    launchBeanbag(vxPx, vyPx);
  }

  canvas.addEventListener('mousedown', onDown);
  canvas.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  canvas.addEventListener('touchstart', onDown, { passive: false });
  canvas.addEventListener('touchmove', onMove, { passive: false });
  canvas.addEventListener('touchend', onUp, { passive: false });

  // --- Throw physics ---
  // Swipe velocity (px/ms) maps directly to world velocity components.
  // Tuned so a ~1.0 px/ms upward flick reaches the box depth.
  const K_FWD  = 4.6;   // upward swipe speed → forward (-z) world speed
  const K_UP   = 3.1;   // upward swipe speed → world +y (lofting)
  const K_SIDE = 3.6;   // horizontal swipe speed → world x  (aim)
  const GRAVITY = 0.11;

  function launchBeanbag(svx, svy) {
    // cap the extreme flicks so you can't overshoot absurdly
    const vMag = Math.hypot(svx, svy);
    const cap = 2.2;
    const k = vMag > cap ? cap / vMag : 1;
    const sx = svx * k, sy = svy * k;

    // choose the visual for this specific throw based on selected ball type
    const kind = state.ballType;
    const fruit = kind === 'fruit'
      ? FRUIT_EMOJI[Math.floor(Math.random() * FRUIT_EMOJI.length)]
      : null;

    state.beanbag = {
      x: 0, y: CAM_Y - 10, z: -60,
      px: 0, py: CAM_Y - 10, pz: -60,
      vx: sx * K_SIDE,
      vy: sy * K_UP,
      vz: -sy * K_FWD,
      scored: false,
      entering: false,
      lifeInside: 0,
      trail: [],
      kind,
      fruit,
      spin: Math.random() * Math.PI * 2,
    };
    state.shots++;
    updateHUD();
  }

  function stepBeanbag() {
    const b = state.beanbag;
    if (!b) return;
    b.px = b.x; b.py = b.y; b.pz = b.z;
    b.vy -= GRAVITY;
    b.x += b.vx; b.y += b.vy; b.z += b.vz;
    b.spin = (b.spin || 0) + 0.18;

    b.trail.push({ x: b.x, y: b.y, z: b.z });
    if (b.trail.length > 16) b.trail.shift();

    const bp = currentBoxPos();
    const half = box.size / 2;

    // Hit zone: the front-facing square of the box as seen from the thrower.
    // Test in SCREEN SPACE — if the ball's projected position falls inside the
    // projected front-face rectangle AND the ball's z is within a narrow
    // window around the front plane, count it as a hit.
    const zFront = DIFFICULTY_Z_FRONT[state.difficulty] || 10;
    const zBack  = DIFFICULTY_Z_BACK[state.difficulty]  || 22;
    if (!b.scored && b.z <= bp.z + zFront && b.z >= bp.z - zBack) {
      const bproj = project(b.x, b.y, b.z);
      const cx    = project(bp.x, bp.y, bp.z);
      const cR    = project(bp.x + half, bp.y, bp.z);
      const cT    = project(bp.x, bp.y + half, bp.z);
      if (bproj.visible && cx.visible) {
        const hz = hitZoneScale();
        const halfPxX = Math.abs(cR.x - cx.x) * hz;
        const halfPxY = Math.abs(cT.y - cx.y) * hz;
        const inside =
          bproj.x >= cx.x - halfPxX && bproj.x <= cx.x + halfPxX &&
          bproj.y >= cx.y - halfPxY && bproj.y <= cx.y + halfPxY;
        if (inside) {
          // Map the ball's screen-space offset back to world coords on the
          // front-face plane, so scoring can grade center vs. edge.
          const hx = bp.x + ((bproj.x - cx.x) / halfPxX) * half;
          const hy = bp.y - ((bproj.y - cx.y) / halfPxY) * half;
          b.scored = true;
          b.entering = true;
          scoreHit(hx, hy, bp.z);
        }
      }
    }

    // Inside the box: let it travel for a few frames then despawn
    if (b.entering) {
      b.lifeInside++;
      if (b.lifeInside > 30 || b.z < bp.z - box.size) {
        state.beanbag = null;
      }
      return;
    }

    if (b.y < -30 || b.z < -2000 || Math.abs(b.x) > 2200) {
      if (!b.scored) registerMiss();
      state.beanbag = null;
    }
  }

  function registerMiss() {
    if (!state.running) return;
    if (state.mode !== 'ranking') return; // free mode = unlimited
    state.misses++;
    updateHUD();
    if (state.misses >= state.maxMisses) endGame();
  }

  function endGame() {
    state.running = false;
    state.gameOver = 1;
    state.holding = null;
  }

  function scoreHit(hx, hy, hz) {
    const bp = currentBoxPos();
    const dxc = (hx - bp.x) / (box.size / 2);
    const dyc = (hy - bp.y) / (box.size / 2);
    const r = Math.hypot(dxc, dyc);
    const bonus = r < 0.3 ? 5 : r < 0.6 ? 3 : 1;
    state.score += bonus;
    state.hits++;
    state.flash = 42;
    spawnConfetti(hx, hy, hz);
    triggerCelebration(hx, hy, hz);
    updateHUD();
  }

  // --- Celebration: slow-mo + sky fireworks on success ---
  function triggerCelebration(hx, hy, hz) {
    state.celebrate = 220;
    state.winText = 110;
    state.slowmo = 55;           // ~0.9s of slow-motion at 60fps
    state.shockwave = 30;
    // screen-space shock origin
    const hp = project(hx || 0, hy || 0, hz || -820);
    state.shockX = hp.visible ? hp.x : W / 2;
    state.shockY = hp.visible ? hp.y : H / 2;

    const t0 = state.time;
    const count = 16;            // more fireworks, bigger, denser
    for (let i = 0; i < count; i++) {
      state.celebrateBursts.push({
        x: 40 + Math.random() * (W - 80),
        y: 40 + Math.random() * (HORIZON_Y * 0.55),
        t0: t0 + i * 5,
        color: `hsl(${warmHue(Math.floor(Math.random() * 360))},98%,68%)`,
        dur: 70 + Math.random() * 35,
        size: 160 + Math.random() * 120,
        rays: 20 + Math.floor(Math.random() * 14),
      });
    }
    // extra ring bursts clustered near the hit point
    for (let i = 0; i < 4; i++) {
      state.celebrateBursts.push({
        x: state.shockX + (Math.random() - 0.5) * 240,
        y: state.shockY + (Math.random() - 0.5) * 180,
        t0: t0 + i * 3,
        color: i % 2 ? '#ffe14d' : '#ff3b82',
        dur: 60 + Math.random() * 20,
        size: 220 + Math.random() * 80,
        rays: 28,
      });
    }
  }

  function spawnConfetti(x, y, z) {
    for (let i = 0; i < 50; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 3 + Math.random() * 7;
      state.particles.push({
        x, y, z,
        vx: Math.cos(a) * s,
        vy: 6 + Math.random() * 8,
        vz: Math.sin(a) * s * 0.4,
        life: 60 + Math.random() * 30,
        color: `hsl(${warmHue(Math.floor(Math.random() * 360))},95%,66%)`,
      });
    }
  }

  function stepParticles() {
    for (const p of state.particles) {
      p.vy -= 0.45;
      p.x += p.vx; p.y += p.vy; p.z += p.vz;
      p.life--;
    }
    state.particles = state.particles.filter(p => p.life > 0 && p.y > -100);
  }

  // ---------- Background (festival) ----------
  function drawSky() {
    // Fixed bright pastel sky — no hue cycling, no dark gradient.
    ctx.fillStyle = '#fff4fb';
    ctx.fillRect(0, 0, W, HORIZON_Y + 40);

    // Soft pink twinkle dots (static positions, gentle twinkle opacity)
    for (let i = 0; i < 40; i++) {
      const sx = (i * 97) % W;
      const sy = ((i * 53) % (HORIZON_Y * 0.6)) + 4;
      const tw = 0.15 + 0.25 * Math.abs(Math.sin(state.time * 0.05 + i));
      ctx.fillStyle = `rgba(255,158,207,${tw})`;
      ctx.fillRect(sx, sy, 2, 2);
    }

    // Ambient background fireworks — kept for festive motion, fixed palette
    drawFireworkBurst(W * 0.22, HORIZON_Y * 0.35, '#ff9ecf', (state.time * 0.6) % 180, 180, 70);
    drawFireworkBurst(W * 0.78, HORIZON_Y * 0.28, '#ffd36a', (state.time * 0.6 + 90) % 180, 180, 70);
    drawFireworkBurst(W * 0.5, HORIZON_Y * 0.18, '#ff8a3d', (state.time * 0.6 + 140) % 180, 180, 70);

    // Celebration fireworks (on top, bigger)
    for (const b of state.celebrateBursts) {
      const age = state.time - b.t0;
      if (age < 0 || age > b.dur) continue;
      drawFireworkBurst(b.x, b.y, b.color, age, b.dur, b.size || 140, b.rays || 18);
    }
    state.celebrateBursts = state.celebrateBursts.filter(b => state.time - b.t0 < b.dur);
  }

  function drawFireworkBurst(cx, cy, color, t, dur, maxR, rays) {
    const life = t / dur;
    const r = life * maxR;
    ctx.save();
    ctx.globalAlpha = Math.max(0, 1 - life);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    rays = rays || 18;
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r * 0.45, cy + Math.sin(a) * r * 0.45);
      ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      ctx.stroke();
    }
    // center flash
    ctx.fillStyle = color;
    ctx.globalAlpha = Math.max(0, 0.7 - life);
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(1, 6 * (1 - life)), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawGround() {
    // Fixed light pastel floor — no dark brown gradient.
    ctx.fillStyle = '#ffe2d4';
    ctx.fillRect(0, HORIZON_Y, W, H - HORIZON_Y);

    ctx.strokeStyle = 'rgba(200, 140, 180, 0.35)';
    ctx.lineWidth = 1;
    for (let z = -100; z >= -1800; z -= 80) {
      const a = project(-1000, 0, z);
      const b = project(1000, 0, z);
      if (a.visible && b.visible) {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
  }

  // Map any hue (0-360) into the warm pink → orange → yellow range.
  function warmHue(h) { return (((h % 100) + 320) % 360); }

  function drawCanopy() {
    const stripeW = 60;
    const yBot = 70;
    for (let i = 0; i * stripeW < W + stripeW; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#ff6fa8' : '#ffffff';
      ctx.fillRect(i * stripeW, 0, stripeW, yBot);
    }
    ctx.fillStyle = '#ff8a6f';
    for (let x = 0; x < W + 30; x += 30) {
      ctx.beginPath();
      ctx.arc(x, yBot, 15, 0, Math.PI);
      ctx.fill();
    }
    ctx.fillStyle = '#ffc46a';
    ctx.fillRect(0, yBot + 14, W, 4);
  }

  function drawLanterns() {
    const lanternY = 110;
    const count = 5;
    for (let i = 0; i < count; i++) {
      const cx = ((i + 0.5) / count) * W;
      const bob = Math.sin(state.time * 0.03 + i) * 4;
      ctx.strokeStyle = 'rgba(200, 120, 140, 0.55)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx, 74);
      ctx.lineTo(cx, lanternY - 22 + bob);
      ctx.stroke();

      const ly = lanternY + bob;
      const glow = ctx.createRadialGradient(cx, ly, 4, cx, ly, 55);
      glow.addColorStop(0, 'rgba(255,235,150,0.75)');
      glow.addColorStop(1, 'rgba(255,235,150,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(cx - 55, ly - 55, 110, 110);
      ctx.fillStyle = '#ff8a6f';
      ctx.beginPath();
      ctx.ellipse(cx, ly, 22, 28, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffc46a';
      ctx.fillRect(cx - 16, ly - 30, 32, 4);
      ctx.fillRect(cx - 16, ly + 26, 32, 4);
      ctx.fillStyle = '#fff';
      ctx.font = 'bold 20px serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('祭', cx, ly + 1);
    }
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  function drawBunting() {
    const y = 128;
    const span = 40;
    const colors = ['#ffe14d', '#ffb88a', '#ff6b9d', '#ffd36a', '#ff8a3d', '#ff9ecf'];
    for (let i = 0; i * span < W; i++) {
      const x = i * span;
      const sag = Math.sin(i * 0.8) * 3;
      ctx.fillStyle = colors[i % colors.length];
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + span, y);
      ctx.lineTo(x + span / 2, y + 22 + sag);
      ctx.closePath();
      ctx.fill();
    }
  }

  // ---------- Candy shelves + excited kids silhouettes ----------
  function drawCandyShelf(sx, sy, sw, sh, tierCount) {
    // creamy pastel shelf unit (no dark wood)
    ctx.fillStyle = '#ffe4cc';
    ctx.fillRect(sx, sy, sw, sh);
    // back inner wall (warmer)
    ctx.fillStyle = 'rgba(255, 210, 140, 0.35)';
    ctx.fillRect(sx + 4, sy + 4, sw - 8, sh - 8);
    // side pillars
    ctx.fillStyle = '#ffb88a';
    ctx.fillRect(sx, sy, 5, sh);
    ctx.fillRect(sx + sw - 5, sy, 5, sh);
    // top trim (pink)
    ctx.fillStyle = '#ff6fa8';
    ctx.fillRect(sx, sy - 6, sw, 7);
    ctx.fillStyle = '#ffd24a';
    ctx.fillRect(sx, sy - 7, sw, 2);

    const tierH = (sh - 8) / tierCount;
    for (let t = 0; t < tierCount; t++) {
      const ty = sy + 4 + t * tierH;
      // shelf board
      ctx.fillStyle = '#ffc890';
      ctx.fillRect(sx + 4, ty + tierH - 6, sw - 8, 6);
      ctx.fillStyle = 'rgba(200, 120, 80, 0.28)';
      ctx.fillRect(sx + 4, ty + tierH - 2, sw - 8, 2);
      // price tag
      ctx.fillStyle = '#ffe14d';
      const tagW = 28, tagH = 14;
      const tagX = sx + 8 + ((t * 37) % (sw - 40));
      const tagY = ty + tierH - 22;
      ctx.fillRect(tagX, tagY, tagW, tagH);
      ctx.strokeStyle = '#ff6fa8';
      ctx.lineWidth = 1;
      ctx.strokeRect(tagX, tagY, tagW, tagH);
      ctx.fillStyle = '#ff4f8a';
      ctx.font = 'bold 9px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('¥' + (100 + t * 50), tagX + tagW / 2, tagY + tagH / 2 + 1);

      // stacked candies on this tier
      drawCandyRow(sx + 10, ty + 2, sw - 20, tierH - 10, t);
    }
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  function drawCandyRow(rx, ry, rw, rh, tierIdx) {
    // deterministic pseudo-random so candies don't flicker every frame
    const seed = tierIdx * 131 + Math.floor(rx);
    function rnd(i) {
      const v = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
      return v - Math.floor(v);
    }
    const types = ['lolly', 'wrap', 'jar', 'bar', 'donut', 'cupcake'];
    const itemW = 38;
    const count = Math.floor(rw / itemW);
    for (let i = 0; i < count; i++) {
      const cx = rx + i * itemW + itemW / 2;
      const cy = ry + rh - 6;
      const type = types[Math.floor(rnd(i) * types.length)];
      const hue = Math.floor(rnd(i + 11) * 360);
      drawCandyItem(cx, cy, type, hue, rnd(i + 23));
    }
  }

  function drawCandyItem(cx, cy, type, hue, r) {
    const wh = warmHue(hue);
    ctx.save();
    ctx.translate(cx, cy);
    if (type === 'lolly') {
      // stick
      ctx.fillStyle = '#f5efe2';
      ctx.fillRect(-1.5, -8, 3, 22);
      // disk with swirl
      ctx.fillStyle = `hsl(${wh},90%,72%)`;
      ctx.beginPath(); ctx.arc(0, -14, 13, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let a = 0; a < Math.PI * 2; a += 0.25) {
        const rr = 3 + a * 1.6;
        const x = Math.cos(a) * rr, y = -14 + Math.sin(a) * rr;
        if (a === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.strokeStyle = 'rgba(200, 120, 140, 0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(0, -14, 13, 0, Math.PI * 2); ctx.stroke();
    } else if (type === 'wrap') {
      // wrapped candy (twisted ends)
      ctx.fillStyle = `hsl(${wh},92%,74%)`;
      ctx.beginPath();
      ctx.ellipse(0, -8, 12, 8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(200, 120, 140, 0.35)';
      ctx.stroke();
      ctx.fillStyle = `hsl(${wh},92%,82%)`;
      ctx.beginPath(); ctx.moveTo(-12, -8); ctx.lineTo(-20, -12); ctx.lineTo(-20, -4); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo( 12, -8); ctx.lineTo( 20, -12); ctx.lineTo( 20, -4); ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.beginPath(); ctx.ellipse(-3, -10, 4, 2, 0, 0, Math.PI * 2); ctx.fill();
    } else if (type === 'jar') {
      // glass jar with gumballs
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillRect(-11, -24, 22, 26);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(-11, -24, 22, 26);
      // lid
      ctx.fillStyle = '#ff6fa8';
      ctx.fillRect(-12, -27, 24, 5);
      // gumballs (all warm)
      for (let k = 0; k < 5; k++) {
        ctx.fillStyle = `hsl(${warmHue(hue + k * 22)},92%,68%)`;
        const gx = -7 + (k % 3) * 7;
        const gy = -20 + Math.floor(k / 3) * 7;
        ctx.beginPath(); ctx.arc(gx, gy, 3.2, 0, Math.PI * 2); ctx.fill();
      }
    } else if (type === 'bar') {
      // candy bar — peach body, not chocolate
      ctx.fillStyle = '#ffb88a';
      ctx.fillRect(-14, -18, 28, 18);
      ctx.fillStyle = '#ffd6a8';
      ctx.fillRect(-14, -18, 28, 4);
      // wrapper label
      ctx.fillStyle = `hsl(${wh},88%,70%)`;
      ctx.fillRect(-12, -13, 24, 8);
      ctx.strokeStyle = '#fff';
      ctx.strokeRect(-12, -13, 24, 8);
    } else if (type === 'donut') {
      // dough: peachy
      ctx.fillStyle = '#ffc890';
      ctx.beginPath(); ctx.arc(0, -10, 11, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = `hsl(${wh},88%,78%)`;
      ctx.beginPath(); ctx.arc(0, -10, 10, 0, Math.PI * 2); ctx.fill();
      // hole (light peach, not black)
      ctx.fillStyle = '#ffe2c4';
      ctx.beginPath(); ctx.arc(0, -10, 3.5, 0, Math.PI * 2); ctx.fill();
      // sprinkles (all warm)
      for (let k = 0; k < 6; k++) {
        ctx.fillStyle = `hsl(${warmHue(hue + k * 18)},95%,68%)`;
        const a = k * 1.1;
        ctx.fillRect(Math.cos(a) * 6 - 1, -10 + Math.sin(a) * 6 - 1, 2.5, 2.5);
      }
    } else {
      // cupcake — peachy liner instead of dark brown
      ctx.fillStyle = '#ffb88a';
      ctx.beginPath();
      ctx.moveTo(-11, -2); ctx.lineTo(11, -2); ctx.lineTo(8, -14); ctx.lineTo(-8, -14); ctx.closePath();
      ctx.fill();
      // liner stripes
      ctx.strokeStyle = 'rgba(200, 120, 80, 0.35)';
      ctx.beginPath();
      for (let k = -9; k <= 9; k += 4) { ctx.moveTo(k, -2); ctx.lineTo(k - 1, -14); }
      ctx.stroke();
      // frosting swirl (warm only)
      ctx.fillStyle = `hsl(${wh},90%,82%)`;
      ctx.beginPath(); ctx.arc(0, -18, 10, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(-4, -23, 5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(4, -23, 5, 0, Math.PI * 2); ctx.fill();
      // cherry — keep as a pink accent
      ctx.fillStyle = '#ff4f8a';
      ctx.beginPath(); ctx.arc(0, -28, 3, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  function drawExcitedKid(cx, baseY, flip, bob, skin, shirt) {
    ctx.save();
    ctx.translate(cx, baseY);
    if (flip) ctx.scale(-1, 1);
    const by = Math.sin(bob) * 2;

    // body
    ctx.fillStyle = shirt;
    ctx.beginPath();
    ctx.moveTo(-12, 0); ctx.lineTo(12, 0);
    ctx.lineTo(10, -24); ctx.lineTo(-10, -24); ctx.closePath();
    ctx.fill();
    // arms raised (excited!)
    ctx.strokeStyle = skin;
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-8, -20); ctx.lineTo(-16, -38 + by);
    ctx.moveTo( 8, -20); ctx.lineTo( 16, -40 + by);
    ctx.stroke();
    // head
    ctx.fillStyle = skin;
    ctx.beginPath(); ctx.arc(0, -32 + by, 9, 0, Math.PI * 2); ctx.fill();
    // hair (warm brown, not near-black)
    ctx.fillStyle = '#c4784a';
    ctx.beginPath();
    ctx.arc(0, -36 + by, 9, Math.PI, Math.PI * 2);
    ctx.fill();
    // eyes (sparkle)
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(-3, -32 + by, 1.6, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc( 3, -32 + by, 1.6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#8a4868';
    ctx.beginPath(); ctx.arc(-3, -31.5 + by, 1, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc( 3, -31.5 + by, 1, 0, Math.PI * 2); ctx.fill();
    // open smile
    ctx.fillStyle = '#8a4868';
    ctx.beginPath();
    ctx.ellipse(0, -27 + by, 3, 2, 0, 0, Math.PI * 2);
    ctx.fill();
    // blush
    ctx.fillStyle = 'rgba(255, 105, 160, 0.55)';
    ctx.beginPath(); ctx.arc(-5, -29 + by, 2, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc( 5, -29 + by, 2, 0, Math.PI * 2); ctx.fill();

    ctx.restore();
  }

  function drawBackWall() {
    // bright pastel wall behind the rotating box — fixed colors, no gradient cycle.
    ctx.fillStyle = '#fde3f2';
    ctx.fillRect(0, HORIZON_Y - 160, W, 150);

    // 2) a big candy shelf spanning the back wall, split in two units
    const shelfY = HORIZON_Y - 150;
    const shelfH = 130;
    drawCandyShelf(20,       shelfY, W * 0.46 - 30, shelfH, 3);
    drawCandyShelf(W * 0.54 + 10, shelfY, W * 0.46 - 30, shelfH, 3);

    // 3) storefront pink & gold signboard between shelves, above the rotating box
    const signX = W * 0.18, signY = HORIZON_Y - 168, signW = W * 0.64, signH = 30;
    ctx.fillStyle = '#ff8a6f';
    ctx.fillRect(signX - 4, signY - 2, signW + 8, signH + 4);
    const sg = ctx.createLinearGradient(signX, signY, signX, signY + signH);
    sg.addColorStop(0, '#ffd24a');
    sg.addColorStop(1, '#ff6fa8');
    ctx.fillStyle = sg;
    ctx.fillRect(signX, signY, signW, signH);
    ctx.strokeStyle = '#ff4f8a';
    ctx.lineWidth = 2;
    ctx.strokeRect(signX, signY, signW, signH);
    ctx.fillStyle = '#a14a66';
    ctx.font = 'bold 18px "Rampart One", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('🎯  お か し  き ゃ っ ち !  🎯', W / 2, signY + signH / 2 + 1);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';

    // 4) excited kids peeking in front of the shelves (silhouette-like)
    const groundY = HORIZON_Y - 12;
    const bob = state.time * 0.08;
    drawExcitedKid(90,  groundY, false, bob,        '#f0c9a0', '#ff8a6f');
    drawExcitedKid(180, groundY, true,  bob + 1.2,  '#f0c9a0', '#ff6fa8');
    drawExcitedKid(W - 180, groundY, false, bob + 2.4, '#f0c9a0', '#ffe14d');
    drawExcitedKid(W - 90,  groundY, true,  bob + 0.6, '#f0c9a0', '#ffc46a');
  }

  function drawBooth() {
    const topY = H - 110;
    // Light wooden counter — fixed pastel color, no gradient cycle.
    ctx.fillStyle = '#ffd6b8';
    ctx.fillRect(0, topY, W, H - topY);
    ctx.fillStyle = '#ffb88a';
    ctx.fillRect(0, topY, W, 8);
    ctx.strokeStyle = 'rgba(180, 120, 80, 0.35)';
    for (let x = 60; x < W; x += 90) {
      ctx.beginPath();
      ctx.moveTo(x, topY + 8);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
  }

  // ---------- Target box (open front facing player) ----------
  function drawBox() {
    const bp = currentBoxPos();
    const s = box.size;
    const h = s / 2;
    const backZ = bp.z - s;

    const F = {
      tl: project(bp.x - h, bp.y + h, bp.z),
      tr: project(bp.x + h, bp.y + h, bp.z),
      br: project(bp.x + h, bp.y - h, bp.z),
      bl: project(bp.x - h, bp.y - h, bp.z),
    };
    const B = {
      tl: project(bp.x - h, bp.y + h, backZ),
      tr: project(bp.x + h, bp.y + h, backZ),
      br: project(bp.x + h, bp.y - h, backZ),
      bl: project(bp.x - h, bp.y - h, backZ),
    };

    // ground shadow
    const sh = project(bp.x, 0, bp.z);
    if (sh.visible) {
      ctx.save();
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(sh.x, sh.y + 3, s * 0.9 * sh.scale, s * 0.3 * sh.scale, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    function fillQuad(a, b, c, d, fill, stroke) {
      ctx.beginPath();
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.lineTo(c.x, c.y); ctx.lineTo(d.x, d.y);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // 1) Back interior wall (far) — this is where the ? mark goes
    fillQuad(B.tl, B.tr, B.br, B.bl, '#b8860b', 'rgba(80,40,0,0.7)');

    // ? mark on back wall (inside the box, visible through the opening)
    const cxS = (B.tl.x + B.br.x) / 2;
    const cyS = (B.tl.y + B.br.y) / 2;
    const faceH = Math.abs(B.tl.y - B.bl.y);
    const fs = Math.max(14, faceH * 0.7);
    ctx.save();
    ctx.font = `900 ${fs}px "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(3, fs * 0.12);
    ctx.strokeStyle = '#4a1400';
    ctx.strokeText('?', cxS, cyS + Math.sin(state.time * 0.1) * 2);
    ctx.fillStyle = '#d72631';
    ctx.fillText('?', cxS, cyS + Math.sin(state.time * 0.1) * 2);
    ctx.restore();

    // 2) Interior side walls (trapezoids from back edges out to front opening edges)
    //    Drawn darker to suggest inside depth.
    fillQuad(B.tl, B.tr, F.tr, F.tl, '#8a6500');  // ceiling
    fillQuad(B.bl, B.br, F.br, F.bl, '#6b4d00');  // floor
    fillQuad(B.tl, B.bl, F.bl, F.tl, '#9f7a1a');  // left wall
    fillQuad(B.tr, B.br, F.br, F.tr, '#9f7a1a');  // right wall

    // 3) Outer rim around the opening (yellow thick frame)
    const pad = 0.12;
    const rimOuter = [F.tl, F.tr, F.br, F.bl];
    // Inner rim — slightly inset toward face center
    const cxF = (F.tl.x + F.br.x) / 2;
    const cyF = (F.tl.y + F.br.y) / 2;
    const rimInner = rimOuter.map(p => ({
      x: cxF + (p.x - cxF) * (1 - pad),
      y: cyF + (p.y - cyF) * (1 - pad),
    }));
    ctx.fillStyle = '#ffd84d';
    ctx.beginPath();
    ctx.moveTo(rimOuter[0].x, rimOuter[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(rimOuter[i].x, rimOuter[i].y);
    ctx.lineTo(rimInner[0].x, rimInner[0].y);
    for (let i = 3; i >= 0; i--) ctx.lineTo(rimInner[i].x, rimInner[i].y);
    ctx.closePath();
    ctx.fill('evenodd');
    ctx.strokeStyle = '#8a5a00';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(rimOuter[0].x, rimOuter[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(rimOuter[i].x, rimOuter[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(rimInner[0].x, rimInner[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(rimInner[i].x, rimInner[i].y);
    ctx.closePath();
    ctx.stroke();

    // Red accent stripe on rim top
    ctx.fillStyle = '#d72631';
    ctx.beginPath();
    ctx.moveTo(rimOuter[0].x, rimOuter[0].y);
    ctx.lineTo(rimOuter[1].x, rimOuter[1].y);
    ctx.lineTo(rimInner[1].x, rimInner[1].y);
    ctx.lineTo(rimInner[0].x, rimInner[0].y);
    ctx.closePath();
    ctx.fill();
  }

  function drawBeanbag() {
    const b = state.beanbag;
    if (!b) return;
    const kind = b.kind || 'beanbag';
    const trailColor = kind === 'fruit'     ? '#ffd24a'
                     : kind === 'poop_boy'  ? '#b5722a'
                     : kind === 'poop_girl' ? '#ff8ac2'
                     : '#ff6b9d';
    for (let i = 0; i < b.trail.length; i++) {
      const t = b.trail[i];
      const p = project(t.x, t.y, t.z);
      if (!p.visible) continue;
      ctx.globalAlpha = (i + 1) / b.trail.length * 0.5;
      ctx.fillStyle = trailColor;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(2, 6 * p.scale), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    const sh = project(b.x, 0, b.z);
    if (sh.visible) {
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(sh.x, sh.y, 14 * sh.scale, 5 * sh.scale, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    const p = project(b.x, b.y, b.z);
    if (!p.visible) return;
    const r = Math.max(5, 16 * p.scale);

    if (kind === 'fruit') {
      drawFruitBall(p.x, p.y, r, b.fruit || '🍎', b.spin);
    } else if (kind === 'poop_boy') {
      drawPoopBoy(p.x, p.y, r, b.spin, true);
    } else if (kind === 'poop_girl') {
      drawPoopGirl(p.x, p.y, r, b.spin, true);
    } else {
      drawBeanbagBall(p.x, p.y, r);
    }
  }

  function drawBeanbagBall(x, y, r) {
    const grad = ctx.createRadialGradient(x - r/3, y - r/3, r/4, x, y, r);
    grad.addColorStop(0, '#ff8fb3');
    grad.addColorStop(1, '#c2185b');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#6a0d2d';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // seam stitches
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x - r * 0.7, y);
    ctx.quadraticCurveTo(x, y - r * 0.4, x + r * 0.7, y);
    ctx.stroke();
  }

  function drawFruitBall(x, y, r, emoji, spin) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(spin || 0);
    // soft halo so fruit pops out on dark bg
    const halo = ctx.createRadialGradient(0, 0, r * 0.3, 0, 0, r * 2.1);
    halo.addColorStop(0, 'rgba(255, 210, 74, 0.55)');
    halo.addColorStop(1, 'rgba(255, 210, 74, 0)');
    ctx.fillStyle = halo;
    ctx.fillRect(-r * 2.1, -r * 2.1, r * 4.2, r * 4.2);

    const fs = r * 2.6;
    ctx.font = `${fs}px "Segoe UI Emoji", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(emoji, 0, 0);
    ctx.restore();
  }

  function drawPoopBoy(x, y, r, spin, inFlight) {
    ctx.save();
    ctx.translate(x, y);
    const wob = Math.sin((spin || 0) * 0.8) * 0.08;
    ctx.scale(1 + wob, 1 - wob);

    // soft brown halo
    const halo = ctx.createRadialGradient(0, 0, r * 0.3, 0, 0, r * 1.8);
    halo.addColorStop(0, 'rgba(255, 190, 100, 0.45)');
    halo.addColorStop(1, 'rgba(255, 190, 100, 0)');
    ctx.fillStyle = halo;
    ctx.fillRect(-r * 1.8, -r * 1.8, r * 3.6, r * 3.6);

    // 3-layer poop pile — classic brown
    const layers = [
      { rx: r * 1.0,  ry: r * 0.6,  cy:  r * 0.55, c1: '#a86420', c2: '#6b3a10' },
      { rx: r * 0.72, ry: r * 0.48, cy:  r * 0.05, c1: '#b8722a', c2: '#7a4414' },
      { rx: r * 0.48, ry: r * 0.36, cy: -r * 0.4,  c1: '#c57c30', c2: '#8a4a18' },
    ];
    for (const L of layers) {
      const g = ctx.createRadialGradient(-L.rx * 0.3, L.cy - L.ry * 0.3, L.rx * 0.2, 0, L.cy, L.rx);
      g.addColorStop(0, L.c1);
      g.addColorStop(1, L.c2);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(0, L.cy, L.rx, L.ry, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // top tip
    ctx.fillStyle = '#c57c30';
    ctx.beginPath();
    ctx.arc(0, -r * 0.65, r * 0.18, 0, Math.PI * 2);
    ctx.fill();

    const ey = -r * 0.05;
    const ex = r * 0.22;

    if (inFlight) {
      // 目玉が飛び出したビックリ顔
      const bex = r * 0.32;     // eyes pushed outward
      const bey = -r * 0.08;
      const bulge = r * 0.28;   // big round whites
      // bulge stem (eye popping out of socket) — dark connector behind
      ctx.fillStyle = '#2a1208';
      ctx.beginPath();
      ctx.ellipse(-bex * 0.6, bey, r * 0.14, r * 0.12, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath();
      ctx.ellipse( bex * 0.6, bey, r * 0.14, r * 0.12, 0, 0, Math.PI * 2); ctx.fill();
      // popped-out eye whites — huge round circles
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#1a0a00';
      ctx.lineWidth = Math.max(1, r * 0.05);
      ctx.beginPath(); ctx.arc(-bex, bey, bulge, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc( bex, bey, bulge, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      // tiny shocked pupils
      ctx.fillStyle = '#1a0a00';
      ctx.beginPath(); ctx.arc(-bex + r * 0.04, bey + r * 0.02, r * 0.06, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc( bex - r * 0.04, bey + r * 0.02, r * 0.06, 0, Math.PI * 2); ctx.fill();
      // eye sheen
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(-bex - r * 0.08, bey - r * 0.1, r * 0.06, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc( bex - r * 0.08, bey - r * 0.1, r * 0.06, 0, Math.PI * 2); ctx.fill();
      // big round O mouth (shocked)
      ctx.fillStyle = '#3a0018';
      ctx.beginPath();
      ctx.ellipse(0, r * 0.22, r * 0.14, r * 0.18, 0, 0, Math.PI * 2);
      ctx.fill();
      // tongue inside O
      ctx.fillStyle = '#ff6aa0';
      ctx.beginPath();
      ctx.ellipse(0, r * 0.28, r * 0.1, r * 0.08, 0, 0, Math.PI * 2);
      ctx.fill();
      // shock marks (!) around head
      ctx.fillStyle = '#ffe84a';
      ctx.strokeStyle = '#1a0a00';
      ctx.lineWidth = Math.max(1, r * 0.04);
      for (const [mx, my] of [[r * 0.72, -r * 0.42], [-r * 0.72, -r * 0.32]]) {
        ctx.save();
        ctx.translate(mx, my);
        ctx.font = `bold ${r * 0.32}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.strokeText('!', 0, 0);
        ctx.fillText('!', 0, 0);
        ctx.restore();
      }
    } else {
      // cute resting face
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(-ex, ey, r * 0.17, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc( ex, ey, r * 0.17, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#1a0a00';
      ctx.beginPath(); ctx.arc(-ex + r * 0.03, ey, r * 0.09, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc( ex + r * 0.03, ey, r * 0.09, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(-ex + r * 0.05, ey - r * 0.03, r * 0.03, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc( ex + r * 0.05, ey - r * 0.03, r * 0.03, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#1a0a00';
      ctx.lineWidth = Math.max(1, r * 0.08);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(0, r * 0.12, r * 0.18, 0.1 * Math.PI, 0.9 * Math.PI);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255, 120, 160, 0.55)';
      ctx.beginPath(); ctx.arc(-ex - r * 0.05, ey + r * 0.18, r * 0.09, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc( ex + r * 0.05, ey + r * 0.18, r * 0.09, 0, Math.PI * 2); ctx.fill();
    }

    ctx.restore();
  }

  function drawPoopGirl(x, y, r, spin, inFlight) {
    ctx.save();
    ctx.translate(x, y);
    const wob = Math.sin((spin || 0) * 0.8) * 0.08;
    ctx.scale(1 + wob, 1 - wob);

    // sparkly pink halo
    const halo = ctx.createRadialGradient(0, 0, r * 0.3, 0, 0, r * 1.9);
    halo.addColorStop(0, 'rgba(255, 180, 220, 0.55)');
    halo.addColorStop(0.6, 'rgba(255, 140, 200, 0.25)');
    halo.addColorStop(1, 'rgba(255, 140, 200, 0)');
    ctx.fillStyle = halo;
    ctx.fillRect(-r * 1.9, -r * 1.9, r * 3.8, r * 3.8);

    // 3-layer poop pile — soft pink / rose tones
    const layers = [
      { rx: r * 1.0,  ry: r * 0.6,  cy:  r * 0.55, c1: '#ffc1d9', c2: '#e0669a' },
      { rx: r * 0.72, ry: r * 0.48, cy:  r * 0.05, c1: '#ffd0e2', c2: '#e47aa8' },
      { rx: r * 0.48, ry: r * 0.36, cy: -r * 0.4,  c1: '#ffe0ee', c2: '#e989b3' },
    ];
    for (const L of layers) {
      const g = ctx.createRadialGradient(-L.rx * 0.3, L.cy - L.ry * 0.3, L.rx * 0.2, 0, L.cy, L.rx);
      g.addColorStop(0, L.c1);
      g.addColorStop(1, L.c2);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(0, L.cy, L.rx, L.ry, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // top tip (pink, matching うん丸くん's silhouette)
    ctx.fillStyle = '#ffb0d0';
    ctx.beginPath();
    ctx.arc(0, -r * 0.65, r * 0.18, 0, Math.PI * 2);
    ctx.fill();

    const ey = -r * 0.05;
    const ex = r * 0.24;

    if (inFlight) {
      // かわいい びっくり顔 (big sparkly shocked eyes + お口ぽかん)
      const bex = r * 0.26;
      const bey = -r * 0.06;
      const eyeR = r * 0.28;
      // big round whites
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#3a0018';
      ctx.lineWidth = Math.max(1, r * 0.04);
      ctx.beginPath(); ctx.arc(-bex, bey, eyeR, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc( bex, bey, eyeR, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      // pink iris ring
      ctx.fillStyle = '#f47aa8';
      ctx.beginPath(); ctx.arc(-bex, bey + r * 0.02, r * 0.19, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc( bex, bey + r * 0.02, r * 0.19, 0, Math.PI * 2); ctx.fill();
      // deep magenta pupils (shrunken)
      ctx.fillStyle = '#5a0a3a';
      ctx.beginPath(); ctx.arc(-bex, bey + r * 0.03, r * 0.09, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc( bex, bey + r * 0.03, r * 0.09, 0, Math.PI * 2); ctx.fill();
      // big sparkles (the defining cute-shocked look)
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(-bex - r * 0.08, bey - r * 0.1, r * 0.08, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc( bex - r * 0.08, bey - r * 0.1, r * 0.08, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(-bex + r * 0.08, bey + r * 0.1, r * 0.035, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc( bex + r * 0.08, bey + r * 0.1, r * 0.035, 0, Math.PI * 2); ctx.fill();
      // raised brow eyelashes (surprise arches)
      ctx.strokeStyle = '#3a0018';
      ctx.lineWidth = Math.max(1, r * 0.05);
      ctx.lineCap = 'round';
      for (const sx of [-bex, bex]) {
        ctx.beginPath();
        ctx.moveTo(sx - r * 0.12, bey - eyeR - r * 0.04);
        ctx.lineTo(sx - r * 0.16, bey - eyeR - r * 0.16);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(sx + r * 0.12, bey - eyeR - r * 0.04);
        ctx.lineTo(sx + r * 0.16, bey - eyeR - r * 0.16);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(sx, bey - eyeR - r * 0.06);
        ctx.lineTo(sx, bey - eyeR - r * 0.2);
        ctx.stroke();
      }
      // small round "お口ぽかん" mouth
      const mY = r * 0.28;
      ctx.fillStyle = '#c9265a';
      ctx.beginPath();
      ctx.ellipse(0, mY, r * 0.08, r * 0.1, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ff98bd';
      ctx.beginPath();
      ctx.ellipse(0, mY + r * 0.02, r * 0.05, r * 0.05, 0, 0, Math.PI * 2);
      ctx.fill();
      // pink shock marks (♡ + !)
      ctx.save();
      ctx.fillStyle = '#ff3a78';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = Math.max(1, r * 0.04);
      ctx.font = `bold ${r * 0.3}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.strokeText('!', r * 0.68, -r * 0.42);
      ctx.fillText('!', r * 0.68, -r * 0.42);
      ctx.strokeText('♡', -r * 0.72, -r * 0.3);
      ctx.fillText('♡', -r * 0.72, -r * 0.3);
      ctx.restore();
    } else {
      // cute resting (sparkly eyes, heart mouth)
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.ellipse(-ex, ey, r * 0.2, r * 0.23, -0.1, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse( ex, ey, r * 0.2, r * 0.23,  0.1, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#8a1e5a';
      ctx.beginPath(); ctx.ellipse(-ex + r * 0.02, ey + r * 0.02, r * 0.13, r * 0.16, 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse( ex + r * 0.02, ey + r * 0.02, r * 0.13, r * 0.16, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(-ex + r * 0.06, ey - r * 0.05, r * 0.055, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc( ex + r * 0.06, ey - r * 0.05, r * 0.055, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(-ex - r * 0.02, ey + r * 0.06, r * 0.025, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc( ex - r * 0.02, ey + r * 0.06, r * 0.025, 0, Math.PI * 2); ctx.fill();

      ctx.strokeStyle = '#3a0018';
      ctx.lineWidth = Math.max(1, r * 0.05);
      ctx.lineCap = 'round';
      const lashes = [
        [-ex - r * 0.15, ey - r * 0.18, -ex - r * 0.22, ey - r * 0.28],
        [-ex - r * 0.05, ey - r * 0.22, -ex - r * 0.08, ey - r * 0.34],
        [ ex + r * 0.15, ey - r * 0.18,  ex + r * 0.22, ey - r * 0.28],
        [ ex + r * 0.05, ey - r * 0.22,  ex + r * 0.08, ey - r * 0.34],
      ];
      for (const l of lashes) {
        ctx.beginPath();
        ctx.moveTo(l[0], l[1]);
        ctx.lineTo(l[2], l[3]);
        ctx.stroke();
      }

      const mY = r * 0.18;
      ctx.fillStyle = '#ff3a78';
      ctx.beginPath();
      ctx.moveTo(0, mY + r * 0.08);
      ctx.bezierCurveTo(-r * 0.12, mY - r * 0.02, -r * 0.08, mY - r * 0.12, 0, mY - r * 0.02);
      ctx.bezierCurveTo( r * 0.08, mY - r * 0.12,  r * 0.12, mY - r * 0.02, 0, mY + r * 0.08);
      ctx.fill();
    }

    // pink cheek blush
    ctx.fillStyle = 'rgba(255, 100, 160, 0.6)';
    ctx.beginPath(); ctx.ellipse(-ex - r * 0.08, ey + r * 0.22, r * 0.13, r * 0.08, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse( ex + r * 0.08, ey + r * 0.22, r * 0.13, r * 0.08, 0, 0, Math.PI * 2); ctx.fill();

    // sparkle stars around face
    ctx.fillStyle = '#fff';
    const sparkles = [
      [-r * 0.85, -r * 0.2, r * 0.06],
      [ r * 0.85, -r * 0.1, r * 0.05],
      [-r * 0.7,   r * 0.3, r * 0.04],
      [ r * 0.75,  r * 0.35, r * 0.05],
    ];
    for (const s of sparkles) {
      drawSparkle(s[0], s[1], s[2]);
    }

    ctx.restore();
  }

  function drawSparkle(x, y, s) {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(0, -s * 2);
    ctx.lineTo(s * 0.5, -s * 0.5);
    ctx.lineTo(s * 2, 0);
    ctx.lineTo(s * 0.5, s * 0.5);
    ctx.lineTo(0, s * 2);
    ctx.lineTo(-s * 0.5, s * 0.5);
    ctx.lineTo(-s * 2, 0);
    ctx.lineTo(-s * 0.5, -s * 0.5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  function drawParticles() {
    for (const p of state.particles) {
      const pr = project(p.x, p.y, p.z);
      if (!pr.visible) continue;
      ctx.fillStyle = p.color;
      const sz = 5 * pr.scale + 2;
      ctx.fillRect(pr.x - sz/2, pr.y - sz/2, sz, sz);
    }
  }

  function drawHand() {
    const cx = W / 2, cy = H - 70;
    ctx.save();
    ctx.fillStyle = '#f0c9a0';
    ctx.beginPath();
    ctx.ellipse(cx, H - 20, 80, 50, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#8a5a34';
    ctx.lineWidth = 2;
    ctx.stroke();
    if (!state.beanbag) {
      const kind = state.ballType;
      if (kind === 'fruit') {
        // preview the fruit set (cycle by time)
        const idx = Math.floor(state.time / 40) % FRUIT_EMOJI.length;
        drawFruitBall(cx, cy, 26, FRUIT_EMOJI[idx], state.time * 0.05);
      } else if (kind === 'poop_boy') {
        drawPoopBoy(cx, cy, 28, state.time * 0.1);
      } else if (kind === 'poop_girl') {
        drawPoopGirl(cx, cy, 28, state.time * 0.1);
      } else {
        drawBeanbagBall(cx, cy, 24);
      }
    }
    ctx.restore();
  }

  function drawSwipeGuide() {
    if (!state.holding) return;
    const h = state.holding;
    // Estimate live swipe velocity for HUD feedback
    const samples = h.samples;
    let powerRatio = 0;
    if (samples.length >= 2) {
      const last = samples[samples.length - 1];
      let first = samples[0];
      for (let i = samples.length - 1; i >= 0; i--) {
        if (last.t - samples[i].t >= 80) { first = samples[i]; break; }
      }
      const dt = Math.max(16, last.t - first.t);
      const vy = (first.y - last.y) / dt;
      powerRatio = Math.max(0, Math.min(vy / 2.0, 1));
    }
    ctx.save();
    ctx.strokeStyle = `rgba(255,220,80,${0.5 + powerRatio * 0.5})`;
    ctx.lineWidth = 4 + powerRatio * 6;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(h.startX, h.startY);
    ctx.lineTo(h.curX, h.curY);
    ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.fillRect(20, H - 40, 200, 16);
    ctx.fillStyle = powerRatio > 0.9 ? '#ff3b3b' : '#ffd84d';
    ctx.fillRect(20, H - 40, 200 * powerRatio, 16);
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(20, H - 40, 200, 16);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 12px sans-serif';
    ctx.fillText('SPEED', 25, H - 46);
    ctx.restore();
  }

  function drawFlash() {
    if (state.flash <= 0) return;
    ctx.fillStyle = `rgba(255,240,120,${state.flash / 56})`;
    ctx.fillRect(0, 0, W, H);
    state.flash--;
  }

  function drawShockwave() {
    if (state.shockwave <= 0) return;
    const age = 30 - state.shockwave;
    const life = age / 30;
    const r = life * 520;
    ctx.save();
    // outer ring
    ctx.globalAlpha = Math.max(0, 1 - life);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 12 * (1 - life) + 2;
    ctx.beginPath();
    ctx.arc(state.shockX, state.shockY, r, 0, Math.PI * 2);
    ctx.stroke();
    // inner neon ring
    ctx.strokeStyle = '#ff3b82';
    ctx.lineWidth = 6 * (1 - life) + 1;
    ctx.beginPath();
    ctx.arc(state.shockX, state.shockY, r * 0.82, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = '#ffd36a';
    ctx.lineWidth = 4 * (1 - life) + 1;
    ctx.beginPath();
    ctx.arc(state.shockX, state.shockY, r * 0.6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawWinText() {
    if (state.winText <= 0) return;
    const t = state.winText;
    // pop-in: big → settle, then fade at tail
    const age = 110 - t;
    const popScale = age < 12
      ? 0.4 + (age / 12) * 1.1   // 0.4 → 1.5
      : age < 24
        ? 1.5 - ((age - 12) / 12) * 0.45  // 1.5 → 1.05
        : 1.05 + Math.sin((age - 24) * 0.22) * 0.04; // gentle breath
    const alpha = t < 20 ? t / 20 : 1;
    const shake = t > 70 ? (Math.random() - 0.5) * 10 : 0;
    const rot = Math.sin(age * 0.18) * 0.03;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(W / 2 + shake, H * 0.32 + shake * 0.5);
    ctx.rotate(rot);
    ctx.scale(popScale, popScale);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // radial burst behind text
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 320);
    grad.addColorStop(0, 'rgba(255, 240, 120, 0.85)');
    grad.addColorStop(0.4, 'rgba(255, 59, 130, 0.55)');
    grad.addColorStop(1, 'rgba(255, 59, 130, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, 320, 0, Math.PI * 2);
    ctx.fill();

    // radiating rays
    ctx.globalAlpha = alpha * 0.6;
    ctx.strokeStyle = '#ffe14d';
    ctx.lineWidth = 3;
    const rayCount = 20;
    for (let i = 0; i < rayCount; i++) {
      const a = (i / rayCount) * Math.PI * 2 + age * 0.04;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 180, Math.sin(a) * 180);
      ctx.lineTo(Math.cos(a) * 300, Math.sin(a) * 300);
      ctx.stroke();
    }
    ctx.globalAlpha = alpha;

    // Main logo: あたり！！
    const label = 'あたり！！';
    ctx.font = '900 92px "Rampart One", serif';

    // Neon outer glow (multi-pass)
    ctx.shadowColor = '#ff1f8a';
    ctx.shadowBlur = 40;
    ctx.fillStyle = '#ff1f8a';
    ctx.fillText(label, 0, 0);
    ctx.shadowColor = '#ffc846';
    ctx.shadowBlur = 28;
    ctx.fillStyle = '#ffc846';
    ctx.fillText(label, 0, 0);
    ctx.shadowBlur = 0;

    // Heavy stroke
    ctx.lineJoin = 'round';
    ctx.lineWidth = 14;
    ctx.strokeStyle = '#2a0550';
    ctx.strokeText(label, 0, 0);
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeText(label, 0, 0);

    // Fill with gradient
    const textGrad = ctx.createLinearGradient(0, -50, 0, 50);
    textGrad.addColorStop(0, '#fff5e8');
    textGrad.addColorStop(0.45, '#ffe14d');
    textGrad.addColorStop(1, '#ff3b82');
    ctx.fillStyle = textGrad;
    ctx.fillText(label, 0, 0);

    // Chromatic glitch copies
    ctx.globalAlpha = alpha * 0.55;
    ctx.fillStyle = '#ffc846';
    ctx.fillText(label, -4 + Math.sin(age * 0.5) * 2, 0);
    ctx.fillStyle = '#ff1f8a';
    ctx.fillText(label, 4 + Math.cos(age * 0.5) * 2, 0);

    // Sub tag "HIT! / PERFECT"
    ctx.globalAlpha = alpha;
    ctx.font = 'bold 22px "Syncopate", sans-serif';
    ctx.fillStyle = '#fff';
    ctx.shadowColor = '#ff1f8a';
    ctx.shadowBlur = 14;
    ctx.fillText('☆  H I T ! !  ☆', 0, 74);
    ctx.shadowBlur = 0;

    ctx.restore();
    state.winText--;
  }

  function drawOverlay() {
    if (state.running) return;
    if (state.gameOver > 0) { drawGameOver(); return; }

    // Very light pastel veil — keeps the bright scene visible, no dark tint.
    ctx.fillStyle = 'rgba(255, 244, 251, 0.55)';
    ctx.fillRect(0, 0, W, H);

    const cx = W / 2;
    const baseY = H / 2 - 46;
    const t = state.time;
    const bob = Math.sin(t * 0.05) * 6;
    const pulse = 1 + Math.sin(t * 0.08) * 0.04;

    ctx.save();
    ctx.translate(cx, baseY + bob);
    ctx.scale(pulse, pulse);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // radial burst halo
    const halo = ctx.createRadialGradient(0, 0, 20, 0, 0, 320);
    halo.addColorStop(0, 'rgba(255, 240, 120, 0.55)');
    halo.addColorStop(0.5, 'rgba(255, 59, 130, 0.35)');
    halo.addColorStop(1, 'rgba(255, 59, 130, 0)');
    ctx.fillStyle = halo;
    ctx.beginPath();
    ctx.arc(0, 0, 320, 0, Math.PI * 2);
    ctx.fill();

    // radiating candy rays
    ctx.save();
    ctx.rotate(t * 0.004);
    ctx.strokeStyle = 'rgba(255, 225, 77, 0.55)';
    ctx.lineWidth = 3;
    const rays = 16;
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 150, Math.sin(a) * 150);
      ctx.lineTo(Math.cos(a) * 260, Math.sin(a) * 260);
      ctx.stroke();
    }
    ctx.restore();

    // title: おかしきゃっち
    const label = 'おかしきゃっち';
    ctx.font = '900 72px "Rampart One", serif';

    // outer multi-color neon glow
    ctx.shadowColor = '#ff1f8a';
    ctx.shadowBlur = 32;
    ctx.fillStyle = '#ff1f8a';
    ctx.fillText(label, 0, 0);
    ctx.shadowColor = '#ffc846';
    ctx.shadowBlur = 24;
    ctx.fillStyle = '#ffc846';
    ctx.fillText(label, 0, 0);
    ctx.shadowBlur = 0;

    // heavy outline
    ctx.lineJoin = 'round';
    ctx.lineWidth = 12;
    ctx.strokeStyle = '#2a0550';
    ctx.strokeText(label, 0, 0);
    ctx.lineWidth = 5;
    ctx.strokeStyle = '#ffffff';
    ctx.strokeText(label, 0, 0);

    // candy gradient fill
    const grad = ctx.createLinearGradient(0, -40, 0, 40);
    grad.addColorStop(0, '#fff5e8');
    grad.addColorStop(0.45, '#ffe14d');
    grad.addColorStop(1, '#ff3b82');
    ctx.fillStyle = grad;
    ctx.fillText(label, 0, 0);

    // exclamation mark
    ctx.font = '900 72px "Rampart One", serif';
    ctx.fillStyle = '#ff3b82';
    ctx.fillText('！', 250, 0);
    ctx.fillStyle = '#fff';
    ctx.font = '900 72px "Rampart One", serif';

    // cute candy icons on each side
    ctx.font = '56px "Segoe UI Emoji", sans-serif';
    ctx.fillText('🍭', -280, -4);
    ctx.fillText('🍬', 300, -4);
    ctx.restore();

    // sub-title: instructions in soft rounded style
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // tag line
    ctx.font = 'bold 22px "Rampart One", "Zen Kaku Gothic New", sans-serif';
    ctx.fillStyle = '#ffe14d';
    ctx.shadowColor = '#ff1f8a';
    ctx.shadowBlur = 10;
    ctx.fillText('☆ そらから おちてくる おかしを ぜんぶ キャッチ！ ☆', cx, H / 2 + 50);
    ctx.shadowBlur = 0;

    // button hint with bouncing arrow
    const abob = Math.sin(t * 0.1) * 4;
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 18px "Zen Kaku Gothic New", sans-serif';
    ctx.fillText('「はじめる」を おして あそぼう！', cx, H / 2 + 84 + abob);

    // instructions
    ctx.font = '15px "Zen Kaku Gothic New", sans-serif';
    ctx.fillStyle = 'rgba(255, 245, 232, 0.9)';
    ctx.fillText('⬆ したから うえに ゆびで シュッ！  はやさ＝とぶ ながさ  /  むき＝とぶ ほうこう', cx, H / 2 + 116);
    ctx.fillText('ぐるぐる まわる 🎯 の しかくに いれたら だいせいこう！', cx, H / 2 + 140);

    ctx.restore();
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  function drawGameOver() {
    // Light pastel pink veil (instead of dark purple) so the scene stays bright.
    ctx.fillStyle = 'rgba(255, 224, 240, 0.72)';
    ctx.fillRect(0, 0, W, H);

    const cx = W / 2;
    const baseY = H / 2 - 30;
    const t = state.time;
    const bob = Math.sin(t * 0.06) * 6;
    const pulse = 1 + Math.sin(t * 0.08) * 0.04;

    ctx.save();
    ctx.translate(cx, baseY + bob);
    ctx.scale(pulse, pulse);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const halo = ctx.createRadialGradient(0, 0, 20, 0, 0, 300);
    halo.addColorStop(0, 'rgba(255, 210, 74, 0.5)');
    halo.addColorStop(1, 'rgba(255, 59, 130, 0)');
    ctx.fillStyle = halo;
    ctx.beginPath(); ctx.arc(0, 0, 300, 0, Math.PI * 2); ctx.fill();

    const label = 'おしまい！';
    ctx.font = '900 76px "Rampart One", serif';
    ctx.shadowColor = '#ff1f8a'; ctx.shadowBlur = 32;
    ctx.fillStyle = '#ff1f8a'; ctx.fillText(label, 0, 0);
    ctx.shadowColor = '#ffc846'; ctx.shadowBlur = 24;
    ctx.fillStyle = '#ffc846'; ctx.fillText(label, 0, 0);
    ctx.shadowBlur = 0;
    ctx.lineJoin = 'round';
    ctx.lineWidth = 12; ctx.strokeStyle = '#2a0550'; ctx.strokeText(label, 0, 0);
    ctx.lineWidth = 5;  ctx.strokeStyle = '#ffffff'; ctx.strokeText(label, 0, 0);
    const grad = ctx.createLinearGradient(0, -40, 0, 40);
    grad.addColorStop(0, '#fff5e8');
    grad.addColorStop(0.5, '#ffe14d');
    grad.addColorStop(1, '#ff3b82');
    ctx.fillStyle = grad; ctx.fillText(label, 0, 0);
    ctx.restore();

    // score + stats summary
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 26px "Rampart One", "Zen Kaku Gothic New", sans-serif';
    ctx.fillStyle = '#ffe14d';
    ctx.shadowColor = '#ff1f8a'; ctx.shadowBlur = 10;
    ctx.fillText(`SCORE  ${state.score} pts`, cx, H / 2 + 60);
    ctx.shadowBlur = 0;
    ctx.font = '16px "Zen Kaku Gothic New", sans-serif';
    ctx.fillStyle = 'rgba(255, 245, 232, 0.92)';
    ctx.fillText(`あたり ${state.hits} / ${state.shots} かい  ・  はずし ${state.misses}`, cx, H / 2 + 92);

    const abob = Math.sin(t * 0.12) * 4;
    ctx.font = 'bold 18px "Zen Kaku Gothic New", sans-serif';
    ctx.fillStyle = '#fff';
    ctx.fillText('「やりなおし」 → 「はじめる」で もういっかい あそぼう！', cx, H / 2 + 128 + abob);
    ctx.restore();
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  let slowAccum = 0;
  function update() {
    state.time++;
    if (state.celebrate > 0) state.celebrate--;
    if (state.shockwave > 0) state.shockwave--;
    if (state.running) {
      // Slow-motion: advance physics only every ~5 frames while slowmo > 0
      if (state.slowmo > 0) {
        slowAccum += 0.2;
        state.slowmo--;
        if (slowAccum >= 1) {
          slowAccum -= 1;
          box.angle += box.omega;
          stepBeanbag();
          stepParticles();
        }
      } else {
        slowAccum = 0;
        box.angle += box.omega;
        stepBeanbag();
        stepParticles();
      }
    }
  }

  function render() {
    ctx.clearRect(0, 0, W, H);
    drawSky();
    drawGround();
    drawBackWall();
    drawBox();
    drawParticles();
    drawBeanbag();
    drawCanopy();
    drawBunting();
    drawLanterns();
    drawBooth();
    drawHand();
    drawSwipeGuide();
    drawShockwave();
    drawFlash();
    drawWinText();
    drawOverlay();
  }

  function loop() {
    update();
    render();
    requestAnimationFrame(loop);
  }

  function updateHUD() {
    scoreEl.textContent = state.score;
    shotsEl.textContent = state.shots;
    const acc = state.shots > 0 ? Math.round((state.hits / state.shots) * 100) : 0;
    accuracyEl.textContent = acc + '%';
    renderLives();
  }

  const livesRowEl    = document.getElementById('livesRow');
  const livesCountEl  = document.getElementById('livesCount');
  const livesCountWrap= document.getElementById('livesCountWrap');
  const livesSection  = document.querySelector('.lives');
  const modeEls       = document.querySelectorAll('.mode[data-mode]');
  function renderLives() {
    if (!livesRowEl) return;
    const ranking = state.mode === 'ranking';
    livesRowEl.hidden = !ranking;
    if (livesCountWrap) livesCountWrap.hidden = !ranking;
    if (!ranking) {
      livesRowEl.innerHTML = '';
      return;
    }
    const remaining = Math.max(0, state.maxMisses - state.misses);
    livesRowEl.innerHTML = '';
    for (let i = 0; i < state.maxMisses; i++) {
      const span = document.createElement('span');
      const alive = i < remaining;
      span.className = 'life ' + (alive ? 'is-on' : 'is-off');
      span.textContent = alive ? '🍬' : '💥';
      livesRowEl.appendChild(span);
    }
    if (livesCountEl) livesCountEl.textContent = `${remaining} / ${state.maxMisses}`;
  }

  function setMode(mode) {
    if (state.running) return;
    if (mode !== 'free' && mode !== 'ranking') return;
    state.mode = mode;
    state.misses = 0;
    state.gameOver = 0;
    window.sweetsRushMode = mode;
    modeEls.forEach(el => {
      const active = el.getAttribute('data-mode') === mode;
      el.classList.toggle('is-active', active);
      el.setAttribute('aria-checked', active ? 'true' : 'false');
    });
    if (livesSection) livesSection.setAttribute('data-mode', mode);
    updateHUD();
  }
  modeEls.forEach(el => {
    el.addEventListener('click', () => setMode(el.getAttribute('data-mode')));
  });

  // --- Difficulty selector (easy / medium / hard) ---
  const diffEls = document.querySelectorAll('.diff[data-diff]');
  function setDifficulty(diff) {
    if (!DIFFICULTY_HITZONE[diff]) return;
    state.difficulty = diff;
    box.size = DIFFICULTY_BOX_SIZE[diff] || 150;
    diffEls.forEach(el => {
      const active = el.getAttribute('data-diff') === diff;
      el.classList.toggle('is-active', active);
      el.setAttribute('aria-checked', active ? 'true' : 'false');
    });
  }
  // Apply initial difficulty so box.size matches the default (medium).
  setDifficulty(state.difficulty);
  diffEls.forEach(el => {
    el.addEventListener('click', () => setDifficulty(el.getAttribute('data-diff')));
  });

  function start() {
    // reset run-specific counters on fresh start
    state.score = 0; state.shots = 0; state.hits = 0; state.misses = 0;
    state.beanbag = null; state.particles = []; state.holding = null;
    state.celebrate = 0; state.celebrateBursts = []; state.winText = 0;
    state.gameOver = 0;
    state.running = true;
    updateHUD();
  }
  function reset() {
    state.running = false;
    state.score = 0; state.shots = 0; state.hits = 0; state.misses = 0;
    state.beanbag = null; state.particles = []; state.holding = null;
    state.celebrate = 0; state.celebrateBursts = []; state.winText = 0;
    state.gameOver = 0;
    box.angle = Math.PI;
    updateHUD();
  }

  startBtn.addEventListener('click', start);
  resetBtn.addEventListener('click', reset);

  // --- Ball selector ---
  const ballCurrentEl = document.getElementById('ballCurrent');
  const ballButtons = document.querySelectorAll('.ball[data-ball]');
  const BALL_LABEL = { beanbag: 'お手玉', fruit: '果物', poop_boy: 'うん丸くん', poop_girl: 'うん姫ちゃん' };
  function selectBall(kind) {
    if (!BALL_LABEL[kind]) return;
    state.ballType = kind;
    ballButtons.forEach(btn => {
      const active = btn.getAttribute('data-ball') === kind;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-checked', active ? 'true' : 'false');
    });
    if (ballCurrentEl) ballCurrentEl.textContent = BALL_LABEL[kind];
  }
  ballButtons.forEach(btn => {
    btn.addEventListener('click', () => selectBall(btn.getAttribute('data-ball')));
  });

  // Render うん姫ちゃん icon into the ball selector preview
  (function renderGirlIcon() {
    const iconCanvas = document.getElementById('ballIconGirl');
    if (!iconCanvas) return;
    const iconCtx = iconCanvas.getContext('2d');
    ctx = iconCtx;
    iconCtx.clearRect(0, 0, iconCanvas.width, iconCanvas.height);
    drawPoopGirl(iconCanvas.width / 2, iconCanvas.height / 2 + 4, 22, 0, false);
    ctx = mainCtx;
  })();

  updateHUD();
  loop();
})();
