import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { createApplication, declaredRoutes } from './app.ts';


// Process overrides win; .env.local wins over .env, independently of launch cwd.
config({path: fileURLToPath(new URL('../.env.local', import.meta.url)), quiet: true});
config({path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true});
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name)+1] : fallback;
const port = Number(option('--port', process.env.PORT ?? '3000'));
const host = option('--hostname', process.env.HOST ?? '127.0.0.1');
if (!Number.isInteger(port) || port < 1 || port > 65535 || !host) throw new Error('Invalid server address');
const app = await createApplication();
app.enableShutdownHooks();
await app.listen(port, host);
console.log(`Nest API listening on http://${host}:${port}`);
console.log('Rutas disponibles:');
for (const entry of declaredRoutes()) console.log(`  ${entry.method.padEnd(7)} ${entry.path}`);
