// Server bootstrap: Express (static client + config endpoint) + Socket.IO,
// wired to the game engine and the AI card buffer (with seed fallback).
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import express from 'express';
import { Server } from 'socket.io';
import { SOCKET_PATH } from '@pinpoint/shared';
import { CardBuffer } from './ai/buffer.js';
import { MessageGenerator } from './ai/generator.js';
import { RoomManager } from './net/rooms.js';
import { attachSocketServer } from './net/server.js';
import { loadRootEnv, readAppVersion } from './env.js';

loadRootEnv();

// Last-resort safety net: every socket event and timer callback in
// net/server.ts already catches its own exceptions (a single room's bug
// must never take down every other concurrent game), but this is the
// backstop for anywhere that guard was missed. Node's default behavior for
// an uncaught exception is to terminate the process — for a long-running
// multi-room game server that means one bad room ends everyone else's game
// too. Log and keep running instead.
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException (server staying up):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection (server staying up):', reason);
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_VERSION = readAppVersion();

const PORT = Number(process.env.PORT ?? 3001);
const CAST_RECEIVER_APP_ID = process.env.CAST_RECEIVER_APP_ID ?? '';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? `http://localhost:5173`;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5';

// --- Card generation: AI buffer with seed fallback (§4.12) ---
const generator = ANTHROPIC_API_KEY
  ? new MessageGenerator({ apiKey: ANTHROPIC_API_KEY, model: ANTHROPIC_MODEL })
  : null;
if (!generator) {
  console.warn('[startup] ANTHROPIC_API_KEY not set — using bundled seed cards only.');
}
const cardBuffer = new CardBuffer(generator);
const rooms = new RoomManager(cardBuffer);

// --- HTTP + static client ---
const app = express();
app.get('/api/config', (_req, res) => {
  res.json({
    castReceiverAppId: CAST_RECEIVER_APP_ID,
    publicBaseUrl: PUBLIC_BASE_URL,
    appVersion: APP_VERSION,
  });
});
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, version: APP_VERSION, rooms: rooms.all().length, pools: cardBuffer.stats() });
});
app.get('/api/cast-room', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const code = rooms.getPendingCastCode();
  res.json({ code });
});

// Serve the built client if present (player at /, receiver at /receiver/).
const clientDist = join(__dirname, '../../client/dist');
const DEPLOY_VERSION = Date.now().toString(36);
if (existsSync(clientDist)) {
  // Redirect /receiver.html to a versioned URL so the Chromecast never serves
  // a cached copy — the version changes on every deploy.
  app.get('/receiver.html', (req, res) => {
    if (req.query.v === DEPLOY_VERSION) {
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(join(clientDist, 'receiver.html'));
    } else {
      res.redirect(302, `/receiver.html?v=${DEPLOY_VERSION}`);
    }
  });
  app.use(express.static(clientDist));
  // SPA fallback for the player deep-link routes (/, /join?code=…). The TV
  // receiver is served directly as /receiver.html by express.static above.
  app.get(/^\/(join)?$/, (_req, res) => {
    res.sendFile(join(clientDist, 'index.html'));
  });
}

const httpServer = createServer(app);
const io = new Server(httpServer, {
  path: SOCKET_PATH,
  cors: { origin: true, credentials: true },
  // Mobile browsers throttle JS timers in backgrounded tabs, which starves
  // the Socket.IO heartbeat well before the player actually left. Default
  // (25s interval / 20s timeout, ~45s combined) is too tight for someone
  // who just tabbed away for a minute — give it real slack so that doesn't
  // read as a disconnect at all. (See net/server.ts
  // DEFAULT_DISCONNECT_GRACE_MS for the second layer: even a real detected
  // disconnect gets a grace window before it actually pauses the game.)
  pingInterval: 25_000,
  pingTimeout: 60_000,
});

attachSocketServer(io, rooms);

httpServer.listen(PORT, () => {
  console.log(`[startup] Pinpoint v${APP_VERSION} on :${PORT} (socket ${SOCKET_PATH})`);
  // Pre-warm card pools in the background (non-blocking).
  void cardBuffer.warmup().then(() => {
    console.log('[startup] card pools warmed:', cardBuffer.stats());
  });
});
