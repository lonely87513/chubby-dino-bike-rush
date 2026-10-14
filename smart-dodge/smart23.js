// Smart dodge V23 — V22 no-down extended to 20s+, conditional down fallback
// V22 baseline: V20 + Phase 1 (0-20s) no-down lane-escape (avg 5408.7)
// V23 NEW: Extend no-down policy to AFTER 20s. Only allow 'down' when BOTH
//   'left' and 'right' would collide (lane change unsafe). In that case,
//   down is allowed as the safe escape. Otherwise, no-down.
// Phase 1 logic (0-20s) remains the V19-style 60f lookahead conditional up
//   + V22-style no-down lane fallback.
const { chromium } = require('playwright');
const fs = require('fs');

const URL = 'https://lonely87513.github.io/chubby-dino-bike-rush/';
const MAX_GAME_MS = 120000;
const TICK_MS = 80;
const SIM_FRAMES = 30;
const EARLY_SIM_FRAMES = 60;
const FORCE_UP_MS = 20000;
const PHASE2_MS = 30000;
const EARLY_COLLIDE_CUTOFF = 50;
const SAFE_THRESHOLD = 100;
const COUNTER_DODGE_DIST = 100;
const COUNTER_DODGE_BONUS = 200;
const PREDICTIVE_UP_BONUS_MULT = 0.5;
const CLUSTER_Y_FORWARD = 250;
const CLUSTER_X_RANGE = 100;
const MULTI_OBS_THRESHOLD = 2;
const MULTI_OBS_UP_BONUS = 400;
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
  let starsCollected = 0;

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
      if (it.isBomb && dist < closestBomb) closestBomb = dist;
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

  return { collidedAt, collidedType, p, closestThreat, closestBomb, starsCollected };
}

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

  let score = 1000 + centrality + threatMargin + progressBonus + starBonus;

  if (rollout.closestThreat > SAFE_THRESHOLD && action === 'up') {
    score += (rollout.closestThreat - SAFE_THRESHOLD) * PREDICTIVE_UP_BONUS_MULT;
  }

  if (useCounterDodge) {
    const speed = state.speed * rollout.p.sm;
    const playerX = rollout.p.x;
    const playerY = rollout.p.y;
    for (const o of state.obstacles) {
      if (!o.isMoving || !o.vx) continue;
      const futureX = o.x + o.vx * SIM_FRAMES;
      const futureY = o.y + speed * SIM_FRAMES;
      const dx = futureX - playerX;
      const dy = futureY - playerY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < COUNTER_DODGE_DIST) {
        if (o.vx > 0 && action === 'left') score += COUNTER_DODGE_BONUS;
        if (o.vx < 0 && action === 'right') score += COUNTER_DODGE_BONUS;
      }
    }
  }

  let clusterCount = 0;
  let hasMovingInCluster = false;
  for (const o of state.obstacles) {
    const dy = o.y - state.player.y;
    if (dy < 0 && dy > -CLUSTER_Y_FORWARD) {
      if (Math.abs(o.x - state.player.x) < CLUSTER_X_RANGE) {
        clusterCount++;
        if (o.isMoving) hasMovingInCluster = true;
      }
    }
  }
  if (clusterCount >= MULTI_OBS_THRESHOLD && hasMovingInCluster && action === 'up') {
    score += MULTI_OBS_UP_BONUS * Math.min(clusterCount, 4);
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
    gameIdx, strategy: 'smart23-v22-no-down-extended-conditional-down',
    startTime: new Date(wallStart).toISOString(),
    finalScore: null, finalTime: null, finalDist: null, finalBonus: null,
    error: null, ticks: 0,
    actions: { left: 0, right: 0, up: 0, down: 0, none: 0 },
    earlyTicks: 0,
    postEarlyTicks: 0,
    earlyUpChosen: 0,
    earlyLaneEscape: 0,
    earlyDownInPhase1: 0,
    postEarlyNoDown: 0,         // 20s+ ticks where 'down' was excluded (no-down policy active)
    postEarlyDownFallback: 0,   // 20s+ ticks where both lane changes collided, down allowed
    postEarlyDownChosen: 0,     // 20s+ ticks where 'down' was actually chosen
    postEarlyLeftRightCollide: 0, // 20s+ ticks where both 'left' and 'right' would collide
    scoreAt20s: null,
    scoreAt30s: null,
    movingObsTicks: 0,
    counterDodgeTriggered: 0,
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
      const inEarlyPhase = elapsedMs < FORCE_UP_MS;
      const useCounterDodge = elapsedMs >= PHASE2_MS;
      if (inEarlyPhase) result.earlyTicks++; else result.postEarlyTicks++;

      if (result.scoreAt20s === null && elapsedMs >= FORCE_UP_MS) {
        result.scoreAt20s = state.time;
      }
      if (result.scoreAt30s === null && elapsedMs >= PHASE2_MS) {
        result.scoreAt30s = state.time;
      }

      let best;
      if (inEarlyPhase) {
        // V22-style Phase 1: force up, no-down lane-escape fallback
        const upSimLong = simulate(state, 'up', EARLY_SIM_FRAMES);
        if (upSimLong.collidedAt >= 0 && upSimLong.collidedAt < EARLY_COLLIDE_CUTOFF) {
          result.earlyLaneEscape++;
          const scores = {};
          const escapeActions = ACTIONS.filter(a => a !== 'down');
          for (const a of escapeActions) {
            const r = simulate(state, a, SIM_FRAMES);
            scores[a] = scoreAction(state, r, a, useCounterDodge);
          }
          const sorted = escapeActions.slice().sort((a, b) => {
            if (scores[b] !== scores[a]) return scores[b] - scores[a];
            return a === lastChosen ? -1 : b === lastChosen ? 1 : 0;
          });
          best = sorted[0];
        } else {
          best = 'up';
          result.earlyUpChosen++;
        }
        if (best === 'down') result.earlyDownInPhase1++;
      } else {
        // V23 NEW: Phase 2 (20s+) — extend no-down policy with conditional fallback
        let movingObsCount = 0;
        for (const o of state.obstacles) {
          if (o.isMoving && o.vx) movingObsCount++;
        }
        if (movingObsCount > 0) result.movingObsTicks++;

        // Simulate all 5 actions
        const rollouts = {};
        for (const a of ACTIONS) {
          rollouts[a] = simulate(state, a, SIM_FRAMES);
        }

        // V23: Check if both lane changes would collide → down is allowed
        const leftCollides = rollouts.left.collidedAt >= 0;
        const rightCollides = rollouts.right.collidedAt >= 0;
        const bothLaneChangeCollide = leftCollides && rightCollides;
        if (bothLaneChangeCollide) result.postEarlyLeftRightCollide++;

        // Default: no-down policy. Exception: both lane changes collide → allow down
        const actionsToConsider = bothLaneChangeCollide ? ACTIONS : ACTIONS.filter(a => a !== 'down');
        if (bothLaneChangeCollide) {
          result.postEarlyDownFallback++;
        } else {
          result.postEarlyNoDown++;
        }

        const scores = {};
        for (const a of actionsToConsider) {
          scores[a] = scoreAction(state, rollouts[a], a, useCounterDodge);
        }
        const sorted = actionsToConsider.slice().sort((a, b) => {
          if (scores[b] !== scores[a]) return scores[b] - scores[a];
          return a === lastChosen ? -1 : b === lastChosen ? 1 : 0;
        });
        best = sorted[0];
        if (best === 'down') result.postEarlyDownChosen++;

        if (useCounterDodge) {
          for (const o of state.obstacles) {
            if (!o.isMoving || !o.vx) continue;
            const futureX = o.x + o.vx * SIM_FRAMES;
            const futureY = o.y + state.speed * SIM_FRAMES;
            const dx = futureX - state.player.x;
            const dy = futureY - state.player.y;
            if (Math.sqrt(dx*dx + dy*dy) < COUNTER_DODGE_DIST) {
              if ((o.vx > 0 && best === 'left') || (o.vx < 0 && best === 'right')) {
                result.counterDodgeTriggered++;
                break;
              }
            }
          }
        }
      }

      lastChosen = best;
      result.actions[best] = (result.actions[best] || 0) + 1;
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
    const ePct = result.earlyTicks > 0 ? (result.earlyUpChosen / result.earlyTicks * 100).toFixed(0) : '0';
    const eEPct = result.earlyTicks > 0 ? (result.earlyLaneEscape / result.earlyTicks * 100).toFixed(0) : '0';
    const pEPct = result.postEarlyTicks > 0 ? (result.postEarlyNoDown / result.postEarlyTicks * 100).toFixed(0) : '0';
    const pFPct = result.postEarlyTicks > 0 ? (result.postEarlyDownFallback / result.postEarlyTicks * 100).toFixed(0) : '0';
    const pDPct = result.postEarlyTicks > 0 ? (result.postEarlyDownChosen / result.postEarlyTicks * 100).toFixed(0) : '0';
    console.log(`[g${gameIdx}] smart23 score=${String(result.finalScore).padStart(5)} t=${String(result.finalTime||0).padStart(3)}s d=${String(result.finalDist||0).padStart(5)}m b=${String(result.finalBonus||0).padStart(4)} ${actStr} P1:up${ePct}%/esc${eEPct}%|P2:noDwn${pEPct}%/fall${pFPct}%/dwn${pDPct}% s20=${result.scoreAt20s || '?'} s30=${result.scoreAt30s || '?'} [${goStr}] (${(result.durationMs/1000).toFixed(1)}s) err=${result.error || 'none'}`);
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
  fs.writeFileSync('/tmp/stress/smart23-results.json', JSON.stringify(all, null, 2));

  const ok = all.filter(r => r.error == null && r.finalScore > 100);
  console.log('\n=== SMART23 V22 + NO-DOWN EXTENDED TO PHASE 2 ===');
  if (ok.length === 0) { console.log('No successful runs'); }
  else {
    const scores = ok.map(r => r.finalScore);
    const times = ok.map(r => r.finalTime || 0);
    const dists = ok.map(r => r.finalDist || 0);
    const bonuses = ok.map(r => r.finalBonus || 0);
    const avg = (a) => (a.reduce((s,x)=>s+x,0) / a.length).toFixed(1);
    const min = (a) => Math.min(...a);
    const max = (a) => Math.max(...a);

    const totalP2NoDwn = ok.reduce((s,r) => s + (r.postEarlyNoDown || 0), 0);
    const totalP2Fall = ok.reduce((s,r) => s + (r.postEarlyDownFallback || 0), 0);
    const totalP2Dwn = ok.reduce((s,r) => s + (r.postEarlyDownChosen || 0), 0);
    const totalP2LRCollide = ok.reduce((s,r) => s + (r.postEarlyLeftRightCollide || 0), 0);
    const totalP2Ticks = ok.reduce((s,r) => s + (r.postEarlyTicks || 0), 0);
    const totalBombDeaths = ok.reduce((s,r) => s + (r.bombDeaths || 0), 0);

    console.log(`SMART23 (n=${ok.length}): score ${min(scores)}-${max(scores)} avg=${avg(scores)} | time ${min(times)}-${max(times)}s avg=${avg(times)}s | dist ${min(dists)}-${max(dists)}m avg=${avg(dists)}m | bonus ${min(bonuses)}-${max(bonuses)} avg=${avg(bonuses)}`);
    if (totalP2Ticks > 0) {
      console.log(`Phase 2 (20s+): no-down active ${totalP2NoDwn} (${(totalP2NoDwn/totalP2Ticks*100).toFixed(0)}%) | both-lane-collide ${totalP2LRCollide} (${(totalP2LRCollide/totalP2Ticks*100).toFixed(0)}%) → down fallback ${totalP2Fall} (${(totalP2Fall/totalP2Ticks*100).toFixed(0)}%) | DOWN chosen: ${totalP2Dwn} (${(totalP2Dwn/totalP2Ticks*100).toFixed(0)}%)`);
    }
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
  let smart4_10 = null, smart15_10 = null, smart19_10 = null, smart20_10 = null, smart22_10 = null;
  try { smart4_10 = JSON.parse(fs.readFileSync('/tmp/stress/smart4-results.json', 'utf8')); } catch {}
  try { smart15_10 = JSON.parse(fs.readFileSync('/tmp/stress/smart15-results.json', 'utf8')); } catch {}
  try { smart19_10 = JSON.parse(fs.readFileSync('/tmp/stress/smart19-results.json', 'utf8')); } catch {}
  try { smart20_10 = JSON.parse(fs.readFileSync('/tmp/stress/smart20-results.json', 'utf8')); } catch {}
  try { smart22_10 = JSON.parse(fs.readFileSync('/tmp/stress/smart22-results.json', 'utf8')); } catch {}
  show('smart4(10)', smart4_10);
  show('smart15(10)', smart15_10);
  show('smart19(10)', smart19_10);
  show('smart20(10)', smart20_10);
  show('smart22(10)', smart22_10);
  show('smart23(10)', all);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
