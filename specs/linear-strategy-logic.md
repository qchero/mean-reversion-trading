# Linear Mean Reversion Strategy Logic

This document outlines the core algorithms, constraints, and dynamic behavioral paths executed by the Mean Reversion V2 trading engine.

## 1. The Core Deviation Metric (Sigma)
Instead of looking at standard stock price or simple percentage drops, the engine normalizes price dynamically based on historical moving averages (SMA200) and historical daily volatility.

- **Formula:** `σ = (SMA200 - Price) / (SMA200 × Volatility)`
- A drop in stock price results in a mathematically *higher* standard deviation away from the mean.
- **Visual Note:** On the UI, we invert this mathematically positive Sigma into a conventional negative string (e.g., `-6σ`) to intuitively indicate the price is *below* the mean.

## 2. Linear Scaling & Target Calculation
Rather than going "all-in" at a certain price, the engine maps your total capital (`Max Budget`) linearly across a customizable range (`BandLo` to `BandHi`).

- If price is above `BandLo` (e.g., above -6σ): **Target Shares = 0**
- If price drops below `BandHi` (e.g., below -14σ): **Target Shares = Max Budget / Price**
- In between, it scales capital steadily as the price dips deeper:
  - `Progress = (σ - BandLo) / (BandHi - BandLo)`
  - `Target Value = Max Budget × Progress`
- **Final Target Shares:** `Math.round(Target Value / Price)`

## 3. The Execution Threshold (Grid Size)
To avoid spamming brokers with useless micro-transactions (e.g., buying 1 share at a time whenever the target fluctuates slightly), the system restricts math with a `Min Trade Amount` boundary.

- **Trade Threshold:** `Math.max(1, Math.ceil(Min Trade Amount / Price))`
- **Direction & Trade Size:** Direction comes directly from `diff = targetShares - currentShares`. Positive diff → BUY, negative → SELL. There is no separate "direction guard" — the clamped target already incorporates the budget cap, so `diff` is the final word on what to do.
- **Primary Gate:** A trade is triggered when `|diff| >= Trade Threshold`. This checks the *actual trade size* against the minimum.
- **Unclamped Fallback:** When the budget cap or a near-zero position squashes `diff` to just 1–2 shares (e.g., `maxShares = 2` or selling the last 2 shares), `|diff|` can never reach the threshold on its own. In these edge cases, the gate also passes if `|unclampedDiff| >= Trade Threshold` — the unclamped signal strength qualifies the trade even though the executed size is small.
- *Consequence:* This organically produces a "grid" of buying and selling points that dynamically spaces out based on the stock's current price. Because it leverages `Math.ceil()` for safety, executions are strictly guaranteed to exceed your dollar minimum requirement.

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
