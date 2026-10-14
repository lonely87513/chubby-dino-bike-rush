// Smart dodge V23 — single game with video recording for Nathan
// V23 design: V22 no-down extended to 20s+ with conditional down fallback
//   - Phase 1 (0-20s): V19-style 60f lookahead force-up + no-down lane-escape
//   - Phase 2 (20s+): No-down by default, down only when both left+right would collide
// Records WebM via Playwright, converts to MP4 + contact sheet
const { chromium } = require('playwright');
const fs = require('fs');
const { execSync } = require('child_process');

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
const VIDEO_DIR = '/tmp/stress/videos';
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
    recordVideo: {
      dir: VIDEO_DIR,
      size: { width: 414, height: 736 },
    },
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
    gameIdx, strategy: 'smart23-single',
    startTime: new Date(wallStart).toISOString(),
    finalScore: null, finalTime: null, finalDist: null, finalBonus: null,
    error: null, ticks: 0,
    actions: { left: 0, right: 0, up: 0, down: 0, none: 0 },
    earlyTicks: 0,
    postEarlyTicks: 0,
    earlyUpChosen: 0,
    earlyLaneEscape: 0,
    earlyDownInPhase1: 0,
    postEarlyNoDown: 0,
    postEarlyDownFallback: 0,
    postEarlyDownChosen: 0,
    postEarlyLeftRightCollide: 0,
    scoreAt20s: null,
    scoreAt30s: null,
    counterDodgeTriggered: 0,
    bombDeaths: 0,
    gameOver: null,
    videoWebm: null,
    videoMp4: null,
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
        const rollouts = {};
        for (const a of ACTIONS) {
          rollouts[a] = simulate(state, a, SIM_FRAMES);
        }
        const leftCollides = rollouts.left.collidedAt >= 0;
        const rightCollides = rollouts.right.collidedAt >= 0;
        const bothLaneChangeCollide = leftCollides && rightCollides;
        if (bothLaneChangeCollide) result.postEarlyLeftRightCollide++;

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

    await sleep(500).catch(() => {});
  } catch (e) {
    result.error = e.message;
  } finally {
    try {
      const v = page.video();
      if (v) {
        result.videoWebm = await v.path();
      }
    } catch (e) {
      result.error = (result.error || '') + ' | video-path-err: ' + e.message;
    }
    abortCtl.abort();
    if (currentKey) try { await page.keyboard.up(currentKey); } catch {}
    try { await ctx.close(); } catch {}
    result.endTime = new Date().toISOString();
    result.durationMs = Date.now() - wallStart;
    const a = result.actions;
    const actStr = `L${a.left||0}/R${a.right||0}/U${a.up||0}/D${a.down||0}/·${a.none||0}`;
    const go = result.gameOver;
    const goStr = go && !go.err ? `${go.hitType || '?'} obs@${go.nearestObsDist?.toFixed(0) || '?'}px ${go.hitObs?.type || '-'} mv=${go.movingObsCount || 0} bombs@${go.bombsNear300 || 0}/s@${go.starsNear300 || 0}` : '-';
    const pEPct = result.postEarlyTicks > 0 ? (result.postEarlyNoDown / result.postEarlyTicks * 100).toFixed(0) : '0';
    const pDPct = result.postEarlyTicks > 0 ? (result.postEarlyDownChosen / result.postEarlyTicks * 100).toFixed(0) : '0';
    console.log(`[g${gameIdx}] smart23-single score=${String(result.finalScore).padStart(5)} t=${String(result.finalTime||0).padStart(3)}s d=${String(result.finalDist||0).padStart(5)}m b=${String(result.finalBonus||0).padStart(4)} ${actStr} P2:noDwn${pEPct}%/dwn${pDPct}% s20=${result.scoreAt20s || '?'} s30=${result.scoreAt30s || '?'} [${goStr}] (${(result.durationMs/1000).toFixed(1)}s) err=${result.error || 'none'}`);
    console.log(`VIDEO_WEBM=${result.videoWebm}`);
  }
  return result;
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--mute-audio','--autoplay-policy=no-user-gesture-required','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows'],
  });

  const result = await runOne(browser, 0);
  await browser.close();

  // Convert WebM to MP4
  let mp4Path = null;
  if (result.videoWebm && fs.existsSync(result.videoWebm)) {
    mp4Path = result.videoWebm.replace(/\.webm$/, '.mp4');
    try {
      execSync(`ffmpeg -y -i "${result.videoWebm}" -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -movflags +faststart -an "${mp4Path}"`, { stdio: 'pipe' });
      const stat = fs.statSync(mp4Path);
      console.log(`MP4_OK size=${(stat.size/1024/1024).toFixed(2)}MB path=${mp4Path}`);

      // Smaller version
      const smallMp4 = '/tmp/stress/v23-game-small.mp4';
      try {
        execSync(`ffmpeg -y -i "${mp4Path}" -vf "scale=300:-2" -c:v libx264 -preset fast -crf 28 -pix_fmt yuv420p -movflags +faststart -an "${smallMp4}"`, { stdio: 'pipe' });
        const sstat = fs.statSync(smallMp4);
        console.log(`SMALL_MP4_OK size=${(sstat.size/1024/1024).toFixed(2)}MB path=${smallMp4}`);

        // Contact sheet
        const contactSheet = '/tmp/stress/v23-contact.png';
        execSync(`ffmpeg -y -i "${mp4Path}" -vf "select='not(mod(n\\,270))',scale=240:-2,tile=3x3" -frames:v 1 "${contactSheet}"`, { stdio: 'pipe' });
        const cstat = fs.statSync(contactSheet);
        console.log(`CONTACT_SHEET_OK size=${(cstat.size/1024).toFixed(0)}KB path=${contactSheet}`);
      } catch (e) {
        console.log(`DERIVATIVE_FAIL: ${e.message}`);
      }
    } catch (e) {
      console.log(`MP4_FAIL: ${e.message}`);
      mp4Path = null;
    }
  }
  result.videoMp4 = mp4Path;

  fs.writeFileSync('/tmp/stress/smart23-single-result.json', JSON.stringify(result, null, 2));
  console.log(`\nFINAL_SCORE=${result.finalScore}`);
  console.log(`SMALL_MP4=/tmp/stress/v23-game-small.mp4`);
  console.log(`CONTACT_SHEET=/tmp/stress/v23-contact.png`);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
