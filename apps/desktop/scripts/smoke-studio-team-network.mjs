// Checks the same peer discovery and WebRTC data path used by connected Project Studio.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({
  stdin: {
    contents: `import { joinRoom } from 'trystero';
      window.joinTestRoom = (roomId, password) => {
        const room = joinRoom({ appId: 'ai.kai.desktop.project-studio.team.v1', password }, roomId);
        const action = room.makeAction('test');
        window.received = [];
        window.peers = [];
        room.onPeerJoin = id => window.peers.push(id);
        action.onMessage = text => window.received.push(text);
        window.sendTestMessage = text => action.send(text);
      };`,
    resolveDir: appRoot,
    sourcefile: 'team-smoke.js',
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  write: false,
});
const script = bundle.outputFiles[0].text;
const server = http.createServer((request, response) => {
  response.setHeader('Content-Type', request.url === '/bundle.js' ? 'text/javascript' : 'text/html');
  response.end(request.url === '/bundle.js' ? script : '<script src="/bundle.js"></script>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const browser = await chromium.launch({ headless: true });
try {
  const first = await browser.newPage();
  const second = await browser.newPage();
  await Promise.all([first.goto(`http://127.0.0.1:${port}`), second.goto(`http://127.0.0.1:${port}`)]);
  const roomId = crypto.randomUUID().replaceAll('-', '');
  const password = crypto.randomUUID().replaceAll('-', '');
  await Promise.all([
    first.evaluate(([room, secret]) => window.joinTestRoom(room, secret), [roomId, password]),
    second.evaluate(([room, secret]) => window.joinTestRoom(room, secret), [roomId, password]),
  ]);
  await Promise.all([
    first.waitForFunction(() => window.peers?.length > 0, null, { timeout: 45_000 }),
    second.waitForFunction(() => window.peers?.length > 0, null, { timeout: 45_000 }),
  ]);
  await first.evaluate(() => window.sendTestMessage('KAi team connection works'));
  await second.waitForFunction(() => window.received?.includes('KAi team connection works'), null, { timeout: 15_000 });
  console.log('Connected Project Studio peer transport passed.');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
