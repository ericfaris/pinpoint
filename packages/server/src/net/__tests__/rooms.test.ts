// Regression test for a real Chromecast bug: a receiver reload (the
// receiver.html HTTP-polling fallback redirects the page, which is a real
// socket disconnect) briefly leaves a brand-new room with zero players
// (host hasn't finished the Cast handshake + entered their name yet) and
// zero receivers. Without a grace period, closeIfEmpty destroyed the room
// out from under the in-progress host join, permanently stranding the TV
// on "Waiting for a room…".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyntheticCardSource } from '../../engine/cards.js';
import { makeRng } from '../../engine/rng.js';
import { RoomManager } from '../rooms.js';

function makeManager(): RoomManager {
  return new RoomManager(new SyntheticCardSource(makeRng(1)));
}

describe('RoomManager.closeIfEmpty', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('protects a brand-new empty room (grace period)', () => {
    const rooms = makeManager();
    const { engine } = rooms.create();
    const code = engine.room.code;

    expect(rooms.closeIfEmpty(code)).toBe(false);
    expect(rooms.has(code)).toBe(true);
  });

  it('closes an empty room once the grace period elapses', () => {
    const rooms = makeManager();
    const { engine } = rooms.create();
    const code = engine.room.code;

    vi.advanceTimersByTime(61_000);

    expect(rooms.closeIfEmpty(code)).toBe(true);
    expect(rooms.has(code)).toBe(false);
  });

  it('never closes a room with a connected player, grace period or not', () => {
    const rooms = makeManager();
    const runtime = rooms.create();
    const code = runtime.engine.room.code;
    const res = runtime.engine.join({ displayName: 'Eric' });
    expect(res.ok).toBe(true);

    vi.advanceTimersByTime(61_000);

    expect(rooms.closeIfEmpty(code)).toBe(false);
    expect(rooms.has(code)).toBe(true);
  });

  it('never closes a room with an attached receiver, grace period or not', () => {
    const rooms = makeManager();
    const runtime = rooms.create();
    const code = runtime.engine.room.code;
    runtime.receivers.add('socket-1');

    vi.advanceTimersByTime(61_000);

    expect(rooms.closeIfEmpty(code)).toBe(false);
    expect(rooms.has(code)).toBe(true);
  });
});
