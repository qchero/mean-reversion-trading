/**
 * Entrypoint for the QuantGT monthly rebalancer.
 *
 *   npm run qt            # LIVE preview + MOO placement (PAPER gateway by default)
 *   npm run qt:sim        # offline dry-run (no IBKR connection, no state written)
 *
 * Flags:
 *   --simulate            dry-run (preview + projected plan, never places/writes)
 *   --live                use the LIVE IB Gateway (port 4001) instead of paper
 *   --host <h>            IB Gateway host (default 127.0.0.1)
 *   --port <p>            override port (default 4002 paper / 4001 live)
 *   --client-id <n>       IBKR client id (default 3; v1=1, v2=2)
 *   --config <path>       config file (default src/trading/qt/config.json)
 */

import 'dotenv/config';
import { IBKRClient } from '../ibkr';
import { QtEngine } from './engine';
import { DEFAULT_CONFIG_PATH } from './config';

const args = process.argv.slice(2);
function getArg(name: string, defaultVal: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultVal;
}
const hasFlag = (name: string) => args.includes(`--${name}`);

const simulate = hasFlag('simulate');
const live = hasFlag('live');
const host = getArg('host', '127.0.0.1');
const defaultPort = live ? '4001' : '4002';
const port = parseInt(getArg('port', defaultPort), 10);
const clientId = parseInt(getArg('client-id', '3'), 10);
const configPath = getArg('config', DEFAULT_CONFIG_PATH);

const mode = simulate ? 'SIMULATION (dry-run)' : live ? 'LIVE TRADING (real $)' : 'PAPER';

console.log(`
╔══════════════════════════════════════════════╗
║  QuantGT Monthly Rebalancer (qt)             ║
╠══════════════════════════════════════════════╣
║  Mode:       ${mode.padEnd(32)}║
║  IB Gateway: ${`${host}:${port}`.padEnd(32)}║
║  Client ID:  ${String(clientId).padEnd(32)}║
║  Order:      Market-on-Open (MOO / OPG)      ║
╚══════════════════════════════════════════════╝
`);

const client = new IBKRClient(host, port, clientId);
const engine = new QtEngine(client, configPath, { simulate });

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
