const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Visitors with no Homeroom account ("guests") may look around this app at
// its own address, read-only (every public app). The platform marks
// them with a token of their own: ES256, signed by a key of its own (its
// public half is USERNODE_GUEST_JWT_PUBLIC_KEY), this audience, `pur:
// 'guest'`, `guest: true`, and no id or username. Such a visitor is
// `req.guest`, never `req.user`, and every write they try is answered 401
// `account_required`, which the bridge turns into "Make an account to
// continue".
const GUEST_AUDIENCE = APP_AUDIENCE ? APP_AUDIENCE + ':guest' : null;
const GUEST_PUBLIC_KEY = (process.env.USERNODE_GUEST_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);
// Read-only routes an anonymous visitor may fetch: who is asking (answers
// "nobody") and the club's decisions with their tallies. The club's
// questions and counts are public by design — guests could already read
// everything, and the checks browser reads signed out. Writes stay
// deny-by-default, and the HTML shell still sends anonymous document
// visits to the platform's chromeless view.
const PUBLIC_READ_PATHS = ['/api/me', '/api/decisions'];

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// "Now" for this request, as a Date: `req.now`, set for every request by
// the middleware below. Read the day and the time through it (and
// `usernode.now()` in the page), never `new Date()` or SQL's NOW(),
// wherever they decide what shows: a reminder, a rota, a deadline.
// Production always gets the real time. A staging preview may be shown as of
// a chosen moment: the platform opens it with `?un-now=<ISO time>`, and the
// page sends `usernode.now()` on as the `x-usernode-now` header. Only a
// staging container reads either. See "Time-dependent features" in the
// platform conventions.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';
const PREVIEW_NOW = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
function requestNow(req) {
  const raw = IS_STAGING ? (req.headers['x-usernode-now'] || req.query['un-now']) : null;
  return typeof raw === 'string' && PREVIEW_NOW.test(raw) ? new Date(raw) : new Date();
}

// ── Staging demo ────────────────────────────────────────────────────────────
// `?demo=1` shows the populated demo, on a staging preview only. Outside
// staging the flag does nothing: the plain route never returns is_demo rows.
// `req.demo` is computed per request, here in the auth middleware.
const DEMO_FLAG = 'demo';

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  req.now = requestNow(req);
  req.demo = IS_STAGING && req.query[DEMO_FLAG] === '1';
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }
  if (!req.user && token && GUEST_PUBLIC_KEY && GUEST_AUDIENCE) {
    try {
      const guest = jwt.verify(token, GUEST_PUBLIC_KEY, {
        algorithms: ['ES256'],
        issuer: 'usernode',
        audience: GUEST_AUDIENCE,
      });
      if (guest && guest.pur === 'guest' && guest.guest === true) req.guest = true;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet. A guest may READ: every GET,
  // `/api/*` included, so read routes must not assume req.user (use
  // `req.user ? req.user.id : null`). Every write needs an account.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (req.method === 'GET' && PUBLIC_READ_PATHS.some((p) => req.path === p || req.path.startsWith(p + '/'))) return next();
    if (!req.user && req.guest) {
      if (req.method === 'GET' || req.method === 'HEAD') return next();
      return res.status(401).json({ error: 'account_required' });
    }
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

// ── Schema ──────────────────────────────────────────────────────────────────
// Idempotent, applied on boot. User ids are text from req.user.id; the
// username is copied at write time. Reports and demo_viewers are private:
// they hold who reported what, and who the demo was written for.
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS decisions (
      id serial PRIMARY KEY,
      author_id text NOT NULL,
      author_username text NOT NULL,
      question text NOT NULL CHECK (char_length(question) BETWEEN 3 AND 140),
      details text CHECK (details IS NULL OR char_length(details) <= 1000),
      created_at timestamptz NOT NULL DEFAULT now(),
      closed_at timestamptz,
      is_demo boolean NOT NULL DEFAULT false,
      demo_key text UNIQUE
    );
    CREATE INDEX IF NOT EXISTS decisions_list_idx
      ON decisions (is_demo, closed_at, created_at DESC);

    CREATE TABLE IF NOT EXISTS votes (
      decision_id int NOT NULL REFERENCES decisions(id),
      user_id text NOT NULL,
      choice text NOT NULL CHECK (choice IN ('agree','disagree')),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (decision_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS comments (
      id serial PRIMARY KEY,
      decision_id int NOT NULL REFERENCES decisions(id),
      author_id text NOT NULL,
      author_username text NOT NULL,
      body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
      created_at timestamptz NOT NULL DEFAULT now(),
      demo_key text UNIQUE
    );
    CREATE INDEX IF NOT EXISTS comments_decision_idx
      ON comments (decision_id, created_at);

    CREATE TABLE IF NOT EXISTS reports (
      id serial PRIMARY KEY,
      target_type text NOT NULL CHECK (target_type IN ('decision','comment')),
      target_id int NOT NULL,
      reporter_id text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (target_type, target_id, reporter_id)
    );

    CREATE TABLE IF NOT EXISTS demo_viewers (
      user_id text PRIMARY KEY,
      seeded_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  // Private so a staging copy carries the shape but not the rows.
  await pool.query(`COMMENT ON TABLE reports IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE demo_viewers IS 'staging:private'`);
}

// The hidden rule: an item is left out when it has 3 or more distinct
// reporters, or when the viewer has reported it. Applied in every read.
// Each takes the parameter number that holds the viewer id, so callers
// number their placeholders however they like.
const decisionVisibleSql = (viewer) => `
  (SELECT count(*) FROM reports r
    WHERE r.target_type = 'decision' AND r.target_id = d.id) < 3
  AND ($${viewer}::text IS NULL OR NOT EXISTS (
    SELECT 1 FROM reports r
    WHERE r.target_type = 'decision' AND r.target_id = d.id AND r.reporter_id = $${viewer}))`;
const commentVisibleSql = (viewer) => `
  (SELECT count(*) FROM reports r
    WHERE r.target_type = 'comment' AND r.target_id = c.id) < 3
  AND ($${viewer}::text IS NULL OR NOT EXISTS (
    SELECT 1 FROM reports r
    WHERE r.target_type = 'comment' AND r.target_id = c.id AND r.reporter_id = $${viewer}))`;

// ── Staging seed ────────────────────────────────────────────────────────────
// Boot-time, staging only: seven open and three closed made-up club
// decisions with fake authors and voters, fixed ids, ON CONFLICT DO
// NOTHING. The viewer's own rows (their decision, their votes, their
// comment) are written once per viewer on the first demo list read — see
// seedDemoViewer. The page shows "Staging demo" once; every author here is
// an obviously fake demo_ name.
const DEMO_DECISIONS = [
  { id: 900001, author: 'demo_wren', agoMin: 20, question: 'Make the newsletter monthly instead of weekly?', details: null, agree: 0, disagree: 0, closedAgoMin: null, closedBy: null },
  { id: 900002, author: 'demo_priya', agoMin: 120, question: 'Hold the spring picnic at Riverside Park?', details: 'Saturday 18 May, from noon. Everyone brings one dish to share. The park has toilets, shade and plenty of space for games.', agree: 8, disagree: 2, closedAgoMin: null, closedBy: null },
  { id: 900003, author: 'demo_rowan', agoMin: 300, question: 'Move our weekly meetup from Tuesday to Thursday?', details: null, agree: 5, disagree: 4, closedAgoMin: null, closedBy: null },
  { id: 900005, author: 'demo_tomas', agoMin: 25 * 60, question: 'Raise yearly dues from 20 to 25 to cover room hire?', details: 'The room costs went up in March. At 20 a year we are about 40 short each term.', agree: 3, disagree: 8, closedAgoMin: null, closedBy: null },
  { id: 900006, author: 'demo_kofi', agoMin: 48 * 60, question: 'Buy a second projector for talk nights?', details: null, agree: 3, disagree: 3, closedAgoMin: null, closedBy: null },
  { id: 900007, author: 'demo_kofi', agoMin: 72 * 60, question: 'Invite the chess club to a joint quiz night?', details: 'They asked at the last inter-club meet. Their hall or ours, whichever is free.', agree: 6, disagree: 0, closedAgoMin: null, closedBy: null },
  { id: 900008, author: 'demo_wren', agoMin: 10 * 24 * 60, question: 'Order club T-shirts in forest green?', details: 'Roughly 12 each, sizes at the next meet. Design is the club mark on the front.', agree: 9, disagree: 3, closedAgoMin: 3 * 24 * 60, closedBy: 'demo_wren' },
  { id: 900009, author: 'demo_tomas', agoMin: 9 * 24 * 60, question: 'Move the group chat to a new app?', details: 'The one we use is shutting down. The two on the shortlist are Bean Chat and Ripple.', agree: 2, disagree: 9, closedAgoMin: 4 * 24 * 60, closedBy: 'demo_tomas' },
  { id: 900010, author: 'demo_kofi', agoMin: 8 * 24 * 60, question: 'Do a beach clean-up in May?', details: 'Half a day, gloves and bags provided by the council. Low tide is around ten.', agree: 8, disagree: 1, closedAgoMin: 5 * 24 * 60, closedBy: 'demo_kofi' },
];
// Comment ids start at 910001 so re-seeding never collides.
const DEMO_COMMENTS = [
  { id: 910001, decision: 900002, author: 'demo_rowan', agoMin: 60, body: 'Riverside has the covered tables, so a bit of rain would not stop us.' },
  { id: 910002, decision: 900002, author: 'demo_tomas', agoMin: 59, body: 'Can someone check it does not clash with the town fun run?' },
  { id: 910003, decision: 900002, author: 'demo_priya', agoMin: 58, body: 'Checked: the fun run is the week after. We are clear.' },
  { id: 910004, decision: 900003, author: 'demo_wren', agoMin: 4 * 60, body: 'Thursdays work better for me, I finish early.' },
  { id: 910005, decision: 900003, author: 'demo_tomas', agoMin: 4 * 60 - 5, body: 'Tuesday is our standing late meeting, Thursday avoids it.' },
  { id: 910006, decision: 900003, author: 'demo_rowan', agoMin: 3 * 60, body: 'Worth trying for a month either way.' },
  { id: 910007, decision: 900003, author: 'demo_kofi', agoMin: 2 * 60, body: 'Either is fine here.' },
  { id: 910008, decision: 900003, author: 'demo_priya', agoMin: 100, body: 'Thursday, please, the Tuesday train home is packed.' },
  { id: 910009, decision: 900003, author: 'demo_wren', agoMin: 90, body: 'Same room booked either way, I checked.' },
  { id: 910010, decision: 900003, author: 'demo_tomas', agoMin: 80, body: 'Then let us settle it on the vote.' },
  { id: 910011, decision: 900005, author: 'demo_kofi', agoMin: 23 * 60, body: 'Twenty five still sounds fair for the room.' },
  { id: 910012, decision: 900005, author: 'demo_rowan', agoMin: 22 * 60, body: 'Can we see the room hire figures first?' },
  { id: 910013, decision: 900005, author: 'demo_tomas', agoMin: 21 * 60, body: 'They are on the notice board, I will bring copies.' },
  { id: 910014, decision: 900005, author: 'demo_wren', agoMin: 20 * 60, body: 'Happy to pay it either way.' },
  { id: 910015, decision: 900005, author: 'demo_priya', agoMin: 18 * 60, body: 'Could we do it from January instead of now?' },
  { id: 910016, decision: 900005, author: 'demo_kofi', agoMin: 16 * 60, body: 'January sounds sensible.' },
  { id: 910017, decision: 900005, author: 'demo_rowan', agoMin: 14 * 60, body: 'What happens if we stay at twenty?' },
  { id: 910018, decision: 900005, author: 'demo_tomas', agoMin: 12 * 60, body: 'We would use up the float by spring.' },
  { id: 910019, decision: 900005, author: 'demo_wren', agoMin: 10 * 60, body: 'A quarterly option might soften it.' },
  { id: 910020, decision: 900005, author: 'demo_priya', agoMin: 8 * 60, body: 'Good idea, worth a try.' },
  { id: 910021, decision: 900005, author: 'demo_tomas', agoMin: 6 * 60, body: 'I will note both ideas for the meeting.' },
  { id: 910022, decision: 900006, author: 'demo_wren', agoMin: 40 * 60, body: 'Which model were you looking at?' },
  { id: 910023, decision: 900006, author: 'demo_kofi', agoMin: 38 * 60, body: 'The one the library uses, about the same price.' },
  { id: 910024, decision: 900006, author: 'demo_tomas', agoMin: 30 * 60, body: 'Storage cupboard 2 has room for it.' },
  { id: 910025, decision: 900006, author: 'demo_priya', agoMin: 26 * 60, body: 'Happy to split the cost with the film night budget.' },
  { id: 910026, decision: 900006, author: 'demo_rowan', agoMin: 20 * 60, body: 'Talk nights would be much better with one.' },
  { id: 910027, decision: 900007, author: 'demo_priya', agoMin: 2 * 24 * 60, body: 'Their quiz master would love this.' },
  { id: 910028, decision: 900008, author: 'demo_priya', agoMin: 9 * 24 * 60, body: 'Forest green, please.' },
  { id: 910029, decision: 900008, author: 'demo_kofi', agoMin: 8 * 24 * 60, body: 'Sizes at the next meet, then.' },
  { id: 910030, decision: 900008, author: 'demo_wren', agoMin: 7 * 24 * 60, body: 'Ordered two of each last time, worked well.' },
  { id: 910031, decision: 900009, author: 'demo_wren', agoMin: 9 * 24 * 60 - 10, body: 'The old app shuts down soon, so this matters.' },
  { id: 910032, decision: 900009, author: 'demo_rowan', agoMin: 8 * 24 * 60, body: 'Which app are we moving to?' },
  { id: 910033, decision: 900010, author: 'demo_kofi', agoMin: 7 * 24 * 60, body: 'I will bring the litter pickers.' },
  { id: 910034, decision: 900010, author: 'demo_wren', agoMin: 6 * 24 * 60, body: 'May tides are morning ones, we should start early.' },
];

async function seedDemo() {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const d of DEMO_DECISIONS) {
      await c.query(
        `INSERT INTO decisions (id, author_id, author_username, question, details, created_at, closed_at, is_demo)
         VALUES ($1, $2, $3, $4, $5, now() - ($6 || ' minutes')::interval,
                 CASE WHEN $7::int IS NULL THEN NULL ELSE now() - ($7 || ' minutes')::interval END, true)
         ON CONFLICT (id) DO NOTHING`,
        [d.id, d.author, d.author, d.question, d.details, d.agoMin, d.closedAgoMin]
      );
    }
    // Fake voters: agree voters numbered from 01, disagree voters from 31,
    // so the two never collide on the (decision, voter) primary key. The
    // counts above EXCLUDE the viewer's own vote, so the totals on screen
    // match once their vote is added.
    for (const d of DEMO_DECISIONS) {
      const voters = [];
      for (let i = 1; i <= d.agree; i++) voters.push([pad2(i), 'agree']);
      for (let i = 1; i <= d.disagree; i++) voters.push([pad2(30 + i), 'disagree']);
      for (const [n, choice] of voters) {
        await c.query(
          `INSERT INTO votes (decision_id, user_id, choice, updated_at)
           VALUES ($1, 'demo_voter_' || $2, $3, now())
           ON CONFLICT (decision_id, user_id) DO NOTHING`,
          [d.id, n, choice]
        );
      }
    }
    for (const cm of DEMO_COMMENTS) {
      await c.query(
        `INSERT INTO comments (id, decision_id, author_id, author_username, body, created_at)
         VALUES ($1, $2, $3, $3, $4, now() - ($5 || ' minutes')::interval)
         ON CONFLICT (id) DO NOTHING`,
        [cm.id, cm.decision, cm.author, cm.body, cm.agoMin]
      );
    }
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('staging seed failed: ' + err.message);
  } finally {
    c.release();
  }
}
const pad2 = (n) => String(n).padStart(2, '0');

// The viewer's own demo rows, written ONCE per viewer: their decision
// (board game library), their five votes, and their comment on the picnic.
// ON CONFLICT DO NOTHING RETURNING means a reload changes nothing, and what
// the viewer does afterwards (a vote changed, a comment added) stays.
async function seedDemoViewer(userId, username) {
  const ins = await pool.query(
    `INSERT INTO demo_viewers (user_id) VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING RETURNING user_id`,
    [userId]
  );
  if (ins.rowCount === 0) return; // already seeded
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const lib = await c.query(
      `INSERT INTO decisions (author_id, author_username, question, details, created_at, is_demo, demo_key)
       VALUES ($1, $2, 'Start a shared club library of board games?', 'We each bring one game and keep the box in the clubhouse.', now() - interval '1 day', true, $3)
       RETURNING id`,
      [userId, username, 'library:' + userId]
    );
    const libId = lib.rows[0].id;
    for (const [n, choice] of [[pad2(1), 'agree'], [pad2(2), 'agree'], [pad2(3), 'agree'], [pad2(4), 'agree'], [pad2(5), 'agree'], [pad2(7), 'disagree'], [pad2(8), 'disagree']]) {
      await c.query(
        `INSERT INTO votes (decision_id, user_id, choice, updated_at)
         VALUES ($1, 'demo_voter_' || $2, $3, now()) ON CONFLICT DO NOTHING`,
        [libId, n, choice]
      );
    }
    const mine = [
      [libId, 'agree'],
      [900002, 'agree'],
      [900003, 'disagree'],
      [900007, 'agree'],
      [900008, 'agree'],
    ];
    for (const [id, choice] of mine) {
      await c.query(
        `INSERT INTO votes (decision_id, user_id, choice, updated_at)
         VALUES ($1, $2, $3, now()) ON CONFLICT (decision_id, user_id) DO NOTHING`,
        [id, userId, choice]
      );
    }
    await c.query(
      `INSERT INTO comments (decision_id, author_id, author_username, body, created_at, demo_key)
       VALUES (900002, $1, $2, 'I can bring the picnic blankets and a speaker.', now() - interval '40 minutes', $3)
       ON CONFLICT (demo_key) DO NOTHING`,
      [userId, username, 'picnic:' + userId]
    );
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    console.error('demo viewer seed failed: ' + err.message);
  } finally {
    c.release();
  }
}

// ── API ─────────────────────────────────────────────────────────────────────
function viewerId(req) { return req.user ? req.user.id : null; }
function outcome(agree, disagree) {
  if (agree > disagree) return 'agreed';
  if (disagree > agree) return 'not_agreed';
  return 'tied';
}

app.get('/api/me', (req, res) => {
  res.json({
    user: req.user ? { id: req.user.id, username: req.user.username } : null,
    guest: !!req.guest,
    demo: req.demo,
  });
});

app.get('/api/decisions', async (req, res) => {
  const status = req.query.status === 'decided' ? 'decided'
    : req.query.status === 'open' || !req.query.status ? 'open' : null;
  if (!status) return res.status(400).json({ error: 'Unknown status. Use open or decided.' });
  const vid = viewerId(req);
  try {
    if (req.demo && req.user) await seedDemoViewer(req.user.id, req.user.username);
    const list = await pool.query(
      `SELECT d.id, d.question, d.author_id, d.author_username, d.created_at, d.closed_at,
        (SELECT count(*) FROM votes v WHERE v.decision_id = d.id AND v.choice = 'agree') AS agree,
        (SELECT count(*) FROM votes v WHERE v.decision_id = d.id AND v.choice = 'disagree') AS disagree,
        (SELECT v.choice FROM votes v WHERE v.decision_id = d.id AND v.user_id = $1) AS my_vote,
        ($1::text IS NOT NULL AND d.author_id = $1) AS mine,
        (SELECT count(*) FROM comments c WHERE c.decision_id = d.id AND ${commentVisibleSql(1)}) AS comment_count
       FROM decisions d
       WHERE d.is_demo = $2 AND ${decisionVisibleSql(1)}
         AND (CASE WHEN $3 = 'decided' THEN d.closed_at IS NOT NULL ELSE d.closed_at IS NULL END)
       ORDER BY (CASE WHEN $3 = 'decided' THEN d.closed_at ELSE d.created_at END) DESC
       LIMIT 100`,
      [vid, req.demo, status]
    );
    const counts = await pool.query(
      `SELECT count(*) FILTER (WHERE closed_at IS NULL) AS open,
              count(*) FILTER (WHERE closed_at IS NOT NULL) AS decided
       FROM decisions d
       WHERE d.is_demo = $1 AND ${decisionVisibleSql(2)}`,
      [req.demo, vid]
    );
    res.json({
      demo: req.demo,
      decisions: list.rows.map((r) => ({
        id: r.id,
        question: r.question,
        author_username: r.author_username,
        mine: r.mine,
        created_at: r.created_at,
        closed_at: r.closed_at,
        closed_by: null,
        agree: Number(r.agree),
        disagree: Number(r.disagree),
        my_vote: r.my_vote,
        comment_count: Number(r.comment_count),
        outcome: r.closed_at ? outcome(Number(r.agree), Number(r.disagree)) : null,
      })),
      counts: {
        open: Number(counts.rows[0].open),
        decided: Number(counts.rows[0].decided),
      },
    });
  } catch (err) {
    console.error('list decisions failed: ' + err.message);
    res.status(500).json({ error: 'Something went wrong loading the decisions.' });
  }
});

app.post('/api/decisions', async (req, res) => {
  const question = typeof req.body.question === 'string' ? req.body.question.trim() : '';
  const details = typeof req.body.details === 'string' ? req.body.details.trim() : '';
  if (question.length < 3 || question.length > 140) {
    return res.status(400).json({ error: 'The question needs between 3 and 140 characters.' });
  }
  if (details.length > 1000) {
    return res.status(400).json({ error: 'Details can be at most 1,000 characters.' });
  }
  try {
    const r = await pool.query(
      `INSERT INTO decisions (author_id, author_username, question, details, created_at, is_demo)
       VALUES ($1, $2, $3, NULLIF($4, ''), $5, $6) RETURNING id, question, details, created_at, closed_at`,
      [req.user.id, req.user.username, question, details || null, req.now, req.demo]
    );
    const row = r.rows[0];
    res.status(201).json({
      id: row.id, question: row.question, author_username: req.user.username,
      mine: true, created_at: row.created_at, closed_at: null, closed_by: null,
      agree: 0, disagree: 0, my_vote: null, comment_count: 0, outcome: null,
    });
  } catch (err) {
    console.error('post decision failed: ' + err.message);
    res.status(500).json({ error: 'Your decision did not save. Try again.' });
  }
});

async function loadDecision(id, vid, isDemo) {
  const r = await pool.query(
    `SELECT d.id, d.question, d.details, d.author_id, d.author_username, d.created_at, d.closed_at,
      (SELECT count(*) FROM votes v WHERE v.decision_id = d.id AND v.choice = 'agree') AS agree,
      (SELECT count(*) FROM votes v WHERE v.decision_id = d.id AND v.choice = 'disagree') AS disagree,
      (SELECT v.choice FROM votes v WHERE v.decision_id = d.id AND v.user_id = $2) AS my_vote,
      ($2::text IS NOT NULL AND d.author_id = $2) AS mine,
      (SELECT reporter_id FROM reports r WHERE r.target_type = 'decision' AND r.target_id = d.id AND r.reporter_id = $2 LIMIT 1) AS i_reported
     FROM decisions d
     WHERE d.id = $1 AND d.is_demo = $3`,
    [id, vid, isDemo]
  );
  return r.rows[0] || null;
}

app.get('/api/decisions/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'not_found' });
  const vid = viewerId(req);
  try {
    const d = await loadDecision(id, vid, req.demo);
    if (!d) return res.status(404).json({ error: 'not_found' });
    // Hidden by reports: 410 removed for the viewer.
    const flag = await pool.query(
      `SELECT (SELECT count(DISTINCT r.reporter_id) FROM reports r
                WHERE r.target_type = 'decision' AND r.target_id = $1) >= 3
              OR ($2::text IS NOT NULL AND EXISTS (
                SELECT 1 FROM reports r WHERE r.target_type = 'decision'
                AND r.target_id = $1 AND r.reporter_id = $2)) AS hidden`,
      [id, vid]
    );
    if (flag.rows[0].hidden) return res.status(410).json({ error: 'removed' });
    const comments = await pool.query(
      `SELECT c.id, c.author_id, c.author_username, c.body, c.created_at,
              ($2::text IS NOT NULL AND c.author_id = $2) AS mine
       FROM comments c
       WHERE c.decision_id = $1 AND ${commentVisibleSql(2)}
       ORDER BY c.created_at ASC`,
      [id, vid]
    );
    res.json({
      id: d.id, question: d.question, details: d.details,
      author_username: d.author_username, mine: d.mine,
      created_at: d.created_at, closed_at: d.closed_at,
      agree: Number(d.agree), disagree: Number(d.disagree),
      my_vote: d.my_vote, outcome: d.closed_at ? outcome(Number(d.agree), Number(d.disagree)) : null,
      comments: comments.rows.map((c) => ({
        id: c.id, author_username: c.author_username, body: c.body,
        created_at: c.created_at, mine: c.mine,
      })),
    });
  } catch (err) {
    console.error('decision detail failed: ' + err.message);
    res.status(500).json({ error: 'Something went wrong loading this decision.' });
  }
});

async function tallies(decisionId, vid) {
  const r = await pool.query(
    `SELECT
      (SELECT count(*) FROM votes v WHERE v.decision_id = $1 AND v.choice = 'agree') AS agree,
      (SELECT count(*) FROM votes v WHERE v.decision_id = $1 AND v.choice = 'disagree') AS disagree,
      (SELECT v.choice FROM votes v WHERE v.decision_id = $1 AND v.user_id = $2) AS my_vote`,
    [decisionId, vid]
  );
  const row = r.rows[0];
  return { agree: Number(row.agree), disagree: Number(row.disagree), my_vote: row.my_vote };
}

app.put('/api/decisions/:id/vote', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const choice = req.body.choice === null ? null : req.body.choice;
  if (choice !== null && choice !== 'agree' && choice !== 'disagree') {
    return res.status(400).json({ error: 'Choice must be agree, disagree or null.' });
  }
  try {
    const d = await pool.query(
      `SELECT id, closed_at FROM decisions d WHERE d.id = $1 AND d.is_demo = $3 AND ${decisionVisibleSql(2)}`,
      [id, viewerId(req), req.demo]
    );
    if (d.rowCount === 0) return res.status(404).json({ error: 'not_found' });
    if (d.rows[0].closed_at) return res.status(409).json({ error: 'closed' });
    if (choice === null) {
      await pool.query(`DELETE FROM votes WHERE decision_id = $1 AND user_id = $2`, [id, req.user.id]);
    } else {
      // One vote per person per decision: an upsert changes it, a delete
      // takes it back.
      await pool.query(
        `INSERT INTO votes (decision_id, user_id, choice, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (decision_id, user_id)
         DO UPDATE SET choice = $3, updated_at = $4`,
        [id, req.user.id, choice, req.now]
      );
    }
    res.json(await tallies(id, req.user.id));
  } catch (err) {
    console.error('vote failed: ' + err.message);
    res.status(500).json({ error: 'Your vote did not save. Try again.' });
  }
});

app.post('/api/decisions/:id/close', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const d = await pool.query(
      `SELECT author_id, closed_at FROM decisions WHERE id = $1 AND is_demo = $2`,
      [id, req.demo]
    );
    if (d.rowCount === 0) return res.status(404).json({ error: 'not_found' });
    if (d.rows[0].author_id !== req.user.id) return res.status(403).json({ error: 'not_yours' });
    if (d.rows[0].closed_at) return res.status(409).json({ error: 'already_closed' });
    await pool.query(`UPDATE decisions SET closed_at = $2 WHERE id = $1`, [id, req.now]);
    const t = await tallies(id, req.user.id);
    res.json({ closed_at: req.now, outcome: outcome(t.agree, t.disagree) });
  } catch (err) {
    console.error('close failed: ' + err.message);
    res.status(500).json({ error: 'The decision could not be closed. Try again.' });
  }
});

app.post('/api/decisions/:id/comments', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const body = typeof req.body.body === 'string' ? req.body.body.trim() : '';
  if (body.length < 1 || body.length > 1000) {
    return res.status(400).json({ error: 'A comment needs between 1 and 1,000 characters.' });
  }
  try {
    const d = await pool.query(
      `SELECT id FROM decisions d WHERE d.id = $1 AND d.is_demo = $3 AND ${decisionVisibleSql(2)}`,
      [id, viewerId(req), req.demo]
    );
    if (d.rowCount === 0) return res.status(404).json({ error: 'not_found' });
    // Comments stay open after a decision is closed: the club can talk
    // about the follow-up.
    const r = await pool.query(
      `INSERT INTO comments (decision_id, author_id, author_username, body, created_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [id, req.user.id, req.user.username, body, req.now]
    );
    res.status(201).json({
      id: r.rows[0].id, author_username: req.user.username, body,
      created_at: r.rows[0].created_at, mine: true,
    });
  } catch (err) {
    console.error('comment failed: ' + err.message);
    res.status(500).json({ error: 'Your comment did not save. Try again.' });
  }
});

app.post('/api/reports', async (req, res) => {
  const { type, id } = req.body || {};
  if ((type !== 'decision' && type !== 'comment') || !Number.isInteger(id)) {
    return res.status(400).json({ error: 'A report needs a type and an id.' });
  }
  try {
    // Comments have no is_demo of their own: their decision carries it.
    const row = type === 'decision'
      ? await pool.query(`SELECT author_id FROM decisions WHERE id = $1 AND is_demo = $2`, [id, req.demo])
      : await pool.query(
        `SELECT c.author_id FROM comments c JOIN decisions d ON d.id = c.decision_id
         WHERE c.id = $1 AND d.is_demo = $2`,
        [id, req.demo]
      );
    if (row.rowCount === 0) return res.status(404).json({ error: 'not_found' });
    if (row.rows[0].author_id === req.user.id) {
      return res.status(400).json({ error: 'You cannot report your own post.' });
    }
    await pool.query(
      `INSERT INTO reports (target_type, target_id, reporter_id, created_at)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [type, id, req.user.id, req.now]
    );
    const count = await pool.query(
      `SELECT count(DISTINCT reporter_id) AS n FROM reports
       WHERE target_type = $1 AND target_id = $2`,
      [type, id]
    );
    res.json({ reported: true, reporters: Number(count.rows[0].n) });
  } catch (err) {
    console.error('report failed: ' + err.message);
    res.status(500).json({ error: 'The report did not save. Try again.' });
  }
});

// ── Static + shell ──────────────────────────────────────────────────────────
let shuttingDown = false;

app.get('/health', (_req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'shutting_down' });
  res.json({ status: 'ok' });
});

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user && !req.guest) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // shell decodes and validates it as relative-only before use. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/club-votes-0e42b6/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/club-votes-0e42b6/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Boot + shutdown ─────────────────────────────────────────────────────────
let server;

async function start() {
  await ensureSchema();
  if (IS_STAGING) await seedDemo();
  server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

// Stop accepting connections, drain for ~3s, close the pool, exit.
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, draining`);
  if (!server) { process.exit(0); return; }
  server.close(() => {
    pool.end().then(() => process.exit(0)).catch(() => process.exit(0));
  });
  setTimeout(() => {
    pool.end().then(() => process.exit(0)).catch(() => process.exit(0));
  }, 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch(err => { console.error(err); process.exit(1); });
