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
- **Actionable Gap:** The engine takes the absolute difference between `Unclamped Target Shares` and `Current Shares`. A trade is *only triggered* if this gap meets or exceeds the calculated Trade Threshold. 
- *Unclamped Cleanup Boundary:* This guarantees that if price shoots severely out of bounds, residual edge positions (e.g., 1 lone share) are forcefully cleaned up because the mathematical "unclamped" extrapolated intent breaks the trade threshold gap requirement, even though the actual clamped closure bounds limit the executed sale to exactly 1 share.
- *Consequence:* This organically produces a "grid" of buying and selling points that dynamically spaces out based on the stock's current price. Because it leverages `Math.ceil()` for safety, executions are strictly guaranteed to exceed your dollar minimum requirement.

## 4. Execution Timing & Order Types
Because the engine loops continuously, the Web UI natively tracks and evaluates real-time limit threshold states live intraday.

- **Execution Dispatch:** However, actual order placements do not trigger randomly mid-day. The engine waits until exactly **3:45 PM ET** to package all true actionable signals.
- **Order Structure:**
  - **BUY → Market On Close (MOC):** Guarantees fill at the closing auction price. Since we're accumulating at a discount, execution certainty is prioritized over price precision.
  - **SELL → Limit On Close (LOC):** The limit price is set to `max LIFO cost basis × 1.001` (0.1% premium ≈ bid/ask spread), enforcing the No-Loss Rule (§5) at the close auction. If the closing price is below the limit, the order simply doesn't fill.

## 5. The Absolute "No-Loss" Rule (LIFO Execution)
When the mathematical target forces a Sell, the system strictly enforces profitability. It evaluates your actual inventory of stock via *Last In, First Out (LIFO)* sequencing.

- The engine sorts all open lots by `Date` descending.
- It steps through these lots iteratively until it collects enough shares to satisfy the desired transaction size.
- **The Gate (LOC Limit Price):** The SELL LOC limit price is set to the *maximum* cost basis among the LIFO lots being sold × 1.001. This means the closing auction must clear above every lot's cost basis for the order to fill. If the close is below this floor, the order expires unfilled — no loss is realized.
- **Safety Net (Post-Fill Check):** As a belt-and-suspenders guard, the engine also validates at fill time: if the actual fill price is below the cost basis of *any* lot in the LIFO batch, the entire aggregate sale is rejected and lots are left intact.
- *UI Indicator:* The dashboard dynamically detects when the no-loss rule would block a sell, overrides the mathematical "Target Price" with the "LIFO Cost Basis" price, and labels it `(LIFO floor)`. The system sits parked until the underlying price reaches profitability at close.
