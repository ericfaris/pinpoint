import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { PublicRoom, TeamId } from '@triangulation/shared';
import { useGame } from '../common/useGame.js';
import { store } from '../common/store.js';
import { Board, CategoryTag, Timer, Tokens } from '../common/ui.js';
import { CAST_NAMESPACE } from '../common/cast.js';

const teamClass = (t: TeamId) => (t === 'A' ? 'teamA' : 'teamB');
const nameOf = (pub: PublicRoom, id: string) =>
  pub.players.find((p) => p.id === id)?.displayName ?? '???';

export default function App() {
  const g = useGame();
  const [baseUrl, setBaseUrl] = useState(window.location.origin);

  // Resolve the room code: ?code= (local), or via Cast custom message channel.
  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((c) => c.publicBaseUrl && setBaseUrl(c.publicBaseUrl))
      .catch(() => undefined);

    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.get('code');
    if (fromQuery) {
      void store.receiverSubscribe(fromQuery);
      return;
    }
    // Running on a Chromecast: read the code off the Cast receiver channel.
    const cast = (window as { cast?: any }).cast;
    if (cast?.framework?.CastReceiverContext) {
      const ctx = cast.framework.CastReceiverContext.getInstance();
      ctx.addCustomMessageListener(CAST_NAMESPACE, (event: any) => {
        const code = event?.data?.code;
        if (code) void store.receiverSubscribe(String(code));
      });
      ctx.start();
    }
  }, []);

  if (!g.pub) {
    return (
      <div className="tv center">
        <div className="brand">TRIANGULATION</div>
        <div className="muted">Waiting for a room…</div>
      </div>
    );
  }

  const pub = g.pub;
  if (pub.phase === 'LOBBY') return <LobbyTV pub={pub} baseUrl={baseUrl} />;
  if (pub.phase === 'PAUSED') return <PausedTV pub={pub} />;
  return <GameTV pub={pub} />;
}

function LobbyTV({ pub, baseUrl }: { pub: PublicRoom; baseUrl: string }) {
  const [qr, setQr] = useState<string>('');
  useEffect(() => {
    const url = `${baseUrl}/?code=${pub.code}`;
    QRCode.toDataURL(url, { width: 360, margin: 1 }).then(setQr).catch(() => undefined);
  }, [baseUrl, pub.code]);

  return (
    <div className="tv">
      <div className="brand">TRIANGULATION</div>
      <div className="spread" style={{ flex: 1 }}>
        <div className="stack center-text">
          <div style={{ fontSize: '2vw' }} className="muted">
            Join at <b>{baseUrl.replace(/^https?:\/\//, '')}</b>
          </div>
          <div className="codebox">{pub.code}</div>
          <div className="muted" style={{ fontSize: '1.6vw' }}>
            {pub.players.filter((p) => !p.pendingJoin).length} players in lobby
          </div>
        </div>
        {qr && (
          <div className="qr">
            <img src={qr} alt="Join QR" />
          </div>
        )}
      </div>
      <div className="players">
        {pub.players.map((p) => (
          <div key={p.id} className="pchip">
            {p.displayName}
            {p.isHost ? ' 👑' : ''}
          </div>
        ))}
      </div>
    </div>
  );
}

function GameTV({ pub }: { pub: PublicRoom }) {
  const g = pub.round?.activeGuessing;
  const insiderState = g
    ? pub.round!.insiders.find((i) => i.insiderPlayerId === g.insiderPlayerId)
    : null;

  return (
    <div className="tv">
      <div className="spread">
        <div className="brand">
          ROUND {pub.round?.roundNumber ?? '–'} ·{' '}
          {pub.phase === 'GUESS_FIRST'
            ? '1ST MESSAGE'
            : pub.phase === 'GUESS_SECOND'
              ? '2ND MESSAGE'
              : pub.phase === 'WRITE_CLUES'
                ? 'WRITING CLUES'
                : 'ROUND END'}
        </div>
        {pub.timer.enabled && pub.timer.phaseDeadline && (
          <Timer deadline={pub.timer.phaseDeadline} className="bigtimer" />
        )}
      </div>

      <Scoreboard pub={pub} />

      {g && insiderState ? (
        <div className="stack" style={{ flex: 1 }}>
          <div className="brand">
            {nameOf(pub, g.insiderPlayerId)}’s message
            {g.revealedCategory && (
              <>
                {' '}
                <CategoryTag category={g.revealedCategory} />
              </>
            )}
          </div>
          <div className="boards">
            {insiderState.clueBoards.map((b) => (
              <Board key={b.slot} board={b} />
            ))}
          </div>
        </div>
      ) : (
        <div className="center" style={{ flex: 1 }}>
          <div className="brand">
            {pub.phase === 'WRITE_CLUES' ? 'Insiders are writing clues…' : 'Get ready…'}
          </div>
        </div>
      )}
    </div>
  );
}

function Scoreboard({ pub }: { pub: PublicRoom }) {
  if (pub.mode === 'TEAM') {
    return (
      <div className="teams">
        {pub.teams.map((t) => (
          <div key={t.id} className="scorecard spread">
            <span className={`teamname ${teamClass(t.id)}`}>Team {t.id}</span>
            <Tokens count={t.tokensFlipped} big />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="teams" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
      {pub.players.filter((p) => !p.pendingJoin).map((p) => (
        <div key={p.id} className="scorecard center-text stack">
          <span className="teamname">{p.displayName}</span>
          <Tokens count={p.tokensFlipped} big />
        </div>
      ))}
    </div>
  );
}

function PausedTV({ pub }: { pub: PublicRoom }) {
  return (
    <div className="tv center">
      <div className="codebox">⏸</div>
      <div className="brand">
        {pub.pause.reason === 'CAST_DROPPED' ? 'Reconnecting to TV…' : 'Paused — waiting for a player'}
      </div>
    </div>
  );
}
