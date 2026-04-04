import 'dotenv/config';
import { LinearTradingEngine } from './engine';
import { IBKRClient } from '../ibkr';

const args = process.argv.slice(2);
function getArg(name: string, defaultVal: string): string {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultVal;
}
const hasFlag = (name: string) => args.includes(`--${name}`);

const simulate = hasFlag('simulate');
const host = getArg('host', '127.0.0.1');
const port = parseInt(getArg('port', '4001'), 10);
const clientId = parseInt(getArg('client-id', '2'), 10); // client ID 2 for Linear so it doesn't conflict with v1

console.log(`
╔══════════════════════════════════════════════╗
║  Linear Strategy Auto-Trader (v2)            ║
╠══════════════════════════════════════════════╣
║  IB Gateway: ${host}:${port}${' '.repeat(Math.max(0, 28 - host.length - String(port).length))}║
║  Client ID:  ${clientId}${' '.repeat(Math.max(0, 30 - String(clientId).length))}║
║  Exec Time:  3:45 PM ET (once daily)         ║
╚══════════════════════════════════════════════╝
`);

const client = new IBKRClient(host, port, clientId);
const engine = new LinearTradingEngine(client, simulate);

process.on('SIGINT', async () => {
  await engine.stop();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await engine.stop();
  process.exit(0);
});

engine.start().catch((err: any) => {
  console.error('[Engine] Failed to start:', err.message);
  process.exit(1);
});
