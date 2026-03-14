# Yearly Parameter Sweep Plan

## Objective
Find the (j, k, levels) combination that maximizes annualized ROC consistently
across all calendar years while maintaining >= 24 operations/year.

## Concern
Current config (j=9σ) produces sparse trades. What works in the past may not
generalize. Need a config that trades frequently enough in every year.

## Parameters (Round 3 — full grid)
- j (entry sigma): 4, 5, 6, 7, 8
- k (step sigma): 0.5, 1, 1.5, 2, 2.5
- levels: 2, 3, 4, 5, 6, 7, 8
- Total combos: 5 × 5 × 7 = 175

### Prior rounds
- Round 1: j=6-10 | k=1.5-2.5 | levels=2-4 (45 combos) → only 3/45 qualified (all j=6σ k=1.5σ)
- Round 2: j=3-6 | k=1.5-2.5 | levels=2-6 (60 combos) → 35/60 qualified, j=6σ k=1.5σ dominated top 4
- Round 3 adds: k=0.5 and k=1 (tighter step), j=7-8 (deeper entry), levels 7-8

## Evaluation
- **Continuous simulation** — positions carry across years (fixed in round 3b)
- Overall ROC = total P&L / overall avg daily $ deployed / total years × 100
- Operations = buys + sells per year
- Constraint: >= 24 operations per full year (pro-rated for partial years like 2026)
- **Ranking: overall annualized ROC across full period** (not averaged per-year)

## Data
- data-start: 2021-03-13 (SMA-200 warmup before 2022)
- end: 2026-03-14
- 14 tickers, 15-min bars from Polygon.io

## Status
### Round 1 (j=6-10, k=1.5-2.5, levels=2-4)
- [x] Run 45 combos × 5 years — only 3/45 qualified (all j=6σ k=1.5σ)
### Round 2 (j=3-6, k=1.5-2.5, levels=2-6)
- [x] Run 60 combos × 5 years — 35/60 qualified, j=6σ k=1.5σ dominated
### Round 3 (j=4-8, k=0.5-2.5, levels=2-8) — independent years, avg ROC ranking
- [x] Run 175 combos — 83/175 qualified, j=7σ k=1σ dominated (avg ROC inflated)
### Round 3b — fixed: continuous carry-over + overall ROC ranking
- [x] Run 175 combos with continuous simulation and overall ROC
- [x] Results are now realistic (37-41% annualized vs 400-600% before)

## Round 3b Results (latest — continuous carry-over + overall ROC)

### Methodology fixes in this round
1. **Continuous simulation** — positions carry across years (a position opened in
   Dec 2022 stays open into 2023). Prior rounds restarted each year from scratch.
2. **Overall ROC ranking** — total P&L / overall avg daily deployed / total years.
   Prior rounds averaged per-year ROC which inflated quiet years astronomically.

### Summary: 83 out of 175 combos pass >= 24 ops/year constraint

**Top 15 qualified combos (sorted by overall annualized ROC):**

| Rank | Config | Total P&L | Avg Deployed | ROC/yr | 2022 P&L (Ops) | 2023 P&L (Ops) | 2024 P&L (Ops) | 2025 P&L (Ops) | 2026 P&L (Ops) |
|------|--------|-----------|-------------|--------|----------------|----------------|----------------|----------------|----------------|
| 1 | j=6σ k=1.5σ lvl=6 | +$12,830 | $7,557/day | 40.5% | +$4,092 (545) | +$3,515 (35) | +$1,373 (32) | +$5,261 (218) | -$1,409 (93) |
| 2 | j=6σ k=1.5σ lvl=5 | +$14,295 | $8,732/day | 39.0% | +$4,256 (519) | +$3,984 (33) | +$1,647 (32) | +$6,125 (212) | -$1,717 (78) |
| 3 | j=6σ k=1.5σ lvl=7 | +$10,832 | $6,623/day | 39.0% | +$3,317 (555) | +$3,012 (35) | +$1,176 (32) | +$4,550 (220) | -$1,225 (102) |
| 4 | j=6σ k=1.5σ lvl=3 | +$19,533 | $12,028/day | 38.7% | +$5,083 (393) | +$5,614 (31) | +$2,745 (32) | +$8,722 (178) | -$2,632 (50) |
| 5 | j=6σ k=1.5σ lvl=4 | +$16,575 | $10,207/day | 38.7% | +$4,744 (468) | +$4,782 (32) | +$2,059 (32) | +$7,247 (202) | -$2,256 (62) |
| 6 | j=7σ k=1σ lvl=4 | +$13,675 | $8,436/day | 38.6% | +$5,017 (634) | +$4,008 (44) | +$2,080 (28) | +$4,568 (195) | -$1,998 (84) |
| 7 | j=7σ k=1σ lvl=5 | +$12,057 | $7,508/day | 38.3% | +$4,750 (721) | +$3,411 (45) | +$1,664 (28) | +$4,068 (219) | -$1,836 (96) |
| 8 | j=6σ k=1.5σ lvl=8 | +$9,257 | $5,864/day | 37.6% | +$2,737 (561) | +$2,636 (35) | +$1,029 (32) | +$3,981 (220) | -$1,127 (106) |
| 9 | j=6σ k=1σ lvl=5 | +$15,534 | $9,951/day | 37.2% | +$4,401 (836) | +$4,878 (66) | +$2,209 (52) | +$6,203 (309) | -$2,157 (116) |
| 10 | j=7σ k=1σ lvl=6 | +$10,414 | $6,692/day | 37.1% | +$4,086 (778) | +$2,922 (46) | +$1,387 (28) | +$3,521 (225) | -$1,501 (114) |
| 11 | j=7σ k=1σ lvl=3 | +$14,758 | $9,493/day | 37.0% | +$4,950 (514) | +$4,526 (40) | +$2,376 (26) | +$5,184 (167) | -$2,277 (64) |
| 12 | j=6σ k=1σ lvl=6 | +$13,872 | $8,924/day | 37.0% | +$4,278 (923) | +$4,236 (67) | +$1,841 (52) | +$5,513 (333) | -$1,996 (128) |
| 13 | j=6σ k=1.5σ lvl=2 | +$22,036 | $14,240/day | 36.9% | +$3,569 (281) | +$6,847 (27) | +$3,417 (28) | +$11,120 (149) | -$2,917 (36) |
| 14 | j=7σ k=1σ lvl=7 | +$9,299 | $6,013/day | 36.8% | +$3,599 (820) | +$2,594 (48) | +$1,189 (28) | +$3,122 (231) | -$1,204 (131) |
| 15 | j=6σ k=1σ lvl=7 | +$12,205 | $8,023/day | 36.2% | +$3,776 (980) | +$3,699 (68) | +$1,578 (52) | +$4,838 (339) | -$1,686 (146) |

### Top disqualified combos (failed min-ops but higher ROC)

| Config | Total P&L | Avg Deployed | ROC/yr | Failure |
|--------|-----------|-------------|--------|---------|
| j=7σ k=2σ lvl=3 | +$17,918 | $8,812/day | 48.4% | 2023: 13 ops |
| j=7σ k=2σ lvl=4 | +$14,422 | $7,174/day | 47.9% | 2023: 14 ops |
| j=7σ k=2σ lvl=2 | +$21,505 | $11,036/day | 46.4% | 2023: 12 ops |

### Key observations

1. **j=6σ k=1.5σ dominates top 5** — all level counts 2-8 clustered at 37-41% ROC/yr.
   Remarkably stable across levels; #1 (lvl=6) edges out at 40.5%.

2. **j=7σ k=1σ at #6-7** — competitive at 38.3-38.6%, but needs tighter step spacing
   (k=1σ) to generate enough operations.

3. **The spread is tight** — top 15 spans only 36.2-40.5% ROC/yr. Not a lot of
   differentiation; the strategy fundamentals dominate parameter choice.

4. **Carry-over matters for 2026** — avg deployed in 2026 jumped from ~$1,100
   (independent) to ~$25,000 (carry-over) because 2025 positions remain open.
   This gives a more realistic picture of actual capital at risk.

5. **2023 P&L dropped with carry-over** — e.g., #1 went from +$5,091 to +$3,515.
   Some of that P&L was actually from closing 2022 carry-over positions, which now
   properly credit the recovery to 2023 rather than double-counting.

6. **Disqualified configs show higher ROC** — j=7σ k=2σ hits 46-48% but fails
   min-ops in quiet years. If we relaxed from 24 to ~15 ops/yr, these would qualify.

7. **All configs still negative in 2026** — partial year, positions may recover.

Full per-ticker detail for top 10: see [sweep_results_round3.md](sweep_results_round3.md)

## Round 4 Results (eval from 2024-01-01 — same grid as Round 3b)

### Setup
- Same grid: j=4-8, k=0.5-2.5, levels=2-8 (175 combos)
- data-start: 2021-03-13 (SMA warmup), eval-start: 2024-01-01, end: 2026-03-14
- Continuous simulation with carry-over, overall ROC ranking
- ~2.2 year eval window (vs ~4.2 years in Round 3b)

### Summary: 83 out of 175 combos pass >= 24 ops/year constraint

**Top 15 qualified combos (sorted by overall annualized ROC):**

| Rank | Config | Total P&L | Avg Deployed | ROC/yr | 2024 P&L (Ops) | 2025 P&L (Ops) | 2026 P&L (Ops) |
|------|--------|-----------|-------------|--------|----------------|----------------|----------------|
| 1 | j=6σ k=0.5σ lvl=2 | +$11,509 | $5,799/day | 90.3% | +$3,023 (76) | +$10,917 (362) | -$2,431 (119) |
| 2 | j=6σ k=1.5σ lvl=2 | +$11,620 | $6,062/day | 87.2% | +$3,417 (28) | +$11,120 (149) | -$2,917 (36) |
| 3 | j=6σ k=1σ lvl=2 | +$10,657 | $5,907/day | 82.1% | +$3,346 (42) | +$10,172 (196) | -$2,860 (55) |
| 4 | j=6σ k=0.5σ lvl=3 | +$9,539 | $5,318/day | 81.6% | +$2,937 (96) | +$8,992 (460) | -$2,390 (156) |
| 5 | j=6σ k=1.5σ lvl=3 | +$8,835 | $5,003/day | 80.3% | +$2,745 (32) | +$8,722 (178) | -$2,632 (50) |
| 6 | j=6σ k=1σ lvl=3 | +$8,506 | $5,118/day | 75.6% | +$2,967 (46) | +$8,130 (243) | -$2,591 (77) |
| 7 | j=6σ k=1.5σ lvl=4 | +$7,050 | $4,301/day | 74.5% | +$2,059 (32) | +$7,247 (202) | -$2,256 (62) |
| 8 | j=6σ k=0.5σ lvl=4 | +$8,074 | $4,968/day | 73.9% | +$2,882 (112) | +$7,676 (547) | -$2,484 (178) |
| 9 | j=6σ k=1.5σ lvl=5 | +$6,055 | $3,753/day | 73.4% | +$1,647 (32) | +$6,125 (212) | -$1,717 (78) |
| 10 | j=6σ k=1σ lvl=4 | +$7,130 | $4,524/day | 71.7% | +$2,463 (50) | +$7,073 (281) | -$2,406 (96) |
| 11 | j=6σ k=1.5σ lvl=6 | +$5,224 | $3,315/day | 71.7% | +$1,373 (32) | +$5,261 (218) | -$1,409 (93) |
| 12 | j=5σ k=2σ lvl=3 | +$10,591 | $6,727/day | 71.6% | +$2,933 (30) | +$9,932 (159) | -$2,274 (50) |
| 13 | j=5σ k=2σ lvl=4 | +$8,699 | $5,554/day | 71.2% | +$2,200 (30) | +$8,315 (179) | -$1,816 (62) |
| 14 | j=6σ k=0.5σ lvl=5 | +$7,189 | $4,639/day | 70.5% | +$2,775 (120) | +$6,820 (624) | -$2,406 (209) |
| 15 | j=5σ k=2σ lvl=2 | +$13,151 | $8,593/day | 69.6% | +$3,112 (26) | +$12,672 (134) | -$2,632 (36) |

### Top disqualified combos (failed min-ops but higher ROC)

| Config | Total P&L | Avg Deployed | ROC/yr | Failure |
|--------|-----------|-------------|--------|---------|
| j=7σ k=2.5σ lvl=2 | +$9,315 | $4,410/day | 96.1% | 2024: 12 ops |
| j=7σ k=2σ lvl=2 | +$8,844 | $4,256/day | 94.5% | 2024: 14 ops |
| j=7σ k=2.5σ lvl=3 | +$6,940 | $3,533/day | 89.3% | 2024: 12 ops |
| j=7σ k=2σ lvl=3 | +$6,904 | $3,515/day | 89.3% | 2024: 14 ops |

### Key observations

1. **ROC roughly doubles vs Round 3b** — top qualified hits 90.3% (vs 40.5%) because
   the 2024-2026 window captured a strong mean-reversion environment (2025 especially)
   without the drag of quieter 2022-2023 years diluting avg deployed.

2. **j=6σ still dominates** — top 11 are all j=6σ. The j=5σ configs appear at #12-15.
   j=7σ configs fail min-ops in the quieter 2024.

3. **k=0.5σ emerges at #1** — tighter step spacing generates more operations (76 in 2024
   vs 28 for k=1.5σ), helping pass the min-ops constraint, while still delivering 90% ROC.

4. **Lower levels win in shorter window** — lvl=2 takes ranks #1-3. With fewer years,
   the capital efficiency advantage of fewer levels shines through.

5. **2025 dominates P&L** — across all configs, 2025 accounts for ~80-90% of total P&L.
   This is a more volatile environment that strongly favors mean reversion.

6. **All configs negative in 2026** — same as Round 3b, partial year with open positions.

7. **Disqualified configs very high ROC** — j=7σ k=2.5σ lvl=2 at 96.1% but only 12 ops
   in 2024. The 2024-start window is less forgiving for sparse traders.

Full per-ticker detail for top 10: see [sweep_results_round4.md](sweep_results_round4.md)
