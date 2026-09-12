/**
 * Bot harness — play a real Pinpoint game with 3 (or N) automated players.
 *
 *   npm run bots                 # 3 bots → TEAM mode (you + 3 = 2v2)
 *   npm run bots -- --bots 2     # 2 bots → THREE_PLAYER mode (you + 2)
 *   npm run bots -- --accuracy 0.9 --fast
 *
 * How it works:
 *   - The first bot creates the room and joins first, so it is the HOST.
 *     It drives every host action for you: start, next round, rematch.
 *   - The other bots join as ordinary players.
 *   - You join from a browser with the printed code and play your own turns.
 *     The harness plays every bot turn: a bot Insider picks a message, writes
 *     one-word clues and submits; a bot Insider in the guessing phase flips a
 *     board and records CORRECT / INCORRECT (weighted by --accuracy) after a
 *     short "let the room talk" delay.
 *
 * Open TWO browser windows: the TV view (receiver.html?code=…) on one, the
 * player view (/?code=…) on another — the player view is you.
 *
 * Requires the dev server (npm run dev). Point --url at whatever origin your
 * browser uses (default http://localhost:5173, through the Vite proxy).
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface, type Interface } from 'node:readline';
import { io as ioc, type Socket } from 'socket.io-client';
import {
  SOCKET_PATH,
  TOKENS_TO_WIN,
  type Ack,
  type BoardSlot,
  type GuessResult,
  type PrivateState,
  type PublicRoom,
} from '@pinpoint/shared';

// ----------------------------------------------------------------- args
interface Args {
  url: string;
  bots: number;
  accuracy: number;
  humans: number;
  open: boolean;
  writeDelayMs: number;
  guessThinkMs: number;
  flipToResultMs: number;
  roundGapMs: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    url: process.env.BOTS_URL ?? 'http://localhost:5173',
    bots: 3,
    accuracy: 0.65,
    humans: 1,
    open: false,
    writeDelayMs: 1500,
    guessThinkMs: 6000,
    flipToResultMs: 2500,
    roundGapMs: 4500,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i]!;
    if (arg === '--url') a.url = next();
    else if (arg === '--bots') a.bots = Number(next());
    else if (arg === '--accuracy') a.accuracy = Number(next());
    else if (arg === '--humans') a.humans = Number(next());
    else if (arg === '--open') a.open = true;
    else if (arg === '--fast') {
      a.writeDelayMs = 400;
      a.guessThinkMs = 1500;
      a.flipToResultMs = 700;
      a.roundGapMs = 1200;
    } else if (arg === '--help' || arg === '-h') {
      console.log(HELP);
      process.exit(0);
    }
  }
  if (!Number.isFinite(a.bots) || a.bots < 2 || a.bots > 7) {
    console.error('--bots must be 2–7');
    process.exit(1);
  }
  return a;
}

const HELP = `bot-harness — play Pinpoint with automated players

  npm run bots [-- options]

  --bots N          bot players (default 3; 2 → THREE_PLAYER mode)
  --humans N        human players to wait for before offering start (default 1)
  --accuracy 0..1   chance a bot Insider records CORRECT (default 0.65)
  --url ORIGIN      dev origin the bots connect through (default http://localhost:5173)
  --open            open the player + TV views in your browser automatically
  --fast            short delays, for quick iteration
`;

/** Best-effort "open this URL in the desktop browser" across WSL / mac / linux. */
function openInBrowser(url: string): void {
  const isWsl =
    !!process.env.WSL_DISTRO_NAME ||
    (() => {
      try {
        return readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
      } catch {
        return false;
      }
    })();
  const wslFirst: Array<[string, string[]]> = [
    ['wslview', [url]],
    ['explorer.exe', [url]],
    ['powershell.exe', ['-NoProfile', '-Command', `Start-Process '${url}'`]],
    ['cmd.exe', ['/c', 'start', '', url]],
  ];
  const nixFirst: Array<[string, string[]]> = [
    ['xdg-open', [url]],
    ['open', [url]],
  ];
  const candidates = isWsl ? [...wslFirst, ...nixFirst] : [...nixFirst, ...wslFirst];

  const tryNext = (i: number): void => {
    if (i >= candidates.length) {
      console.log(C.yellow(`  (couldn't auto-open a browser — copy the URL above)`));
      return;
    }
    const [cmd, cmdArgs] = candidates[i]!;
    const child = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true });
    let advanced = false;
    child.on('error', () => {
      if (!advanced) {
        advanced = true;
        tryNext(i + 1);
      }
    });
    // explorer.exe exits 1 even on success; treat a clean spawn as good enough.
    child.on('spawn', () => child.unref());
  };
  tryNext(0);
}

// ----------------------------------------------------------------- utils
const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
const isOk = (ack: unknown): boolean => !!ack && (ack as Ack<unknown>).ok;

const BOT_NAMES = ['Bishop', 'Rook', 'Knight', 'Sable', 'Vega', 'Ash', 'Corbin'];
const CLUE_WORDS = [
  'radio', 'winter', 'signal', 'border', 'cipher', 'frost', 'agent', 'file',
  'moscow', 'shadow', 'coded', 'wire', 'satchel', 'transit', 'ledger', 'beacon',
  'harbor', 'switch', 'relay', 'archive', 'passport', 'antenna', 'courier', 'static',
];

// ----------------------------------------------------------------- bot
class Bot {
  socket: Socket;
  pub: PublicRoom | null = null;
  priv: PrivateState | null = null;
  playerId = '';
  token = '';
  private done = new Set<string>();
  private pending = new Set<string>();

  constructor(readonly name: string, url: string, onState: (b: Bot) => void) {
    this.socket = ioc(url, {
      path: SOCKET_PATH,
      forceNew: true,
      transports: ['websocket', 'polling'],
    });
    this.socket.on('room:state', (s: PublicRoom) => {
      this.pub = s;
      onState(this);
    });
    this.socket.on('you:state', (s: PrivateState) => {
      this.priv = s;
      onState(this);
    });
    this.socket.on('error', ({ message }: { message: string }) =>
      console.log(C.red(`  ! ${this.name}: ${message}`)),
    );
  }

  connected(): Promise<void> {
    return new Promise((res) => {
      if (this.socket.connected) res();
      else this.socket.once('connect', () => res());
    });
  }
  emit<T>(event: string, payload: unknown = {}): Promise<Ack<T>> {
    return new Promise((res) => this.socket.emit(event, payload, res));
  }
  send(event: string, payload: unknown = {}): void {
    this.socket.emit(event, payload);
  }

  /** run `fn` once for `key`; ignores repeat calls while pending or after done */
  onceDelayed(key: string, ms: number, fn: () => void | Promise<void>): void {
    if (this.done.has(key) || this.pending.has(key)) return;
    this.pending.add(key);
    setTimeout(() => {
      void Promise.resolve(fn()).finally(() => {
        this.pending.delete(key);
        this.done.add(key);
      });
    }, ms);
  }
  forget(prefix: string): void {
    for (const k of [...this.done]) if (k.startsWith(prefix)) this.done.delete(k);
    for (const k of [...this.pending]) if (k.startsWith(prefix)) this.pending.delete(k);
  }
}

// ----------------------------------------------------------------- main
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.bots === 2 ? 'THREE_PLAYER' : 'TEAM';

  console.log(C.bold('\n  Pinpoint bot harness'));
  console.log(C.dim(`  ${args.bots} bots · ${mode} · accuracy ${args.accuracy} · ${args.url}\n`));

  const bots: Bot[] = [];
  let lastPhase = '';
  let gameSerial = 0;
  let endPrompt: (pub: PublicRoom) => Promise<void> = async () => {};

  const react = (b: Bot): void => {
    const pub = b.pub;
    if (!pub || !b.playerId) return;
    const host = bots[0];

    if (b === host && pub.phase !== lastPhase) {
      lastPhase = pub.phase;
      announce(pub);
    }

    const roundNo = pub.round?.roundNumber ?? 0;

    // WRITE_CLUES — a bot Insider writes and submits
    if (pub.phase === 'WRITE_CLUES' && b.priv?.isInsider && b.priv.card) {
      const mine = pub.round?.insiders.find((i) => i.insiderPlayerId === b.playerId);
      if (mine && !mine.submitted) {
        b.onceDelayed(`write:r${roundNo}`, args.writeDelayMs, async () => {
          const card = b.priv?.card ?? [];
          const optionIndex = Math.floor(Math.random() * (card.length || 6));
          b.send('clues:choose', { optionIndex });
          for (const slot of ['A', 'B', 'C'] as BoardSlot[]) {
            b.send('clues:setClue', { slot, clue: pick(CLUE_WORDS) });
          }
          await sleep(250);
          const ack = await b.emit('clues:submit', {});
          console.log(
            isOk(ack)
              ? C.cyan(`  ~ ${b.name} transmitted clues  ${C.dim(`(message: ${card[optionIndex]?.text ?? '?'})`)}`)
              : C.red(`  ! ${b.name} submit failed`),
          );
        });
      }
    }

    // GUESS_* — the active bot Insider flips a board, then records a result
    if ((pub.phase === 'GUESS_FIRST' || pub.phase === 'GUESS_SECOND') && pub.round?.activeGuessing) {
      const g = pub.round.activeGuessing;
      if (g.insiderPlayerId === b.playerId && !g.resolved) {
        const step = g.steps[g.currentStepIndex];
        const key = `guess:r${roundNo}:${pub.phase}:${g.currentStepIndex}`;
        if (step && !step.flippedSlot) {
          b.onceDelayed(`${key}:flip`, args.guessThinkMs, async () => {
            const mine = pub.round?.insiders.find((i) => i.insiderPlayerId === b.playerId);
            const slot = (mine?.clueBoards.find((cb) => !cb.faceUp)?.slot ?? 'A') as BoardSlot;
            if (isOk(await b.emit('guess:flip', { slot }))) {
              console.log(C.cyan(`  ~ ${b.name} flipped board ${slot}`));
            }
          });
        } else if (step?.flippedSlot && !step.spokenResult) {
          b.onceDelayed(`${key}:result`, args.flipToResultMs, async () => {
            const result: GuessResult = Math.random() < args.accuracy ? 'CORRECT' : 'INCORRECT';
            if (isOk(await b.emit('guess:result', { result }))) {
              console.log(
                result === 'CORRECT'
                  ? C.green(`  ~ ${b.name}: target acquired`)
                  : C.yellow(`  ~ ${b.name}: intel compromised`),
              );
            }
          });
        }
      }
    }

    // ROUND_END — host bot advances
    if (pub.phase === 'ROUND_END' && b === host) {
      b.onceDelayed(`next:r${roundNo}`, args.roundGapMs, async () => {
        if (!isOk(await b.emit('round:next', {}))) console.log(C.red('  ! round:next failed'));
        bots.forEach((x) => {
          x.forget('write:');
          x.forget('guess:');
        });
      });
    }

    // GAME_OVER — host bot reports and prompts
    if (pub.phase === 'GAME_OVER' && b === host) {
      b.onceDelayed(`gameover:${gameSerial}`, 500, () => endPrompt(pub));
    }
  };

  // seat bots
  for (let i = 0; i < args.bots; i++) {
    const bot = new Bot(BOT_NAMES[i] ?? `Bot${i + 1}`, args.url, react);
    await bot.connected();
    bots.push(bot);
  }
  const host = bots[0]!;

  const created = await host.emit<{ code: string }>('host:create', { canCast: true });
  if (!created.ok) {
    console.error('host:create failed:', created.error);
    process.exit(1);
  }
  const code = created.data.code;

  for (const bot of bots) {
    const r = await bot.emit<{ playerId: string; reconnectToken: string }>('room:join', {
      code,
      displayName: bot.name,
      canCast: bot === host,
    });
    if (!r.ok) {
      console.error(`${bot.name} join failed:`, r.error);
      process.exit(1);
    }
    bot.playerId = r.data.playerId;
    bot.token = r.data.reconnectToken;
  }
  host.send('host:castStatus', { connected: true });

  const botIds = new Set(bots.map((b) => b.playerId));
  const playerUrl = `${args.url}/?code=${code}`;
  const tvUrl = `${args.url}/receiver.html?code=${code}`;
  const joinPanel = () => {
    console.log(C.bold(`\n  ┌─ ROOM ${C.green(code)} ${C.dim('(new code every run)')}`));
    console.log(`  │  ${C.dim('You (player):')}  ${C.cyan(playerUrl)}`);
    console.log(`  │  ${C.dim('TV view:')}       ${C.cyan(tvUrl)}`);
    console.log(C.dim(`  │  Bots: ${bots.map((b) => b.name).join(', ')} · ${host.name} is host`));
    console.log(C.dim(`  │  Pick any name EXCEPT a bot's. Game won't start until you press ENTER here.`));
    console.log(C.bold('  └─'));
  };
  joinPanel();
  if (args.open) {
    console.log(C.dim('  Opening both views in your browser…'));
    openInBrowser(tvUrl);
    setTimeout(() => openInBrowser(playerUrl), 600);
  }

  // A real terminal gets interactive gates (press ENTER to start, r/q at game
  // over). A piped / non-TTY stdin (e.g. run through an editor's shell, CI)
  // would make readline throw ERR_USE_AFTER_CLOSE, so fall back to timed
  // auto-advance instead.
  const interactive = process.stdin.isTTY === true;
  const rl = interactive
    ? createInterface({ input: process.stdin, output: process.stdout })
    : null;
  let gamesPlayed = 0;
  const maxGames = interactive ? Infinity : 5;

  const humansPresent = () =>
    (host.pub?.players ?? []).filter((p) => !botIds.has(p.id) && !p.pendingJoin && p.connected).length;

  const startGame = async (): Promise<boolean> => {
    const ack = await host.emit('lobby:start', {});
    if (!ack.ok) {
      console.log(C.red(`  ! start failed: ${ack.error}`));
      return false;
    }
    gameSerial++;
    gamesPlayed++;
    bots.forEach((b) => {
      b.forget('write:');
      b.forget('guess:');
      b.forget('next:');
    });
    return true;
  };

  endPrompt = async (pub: PublicRoom): Promise<void> => {
    console.log('');
    if (pub.mode === 'TEAM') {
      pub.teams.forEach((t) =>
        console.log(
          `  Team ${t.id}: ${'★'.repeat(t.tokensFlipped)}${'·'.repeat(TOKENS_TO_WIN - t.tokensFlipped)}`,
        ),
      );
      console.log(C.bold(`  ${pub.winnerTeamId ? `Team ${pub.winnerTeamId} wins!` : 'Game over.'}\n`));
    } else {
      pub.players
        .filter((p) => !p.pendingJoin)
        .forEach((p) => console.log(`  ${p.displayName}: ${'★'.repeat(p.tokensFlipped)}`));
      const w = pub.winnerPlayerIds
        .map((id) => pub.players.find((p) => p.id === id)?.displayName)
        .filter(Boolean);
      console.log(
        C.bold(`  ${w.length ? `${w.join(' & ')} win${w.length > 1 ? '' : 's'}!` : 'Game over.'}\n`),
      );
    }
    const quit = () => {
      host.send('host:forceEnd', {});
      console.log(C.dim('  Room closed. Bye.'));
      rl?.close();
      bots.forEach((b) => b.socket.close());
      process.exit(0);
    };
    const rematch = async () => {
      if (isOk(await host.emit('host:rematch', {}))) {
        lastPhase = '';
        bots.forEach((b) => {
          b.forget('write:');
          b.forget('guess:');
          b.forget('next:');
          b.forget('gameover:');
        });
        console.log(C.dim('  Rematch — teams reshuffled.\n'));
      } else {
        console.log(C.red('  ! rematch failed'));
        quit();
      }
    };

    if (rl) {
      const answer = (await ask(rl, '  [r] rematch   [q] quit  > ')).trim().toLowerCase();
      if (answer === 'r') await rematch();
      else quit();
    } else if (gamesPlayed < maxGames) {
      console.log(C.dim(`  Auto-rematch (${gamesPlayed}/${maxGames})…`));
      await sleep(2500);
      await rematch();
    } else {
      console.log(C.dim(`  Played ${gamesPlayed} games.`));
      quit();
    }
  };

  process.stdout.write(C.dim(`\n  Waiting for ${args.humans} player(s) to join…`));
  let announced = 0;
  while (humansPresent() < args.humans) {
    const n = humansPresent();
    if (n !== announced) {
      announced = n;
      process.stdout.write(C.dim(` (${n}/${args.humans})`));
    }
    await sleep(400);
  }
  const names = (host.pub?.players ?? [])
    .filter((p) => !botIds.has(p.id) && p.connected)
    .map((p) => p.displayName);
  console.log(C.green(`\n  In the lobby with you: ${names.join(', ')}`));

  // Re-show the panel so the code/URLs aren't scrolled off, then gate on start.
  joinPanel();
  for (;;) {
    if (rl) {
      await ask(rl, C.bold('\n  Everyone in? Press ENTER to start the game '));
    } else {
      console.log(C.dim('\n  Non-interactive stdin — auto-starting in 3s…'));
      await sleep(3000);
    }
    if (humansPresent() < args.humans) {
      console.log(C.yellow('  Someone dropped — waiting for them to rejoin…'));
      while (humansPresent() < args.humans) await sleep(400);
      continue;
    }
    if (await startGame()) break;
    console.log(C.dim('  Fix the lobby in your browser (team balance / player count), then try again.'));
    if (!rl) await sleep(2000);
  }
}

function announce(pub: PublicRoom): void {
  const r = pub.round?.roundNumber;
  const map: Record<string, string> = {
    LOBBY: 'Lobby',
    WRITE_CLUES: `Round ${r} — Insiders writing clues`,
    GUESS_FIRST: `Round ${r} — guessing, 1st message`,
    GUESS_SECOND: `Round ${r} — guessing, 2nd message`,
    ROUND_END: `Round ${r} — complete`,
    GAME_OVER: 'Game over',
    PAUSED: 'Paused (waiting for a player / TV)',
  };
  console.log(C.bold(`\n  ▸ ${map[pub.phase] ?? pub.phase}`));
}

const ask = (rl: Interface, q: string): Promise<string> =>
  new Promise((res) => {
    try {
      rl.question(q, res);
    } catch {
      res('');
    }
  });

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
