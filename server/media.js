'use strict';
/* Music / media controls. Only browser media and an optional local audio URL.
   Never claim Spotify, Apple Music or YouTube succeeded without an official
   configured integration (none ships in this build). Playback is requested of
   the client; confirmedPlayback stays false unless the client reports it. */
const cfgm = require('./config');
const permissions = require('./permissions');

const state = {
  provider: 'none',
  playing: false,
  title: null,
  query: null,
  volume: 80,
  lastAction: null,
  lastAt: null,
  clientReported: false
};

function snapshot() {
  return {
    provider: state.provider,
    playing: !!state.playing,
    title: state.title,
    query: state.query,
    volume: state.volume,
    lastAction: state.lastAction,
    lastAt: state.lastAt,
    clientReported: !!state.clientReported,
    confirmedPlayback: !!state.clientReported
  };
}

function limitation(service) {
  const name = service || 'that service';
  return `I cannot control ${name} from here — there is no official configured integration. I can pause/resume whatever this browser is already playing, or play a local file you add in Settings → Media. I will not pretend playback happened.`;
}

function localUrl() {
  const cfg = cfgm.load();
  return String((cfg.media && cfg.media.localUrl) || '').trim();
}

async function play({ query, source } = {}) {
  const q = String(query || '').trim();
  const local = localUrl();
  const branded = q.match(/\b(spotify|apple music|youtube music|yt music|deezer|tidal)\b/i);
  if (branded) {
    permissions.audit({ integration: 'media', action: 'play', status: 'denied', summary: `refused unconfigured ${branded[1]}` });
    return {
      ok: false,
      intent: 'media-play',
      reply: limitation(branded[1]),
      nowPlaying: snapshot(),
      confirmedPlayback: false
    };
  }
  const wantLocal = String(source || '').toLowerCase() === 'local'
    || /\bfocus\b|\blocal\b/i.test(q)
    || (!!local && /playlist/i.test(q));
  if (wantLocal && local) {
    state.provider = 'local';
    state.playing = false;
    state.clientReported = false;
    state.title = q || 'local audio';
    state.query = q;
    state.lastAction = 'play_local';
    state.lastAt = Date.now();
    permissions.audit({ integration: 'media', action: 'play', status: 'ok', summary: 'requested local audio' });
    return {
      ok: true,
      intent: 'media-play',
      clientAction: { type: 'play', url: local, title: state.title },
      reply: `I'll play your local audio in this browser. I cannot confirm it is audible until the page actually starts playback — this is not Spotify or Apple Music.`,
      nowPlaying: snapshot(),
      confirmedPlayback: false
    };
  }
  state.provider = 'browser';
  state.playing = false;
  state.clientReported = false;
  state.title = q || null;
  state.query = q;
  state.lastAction = 'play_browser';
  state.lastAt = Date.now();
  permissions.audit({ integration: 'media', action: 'play', status: 'ok', summary: 'requested browser media (unconfirmed)' });
  return {
    ok: false,
    intent: 'media-play',
    clientAction: { type: 'play_browser', query: q },
    reply: q
      ? `I cannot start "${q}" myself. If a track is already playing in this tab I can pause or skip it. To play a focus track, add a local audio URL in Settings → Media.`
      : 'Nothing is configured to play. Add a local audio URL in Settings → Media, or start playback in the browser first.',
    nowPlaying: snapshot(),
    confirmedPlayback: false
  };
}

function pause() {
  if (state.provider === 'none' && !state.playing) {
    return { ok: false, intent: 'media-pause', reply: 'Nothing is playing that I can control in this browser.', nowPlaying: snapshot(), confirmedPlayback: false };
  }
  state.playing = false;
  state.lastAction = 'pause';
  state.lastAt = Date.now();
  return {
    ok: true,
    intent: 'media-pause',
    clientAction: { type: 'pause' },
    reply: 'Pause requested in this browser. I cannot confirm a pause on Spotify/Apple Music without an official integration.',
    nowPlaying: snapshot(),
    confirmedPlayback: false
  };
}

function resume() {
  if (state.provider === 'none' && !state.title) {
    return { ok: false, intent: 'media-resume', reply: 'Nothing to resume — nothing has been playing under my control.', nowPlaying: snapshot(), confirmedPlayback: false };
  }
  state.lastAction = 'resume';
  state.lastAt = Date.now();
  const local = localUrl();
  return {
    ok: true,
    intent: 'media-resume',
    clientAction: { type: state.provider === 'local' && local ? 'play' : 'resume', url: local || undefined, title: state.title },
    reply: 'Resume requested in this browser. Playback is unconfirmed until the page reports it.',
    nowPlaying: snapshot(),
    confirmedPlayback: false
  };
}

function skip() {
  state.lastAction = 'skip';
  state.lastAt = Date.now();
  return {
    ok: false,
    intent: 'media-skip',
    clientAction: { type: 'skip' },
    reply: 'Skip is only possible if this browser is already playing media it can control. I will not claim a skip on Spotify or Apple Music.',
    nowPlaying: snapshot(),
    confirmedPlayback: false
  };
}

function setVolume(n) {
  const v = Math.max(0, Math.min(100, Number(n)));
  if (!Number.isFinite(v)) {
    return { ok: false, intent: 'media-volume', reply: 'Give me a volume between 0 and 100.', nowPlaying: snapshot() };
  }
  state.volume = v;
  state.lastAction = 'volume';
  state.lastAt = Date.now();
  return {
    ok: true,
    intent: 'media-volume',
    clientAction: { type: 'volume', value: v },
    reply: `Volume requested at ${v}%. Applies only to local/browser audio I can reach.`,
    nowPlaying: snapshot(),
    confirmedPlayback: false
  };
}

function nowPlaying() {
  const snap = snapshot();
  if (snap.provider === 'none' && !snap.title) {
    return { ok: true, intent: 'media-now', reply: 'Nothing is playing under my control. I will not invent a now-playing track.', nowPlaying: snap, confirmedPlayback: false };
  }
  const conf = snap.clientReported ? 'The browser confirmed playback.' : 'Playback has not been confirmed by the browser.';
  return {
    ok: true,
    intent: 'media-now',
    reply: `${snap.playing ? 'Requested playing' : 'Last requested'}: ${snap.title || snap.query || 'browser media'} (${snap.provider}). ${conf}`,
    nowPlaying: snap,
    confirmedPlayback: !!snap.clientReported
  };
}

/* Client (the page) reports actual playback so we never invent it. */
function report({ playing, title, provider } = {}) {
  if (playing === true || playing === false) state.playing = !!playing;
  if (title) state.title = String(title).slice(0, 160);
  if (provider) state.provider = String(provider);
  state.clientReported = true;
  state.lastAt = Date.now();
  return snapshot();
}

function _reset() {
  state.provider = 'none';
  state.playing = false;
  state.title = null;
  state.query = null;
  state.volume = 80;
  state.lastAction = null;
  state.lastAt = null;
  state.clientReported = false;
}

module.exports = { play, pause, resume, skip, setVolume, nowPlaying, report, snapshot, limitation, _reset };
