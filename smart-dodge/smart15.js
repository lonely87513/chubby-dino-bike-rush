// Smart dodge V15 — V4 + Predictive Up + Counter-Dodge for moving obstacles
// 1. When no close threat (closestThreat > 100), reward "up" (speed up) — aggressive scoring
// 2. After 30s: detect moving obstacles (vx != 0), predict their position 30 frames ahead,
//    if they'd be near the player, recommend lane change in OPPOSITE direction of vx
// Base: V4 scoring (no bomb bias, no slow-first)
const { chromium } = require('playwright');
const fs = require('fs');

const URL = 'https://lonely87513.github.io/chubby-dino-bike-rush/';
const MAX_GAME_MS = 120000;
const TICK_MS = 80;
const SIM_FRAMES = 30;
const PHASE2_MS = 30000;  // 30s mark: counter-dodge activates
const SAFE_THRESHOLD = 100;  // closestThreat above this = "safe" for up bonus
const COUNTER_DODGE_DIST = 100;  // distance threshold for counter-dodge to apply
const COUNTER_DODGE_BONUS = 200;  // bonus for counter-direction action
const PREDICTIVE_UP_BONUS_MULT = 0.5;  // multiplier for predictive up bonus
const ACTIONS = ['left', 'right', 'up', 'down', 'none'];
const KEYMAP = { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown' };

const sleep = (ms, abort) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  if (abort) abort.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); });
});

function simulate(state, action, frames) {
  const roadLeft = state.roadLeft;
  const roadWidth = state.roadWidth;
  const width = state.player.width;
  const minX = roadLeft + width * 0.4;
  const maxX = roadLeft + roadWidth - width * 0.4;
  const collisionR = (state.player.hitboxW + state.player.hitboxH) * 0.25;
  const friction = state.friction;
  const speedBase = state.speed;
  const speedCap = state.speedCap;
  const baseY = state.player.baseY;
  const ob = state.obstacles.map(o => ({ x: o.x, y: o.y, r: o.r, vx: o.vx, isMoving: o.isMoving, type: o.type }));
  const items = state.fallingItems.map(it => ({ ...it }));

  let p = { x: state.player.x, y: state.player.y, velX: state.player.velX, sm: state.player.sm, targetY: state.player.y };
  let collidedAt = -1;
  let collidedType = null;
  let closestThreat = Infinity;
  let closestBomb = Infinity;
  let closestBombAtFrame = -1;
  let starsCollected = 0;
  let bombsNearby = 0;
  let bombTrajectories = [];

  for (let f = 0; f < frames; f++) {
    if (action === 'left')  p.velX -= 0.85;
    if (action === 'right') p.velX += 0.85;
    p.velX *= friction;
    p.x += p.velX;
    if (p.x < minX) { p.x = minX; p.velX = 0; }
    if (p.x > maxX) { p.x = maxX; p.velX = 0; }

    if (action === 'up') {
      p.sm = Math.min(p.sm + 0.03, speedCap);
      p.targetY = baseY - 40;
    } else if (action === 'down') {
      p.sm = Math.max(p.sm - 0.03, 0.6);
      p.targetY = baseY + 30;
    } else {
      p.sm += (1.0 - p.sm) * 0.05;
      p.targetY = baseY;
    }
    p.y += (p.targetY - p.y) * 0.1;

    const speed = speedBase * p.sm;
    for (const o of ob) {
      o.y += speed;
      if (o.isMoving) o.x += o.vx;
      const dx = p.x - o.x;
      const dy = p.y - o.y;
      const d = Math.sqrt(dx * dx + dy * dy) - o.r - collisionR;
      if (d < closestThreat) closestThreat = d;
    }
    let bombsNearby = 0;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      it.y += speed + 3.5;
      const dx = p.x - it.x;
      const dy = p.y - it.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < it.radius + collisionR) {
        if (it.isBomb) { collidedAt = f; collidedType = 'bomb'; break; }
        else { starsCollected++; items.splice(i, 1); }
      }
      if (it.isBomb) {
        if (dist < closestBomb) {
          closestBomb = dist;
          closestBombAtFrame = f;
        }
        if (dist < 300) bombsNearby++;
        bombTrajectories.push({ frame: f, x: it.x, y: it.y, dist });
      }
    }
    if (collidedAt >= 0) break;
    for (const o of ob) {
      const dx = p.x - o.x;
      const dy = p.y - o.y;
      const d2 = dx * dx + dy * dy;
      const r = o.r + collisionR;
      if (d2 < r * r) { collidedAt = f; collidedType = 'obstacle'; break; }
    }
    if (collidedAt >= 0) break;
  }

  return { collidedAt, collidedType, p, closestThreat, closestBomb, closestBombAtFrame, starsCollected, bombsNearby, bombTrajectories };
}

// V15: V4 + Predictive Up bonus + Counter-dodge for moving obstacles
function scoreAction(state, rollout, action, useCounterDodge) {
  if (rollout.collidedAt >= 0) {
    if (rollout.collidedType === 'bomb') return -300000 + rollout.collidedAt * 50;
    return -100000 + rollout.collidedAt * 100;
  }

  const centerX = state.roadLeft + state.roadWidth / 2;
  const centrality = -Math.abs(rollout.p.x - centerX) * 0.3;
  const threatMargin = Math.min(rollout.closestThreat, 200) * 0.5;
  const progressBonus = (rollout.p.sm - 1.0) * 2;
  let starBonus = (rollout.starsCollected || 0) * 400;

  // V4 baseline
  let score = 1000 + centrality + threatMargin + progressBonus + starBonus;

  // V15: Predictive Up bonus when no close threat
  if (rollout.closestThreat > SAFE_THRESHOLD && action === 'up') {
    score += (rollout.closestThreat - SAFE_THRESHOLD) * PREDICTIVE_UP_BONUS_MULT;
  }

  // V15: Counter-dodge for moving obstacles (after 30s)
  if (useCounterDodge) {
    const speed = state.speed * rollout.p.sm;  // use final sm for projection
    const playerX = rollout.p.x;
    const playerY = rollout.p.y;
    for (const o of state.obstacles) {
      if (!o.isMoving || !o.vx) continue;
      // Project obstacle position 30 frames ahead
      const futureX = o.x + o.vx * SIM_FRAMES;
      const futureY = o.y + speed * SIM_FRAMES;
      const dx = futureX - playerX;
      const dy = futureY - playerY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < COUNTER_DODGE_DIST) {
        // Counter-dodge: recommend opposite direction of vx
        if (o.vx > 0 && action === 'left') score += COUNTER_DODGE_BONUS;
        if (o.vx < 0 && action === 'right') score += COUNTER_DODGE_BONUS;
      }
    }
  }

  return score;
}

async function runOne(browser, gameIdx) {
  const ctx = await browser.newContext({
    viewport: { width: 414, height: 736 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log(`  [g${gameIdx} PAGEERROR] ${e.message}`));

  await page.addInitScript(() => {
    const noop = () => {};
    const noopNode = {
      connect: noop, disconnect: noop, start: noop, stop: noop,
      frequency: { value: 0, setValueAtTime: noop, linearRampToValueAtTime: noop, exponentialRampToValueAtTime: noop },
      gain: { value: 0, setValueAtTime: noop, linearRampToValueAtTime: noop, exponentialRampToValueAtTime: noop },
      type: 'sine',
    };
    window.AudioContext = function () {
      return {
        currentTime: 0, destination: noopNode, state: 'running',
        resume: noop, suspend: noop, close: noop,
        createOscillator: () => ({ ...noopNode, frequency: noopNode.frequency }),
        createGain: () => ({ ...noopNode, gain: noopNode.gain }),
        createBuffer: () => ({ getChannelData: () => new Float32Array(1) }),
        createBufferSource: () => ({ connect: noop, start: noop, stop: noop, buffer: null }),
        createBiquadFilter: () => ({ ...noopNode, type: 'lowpass', frequency: noopNode.frequency }),
        createDynamicsCompressor: () => noopNode,
        createAnalyser: () => ({ ...noopNode, getByteFrequencyData: noop, getByteTimeDomainData: noop }),
        createStereoPanner: () => noopNode,
        createDelay: () => noopNode,
        createWaveShaper: () => noopNode,
        createPanner: () => noopNode,
        createConvolver: () => noopNode,
      };
    };
    window.webkitAudioContext = window.AudioContext;

    window.__gameOverInfo = null;
    function snapshotState() {
      try {
        let minObsD = Infinity, hitObs = null, bombsNear = 0, starsNear = 0, movingObs = 0;
        if (typeof obstacles !== 'undefined' && player) {
          for (const o of obstacles) {
            const dx = player.x - o.x, dy = player.y - o.y;
            const d = Math.sqrt(dx*dx + dy*dy);
            if (d < minObsD) { minObsD = d; hitObs = o; }
            if (o.isMoving) movingObs++;
          }
        }
        if (typeof fallingItems !== 'undefined' && player) {
          for (const it of fallingItems) {
            const dx = player.x - it.x, dy = player.y - it.y;
            const d = Math.sqrt(dx*dx + dy*dy);
            if (d < 300) {
              if (it.isBomb) bombsNear++;
              else starsNear++;
            }
          }
        }
        return {
          finalScore: typeof score !== 'undefined' ? score : null,
          finalDist: typeof distance !== 'undefined' ? distance : null,
          finalBonus: typeof bonusScore !== 'undefined' ? bonusScore : null,
          player: player ? { x: player.x, y: player.y, baseY: player.baseY, velX: player.velX, sm: player.speedMultiplier } : null,
          weather: typeof currentWeather !== 'undefined' ? currentWeather : null,
          nearestObsDist: minObsD === Infinity ? null : minObsD,
          hitObs: hitObs ? { type: hitObs.type, r: hitObs.r, isMoving: hitObs.isMoving } : null,
          bombsNear300: bombsNear,
          starsNear300: starsNear,
          movingObsCount: movingObs,
        };
      } catch (e) { return { err: e.message }; }
    }
    setTimeout(() => {
      if (typeof triggerGameOver === 'function') {
        const orig = triggerGameOver;
        try {
          window.triggerGameOver = function(hitType) {
            window.__gameOverInfo = snapshotState();
            window.__gameOverInfo.hitType = hitType;
            return orig.call(this, hitType);
          };
        } catch (e) {}
      }
    }, 600);
    let lastGs = null;
    setInterval(() => {
      if (typeof gameState === 'undefined') return;
      if (gameState === 'GAMEOVER' && lastGs !== 'GAMEOVER' && !window.__gameOverInfo) {
        window.__gameOverInfo = snapshotState();
        window.__gameOverInfo.hitType = 'polled';
      }
      lastGs = gameState;
    }, 80);
  });

  const wallStart = Date.now();
  const result = {
    gameIdx, strategy: 'smart15-predictive-up-counter-dodge',
    startTime: new Date(wallStart).toISOString(),
    finalScore: null, finalTime: null, finalDist: null, finalBonus: null,
    error: null, ticks: 0,
    actions: { left: 0, right: 0, up: 0, down: 0, none: 0 },
    phase1Ticks: 0,
    phase2Ticks: 0,
    movingObsTicks: 0,        // ticks with any moving obstacle on screen
    counterDodgeDecisions: 0, // ticks where counter-dodge was applicable and triggered
    phase1UpCount: 0,         // up actions during phase 1
    phase2UpCount: 0,         // up actions during phase 2
    scoreAt30s: null,
    bombDeaths: 0,
    gameOver: null,
  };
  const abortCtl = new AbortController();
  let currentKey = null;

  async function setKey(key) {
    if (currentKey === key) return;
    if (currentKey) try { await page.keyboard.up(currentKey); } catch {}
    if (key) try { await page.keyboard.down(key); } catch {}
    currentKey = key;
  }

  async function smartLoop() {
    let lastChosen = 'none';
    while (!abortCtl.signal.aborted) {
      let state;
      try {
        state = await page.evaluate(() => {
          if (typeof gameState === 'undefined' || typeof obstacles === 'undefined') return null;
          if (gameState !== 'PLAYING') return { gameState };
          return {
            gameState,
            time: typeof score !== 'undefined' ? score : 0,
            player: { x: player.x, y: player.y, baseY: player.baseY, velX: player.velX, width: player.width, hitboxW: player.hitboxW, hitboxH: player.hitboxH, sm: player.speedMultiplier },
            obstacles: obstacles.map(o => ({ x: o.x, y: o.y, r: o.r, vx: o.vx || 0, isMoving: o.isMoving, type: o.type })),
            fallingItems: (typeof fallingItems !== 'undefined' ? fallingItems : []).map(it => ({ x: it.x, y: it.y, radius: it.radius, isBomb: it.isBomb })),
            roadLeft: getCurrentRoadLeft(),
            roadWidth: getCurrentRoadWidth(),
            speed: currentRoadSpeed,
            friction: currentFriction,
            speedCap: 1.7,
          };
        });
      } catch { break; }
      result.ticks++;
      if (!state || state.gameState !== 'PLAYING') break;

      const elapsedMs = Date.now() - wallStart;
      const useCounterDodge = elapsedMs >= PHASE2_MS;
      const inPhase1 = !useCounterDodge;
      if (inPhase1) result.phase1Ticks++; else result.phase2Ticks++;

      if (result.scoreAt30s === null && elapsedMs >= PHASE2_MS) {
        result.scoreAt30s = state.time;
      }

      // Count moving obstacles
      let movingObsCount = 0;
      for (const o of state.obstacles) {
        if (o.isMoving && o.vx) movingObsCount++;
      }
      if (movingObsCount > 0) result.movingObsTicks++;

      // Pre-compute counter-dodge recommendations (for logging)
      let counterDodgeApplicable = false;
      if (useCounterDodge) {
        for (const o of state.obstacles) {
          if (!o.isMoving || !o.vx) continue;
          const speed = state.speed * 1.0;  // approximate
          const futureX = o.x + o.vx * SIM_FRAMES;
          const futureY = o.y + speed * SIM_FRAMES;
          const dx = futureX - state.player.x;
          const dy = futureY - state.player.y;
          if (Math.sqrt(dx*dx + dy*dy) < COUNTER_DODGE_DIST) {
            counterDodgeApplicable = true;
            break;
          }
        }
      }

      const scores = {};
      for (const a of ACTIONS) {
        const r = simulate(state, a, SIM_FRAMES);
        scores[a] = scoreAction(state, r, a, useCounterDodge);
      }

      const sorted = ACTIONS.slice().sort((a, b) => {
        if (scores[b] !== scores[a]) return scores[b] - scores[a];
        return a === lastChosen ? -1 : b === lastChosen ? 1 : 0;
      });
      const best = sorted[0];
      lastChosen = best;
      result.actions[best] = (result.actions[best] || 0) + 1;

      if (inPhase1) {
        if (best === 'up') result.phase1UpCount++;
      } else {
        if (best === 'up') result.phase2UpCount++;
      }

      if (counterDodgeApplicable && (best === 'left' || best === 'right')) {
        result.counterDodgeDecisions++;
      }

      await setKey(best === 'none' ? null : KEYMAP[best]);

      await sleep(TICK_MS, abortCtl.signal);
    }
    if (currentKey) try { await page.keyboard.up(currentKey); } catch {}
  }

  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('#start-screen', { timeout: 15000 });
    await page.waitForTimeout(300);
    await page.click('#start-btn');

    const dodgePromise = smartLoop();
    const deadline = Date.now() + MAX_GAME_MS;
    let finished = false;
    while (Date.now() < deadline) {
      await sleep(200, abortCtl.signal).catch(() => {});
      const gs = await page.evaluate(() => typeof gameState !== 'undefined' ? gameState : 'unknown').catch(() => 'error');
      if (gs === 'GAMEOVER') { finished = true; break; }
    }
    abortCtl.abort();
    await dodgePromise.catch(() => {});

    if (finished) {
      const read = await page.evaluate(() => ({
        finalScore: parseInt(document.getElementById('final-score')?.innerText) || 0,
        finalTime: parseInt(document.getElementById('final-time')?.innerText) || 0,
        finalDist: parseInt(document.getElementById('final-dist')?.innerText) || 0,
        finalBonus: parseInt(document.getElementById('final-bonus')?.innerText) || 0,
        gameOver: window.__gameOverInfo || null,
      })).catch(e => ({ error: e.message }));
      if (read.error) result.error = 'read-fail: ' + read.error;
      else Object.assign(result, read);
      if (read.gameOver?.hitType === 'bomb') result.bombDeaths = 1;
    } else {
      result.error = `no game over within ${MAX_GAME_MS/1000}s`;
      result.finalScore = await page.$eval('#score', el => parseInt(el.innerText) || 0).catch(() => 0);
    }
  } catch (e) {
    result.error = e.message;
  } finally {
    abortCtl.abort();
    if (currentKey) try { await page.keyboard.up(currentKey); } catch {}
    try { await ctx.close(); } catch {}
    result.endTime = new Date().toISOString();
    result.durationMs = Date.now() - wallStart;
    const a = result.actions;
    const actStr = `L${a.left||0}/R${a.right||0}/U${a.up||0}/D${a.down||0}/·${a.none||0}`;
    const go = result.gameOver;
    const goStr = go && !go.err ? `${go.hitType || '?'} obs@${go.nearestObsDist?.toFixed(0) || '?'}px ${go.hitObs?.type || '-'} mv=${go.movingObsCount || 0} bombs@${go.bombsNear300 || 0}/s@${go.starsNear300 || 0}` : '-';
    const p1Pct = result.ticks > 0 ? (result.phase1Ticks / result.ticks * 100).toFixed(0) : '0';
    const p2Pct = result.ticks > 0 ? (result.phase2Ticks / result.ticks * 100).toFixed(0) : '0';
    console.log(`[g${gameIdx}] smart15 score=${String(result.finalScore).padStart(5)} t=${String(result.finalTime||0).padStart(3)}s d=${String(result.finalDist||0).padStart(5)}m b=${String(result.finalBonus||0).padStart(4)} ${actStr} p1=${p1Pct}% p2=${p2Pct}% uP1=${result.phase1UpCount} uP2=${result.phase2UpCount} mvT=${result.movingObsTicks} cd=${result.counterDodgeDecisions} s30=${result.scoreAt30s || '?'} [${goStr}] (${(result.durationMs/1000).toFixed(1)}s) err=${result.error || 'none'}`);
  }
  return result;
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--mute-audio','--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows'],
  });

  const N = 10;
  const all = [];
  for (let i = 0; i < N; i++) {
    all.push(await runOne(browser, i));
  }
  await browser.close();
  fs.writeFileSync('/tmp/stress/smart15-results.json', JSON.stringify(all, null, 2));

  const ok = all.filter(r => r.error == null && r.finalScore > 100);
  console.log('\n=== SMART15 PREDICTIVE-UP COUNTER-DODGE SUMMARY ===');
  if (ok.length === 0) { console.log('No successful runs'); }
  else {
    const scores = ok.map(r => r.finalScore);
    const times = ok.map(r => r.finalTime || 0);
    const dists = ok.map(r => r.finalDist || 0);
    const bonuses = ok.map(r => r.finalBonus || 0);
    const scoreAt30s = ok.map(r => r.scoreAt30s || 0);
    const avg = (a) => (a.reduce((s,x)=>s+x,0) / a.length).toFixed(1);
    const min = (a) => Math.min(...a);
    const max = (a) => Math.max(...a);

    const totalP1 = ok.reduce((s,r) => s + (r.phase1Ticks || 0), 0);
    const totalP2 = ok.reduce((s,r) => s + (r.phase2Ticks || 0), 0);
    const totalMv = ok.reduce((s,r) => s + (r.movingObsTicks || 0), 0);
    const totalCd = ok.reduce((s,r) => s + (r.counterDodgeDecisions || 0), 0);
    const totalUpP1 = ok.reduce((s,r) => s + (r.phase1UpCount || 0), 0);
    const totalUpP2 = ok.reduce((s,r) => s + (r.phase2UpCount || 0), 0);
    const totalUp = totalUpP1 + totalUpP2;
    const totalBombDeaths = ok.reduce((s,r) => s + (r.bombDeaths || 0), 0);

    console.log(`SMART15 (n=${ok.length}): score ${min(scores)}-${max(scores)} avg=${avg(scores)} | time ${min(times)}-${max(times)}s avg=${avg(times)}s | dist ${min(dists)}-${max(dists)}m avg=${avg(dists)}m | bonus ${min(bonuses)}-${max(bonuses)} avg=${avg(bonuses)}`);
    console.log(`Score at 30s mark: ${min(scoreAt30s)}-${max(scoreAt30s)} avg=${avg(scoreAt30s)}`);
    console.log(`Mode split: Phase 1 (0-30s) ${(totalP1/(totalP1+totalP2)*100).toFixed(0)}% (${totalP1} ticks) | Phase 2 (30s+ counter-dodge) ${(totalP2/(totalP1+totalP2)*100).toFixed(0)}% (${totalP2} ticks)`);
    console.log(`UP actions: P1=${totalUpP1} (${(totalUpP1/totalP1*100).toFixed(0)}% of P1) | P2=${totalUpP2} (${(totalUpP2/totalP2*100).toFixed(0)}% of P2) | Total ${totalUp} (${(totalUp/(totalP1+totalP2)*100).toFixed(0)}%)`);
    console.log(`Moving obstacle ticks: ${totalMv} (${(totalMv/(totalP1+totalP2)*100).toFixed(0)}% of total) — counter-dodge triggered ${totalCd} times`);
    console.log(`Bomb deaths: ${totalBombDeaths}/${ok.length}`);
  }

  console.log('\n=== COMPARISON ===');
  const show = (label, results) => {
    if (!results) return;
    const s = results.filter(r => r.error == null && r.finalScore > 100);
    if (!s.length) return;
    const scores = s.map(r => r.finalScore);
    const avg = (a) => (a.reduce((s,x)=>s+x,0) / a.length).toFixed(1);
    const min = (a) => Math.min(...a);
    const max = (a) => Math.max(...a);
    console.log(`${label.padEnd(14)} (n=${s.length}): score ${min(scores)}-${max(scores)} avg=${avg(scores)}`);
  };
  let smart4_10 = null, smart4_100 = null, smart11_10 = null, smart12_10 = null, smart13_10 = null, smart14_10 = null;
  try { smart4_10 = JSON.parse(fs.readFileSync('/tmp/stress/smart4-results.json', 'utf8')); } catch {}
  try { smart4_100 = JSON.parse(fs.readFileSync('/tmp/stress/smart4-100-results.json', 'utf8')); } catch {}
  try { smart11_10 = JSON.parse(fs.readFileSync('/tmp/stress/smart11-results.json', 'utf8')); } catch {}
  try { smart12_10 = JSON.parse(fs.readFileSync('/tmp/stress/smart12-results.json', 'utf8')); } catch {}
  try { smart13_10 = JSON.parse(fs.readFileSync('/tmp/stress/smart13-results.json', 'utf8')); } catch {}
  try { smart14_10 = JSON.parse(fs.readFileSync('/tmp/stress/smart14-results.json', 'utf8')); } catch {}
  show('smart4(10)', smart4_10);
  show('smart4(100)', smart4_100);
  show('smart11(10)', smart11_10);
  show('smart12(10)', smart12_10);
  show('smart13(10)', smart13_10);
  show('smart14(10)', smart14_10);
  show('smart15(10)', all);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
