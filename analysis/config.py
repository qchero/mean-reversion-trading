"""Strategy and data configuration."""

TICKERS = ["NFLX", "AMZN", "NVDA", "AAPL", "GOOGL", "MSFT", "TSLA", "META", "MA", "SPGI", "MCO", "INTU", "COST", "TXRH"]

# Mean reversion parameters (volatility-scaled)
SMA_PERIOD = 200
ENTRY_SIGMA = 9         # First level = ENTRY_SIGMA × daily σ below SMA
STEP_SIGMA = 2          # Step = STEP_SIGMA × daily σ between levels
NUM_LEVELS = 2          # Number of buy levels
TOTAL_BUDGET = 10000    # Total dollars allocated per ticker
