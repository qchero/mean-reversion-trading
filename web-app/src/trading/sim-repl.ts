/**
 * Simulation REPL for injecting prices into the trading engine.
 *
 * Commands:
 *   AAPL 170 171       — inject tick: bid=170 ask=171 → engine checks buy/sell
 *   reload              — reload strategies from DB
 *   help                — show commands
 */

import * as readline from 'readline';
import { TradingEngine } from './engine';

export function startSimRepl(engine: TradingEngine) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  console.log('[Sim] Price override REPL active. Type "help" for commands.\n');
  rl.prompt();

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      return;
    }

    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();

    if (cmd === 'help') {
      console.log(`
Commands:
  AAPL 170 171    Inject tick: bid=170 ask=171 (triggers engine buy/sell check)
  AAPL 170        Shorthand: bid=ask=170
  reload          Reload strategies from DB (picks up auto-execute changes)
  help            Show this help
`);
    } else if (cmd === 'reload') {
      await engine.loadStrategies();
      console.log('  Strategies reloaded');
    } else {
      // Price injection: SYMBOL BID [ASK]
      const symbol = parts[0].toUpperCase();
      const bid = parseFloat(parts[1]);
      const ask = parts[2] ? parseFloat(parts[2]) : bid;

      if (isNaN(bid) || isNaN(ask)) {
        console.log('  Unknown command. Type "help" for usage.');
      } else {
        console.log(`  ${symbol}: bid=$${bid.toFixed(2)} ask=$${ask.toFixed(2)}`);
        engine.injectTick({ symbol, bid, ask, last: (bid + ask) / 2 });
      }
    }

    rl.prompt();
  });

  return rl;
}
