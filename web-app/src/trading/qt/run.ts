/**
 * Entrypoint for the QuantGT monthly rebalancer.
 *
 *   npm run qt        # LIVE — connects to IB Gateway (4001), places real MOO orders
 *   npm run qt:sim    # dry-run: connects + prices like live, but never places/writes
 */

import 'dotenv/config';
import { IBKRClient } from '../ibkr';
import { QtEngine } from './engine';
import { DEFAULT_CONFIG_PATH } from './config';

// Shared IB Gateway; clientId 3 keeps qt off v1 (1) and v2 (2).
const HOST = '127.0.0.1';
const PORT = 4001;
const CLIENT_ID = 3;

const simulate = process.argv.includes('--simulate');
const mode = simulate ? 'SIMULATION (dry-run)' : 'LIVE — places real orders';

console.log(`
╔══════════════════════════════════════════════╗
║  QuantGT Monthly Rebalancer (qt)             ║
╠══════════════════════════════════════════════╣
║  Mode:       ${mode.padEnd(32)}║
║  IB Gateway: ${`${HOST}:${PORT}`.padEnd(32)}║
║  Client ID:  ${String(CLIENT_ID).padEnd(32)}║
║  Order:      Market-on-Open (MOO / OPG)      ║
╚══════════════════════════════════════════════╝
`);

const client = new IBKRClient(HOST, PORT, CLIENT_ID);
const engine = new QtEngine(client, DEFAULT_CONFIG_PATH, { simulate });

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n[qt] Shutting down...');
  await engine.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

engine
  .run()
  .then(() => {
    console.log('[qt] Done.');
    process.exit(0);
  })
  .catch((err: unknown) => {
    console.error('[qt] Failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
