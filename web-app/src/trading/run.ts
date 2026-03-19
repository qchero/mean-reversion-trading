/**
 * Entry point for the auto-trading engine.
 *
 * Usage:
 *   npm run trade                # live trading (port 4001)
 *   npm run trade:sim            # paper trading + price override REPL (port 4002)
 *   npx tsx src/trading/run.ts --host 192.168.1.5 --port 4002 --simulate
 *
 * Prerequisites:
 *   1. IB Gateway running (paper: port 4002, live: port 4001)
 *   2. API connections enabled in IB Gateway config
 *   3. At least one strategy with "Auto Execute" toggled on in the dashboard
 */

import 'dotenv/config';
import { TradingEngine } from './engine';
import { IBKRClient } from './ibkr';
import { startSimRepl } from './sim-repl';

const args = process.argv.slice(2);
function getArg(name: string, defaultVal: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultVal;
}
const hasFlag = (name: string) => args.includes(`--${name}`);

const simulate = hasFlag('simulate');
const host = getArg('host', '127.0.0.1');
const port = parseInt(getArg('port', '4001'), 10);
const clientId = parseInt(getArg('client-id', '1'), 10);

const mode = simulate ? 'SIMULATE 🟡' : port === 4001 ? 'LIVE 🔴' : 'PAPER 🟢';

console.log(`
╔══════════════════════════════════════════════╗
║  Mean Reversion Auto-Trading Engine          ║
╠══════════════════════════════════════════════╣
║  IB Gateway: ${host}:${port}${' '.repeat(Math.max(0, 28 - host.length - String(port).length))}║
║  Client ID:  ${clientId}${' '.repeat(Math.max(0, 30 - String(clientId).length))}║
║  Mode:       ${mode}${' '.repeat(Math.max(0, 31 - mode.length + 2))}║
╚══════════════════════════════════════════════╝
`);

if (simulate) {
  console.log(`Commands:
  AAPL 170 171    Inject bid/ask → triggers buy/sell check
  AAPL 170        Shorthand (bid=ask)
  reload          Reload strategies from DB
  help            Show all commands
`);
} else if (port === 4001) {
  console.log('⚠  LIVE TRADING MODE — real money at risk\n');
}

const client = new IBKRClient(host, port, clientId);
const engine = new TradingEngine(client, simulate);

// Graceful shutdown
process.on('SIGINT', async () => {
  await engine.stop();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await engine.stop();
  process.exit(0);
});

engine.start().then(() => {
  if (simulate) {
    startSimRepl(engine);
  }
}).catch((err) => {
  console.error('[Engine] Failed to start:', err.message);
  process.exit(1);
});
