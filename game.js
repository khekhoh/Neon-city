/**
 * NEON CITY: CYBER-GRID SHOWDOWN
 * Architecture Overview:
 * 1. CONFIG: Tunable constants for speeds, cooldowns, colors, and effects.
 * 2. Pure Logic Functions: Math, normalization, collision, and damage helpers (exported for testing).
 * 3. SoundFX: Zero-dependency Web Audio API synthesizer for laser and hit sounds.
 * 4. Entities: Player, PlasmaPulse (Bullet), and Spark (Particle).
 * 5. Game State & Loop: Centralized `gameState` object updated via delta-time (`requestAnimationFrame`).
 *
 * How to Extend:
 * - Add new obstacles in `CONFIG.OBSTACLES`.
 * - Add a 3rd/4th player by pushing a new `Player` instance in `initPlayers()` with IJKL keybindings.
 */

const CONFIG = {
  WIDTH: 1100,
  HEIGHT: 620,
  ROUND_TIME_SECONDS: 90,
  WIN_SCORE: 5,
  PLAYER_SPEED: 270,          // Pixels per second
  PLAYER_RADIUS: 18,
  PLAYER_MAX_HP: 100,
  RESPAWN_DELAY: 1.5,         // Seconds before respawn
  SPAWN_SHIELD_TIME: 1.0,     // Seconds of invulnerability after respawn
  BULLET_SPEED: 620,          // Pixels per second
  BULLET_RADIUS: 5,
  BULLET_DAMAGE: 25,
  FIRE_COOLDOWN: 0.28,        // Seconds between shots
  ENABLE_AUDIO: true,         // Set false to mute all synthesized audio
  ENABLE_VFX: true,           // Set false to disable particles & neon glow
  COLORS: {
    P1: '#00f3ff',            // Cyber Cyan
    P2: '#ff007f',            // Neon Magenta
    OBSTACLE_FILL: '#101326',
    OBSTACLE_GLOW: '#bd00ff', // Synth Purple
    GRID: 'rgba(0, 243, 255, 0.07)'
  },
  // Symmetrical "Holo-Barrier" obstacles in Sector 7-G
  OBSTACLES: [
    { x: 240, y: 140, w: 40, h: 140 },
    { x: 240, y: 340, w: 40, h: 140 },
    { x: 820, y: 140, w: 40, h: 140 },
    { x: 820, y: 340, w: 40, h: 140 },
    { x: 470, y: 260, w: 160, h: 100 }, // Central Cyber-Core
    { x: 510, y: 70,  w: 80,  h: 40 },
    { x: 510, y: 510, w: 80,  h: 40 }
  ]
};

// ============================================================================
// PURE LOGIC FUNCTIONS (Testable in Browser Console or Node.js)
// ============================================================================

/**
 * Clamps a number `val` between `min` and `max`.
 */
function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/**
 * Normalizes a 2D vector so diagonal movement isn't faster than cardinal movement.
 * By Pythagoras, moving (1, 1) has length sqrt(2) ~= 1.414. Dividing by length makes it 1.0.
 */
function normalizeVector(dx, dy) {
  const length = Math.hypot(dx, dy);
  if (length === 0) return { x: 0, y: 0 };
  return { x: dx / length, y: dy / length };
}

/**
 * Checks if two circles overlap (used for Bullet-vs-Player collision).
 * True if distance between centers <= sum of radii.
 */
function circlesCollide(x1, y1, r1, x2, y2, r2) {
  const distance = Math.hypot(x2 - x1, y2 - y1);
  return distance <= r1 + r2;
}

/**
 * Checks if a circle overlaps an axis-aligned rectangle (used for Player/Bullet vs Holo-Barrier).
 * Finds the closest point on the rectangle to the circle's center, then checks distance.
 */
function circleRectCollide(cx, cy, cr, rx, ry, rw, rh) {
  const closestX = clamp(cx, rx, rx + rw);
  const closestY = clamp(cy, ry, ry + rh);
  const distance = Math.hypot(cx - closestX, cy - closestY);
  return distance < cr;
}

/**
 * Pure damage calculation function. Returns new HP and whether the target was eliminated.
 */
function calculateDamage(currentHp, damageAmount, isShielded = false) {
  if (isShielded || currentHp <= 0) {
    return { hp: currentHp, eliminated: false };
  }
  const nextHp = Math.max(0, currentHp - damageAmount);
  return { hp: nextHp, eliminated: nextHp === 0 };
}

// ============================================================================
// WEB AUDIO SYNTHESIZER (Zero External Assets)
// ============================================================================

const SoundFX = {
  ctx: null,
  init() {
    if (!CONFIG.ENABLE_AUDIO || this.ctx) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) this.ctx = new AudioCtx();
  },
  playTone(startFreq, endFreq, duration, type = 'sawtooth', gainVal = 0.08) {
    if (!CONFIG.ENABLE_AUDIO) return;
    try {
      this.init();
      if (!this.ctx) return;
      if (this.ctx.state === 'suspended') this.ctx.resume();

      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(startFreq, this.ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(endFreq, this.ctx.currentTime + duration);

      gain.gain.setValueAtTime(gainVal, this.ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.001, this.ctx.currentTime + duration);

      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + duration);
    } catch (e) {
      // Ignore audio errors if browser blocks autoplay before interaction
    }
  },
  laser() { this.playTone(720, 140, 0.11, 'sawtooth', 0.06); },
  hit() { this.playTone(220, 55, 0.14, 'square', 0.09); },
  eliminate() { this.playTone(300, 35, 0.35, 'sawtooth', 0.12); }
};

// ============================================================================
// GAME ENTITIES
// ============================================================================

class PlasmaPulse {
  constructor(ownerId, x, y, angle, color) {
    this.ownerId = ownerId;
    this.x = x;
    this.y = y;
    this.vx = Math.cos(angle) * CONFIG.BULLET_SPEED;
    this.vy = Math.sin(angle) * CONFIG.BULLET_SPEED;
    this.radius = CONFIG.BULLET_RADIUS;
    this.color = color;
    this.active = true;
  }

  update(dt, obstacles) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Deactivate if out of arena bounds
    if (this.x < 0 || this.x > CONFIG.WIDTH || this.y < 0 || this.y > CONFIG.HEIGHT) {
      this.active = false;
      return;
    }

    // Deactivate if hitting a Holo-Barrier
    for (const obs of obstacles) {
      if (circleRectCollide(this.x, this.y, this.radius, obs.x, obs.y, obs.w, obs.h)) {
        this.active = false;
        return;
      }
    }
  }
}

class Spark {
  constructor(x, y, color) {
    this.x = x;
    this.y = y;
    const angle = Math.random() * Math.PI * 2;
    const speed = 50 + Math.random() * 190;
    this.vx = Math.cos(angle) * speed;
    this.vy = Math.sin(angle) * speed;
    this.life = 0.25 + Math.random() * 0.25;
    this.maxLife = this.life;
    this.color = color;
  }

  update(dt) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.life -= dt;
  }
}

class Player {
  constructor(id, name, x, y, color, defaultAngle, controls) {
    this.id = id;
    this.name = name;
    this.spawnX = x;
    this.spawnY = y;
    this.x = x;
    this.y = y;
    this.radius = CONFIG.PLAYER_RADIUS;
    this.color = color;
    this.angle = defaultAngle;
    this.defaultAngle = defaultAngle;
    this.controls = controls;

    this.hp = CONFIG.PLAYER_MAX_HP;
    this.score = 0;
    this.cooldown = 0;
    this.respawnTimer = 0;
    this.shieldTimer = 0;
    this.muzzleFlashTimer = 0;
    this.useMouseAim = false;
  }

  resetForNewMatch() {
    this.score = 0;
    this.respawn();
    this.shieldTimer = 0;
  }

  respawn() {
    this.x = this.spawnX;
    this.y = this.spawnY;
    this.hp = CONFIG.PLAYER_MAX_HP;
    this.angle = this.defaultAngle;
    this.respawnTimer = 0;
    this.shieldTimer = CONFIG.SPAWN_SHIELD_TIME;
  }

  update(dt, keys, mouse, obstacles, bullets, sparks) {
    if (this.respawnTimer > 0) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.respawn();
      return;
    }

    if (this.cooldown > 0) this.cooldown -= dt;
    if (this.shieldTimer > 0) this.shieldTimer -= dt;
    if (this.muzzleFlashTimer > 0) this.muzzleFlashTimer -= dt;

    // 1. Read directional input
    let dx = 0;
    let dy = 0;
    if (keys[this.controls.up]) dy -= 1;
    if (keys[this.controls.down]) dy += 1;
    if (keys[this.controls.left]) dx -= 1;
    if (keys[this.controls.right]) dx += 1;

    const dir = normalizeVector(dx, dy);

    // 2. Move along X then Y separately so player slides smoothly along walls
    const nextX = clamp(this.x + dir.x * CONFIG.PLAYER_SPEED * dt, this.radius, CONFIG.WIDTH - this.radius);
    if (!obstacles.some(o => circleRectCollide(nextX, this.y, this.radius, o.x, o.y, o.w, o.h))) {
      this.x = nextX;
    }

    const nextY = clamp(this.y + dir.y * CONFIG.PLAYER_SPEED * dt, this.radius, CONFIG.HEIGHT - this.radius);
    if (!obstacles.some(o => circleRectCollide(this.x, nextY, this.radius, o.x, o.y, o.w, o.h))) {
      this.y = nextY;
    }

    // 3. Aiming: Mouse aim (if enabled on P1) or last movement direction (8-way keyboard)
    if (this.useMouseAim) {
      // atan2(dy, dx) returns the angle in radians between the player and mouse cursor
      this.angle = Math.atan2(mouse.y - this.y, mouse.x - this.x);
    } else if (dir.x !== 0 || dir.y !== 0) {
      this.angle = Math.atan2(dir.y, dir.x);
    }

    // 4. Firing weapon
    const wantsToFire =
      keys[this.controls.fire] ||
      keys[this.controls.altFire] ||
      (this.useMouseAim && mouse.down);

    if (wantsToFire && this.cooldown <= 0) {
      this.fire(bullets, sparks);
    }
  }

  fire(bullets, sparks) {
    this.cooldown = CONFIG.FIRE_COOLDOWN;
    this.muzzleFlashTimer = 0.06;
    const barrelDist = this.radius + 8;
    const bx = this.x + Math.cos(this.angle) * barrelDist;
    const by = this.y + Math.sin(this.angle) * barrelDist;

    bullets.push(new PlasmaPulse(this.id, bx, by, this.angle, this.color));
    SoundFX.laser();

    if (CONFIG.ENABLE_VFX) {
      for (let i = 0; i < 4; i++) {
        sparks.push(new Spark(bx, by, this.color));
      }
    }
  }
}

// ============================================================================
// SINGLE STRUCTURED GAME STATE & MAIN LOOP
// ============================================================================

const gameState = {
  phase: 'START', // 'START' | 'PLAYING' | 'PAUSED' | 'GAMEOVER'
  timeLeft: CONFIG.ROUND_TIME_SECONDS,
  winnerText: '',
  lastTimestamp: 0,
  keys: {},
  mouse: { x: CONFIG.WIDTH / 2, y: CONFIG.HEIGHT / 2, down: false },
  players: [],
  bullets: [],
  sparks: [],
  obstacles: CONFIG.OBSTACLES
};

function createPlayers() {
  return [
    new Player(1, 'CYAN STRIKER', 90, CONFIG.HEIGHT / 2, CONFIG.COLORS.P1, 0, {
      up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD', fire: 'Space', altFire: 'KeyF'
    }),
    new Player(2, 'MAGENTA PHANTOM', CONFIG.WIDTH - 90, CONFIG.HEIGHT / 2, CONFIG.COLORS.P2, Math.PI, {
      up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', fire: 'Enter', altFire: 'Slash'
    })
  ];
}

function startNewMatch() {
  if (gameState.players.length === 0) {
    gameState.players = createPlayers();
  }
  gameState.players.forEach(p => p.resetForNewMatch());
  gameState.bullets = [];
  gameState.sparks = [];
  gameState.timeLeft = CONFIG.ROUND_TIME_SECONDS;
  gameState.winnerText = '';
  gameState.phase = 'PLAYING';
  updateHUD();
}

function spawnHitSparks(x, y, color, count = 12) {
  if (!CONFIG.ENABLE_VFX) return;
  for (let i = 0; i < count; i++) {
    gameState.sparks.push(new Spark(x, y, color));
  }
}

function checkWinConditions() {
  const [p1, p2] = gameState.players;
  if (p1.score >= CONFIG.WIN_SCORE) {
    gameState.winnerText = `${p1.name} WINS THE SECTOR!`;
    gameState.phase = 'GAMEOVER';
  } else if (p2.score >= CONFIG.WIN_SCORE) {
    gameState.winnerText = `${p2.name} WINS THE SECTOR!`;
    gameState.phase = 'GAMEOVER';
  } else if (gameState.timeLeft <= 0) {
    if (p1.score > p2.score) gameState.winnerText = `TIME UP! ${p1.name} WINS!`;
    else if (p2.score > p1.score) gameState.winnerText = `TIME UP! ${p2.name} WINS!`;
    else gameState.winnerText = 'TIME UP! GRID STALEMATE (TIE)!';
    gameState.phase = 'GAMEOVER';
  }
}

function updateGame(dt) {
  if (gameState.phase !== 'PLAYING') return;

  // 1. Update Round Timer
  gameState.timeLeft = Math.max(0, gameState.timeLeft - dt);

  // 2. Update Players
  for (const player of gameState.players) {
    player.update(dt, gameState.keys, gameState.mouse, gameState.obstacles, gameState.bullets, gameState.sparks);
  }

  // 3. Update Bullets & Check Collisions
  for (const bullet of gameState.bullets) {
    bullet.update(dt, gameState.obstacles);
    if (!bullet.active) {
      spawnHitSparks(bullet.x, bullet.y, CONFIG.COLORS.OBSTACLE_GLOW, 5);
      continue;
    }

    for (const target of gameState.players) {
      if (target.id === bullet.ownerId || target.respawnTimer > 0) continue;

      if (circlesCollide(bullet.x, bullet.y, bullet.radius, target.x, target.y, target.radius)) {
        bullet.active = false;
        const result = calculateDamage(target.hp, CONFIG.BULLET_DAMAGE, target.shieldTimer > 0);
        target.hp = result.hp;

        spawnHitSparks(bullet.x, bullet.y, target.color, result.eliminated ? 26 : 10);

        if (result.eliminated) {
          SoundFX.eliminate();
          target.respawnTimer = CONFIG.RESPAWN_DELAY;
          const shooter = gameState.players.find(p => p.id === bullet.ownerId);
          if (shooter) shooter.score += 1;
        } else {
          SoundFX.hit();
        }
      }
    }
  }

  gameState.bullets = gameState.bullets.filter(b => b.active);

  // 4. Update Particles
  for (const spark of gameState.sparks) spark.update(dt);
  gameState.sparks = gameState.sparks.filter(s => s.life > 0);

  checkWinConditions();
  updateHUD();
}

// ============================================================================
// RENDERING & HUD
// ============================================================================

function updateHUD() {
  if (typeof document === 'undefined' || gameState.players.length < 2) return;
  const [p1, p2] = gameState.players;

  const p1HealthEl = document.getElementById('p1-health');
  const p2HealthEl = document.getElementById('p2-health');
  const p1ScoreEl = document.getElementById('p1-score');
  const p2ScoreEl = document.getElementById('p2-score');
  const p1AimEl = document.getElementById('p1-aim-mode');
  const timerEl = document.getElementById('timer-display');

  if (p1HealthEl) p1HealthEl.style.width = `${(p1.hp / CONFIG.PLAYER_MAX_HP) * 100}%`;
  if (p2HealthEl) p2HealthEl.style.width = `${(p2.hp / CONFIG.PLAYER_MAX_HP) * 100}%`;
  if (p1ScoreEl) p1ScoreEl.textContent = p1.score;
  if (p2ScoreEl) p2ScoreEl.textContent = p2.score;
  if (p1AimEl) p1AimEl.textContent = p1.useMouseAim ? 'MOUSE' : 'KEYS';

  if (timerEl) {
    const totalSec = Math.ceil(gameState.timeLeft);
    const mins = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const secs = String(totalSec % 60).padStart(2, '0');
    timerEl.textContent = `${mins}:${secs}`;
  }
}

function renderGame(ctx) {
  ctx.clearRect(0, 0, CONFIG.WIDTH, CONFIG.HEIGHT);

  // 1. Cyber Grid Background
  ctx.strokeStyle = CONFIG.COLORS.GRID;
  ctx.lineWidth = 1;
  const gridSize = 50;
  for (let x = 0; x <= CONFIG.WIDTH; x += gridSize) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, CONFIG.HEIGHT); ctx.stroke();
  }
  for (let y = 0; y <= CONFIG.HEIGHT; y += gridSize) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CONFIG.WIDTH, y); ctx.stroke();
  }

  // 2. Holo-Barriers (Obstacles)
  ctx.save();
  if (CONFIG.ENABLE_VFX) {
    ctx.shadowColor = CONFIG.COLORS.OBSTACLE_GLOW;
    ctx.shadowBlur = 12;
  }
  ctx.fillStyle = CONFIG.COLORS.OBSTACLE_FILL;
  ctx.strokeStyle = CONFIG.COLORS.OBSTACLE_GLOW;
  ctx.lineWidth = 2;
  for (const obs of gameState.obstacles) {
    ctx.fillRect(obs.x, obs.y, obs.w, obs.h);
    ctx.strokeRect(obs.x, obs.y, obs.w, obs.h);
  }
  ctx.restore();

  // 3. Sparks
  for (const spark of gameState.sparks) {
    ctx.save();
    ctx.globalAlpha = Math.max(0, spark.life / spark.maxLife);
    ctx.fillStyle = spark.color;
    ctx.fillRect(spark.x - 2, spark.y - 2, 4, 4);
    ctx.restore();
  }

  // 4. Plasma Pulses (Bullets)
  for (const b of gameState.bullets) {
    ctx.save();
    if (CONFIG.ENABLE_VFX) {
      ctx.shadowColor = b.color;
      ctx.shadowBlur = 10;
    }
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = b.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  // 5. Players & Floating Health Bars
  for (const p of gameState.players) {
    if (p.respawnTimer > 0) continue;

    ctx.save();
    if (CONFIG.ENABLE_VFX) {
      ctx.shadowColor = p.color;
      ctx.shadowBlur = 15;
    }

    // Spawn shield ring
    if (p.shieldTimer > 0) {
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.radius + 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Player body
    ctx.fillStyle = '#0b0e1a';
    ctx.strokeStyle = p.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Aiming turret barrel
    const barrelLen = p.radius + 9;
    const tipX = p.x + Math.cos(p.angle) * barrelLen;
    const tipY = p.y + Math.sin(p.angle) * barrelLen;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(tipX, tipY);
    ctx.stroke();

    // Muzzle flash
    if (p.muzzleFlashTimer > 0 && CONFIG.ENABLE_VFX) {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(tipX, tipY, 7, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Overhead mini health bar
    const barW = 36;
    const barH = 5;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(p.x - barW / 2, p.y - p.radius - 14, barW, barH);
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x - barW / 2, p.y - p.radius - 14, (p.hp / CONFIG.PLAYER_MAX_HP) * barW, barH);
  }

  // 6. Overlay Screens (Start, Pause, Game Over)
  if (gameState.phase !== 'PLAYING') {
    ctx.fillStyle = 'rgba(6, 7, 15, 0.82)';
    ctx.fillRect(0, 0, CONFIG.WIDTH, CONFIG.HEIGHT);

    ctx.textAlign = 'center';
    ctx.fillStyle = '#00f3ff';
    ctx.font = 'bold 38px "Courier New", monospace';

    if (gameState.phase === 'START') {
      ctx.fillText('NEON CITY // CYBER-GRID SHOWDOWN', CONFIG.WIDTH / 2, 220);
      ctx.fillStyle = '#e2e8f0';
      ctx.font = '18px "Courier New", monospace';
      ctx.fillText('P1 (Cyan): WASD to Move, SPACE to Fire (Press M for Mouse Aim)', CONFIG.WIDTH / 2, 285);
      ctx.fillText('P2 (Magenta): ARROW KEYS to Move, ENTER to Fire', CONFIG.WIDTH / 2, 320);
      ctx.fillStyle = '#ff007f';
      ctx.font = 'bold 24px "Courier New", monospace';
      ctx.fillText('[ PRESS SPACE OR ENTER TO INITIALIZE COMBAT ]', CONFIG.WIDTH / 2, 390);
    } else if (gameState.phase === 'PAUSED') {
      ctx.fillText('SYSTEM PAUSED', CONFIG.WIDTH / 2, 270);
      ctx.fillStyle = '#e2e8f0';
      ctx.font = '20px "Courier New", monospace';
      ctx.fillText('Press P or ESC to Resume | Press R to Restart Match', CONFIG.WIDTH / 2, 330);
    } else if (gameState.phase === 'GAMEOVER') {
      ctx.fillText(gameState.winnerText, CONFIG.WIDTH / 2, 260);
      ctx.fillStyle = '#ff007f';
      ctx.font = 'bold 24px "Courier New", monospace';
      ctx.fillText('[ PRESS R OR ENTER TO DEPLOY AGAIN ]', CONFIG.WIDTH / 2, 340);
    }
  }
}

// ============================================================================
// INITIALIZATION & EVENT LISTENERS
// ============================================================================

function initBrowserApp() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  const canvas = document.getElementById('game-canvas');
  if (!canvas) {
    console.error('Initialization Error: Missing #game-canvas element.');
    return;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    console.error('Initialization Error: 2D Canvas context not supported.');
    return;
  }

  gameState.players = createPlayers();

  window.addEventListener('keydown', (e) => {
    // Prevent default scrolling for game keys
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      e.preventDefault();
    }
    gameState.keys[e.code] = true;

    if (gameState.phase === 'START' && (e.code === 'Space' || e.code === 'Enter')) {
      startNewMatch();
    } else if (e.code === 'KeyP' || e.code === 'Escape') {
      if (gameState.phase === 'PLAYING') gameState.phase = 'PAUSED';
      else if (gameState.phase === 'PAUSED') gameState.phase = 'PLAYING';
    } else if (e.code === 'KeyR' && (gameState.phase === 'GAMEOVER' || gameState.phase === 'PAUSED')) {
      startNewMatch();
    } else if (e.code === 'Enter' && gameState.phase === 'GAMEOVER') {
      startNewMatch();
    } else if (e.code === 'KeyM' && gameState.players[0]) {
      gameState.players[0].useMouseAim = !gameState.players[0].useMouseAim;
      updateHUD();
    }
  });

  window.addEventListener('keyup', (e) => {
    gameState.keys[e.code] = false;
  });

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    gameState.mouse.x = (e.clientX - rect.left) * scaleX;
    gameState.mouse.y = (e.clientY - rect.top) * scaleY;
  });

  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 0) gameState.mouse.down = true;
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) gameState.mouse.down = false;
  });

  function loop(timestamp) {
    if (!gameState.lastTimestamp) gameState.lastTimestamp = timestamp;
    // Cap delta time at 0.1s so tab-switching doesn't cause giant physics jumps
    const dt = Math.min((timestamp - gameState.lastTimestamp) / 1000, 0.1);
    gameState.lastTimestamp = timestamp;

    updateGame(dt);
    renderGame(ctx);
    requestAnimationFrame(loop);
  }

  requestAnimationFrame(loop);
}

initBrowserApp();

// Export pure logic functions for Node.js or Browser Console testing
const NeonLogic = {
  clamp,
  normalizeVector,
  circlesCollide,
  circleRectCollide,
  calculateDamage
};

if (typeof window !== 'undefined') window.NeonLogic = NeonLogic;
if (typeof module !== 'undefined' && module.exports) module.exports = NeonLogic;