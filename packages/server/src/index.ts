// Server bootstrap: Express (static client + config endpoint) + Socket.IO,
// wired to the game engine and the AI card buffer (with seed fallback).
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import 'dotenv/config';
import express from 'express';
import { Server } from 'socket.io';
import { SOCKET_PATH } from '@pinpoint/shared';
import { CardBuffer } from './ai/buffer.js';
import { MessageGenerator } from './ai/generator.js';
import { RoomManager } from './net/rooms.js';
import { attachSocketServer } from './net/server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  res.json({ castReceiverAppId: CAST_RECEIVER_APP_ID, publicBaseUrl: PUBLIC_BASE_URL });
});
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.all().length, pools: cardBuffer.stats() });
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
});

attachSocketServer(io, rooms);

httpServer.listen(PORT, () => {
  console.log(`[startup] Pinpoint server on :${PORT} (socket ${SOCKET_PATH})`);
  // Pre-warm card pools in the background (non-blocking).
  void cardBuffer.warmup().then(() => {
    console.log('[startup] card pools warmed:', cardBuffer.stats());
  });
});
