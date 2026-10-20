// utils/expoProjects.js
// Expo push for phones built under two EAS projects. Every Expo request goes through here.
//
// Which project a token belongs to:
//   1. the projectId the app sent with the token (new builds; stored on User.pushTokens)
//   2. otherwise learned from Expo: a mixed batch is rejected with
//      PUSH_TOO_MANY_EXPERIENCE_IDS listing each project's tokens; a refused access token is
//      retried with each project's own token. What is learned is returned to the caller,
//      which stores it, so the next send needs no guessing.
//   A token that can't be placed is sent with EXPO_ACCESS_TOKEN (or none) as before.
//
// Access tokens (Railway env; values are never logged):
//   EXPO_ACCESS_TOKEN_112506B0  → @aqkhan622/Testting (112506b0-…)
//   EXPO_ACCESS_TOKEN_D14CDF3A  → @aqkhan621/tdc      (d14cdf3a-…)
//   EXPO_ACCESS_TOKEN           → fallback for both, and for tokens of unknown project
// Any other project: EXPO_ACCESS_TOKEN_<first 8 characters of its id, upper case>.
// Without a token Expo only accepts the send while Enhanced Push Security is off.

const { Expo } = require('expo-server-sdk');

const PROJECTS = [
  { id: '112506b0-7553-4a1b-afeb-6a37019cc15f', name: '@aqkhan622/Testting' },
  { id: 'd14cdf3a-2494-4d4f-bee0-90f862bf3389', name: '@aqkhan621/tdc' },
];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isProjectId = (v) => UUID_RE.test(String(v || ''));
const short = (projectId) => String(projectId || '').slice(0, 8).toLowerCase();
const envName = (projectId) => `EXPO_ACCESS_TOKEN_${String(projectId).slice(0, 8).toUpperCase()}`;
const label = (projectId) => {
  const p = PROJECTS.find((x) => x.id === projectId);
  return p ? `${short(projectId)} (${p.name})` : short(projectId) || 'unknown project';
};

// Expo's error details name a project by id or by "@owner/slug"
function projectFromExperience(key) {
  const k = String(key || '').trim();
  if (isProjectId(k)) return k.toLowerCase();
  const p = PROJECTS.find((x) => x.name.toLowerCase() === k.toLowerCase());
  return p ? p.id : null;
}

// which env var gives this project its token (the name only)
function tokenSource(projectId) {
  if (projectId && process.env[envName(projectId)]) return envName(projectId);
  if (process.env.EXPO_ACCESS_TOKEN) return 'EXPO_ACCESS_TOKEN';
  return null;
}

// one client per distinct access token (tests replace the factory)
let makeClient = (accessToken) => new Expo(accessToken ? { accessToken } : {});
const clients = new Map();
function clientForSource(source) {
  const key = source || '';
  if (!clients.has(key)) clients.set(key, makeClient(source ? process.env[source] : undefined));
  return clients.get(key);
}
const clientFor = (projectId) => clientForSource(tokenSource(projectId));

// readable warnings, each once per process (no token values, ever)
const warned = new Set();
function warnOnce(key, line) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(line);
}

const isAuthError = (err) =>
  err?.statusCode === 401 || err?.statusCode === 403 ||
  /UNAUTHORI[SZ]ED|FORBIDDEN|ACCESS_TOKEN|AUTH|PERMISSION|INSUFFICIENT/i.test(String(err?.code || ''));

const errorTickets = (n, code, message) =>
  Array.from({ length: n }, () => ({ status: 'error', message, details: { error: code } }));

function noTokenWarning(projectId) {
  if (tokenSource(projectId)) return;
  warnOnce(`none:${projectId || '?'}`,
    `[push] project ${label(projectId)}: no access token set (${projectId ? `${envName(projectId)} or ` : ''}EXPO_ACCESS_TOKEN). ` +
    'Sending without one: Expo accepts this only while Enhanced Push Security is off for that project.');
}

function refusedWarning(projectId, source) {
  warnOnce(`refused:${projectId || '?'}:${source || 'none'}`,
    `[push] project ${label(projectId)}: Expo refused the send ${source ? `with the token from ${source}` : 'without an access token'} ` +
    `(wrong Expo account, expired token, or Enhanced Push Security needs one). ` +
    `${projectId ? `Set ${envName(projectId)} to an access token of the account that owns this project.` : 'Set the project tokens.'}`);
}

/**
 * One chunk with one client. Mixed projects are split by Expo's own grouping and each part
 * goes to its project's client. Returns tickets in message order.
 */
async function sendChunk(client, projectId, chunk, learned, depth = 0) {
  try {
    return await client.sendPushNotificationsAsync(chunk);
  } catch (err) {
    // tokens from several projects: Expo lists each project's tokens
    if (err?.code === 'PUSH_TOO_MANY_EXPERIENCE_IDS' && err.details && typeof err.details === 'object' && depth < 3) {
      const byToken = new Map();
      for (const [experience, tokens] of Object.entries(err.details)) {
        const group = chunk.filter((m) => Array.isArray(tokens) && tokens.includes(m.to));
        if (!group.length) continue;
        const pid = projectFromExperience(experience);
        if (pid) group.forEach((m) => (learned[m.to] = pid));
        else warnOnce(`exp:${experience}`, `[push] tokens from a project this server doesn't know (${String(experience).slice(0, 60)}): sent with EXPO_ACCESS_TOKEN`);
        noTokenWarning(pid);
        const res = await sendChunk(pid ? clientFor(pid) : clientForSource(tokenSource(null)), pid, group, learned, depth + 1);
        group.forEach((m, i) => byToken.set(m.to, res[i]));
      }
      return chunk.map((m) => byToken.get(m.to) || { status: 'error', message: 'not sent', details: { error: 'PUSH_TOO_MANY_EXPERIENCE_IDS' } });
    }
    // the access token was refused: for tokens of unknown project, try each project's token
    if (isAuthError(err)) {
      const usedSource = tokenSource(projectId);
      if (!projectId && depth < 3) {
        const tried = new Set([usedSource || '']);
        for (const p of PROJECTS) {
          const src = tokenSource(p.id);
          if (tried.has(src || '')) continue;
          tried.add(src || '');
          try {
            const res = await clientForSource(src).sendPushNotificationsAsync(chunk);
            chunk.forEach((m) => (learned[m.to] = p.id));
            return res;
          } catch (e2) {
            if (!isAuthError(e2)) break;
          }
        }
      }
      refusedWarning(projectId, usedSource);
      return errorTickets(chunk.length, 'UNAUTHORIZED', `Expo refused the access token for project ${label(projectId)}`);
    }
    // anything else: one by one, so one bad message doesn't sink the rest
    if (chunk.length > 1) {
      const out = [];
      for (const m of chunk) out.push(...(await sendChunk(client, projectId, [m], learned, depth)));
      return out;
    }
    console.error(`[push] send failed (project ${label(projectId)}):`, err?.code || '', err?.statusCode || '', err?.message);
    return errorTickets(1, err?.code || (err?.statusCode === 401 ? 'UNAUTHORIZED' : 'SEND_FAILED'), err?.message || 'send failed');
  }
}

/**
 * Sends messages, each project with its own access token.
 *   projectOf: { [pushToken]: projectId } from User.pushTokens (missing = not known yet)
 * → { tickets (same order as messages, each with .projectId when known), learned: { token: projectId } }
 */
async function sendByProject(messages, projectOf = {}) {
  const tickets = new Array(messages.length);
  const learned = {};
  const groups = new Map(); // projectId | '' → [index]
  messages.forEach((m, i) => {
    const pid = isProjectId(projectOf[m.to]) ? String(projectOf[m.to]).toLowerCase() : '';
    if (!groups.has(pid)) groups.set(pid, []);
    groups.get(pid).push(i);
  });
  for (const [pid, idxs] of groups) {
    const projectId = pid || null;
    noTokenWarning(projectId);
    const client = clientFor(projectId);
    const msgs = idxs.map((i) => messages[i]);
    let done = 0;
    for (const chunk of client.chunkPushNotifications(msgs)) {
      const res = await sendChunk(client, projectId, chunk, learned);
      chunk.forEach((m, k) => {
        const i = idxs[done + k];
        const p = projectId || learned[m.to] || null;
        tickets[i] = { ...(res[k] || { status: 'error', message: 'no ticket', details: { error: 'SEND_FAILED' } }), ...(p ? { projectId: p } : {}) };
      });
      done += chunk.length;
    }
  }
  return { tickets, learned };
}

/**
 * Receipts for ticket ids from both projects.
 *   projectOfId: { [ticketId]: projectId } (tickets from sendByProject carry .projectId)
 * Known ids are asked with their project's token. Unknown ids are asked with each token in
 * turn; a refused group is split in half so one project's ids can't block the other's.
 * → { [ticketId]: receipt }
 */
async function getReceipts(ids, projectOfId = {}) {
  const out = {};
  if (!ids?.length) return out;
  const sources = [...new Set([tokenSource(null) || '', ...PROJECTS.map((p) => tokenSource(p.id) || '')])];

  // ask one client for some ids; refused → halves (max depth keeps it bounded)
  async function ask(src, list, depth = 0) {
    const client = clientForSource(src || null);
    let chunks;
    try {
      chunks = client.chunkPushNotificationReceiptIds(list);
    } catch (err) {
      console.warn('[push] receipt check failed:', err?.message);
      return;
    }
    for (const chunk of chunks) {
      try {
        Object.assign(out, await client.getPushNotificationReceiptsAsync(chunk));
      } catch (err) {
        if (!isAuthError(err)) {
          console.warn('[push] receipt check failed:', err?.code || '', err?.message);
        } else if (chunk.length > 1 && depth < 6) {
          const half = Math.ceil(chunk.length / 2);
          await ask(src, chunk.slice(0, half), depth + 1);
          await ask(src, chunk.slice(half), depth + 1);
        }
      }
    }
  }

  const known = new Map();
  const unknown = [];
  for (const id of ids) {
    const pid = isProjectId(projectOfId[id]) ? projectOfId[id] : null;
    if (pid) {
      const src = tokenSource(pid) || '';
      if (!known.has(src)) known.set(src, []);
      known.get(src).push(id);
    } else unknown.push(id);
  }
  for (const [src, list] of known) await ask(src, list);
  for (const src of sources) {
    const missing = unknown.filter((id) => !out[id]);
    if (!missing.length) break;
    await ask(src, missing);
  }
  return out;
}

const projectOfEntries = (entries) =>
  Object.fromEntries((entries || []).filter((e) => e?.token && isProjectId(e.projectId)).map((e) => [e.token, e.projectId]));

module.exports = {
  PROJECTS,
  isProjectId,
  envName,
  tokenSource,
  projectFromExperience,
  sendByProject,
  getReceipts,
  projectOfEntries,
  // tests
  _setClientFactory: (fn) => { makeClient = fn; clients.clear(); warned.clear(); },
  _reset: () => { clients.clear(); warned.clear(); },
};
