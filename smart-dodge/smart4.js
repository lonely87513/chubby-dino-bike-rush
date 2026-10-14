// Smart dodge V4 — V3 + detailed game-over logging
// Captures: hitType, player x/y/velX/sm, weather, phase, hit obstacle/item, obstacle counts
const { chromium } = require('playwright');
const fs = require('fs');

const URL = 'https://lonely87513.github.io/chubby-dino-bike-rush/';
const MAX_GAME_MS = 120000;
const TICK_MS = 80;
const SIM_FRAMES = 30;

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
  let closestThreat = Infinity;
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
        if (it.isBomb) { collidedAt = f; break; }
        else { starsCollected++; items.splice(i, 1); }
      }
    }
    if (collidedAt >= 0) break;
    for (const o of ob) {
      const dx = p.x - o.x;
      const dy = p.y - o.y;
      const d2 = dx * dx + dy * dy;
      const r = o.r + collisionR;
      if (d2 < r * r) { collidedAt = f; break; }
    }
    if (collidedAt >= 0) break;
  }

  return { collidedAt, p, closestThreat, starsCollected };
}

function scoreAction(state, rollout) {
  if (rollout.collidedAt >= 0) {
    return -100000 + rollout.collidedAt * 100;
  }
  const centerX = state.roadLeft + state.roadWidth / 2;
  const centrality = -Math.abs(rollout.p.x - centerX) * 0.3;
  const threatMargin = Math.min(rollout.closestThreat, 200) * 0.5;
  const progressBonus = (rollout.p.sm - 1.0) * 2;
  const starBonus = (rollout.starsCollected || 0) * 400;
  return 1000 + centrality + threatMargin + progressBonus + starBonus;
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

    // Game-over capture: poll gameState and snapshot context at transition
    window.__gameOverInfo = null;
    function snapshotState(hitTypeGuess) {
      try {
        let minObsD = Infinity, hitObs = null;
        if (typeof obstacles !== 'undefined' && player) {
          for (const o of obstacles) {
            const dx = player.x - o.x, dy = player.y - o.y;
            const d = Math.sqrt(dx*dx + dy*dy);
            if (d < minObsD) { minObsD = d; hitObs = o; }
          }
        }
        let minItemD = Infinity, hitItem = null;
        if (typeof fallingItems !== 'undefined' && player) {
          for (const it of fallingItems) {
            const dx = player.x - it.x, dy = player.y - it.y;
            const d = Math.sqrt(dx*dx + dy*dy);
            if (d < minItemD) { minItemD = d; hitItem = it; }
          }
        }
        // Phase 0=<20s normal, 1=20-40s, 2=40-60s, 3=60-80s, 4=80+ chaos
        const t = typeof score !== 'undefined' ? score : 0;
        const phase = t < 20 ? 0 : t < 40 ? 1 : t < 60 ? 2 : t < 80 ? 3 : 4;
        return {
          hitTypeGuess,
          finalScore: typeof score !== 'undefined' ? score : null,
          finalDist: typeof distance !== 'undefined' ? distance : null,
          finalBonus: typeof bonusScore !== 'undefined' ? bonusScore : null,
          player: player ? { x: player.x, y: player.y, baseY: player.baseY, velX: player.velX, sm: player.speedMultiplier } : null,
          weather: typeof currentWeather !== 'undefined' ? currentWeather : null,
          phase,
          obstacleCount: typeof obstacles !== 'undefined' ? obstacles.length : 0,
          itemCount: typeof fallingItems !== 'undefined' ? fallingItems.length : 0,
          movingObsCount: typeof obstacles !== 'undefined' ? obstacles.filter(o => o.isMoving).length : 0,
          hitObs: hitObs ? { x: hitObs.x, y: hitObs.y, r: hitObs.r, vx: hitObs.vx, type: hitObs.type, isMoving: hitObs.isMoving, dist: minObsD } : null,
          hitItem: hitItem ? { x: hitItem.x, y: hitItem.y, radius: hitItem.radius, isBomb: hitItem.isBomb, dist: minItemD } : null,
          nearestObsDist: minObsD === Infinity ? null : minObsD,
          nearestItemDist: minItemD === Infinity ? null : minItemD,
          // Other items nearby (within 200px)
          nearbyItems: (typeof fallingItems !== 'undefined' ? fallingItems : []).filter(it => {
            if (!player) return false;
            return Math.abs(it.x - player.x) < 200 && Math.abs(it.y - player.y) < 200;
          }).map(it => ({ x: it.x, y: it.y, isBomb: it.isBomb, dist: Math.sqrt((it.x-player.x)**2 + (it.y-player.y)**2) })),
        };
      } catch (e) { return { err: e.message }; }
    }
    // Try patching triggerGameOver; fall back to polling
    let patchOk = false;
    setTimeout(() => {
      if (typeof triggerGameOver === 'function' && !patchOk) {
        const orig = triggerGameOver;
        // Replace via global reassign (works if triggerGameOver is on window/global)
        try {
          window.triggerGameOver = function(hitType) {
            window.__gameOverInfo = snapshotState(hitType);
            return orig.call(this, hitType);
          };
          patchOk = true;
        } catch (e) {}
      }
    }, 600);
    // Fallback polling — capture state when gameState transitions to GAMEOVER
    let lastGs = null;
    setInterval(() => {
      if (typeof gameState === 'undefined') return;
      if (gameState === 'GAMEOVER' && lastGs !== 'GAMEOVER' && !window.__gameOverInfo) {
        window.__gameOverInfo = snapshotState('unknown');
      }
      lastGs = gameState;
    }, 80);
  });

  const wallStart = Date.now();
  const result = { gameIdx, strategy: 'smart4', startTime: new Date(wallStart).toISOString(), finalScore: null, finalTime: null, finalDist: null, finalBonus: null, error: null, ticks: 0, actions: { left: 0, right: 0, up: 0, down: 0, none: 0 }, gameOver: null };
  const abortCtl = new AbortController();
  let currentKey = null;

  async function setKey(key) {
    if (currentKey === key) return;
    if (currentKey) try { await page.keyboard.up(currentKey); } catch {}
    if (key) try { await page.keyboard.down(key); } catch {}
    currentKey = key;
  }

  const ACTIONS = ['left', 'right', 'up', 'down', 'none'];
  const KEYMAP = { left: 'ArrowLeft', right: 'ArrowRight', up: 'ArrowUp', down: 'ArrowDown' };

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

      const scores = {};
      for (const a of ACTIONS) {
        const r = simulate(state, a, SIM_FRAMES);
        scores[a] = scoreAction(state, r);
      }
      const sorted = ACTIONS.slice().sort((a, b) => {
        if (scores[b] !== scores[a]) return scores[b] - scores[a];
        return a === lastChosen ? -1 : b === lastChosen ? 1 : 0;
      });
      const best = sorted[0];
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
      else {
        Object.assign(result, read);
        result.gameOver = read.gameOver;
      }
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
    const goStr = go ? `${go.hitTypeGuess || '?'} obs@${go.nearestObsDist?.toFixed(0) || '?'}px ${go.hitObs?.type || '-'}` : '-';
    console.log(`[g${gameIdx}] smart4 score=${String(result.finalScore).padStart(5)} t=${String(result.finalTime||0).padStart(3)}s d=${String(result.finalDist||0).padStart(5)}m b=${String(result.finalBonus||0).padStart(4)} ${actStr} [${goStr}] (${(result.durationMs/1000).toFixed(1)}s) err=${result.error || 'none'}`);
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
  fs.writeFileSync('/tmp/stress/smart4-results.json', JSON.stringify(all, null, 2));

  // Analysis
  const ok = all.filter(r => r.error == null && r.finalScore > 100);
  console.log('\n=== SMART4 SUMMARY ===');
  if (ok.length === 0) { console.log('No successful runs'); }
  else {
    const scores = ok.map(r => r.finalScore);
    const times = ok.map(r => r.finalTime || 0);
    const dists = ok.map(r => r.finalDist || 0);
    const bonuses = ok.map(r => r.finalBonus || 0);
    const avg = (a) => (a.reduce((s,x)=>s+x,0) / a.length).toFixed(1);
    const min = (a) => Math.min(...a);
    const max = (a) => Math.max(...a);
    console.log(`SMART4 (n=${ok.length}): score ${min(scores)}-${max(scores)} avg=${avg(scores)} | time ${min(times)}-${max(times)}s avg=${avg(times)}s | dist ${min(dists)}-${max(dists)}m avg=${avg(dists)}m | bonus ${min(bonuses)}-${max(bonuses)} avg=${avg(bonuses)}`);
  }

  console.log('\n=== GAME OVER BREAKDOWN ===');
  const withGO = ok.filter(r => r.gameOver);
  if (withGO.length === 0) {
    console.log('No game over info captured');
  } else {
    // Hit type distribution
    const hitTypes = {};
    for (const r of withGO) {
      const t = r.gameOver.hitTypeGuess || 'unknown';
      hitTypes[t] = (hitTypes[t] || 0) + 1;
    }
    console.log('Hit types:', hitTypes);
    // Hit obstacle types
    const obsTypes = {};
    for (const r of withGO) {
      const t = r.gameOver.hitObs?.type || 'none';
      obsTypes[t] = (obsTypes[t] || 0) + 1;
    }
    console.log('Hit obstacle types:', obsTypes);
    // Phase distribution
    const phases = {};
    for (const r of withGO) {
      const p = r.gameOver.phase ?? -1;
      phases[p] = (phases[p] || 0) + 1;
    }
    console.log('Phase at death:', phases);
    // Weather
    const weathers = {};
    for (const r of withGO) {
      const w = r.gameOver.weather || 'unknown';
      weathers[w] = (weathers[w] || 0) + 1;
    }
    console.log('Weather at death:', weathers);
    // Distance from road center
    const distFromCenter = withGO.map(r => {
      const cx = r.gameOver.roadLeft ? r.gameOver.roadLeft + (r.gameOver.roadWidth || 0) / 2 : null;
      return cx !== null ? Math.abs(r.gameOver.player.x - cx) : null;
    }).filter(d => d !== null);
    if (distFromCenter.length) {
      console.log(`Distance from road center: min=${Math.min(...distFromCenter).toFixed(0)} max=${Math.max(...distFromCenter).toFixed(0)} avg=${(distFromCenter.reduce((s,x)=>s+x,0)/distFromCenter.length).toFixed(0)}`);
    }
    // Nearest obstacle at moment of death
    const obsDists = withGO.map(r => r.gameOver.nearestObsDist).filter(d => d !== null);
    if (obsDists.length) {
      console.log(`Nearest obstacle dist: min=${Math.min(...obsDists).toFixed(1)} max=${Math.max(...obsDists).toFixed(1)} avg=${(obsDists.reduce((s,x)=>s+x,0)/obsDists.length).toFixed(1)}`);
    }
    // Moving obstacles count
    const movingCounts = withGO.map(r => r.gameOver.movingObsCount || 0);
    if (movingCounts.length) {
      console.log(`Moving obstacles at death: avg=${(movingCounts.reduce((s,x)=>s+x,0)/movingCounts.length).toFixed(1)}`);
    }
    // velX at death
    const velXList = withGO.map(r => r.gameOver.player?.velX).filter(v => v !== undefined);
    if (velXList.length) {
      console.log(`velX at death: min=${Math.min(...velXList).toFixed(2)} max=${Math.max(...velXList).toFixed(2)} avg=${(velXList.reduce((s,x)=>s+x,0)/velXList.length).toFixed(2)}`);
    }
    // Nearby items (missed opportunities)
    const allNearbyItems = withGO.flatMap(r => (r.gameOver.nearbyItems || []).map(it => ({...it, gameScore: r.finalScore, gameTime: r.finalTime, gamePhase: r.gameOver.phase})));
    if (allNearbyItems.length) {
      const missed = allNearbyItems.filter(it => !it.isBomb);
      const bombs = allNearbyItems.filter(it => it.isBomb);
      console.log(`Nearby items: ${allNearbyItems.length} total, ${missed.length} stars, ${bombs.length} bombs`);
      if (bombs.length) {
        console.log(`Bomb hits: ${bombs.length}/${withGO.length} games (${(bombs.length/withGO.length*100).toFixed(0)}%)`);
      }
    }
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
    console.log(`${label.padEnd(10)} (n=${s.length}): score ${min(scores)}-${max(scores)} avg=${avg(scores)}`);
  };
  let baseline = null, smart1 = null, smart2 = null, smart3 = null;
  try { baseline = JSON.parse(fs.readFileSync('/tmp/stress/results.json', 'utf8')); } catch {}
  try { smart1   = JSON.parse(fs.readFileSync('/tmp/stress/smart-results.json', 'utf8')); } catch {}
  try { smart2   = JSON.parse(fs.readFileSync('/tmp/stress/smart2-results.json', 'utf8')); } catch {}
  try { smart3   = JSON.parse(fs.readFileSync('/tmp/stress/smart3-results.json', 'utf8')); } catch {}
  for (const strat of ['passive', 'active']) {
    const sub = baseline ? baseline.filter(r => r.strategy === strat) : [];
    if (sub.length) show(strat, sub);
  }
  show('smart1', smart1);
  show('smart2', smart2);
  show('smart3', smart3);
  show('smart4', all);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
