import { useState } from 'react';
import {
  CATEGORY_LABELS,
  type BoardSlot,
  type PublicRoom,
  type PrivateState,
  type TeamId,
} from '@triangulation/shared';
import { store } from '../common/store.js';
import { Board, CategoryTag, Timer, Tokens } from '../common/ui.js';

const nameOf = (pub: PublicRoom, id: string) =>
  pub.players.find((p) => p.id === id)?.displayName ?? '???';

const teamLabel = (t: TeamId | null) => (t ? `Team ${t}` : '');
const teamClass = (t: TeamId | null) => (t === 'A' ? 'teamA' : t === 'B' ? 'teamB' : '');

function me(pub: PublicRoom, priv: PrivateState) {
  return pub.players.find((p) => p.id === priv.playerId) ?? null;
}

// ---------------------------------------------------------------- Lobby
export function Lobby({ pub, priv }: { pub: PublicRoom; priv: PrivateState }) {
  const self = me(pub, priv);
  const isHost = !!self?.isHost;
  const present = pub.players.filter((p) => !p.pendingJoin);
  const teamA = pub.players.filter((p) => p.teamId === 'A');
  const teamB = pub.players.filter((p) => p.teamId === 'B');
  const willBe3P = present.length === 3;

  const canStart =
    isHost &&
    pub.castConnected &&
    present.length >= 3 &&
    (willBe3P || (teamA.length >= 2 && teamB.length >= 2));

  return (
    <div className="stack">
      <div className="card stack">
        <div className="spread">
          <div className="h2">Lobby</div>
          <div className="pill">Code {pub.code}</div>
        </div>
        <div className="small muted">
          {pub.castConnected ? '📺 TV connected' : '⚠️ Waiting for TV (cast)…'}
        </div>
      </div>

      {willBe3P ? (
        <div className="card stack">
          <div className="h2">3-Player Mode</div>
          <div className="muted small">No teams — Insider / Interceptor / Contact each round.</div>
          {present.map((p) => (
            <div key={p.id} className="row">
              <span>👤 {p.displayName}</span>
              {p.isHost && <span className="pill">host</span>}
            </div>
          ))}
        </div>
      ) : (
        <div className="row wrap" style={{ alignItems: 'stretch' }}>
          {(['A', 'B'] as TeamId[]).map((t) => (
            <div key={t} className="card grow stack">
              <div className={`h2 ${teamClass(t)}`}>{teamLabel(t)}</div>
              {pub.players.filter((p) => p.teamId === t).map((p) => (
                <div key={p.id} className="spread">
                  <span>
                    {p.displayName} {p.isHost && <span className="pill">host</span>}
                    {p.pendingJoin && <span className="pill">next round</span>}
                    {!p.connected && <span className="pill">offline</span>}
                  </span>
                  {isHost && !p.pendingJoin && (
                    <button
                      className="ghost small"
                      onClick={() => store.assignTeam(p.id, t === 'A' ? 'B' : 'A')}
                    >
                      → {t === 'A' ? 'B' : 'A'}
                    </button>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {isHost && (
        <div className="card stack">
          <div className="h2">Settings</div>
          <Toggle
            label="Casual Mode (reveal category)"
            value={pub.settings.casualMode}
            onChange={(v) => store.updateSettings({ casualMode: v })}
          />
          <Toggle
            label="Turn timers"
            value={pub.settings.timersEnabled}
            onChange={(v) => store.updateSettings({ timersEnabled: v })}
          />
          <label className="stack small">
            <span className="muted">Insider rotation</span>
            <select
              value={pub.settings.rotationMode}
              onChange={(e) => store.updateSettings({ rotationMode: e.target.value as never })}
            >
              <option value="IN_ORDER">In order</option>
              <option value="RANDOM">Random</option>
            </select>
          </label>
          <label className="stack small">
            <span className="muted">Message difficulty</span>
            <select
              value={pub.settings.difficulty}
              onChange={(e) => store.updateSettings({ difficulty: e.target.value as never })}
            >
              <option value="EASY">Easy</option>
              <option value="MEDIUM">Medium</option>
              <option value="HARD">Hard</option>
            </select>
          </label>
        </div>
      )}

      {isHost ? (
        <button className="primary" disabled={!canStart} onClick={() => store.start()}>
          {pub.castConnected
            ? present.length < 3
              ? 'Need 3+ players'
              : 'Start Game'
            : 'Connect TV to start'}
        </button>
      ) : (
        <div className="notice center-text">Waiting for the host to start…</div>
      )}
    </div>
  );
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button className="spread" onClick={() => onChange(!value)}>
      <span>{label}</span>
      <span className={`pill ${value ? '' : 'muted'}`}>{value ? 'ON' : 'OFF'}</span>
    </button>
  );
}

// ------------------------------------------------------------ Write Clues
export function WriteClues({ pub, priv }: { pub: PublicRoom; priv: PrivateState }) {
  const insiderState = pub.round?.insiders.find((i) => i.insiderPlayerId === priv.playerId);
  const amInsider = priv.isInsider && !!insiderState;

  if (!amInsider) {
    const pending = pub.round?.insiders.filter((i) => !i.submitted) ?? [];
    return (
      <div className="stack">
        <PhaseHeader pub={pub} title="Clue writing" />
        <div className="card center-text stack">
          <div className="h2">Insiders are writing clues…</div>
          <div className="muted">
            {pending.length
              ? `Waiting for: ${pending.map((i) => nameOf(pub, i.insiderPlayerId)).join(', ')}`
              : 'Starting…'}
          </div>
        </div>
      </div>
    );
  }

  return <InsiderWriter pub={pub} priv={priv} />;
}

function InsiderWriter({ pub, priv }: { pub: PublicRoom; priv: PrivateState }) {
  const card = priv.card ?? [];
  const chosen = priv.chosenOptionIndex;
  const clues = priv.ownClues ?? [];
  const [submitting, setSubmitting] = useState(false);

  const clueFor = (slot: BoardSlot) => clues.find((c) => c.slot === slot)?.clue ?? '';
  const allFilled = chosen !== null;

  const warn = (slot: BoardSlot): string | null => {
    const c = clueFor(slot).trim();
    if (!c) return null;
    if (/\s/.test(c)) return 'One word only';
    if (/-/.test(c)) return 'Avoid hyphens';
    if (chosen !== null) {
      const msg = card[chosen]?.text.toLowerCase() ?? '';
      const root = c.toLowerCase();
      if (root.length >= 4 && (msg.includes(root) || root.includes(msg.split(' ')[0] ?? '###')))
        return 'Shares a root with the message';
    }
    return null;
  };

  return (
    <div className="stack">
      <PhaseHeader pub={pub} title="Your turn: write clues" />
      <div className="card stack">
        <div className="h2">Pick your secret message</div>
        <div className="muted small">Tap one. Your teammates can’t see this screen.</div>
        <div className="stack">
          {card.map((opt, i) => (
            <button
              key={i}
              className={`option${chosen === i ? ' sel' : ''}`}
              onClick={() => store.choose(i)}
            >
              <CategoryTag category={opt.category} />
              <span className="grow">{opt.text}</span>
              <span className="muted small">{CATEGORY_LABELS[opt.category]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="card stack">
        <div className="h2">Three one-word clues</div>
        {(['A', 'B', 'C'] as BoardSlot[]).map((slot) => (
          <label key={slot} className="stack" style={{ gap: 4 }}>
            <div className="spread">
              <span className="muted small">Board {slot}</span>
              {warn(slot) && <span className="small" style={{ color: 'var(--warn)' }}>⚠ {warn(slot)}</span>}
            </div>
            <input
              value={clueFor(slot)}
              placeholder="one word"
              maxLength={40}
              onChange={(e) => store.setClue(slot, e.target.value)}
            />
          </label>
        ))}
      </div>

      <button
        className="primary"
        disabled={!allFilled || submitting}
        onClick={async () => {
          setSubmitting(true);
          const ok = await store.submit();
          if (!ok) setSubmitting(false);
        }}
      >
        {allFilled ? 'Submit clues' : 'Pick a message first'}
      </button>
      <div className="muted small center-text">
        Blank boards are allowed. First to submit is guessed first.
      </div>
    </div>
  );
}

// -------------------------------------------------------------- Guessing
export function Guessing({ pub, priv }: { pub: PublicRoom; priv: PrivateState }) {
  const g = pub.round?.activeGuessing;
  if (!g) return null;
  const insiderState = pub.round!.insiders.find((i) => i.insiderPlayerId === g.insiderPlayerId)!;
  const amActiveInsider = priv.playerId === g.insiderPlayerId;
  const self = me(pub, priv);
  const step = g.steps[g.currentStepIndex]!;
  const needsFlip = !step.flippedSlot;

  const stepLabel = () => {
    if (pub.mode === 'THREE_PLAYER') {
      const which = g.currentStepIndex < 2 ? 'Interceptor' : 'Contact';
      const ord = g.currentStepIndex === 0 ? ' (guess 1)' : g.currentStepIndex === 1 ? ' (guess 2)' : ' (final)';
      return `${which}${ord}`;
    }
    const team = step.guessingTeam;
    const ord = g.currentStepIndex === 0 ? 'Intercept — guess 1' : g.currentStepIndex === 1 ? 'Intercept — guess 2' : 'Contact — final guess';
    return `${teamLabel(team)} · ${ord}`;
  };

  // Is it "my" turn to guess (verbally)? (TEAM mode by team; 3P by role)
  const myTurn =
    pub.mode === 'TEAM'
      ? self?.teamId === step.guessingTeam && !amActiveInsider
      : priv.threePlayerRole === (g.currentStepIndex < 2 ? 'INTERCEPTOR' : 'CONTACT');

  return (
    <div className="stack">
      <PhaseHeader pub={pub} title={pub.phase === 'GUESS_FIRST' ? 'Guessing — 1st message' : 'Guessing — 2nd message'} />

      <div className="card stack">
        <div className="spread">
          <div>
            <div className="muted small">Insider</div>
            <div className="h2">{nameOf(pub, g.insiderPlayerId)}</div>
          </div>
          <div className="center-text">
            <div className="muted small">Now guessing</div>
            <div className="pill">{stepLabel()}</div>
          </div>
        </div>
        {g.revealedCategory && (
          <div className="notice row">
            <CategoryTag category={g.revealedCategory} />
            <span>Casual Mode: the message is a <b>{CATEGORY_LABELS[g.revealedCategory]}</b>.</span>
          </div>
        )}
        {myTurn && <div className="notice">🗣️ Your turn — discuss and say your guess out loud to the Insider.</div>}
      </div>

      <div className="grid3">
        {insiderState.clueBoards.map((b) => (
          <Board
            key={b.slot}
            board={b}
            flippable={amActiveInsider && needsFlip && pub.phase !== 'ROUND_END'}
            onFlip={(slot) => store.flip(slot)}
          />
        ))}
      </div>

      {amActiveInsider ? (
        <InsiderControls priv={priv} needsFlip={needsFlip} />
      ) : (
        <div className="notice center-text muted">
          The Insider flips boards and records the result. Guess out loud.
        </div>
      )}
    </div>
  );
}

function InsiderControls({
  priv,
  needsFlip,
}: {
  priv: PrivateState;
  needsFlip: boolean;
}) {
  const myMsg =
    priv.card && priv.chosenOptionIndex !== null ? priv.card[priv.chosenOptionIndex] : null;
  return (
    <div className="card stack">
      {myMsg && (
        <div className="row">
          <CategoryTag category={myMsg.category} />
          <span className="muted small">Your message:</span>
          <b>{myMsg.text}</b>
        </div>
      )}
      {needsFlip ? (
        <div className="notice">
          Tap the clue board your guessers asked for, above. (Final guess auto-reveals the last board.)
        </div>
      ) : (
        <div className="stack">
          <div className="muted small center-text">After hearing the spoken guess:</div>
          <div className="row">
            <button className="good grow" onClick={() => store.result('CORRECT')}>
              ✓ Correct
            </button>
            <button className="bad grow" onClick={() => store.result('INCORRECT')}>
              ✗ Incorrect
            </button>
          </div>
        </div>
      )}
      <button className="ghost small" onClick={() => store.flagCard()}>
        🚩 Flag this message
      </button>
    </div>
  );
}

// -------------------------------------------------------------- Round End
export function RoundEnd({ pub, priv }: { pub: PublicRoom; priv: PrivateState }) {
  const self = me(pub, priv);
  return (
    <div className="stack">
      <PhaseHeader pub={pub} title="Round complete" />
      <ScoreSummary pub={pub} />
      {self?.isHost ? (
        <button className="primary" onClick={() => store.nextRound()}>
          Next round →
        </button>
      ) : (
        <div className="notice center-text">Waiting for the host to start the next round…</div>
      )}
    </div>
  );
}

// -------------------------------------------------------------- Game Over
export function GameOver({ pub, priv }: { pub: PublicRoom; priv: PrivateState }) {
  const self = me(pub, priv);
  const winnerText =
    pub.mode === 'TEAM'
      ? pub.winnerTeamId
        ? `Team ${pub.winnerTeamId} wins!`
        : 'Game over'
      : pub.winnerPlayerIds.length
        ? `${pub.winnerPlayerIds.map((id) => nameOf(pub, id)).join(' & ')} win${pub.winnerPlayerIds.length > 1 ? '' : 's'}!`
        : 'Game over';

  return (
    <div className="stack">
      <div className="card center-text stack">
        <div className="title">🏆 {winnerText}</div>
      </div>
      <ScoreSummary pub={pub} />
      {self?.isHost ? (
        <div className="stack">
          <button className="primary" onClick={() => store.rematch()}>
            Rematch (reshuffle teams)
          </button>
          <button className="ghost" onClick={() => store.forceEnd()}>
            Close room
          </button>
        </div>
      ) : (
        <div className="notice center-text">Waiting for the host to start a rematch…</div>
      )}
    </div>
  );
}

function ScoreSummary({ pub }: { pub: PublicRoom }) {
  if (pub.mode === 'TEAM') {
    return (
      <div className="row wrap">
        {pub.teams.map((t) => (
          <div key={t.id} className="card grow center-text stack">
            <div className={`h2 ${teamClass(t.id)}`}>{teamLabel(t.id)}</div>
            <Tokens count={t.tokensFlipped} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="card stack">
      {pub.players.filter((p) => !p.pendingJoin).map((p) => (
        <div key={p.id} className="spread">
          <span>{p.displayName}</span>
          <Tokens count={p.tokensFlipped} />
        </div>
      ))}
    </div>
  );
}

// -------------------------------------------------------------- shared bits
function PhaseHeader({ pub, title }: { pub: PublicRoom; title: string }) {
  return (
    <div className="card spread">
      <div>
        <div className="muted small">Round {pub.round?.roundNumber ?? '–'}</div>
        <div className="h2">{title}</div>
      </div>
      {pub.timer.enabled && pub.timer.phaseDeadline && (
        <Timer deadline={pub.timer.phaseDeadline} />
      )}
    </div>
  );
}

export function Paused({ pub }: { pub: PublicRoom }) {
  const reason = pub.pause.reason;
  const who = pub.pause.waitingForPlayerId ? nameOf(pub, pub.pause.waitingForPlayerId) : null;
  return (
    <div className="card center-text stack">
      <div className="title">⏸ Paused</div>
      <div className="muted">
        {reason === 'CAST_DROPPED'
          ? 'Reconnecting to the TV…'
          : who
            ? `Waiting for ${who} to reconnect…`
            : 'Waiting to resume…'}
      </div>
    </div>
  );
}
