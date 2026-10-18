import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRelay } from './relay.mjs';

const certPath = process.env.PHREMOTE_TLS_CERT;
const keyPath = process.env.PHREMOTE_TLS_KEY;
if (Boolean(certPath) !== Boolean(keyPath)) throw new Error('Set both PHREMOTE_TLS_CERT and PHREMOTE_TLS_KEY');
const tls = certPath ? { cert: await readFile(certPath), key: await readFile(keyPath) } : undefined;
const port = Number(process.env.PHREMOTE_PORT ?? process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid relay port (PHREMOTE_PORT or PORT)');
const relay = await createRelay({
  storePath: resolve(process.env.PHREMOTE_STORE ?? 'server/data/devices.json'),
  allowedOrigins: (process.env.PHREMOTE_ALLOWED_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean),
  tls,
});
await relay.listen({ port, host: process.env.PHREMOTE_HOST ?? '127.0.0.1' });
console.log(`phRemote relay listening on ${tls ? 'https' : 'http'}://${process.env.PHREMOTE_HOST ?? '127.0.0.1'}:${port}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void relay.close().then(() => { process.exitCode = 0; }); });
