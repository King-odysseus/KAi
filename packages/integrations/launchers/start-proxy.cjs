'use strict';

const path = require('node:path');

const engineRoot = process.env.KAI_UAP_ENGINE_ROOT;
if (!engineRoot) {
  process.stderr.write('[kai-proxy] KAI_UAP_ENGINE_ROOT is not set.\n');
  process.exit(2);
}

let ProxyServer;
try {
  ({ ProxyServer } = require(path.join(engineRoot, 'out', 'proxy.js')));
} catch (error) {
  process.stderr.write(`[kai-proxy] Could not load Universal Agent Proxy: ${messageOf(error)}\n`);
  process.exit(2);
}

readStdin()
  .then((payload) => start(payload))
  .catch((error) => {
    process.stderr.write(`[kai-proxy] ${messageOf(error)}\n`);
    process.exit(1);
  });

async function start(payload) {
  const { config, runtime = {} } = payload;
  if (!config || typeof config !== 'object') throw new Error('Proxy configuration is missing.');

  const server = new ProxyServer();
  await server.start(
    config,
    (line) => process.stdout.write(`${line}\n`),
    undefined,
    undefined,
    runtime.errorThreshold,
    runtime.retryConfig,
    runtime.historyConfig,
    runtime.budgetConfig,
    (cap, current, period) =>
      process.stdout.write(`Budget ${period} threshold reached: ${current}/${cap}\n`),
    runtime.rateLimitMaxRPS,
    runtime.maxConcurrent,
    runtime.logging,
    runtime.upstreamTimeout,
    runtime.tls,
  );

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await server.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      input += chunk;
      if (input.length > 2_000_000) reject(new Error('Proxy configuration is too large.'));
    });
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(input));
      } catch (error) {
        reject(new Error(`Invalid proxy configuration: ${messageOf(error)}`));
      }
    });
    process.stdin.on('error', reject);
  });
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
