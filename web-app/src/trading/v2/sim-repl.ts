/**
 * Interactive REPL for the Linear Trading Engine (v2).
 *
 * Commands:
 *   AAPL 170           — Set price to $170, evaluate, and simulate fill if actionable
 *   preview AAPL 170   — Preview evaluation at $170 (dry run, no execution)
 *   order AAPL 170     — Place a REAL LOC order via IBKR at $170
 *   list                — Show all active strategies and positions
 *   reload              — Reload strategies from DB
 *   help                — Show commands
 */

import * as readline from 'readline';
import { LinearTradingEngine } from './engine';

export function startSimRepl(engine: LinearTradingEngine) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'sim> ',
  });

  console.log(`
┌──────────────────────────────────────────────────────────┐
│  Linear Strategy REPL — Type "help" for commands         │
└──────────────────────────────────────────────────────────┘
`);
  rl.prompt();

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    try {
      if (cmd === 'help') {
        console.log(`
Commands:
  AAPL 170          Set price → evaluate → simulate fill if actionable
  preview AAPL      Preview evaluation using last set price (dry run)
  order AAPL        Place a REAL LOC order via IBKR using last set price
  list              Show all active strategies and positions
  reload            Reload strategies from DB
  help              Show this help
`);
      } else if (cmd === 'list') {
        engine.listStrategies();

      } else if (cmd === 'reload') {
        await engine.loadStrategies();
        console.log('  ✅ Strategies reloaded');

      } else if (cmd === 'preview') {
        const symbol = parts[1]?.toUpperCase();
        if (!symbol) {
          console.log('  Usage: preview SYMBOL');
        } else {
          engine.previewTrade(symbol);
        }

      } else if (cmd === 'order') {
        const symbol = parts[1]?.toUpperCase();
        if (!symbol) {
          console.log('  Usage: order SYMBOL');
        } else {
          await engine.placeRealOrder(symbol);
        }

      } else {
        // Default: SYMBOL PRICE — inject tick and simulate
        const symbol = parts[0].toUpperCase();
        const price = parseFloat(parts[1]);

        if (isNaN(price)) {
          console.log('  Unknown command. Type "help" for usage.');
        } else {
          console.log(`  Injecting ${symbol} @ $${price.toFixed(2)}...`);
          await engine.injectTick({ symbol, bid: price, ask: price, last: price });
        }
      }
    } catch (err: any) {
      console.error(`  Error: ${err.message}`);
    }

    rl.prompt();
  });

  return rl;
}
