# Linear Mean Reversion Strategy Logic

This document outlines the core algorithms, constraints, and dynamic behavioral paths executed by the Mean Reversion V2 trading engine.

## 1. The Core Deviation Metric (Sigma)
Instead of looking at standard stock price or simple percentage drops, the engine normalizes price dynamically based on historical moving averages (SMA200) and historical daily volatility.

- **Formula:** `σ = (SMA200 - Price) / (SMA200 × Volatility)`
- A drop in stock price results in a mathematically *higher* standard deviation away from the mean.
- **Visual Note:** On the UI, we invert this mathematically positive Sigma into a conventional negative string (e.g., `-6σ`) to intuitively indicate the price is *below* the mean.

## 2. Target Calculation & Trade Decision

### Step 1: Compute sigma
```
sigmaBelow = (SMA200 - price) / (SMA200 × volatility)
```

### Step 2: Compute unclamped target
The engine maps capital linearly across the band. Below `bandLo` → 0 shares. Above `bandHi` → extrapolates past budget.
```
linearTargetValue = maxBudget × (sigmaBelow - bandLo) / (bandHi - bandLo)
unclampedTargetShares = round(linearTargetValue / price)
unclampedDiff = unclampedTargetShares - currentShares
```

### Step 3: Clamp to budget
```
maxShares = round(maxBudget / price)
targetShares = clamp(unclampedTargetShares, 0, maxShares)
diff = targetShares - currentShares
```
Direction comes from `diff`. Positive → BUY, negative → SELL. No separate direction guard.

Note: `currentShares` can exceed `maxShares` when shares were accumulated at lower prices (where `maxShares` was higher). A price bounce reduces `maxShares` below the current position, making `diff` negative (sell) even though `unclampedDiff` is positive (buy).

### Step 4: Min-trade gate
```
minShares = round(minTradeAmount / price)
minGate = max(1, minShares)
sameSign = (diff > 0 AND unclampedDiff > 0) OR (diff < 0 AND unclampedDiff < 0)

satisfiesMinTrade =
    |diff| >= minGate                                ← primary: actual trade size
 OR (|unclampedDiff| >= minGate AND sameSign)        ← fallback: same-direction only
```

- **Primary:** the actual trade size meets the dollar minimum.
- **Fallback:** when budget cap or near-zero position squashes `diff` to 1–2 shares, the unclamped signal strength qualifies the trade — but only if both point the same direction. The `sameSign` check prevents an unclamped BUY from qualifying a budget-cap SELL below the dollar minimum.

### Step 5: Action
```
if diff ≠ 0 AND satisfiesMinTrade → action = BUY or SELL
else → HOLD
```

## 4. Execution Timing & Order Types
Because the engine loops continuously, the Web UI natively tracks and evaluates real-time limit threshold states live intraday.

- **Execution Dispatch:** However, actual order placements do not trigger randomly mid-day. The engine waits until **3:48 PM ET** to package all true actionable signals.
- **Order Structure:**
  - **BUY → Market On Close (MOC):** Guarantees fill at the closing auction price. Since we're accumulating at a discount, execution certainty is prioritized over price precision.
  - **SELL → Limit On Close (LOC):** The limit price is set to `max LIFO cost basis × 1.001` (0.1% premium ≈ bid/ask spread), enforcing the No-Loss Rule (§5) at the close auction. If the closing price is below the limit, the order simply doesn't fill.

## 5. The Absolute "No-Loss" Rule (Cost-Basis Ordered Execution)
When the mathematical target forces a Sell, the system strictly enforces profitability. It evaluates your actual inventory of stock ordered by cost basis.

- The engine sorts all open lots by `cost basis ascending` (cheapest first = most profitable first).
- It walks lots collecting profitable shares up to the target sell qty, stopping at the first lot where `currentPrice < lot.costBasis` — since lots are sorted ascending, all remaining lots are guaranteed to be worse.
- **The Gate (LOC Limit Price):** The SELL LOC limit price is set to the *highest* cost basis among the collected lots × 1.001. This means the closing auction must clear above every lot's cost basis for the order to fill. If the close is below this floor, the order expires unfilled — no loss is realized.
- **Safety Net (Post-Fill Check):** As a belt-and-suspenders guard, the engine also validates at fill time: if the actual fill price is below the cost basis of *any* lot in the batch, those lots are skipped and left intact.
- *UI Indicator:* The dashboard dynamically detects when the no-loss rule would block a sell, overrides the mathematical "Target Price" with the cost basis floor price, and labels it `(LIFO floor)`. The system sits parked until the underlying price reaches profitability at close.
