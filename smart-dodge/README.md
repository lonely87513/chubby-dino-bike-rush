# Smart Dodge AI — Chubby Dino Bike Rush

AI 自動玩 [Chubby Dino Bike Rush](https://lonely87513.github.io/chubby-dino-bike-rush/)，透過 Playwright + 30-frame lookahead simulation 揀 action。

## 🏆 V23 結果（100 局驗證）

| Version | n | avg | range | bomb death | 設計 |
|---------|--:|----:|-------|-----------:|------|
| **V23** | **100** | **6504** | 4587–8654 | **2%** | V22 no-down 全程 + 條件式 down fallback |
| V4 (baseline) | 100 | 4131 | 1710–5936 | ~22% | 純 baseline |
| **V23 vs V4** | — | **+57.5%** | — | **-20pp** | 🏆 |

V23 100 局：median 6265, stddev 899.6, percentiles [10th=5502, 25th=5846, 50th=6253, 75th=7072, 90th=7844]

## 📊 V23 死亡原因分布（100 局）

| Cause | 局數 | % | avg score |
|-------|----:|--:|----------:|
| ROCK moving | 33 | 33% | 6467 |
| CONE moving | 32 | 32% | 6344 |
| PUDDLE moving | 28 | 28% | 6664 |
| Static obstacles | 5 | 5% | — |
| Bomb | 2 | 2% | 7561 |

**95% 死亡係 moving obstacles** — V23 嘅 counter-dodge 已大幅降低 static/bomb deaths。

## 🚀 Quick Start

### 安裝
```bash
cd smart-dodge/
npm install
```

### 跑 V23 100 局
```bash
node smart23.js
# N=100 喺 script 內可調，預設 10
```

### 跑單一 game + 錄影
```bash
node smart23-single.js  # 產生 WebM + MP4 + contact sheet
```

## 🧠 設計理念

V23 由 V4 baseline 演進，透過 8 個版本反覆測試：

1. **V4** (4353) — 純 baseline，發現 22% bomb death
2. **V11-V14** (3933-4113) — Bomb avoidance variants，全部 fail（過度避 bomb 拖累 score）
3. **V15** (4569) — Predictive up + counter-dodge for moving obstacles，**首個突破 V4**
4. **V17** (3845) — Bomb-obstacle coupling avoidance，over-engineering fail
5. **V18** (399) — 強制 up 0-20s 失敗（30f lookahead 太短，加速後撞）
6. **V19** (4721) — V15 + conditional force-up 0-20s **with 60f lookahead**（4.8s 預測）
7. **V20** (4976) — V19 + multi-obstacle cluster acceleration
8. **V22** (5409) — V20 + Phase 1 no-down lane-escape（不減速，直接 lane change）
9. **V23** (6504) — V22 no-down **擴展到全程** + 條件式 down fallback

### V23 三大關鍵策略

**1. Predictive Up（V15+）**
- 當 closestThreat > 100（安全），reward `up` action: `(closestThreat - 100) * 0.5`
- 鼓勵無威脅時加速

**2. Counter-Dodge for Moving Obstacles（V15+）**
- 偵測 `isMoving && vx !== 0` 嘅 obstacles
- Project 30 frames 位置：`futureX = o.x + o.vx * 30`
- 如果 projected 喺 100px 內，reward counter-direction action（+200）

**3. No-Down Policy with Conditional Fallback（V23 突破）**
- 預設排除 `down` from action candidates
- 維持 high speed multiplier（lane change 唔影響 sm）
- **例外**：當 `left` AND `right` 兩者都會撞（simulated collision），先允許 `down` 減速
- Phase 1 (0-20s) 同時配合 V19 嘅 60f lookahead 預測

## 📁 Files

| File | 用途 |
|------|------|
| `smart4.js` | Baseline reference（n=100, avg 4131）|
| `smart15.js` | V15: Predictive up + counter-dodge |
| `smart22.js` | V22: V20 + Phase 1 no-down |
| `smart23.js` | **V23: Final default（n=100, avg 6504）** |
| `smart23-single.js` | V23 單局 + 錄影版 |
| `v23-100-results.json` | V23 100 局 raw data |
| `v23-100.log` | V23 100 局 run log |

## 🔧 技術細節

- **Framework:** Playwright（headless Chromium）
- **Game URL:** `https://lonely87513.github.io/chubby-dino-bike-rush/`
- **Tick interval:** 80ms
- **Simulation lookahead:** 30 frames（V19+ 嘅 Phase 1 用 60 frames）
- **Actions:** `left`, `right`, `up`, `down`, `none`

### Scoring Function（V23）

```javascript
score = 1000 + centrality + threatMargin + progressBonus + starBonus
      + counterDodgeBonus (if useCounterDodge)
      + multiObsUpBonus (if cluster detected)
```

`up` action bonus: `(closestThreat - 100) * 0.5` (when safe)
`counterDodge` bonus: `+200` for action opposite of `vx` direction
`multiObs` bonus: `400 * min(count, 4)` when 2+ obstacles in forward zone with moving

## 📈 演進 Timeline

| Date | Version | avg | 突破 |
|------|---------|----:|------|
| 2026-10-13 04:01 | V11 | 4113 | Bomb avoidance (failed) |
| 2026-10-13 05:33 | V15 | 4569 | **Counter-dodge moving obs** 🎉 |
| 2026-10-13 06:21 | V19 | 4721 | 60f lookahead 加速 |
| 2026-10-13 12:17 | V20 | 4976 | Multi-obs acceleration |
| 2026-10-13 12:57 | V22 | 5409 | Phase 1 no-down |
| 2026-10-13 13:10 | **V23** | **6504** | **No-down 全程 + 條件式 down** 🏆 |

## 🚧 已知限制

- **95% 死亡仍係 moving obstacles** — V23 嘅 counter-dodge 有用但 moving obs 預判仍有提升空間
- **Speed ceiling：** 玩家 `sm` 達 1.7 後 30f lookahead 太短，加速時可能撞障礙物
- **Counter-dodge 只考慮 vx**，未考慮 vy（向玩家移動嘅 obstacles 仍難處理）

## 📜 License

跟主 repo (`chubby-dino-bike-rush`) 一致。
