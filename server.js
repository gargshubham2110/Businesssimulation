/* Ledger League — multiplayer business simulation server.
   Holds every game in memory, saves them to data/games.json, and pushes live updates over Socket.IO. */
const path = require("path");
const fs = require("fs");
const http = require("http");
const os = require("os");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");
const QRCode = require("qrcode");
const E = require("./public/engine.js");

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "games.json");
const KEEP_DAYS = 14;
const MAX_GAMES = 500;
const MAX_PLAYERS = 300;

/* ---------- persistence ---------- */
let games = {};
try { games = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) || {}; console.log(`Loaded ${Object.keys(games).length} saved game(s).`); }
catch (e) { games = {}; }
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = DATA_FILE + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(games));
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) { console.error("Could not save games:", e.message); }
  }, 300);
}
function prune() {
  const cutoff = Date.now() - KEEP_DAYS * 864e5;
  for (const [c, g] of Object.entries(games)) if ((g.updatedAt || g.createdAt) < cutoff) delete games[c];
}
prune();

/* ---------- helpers ---------- */
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function newCode() {
  for (let i = 0; i < 1000; i++) {
    let c = ""; for (let j = 0; j < 5; j++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!games[c]) return c;
  }
  throw new Error("No free game codes");
}
const clean = (s, n) => String(s == null ? "" : s).replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, n);
const lastClosed = g => g.results.length;
function stateAfter(g, tid, r) {
  if (r <= 0) return E.startState(g.config);
  const rr = g.results[r - 1];
  return rr && rr.teams[tid] ? rr.teams[tid] : E.startState(g.config);
}
function lastDecision(g, tid) {
  const r = lastClosed(g);
  if (!r) return { ...E.DEFAULT_DEC };
  return { ...stateAfter(g, tid, r).dec, loan: 0, capex: 0 };
}
function addLog(g, m, kind = "info") {
  g.log.push({ t: Date.now(), m, kind });
  if (g.log.length > 2000) g.log.splice(0, g.log.length - 2000);
}
const teamName = (g, tid) => (g.config.teams.find(t => t.id === tid) || {}).name || "?";
const playerName = (g, pid) => (g.players[pid] || {}).name || "A player";
const touch = g => { g.updatedAt = Date.now(); save(); };

/* ---------- views ---------- */
function onlineSet(code) {
  const set = new Set();
  const room = io.sockets.adapter.rooms.get(code);
  if (room) for (const id of room) { const s = io.sockets.sockets.get(id); if (s && s.data.role === "player") set.add(s.data.pid); }
  return set;
}
function publicBoard(g) {
  const tids = g.config.teams.map(t => t.id);
  const start = E.startState(g.config).value;
  const series = {}; tids.forEach(t => series[t] = [start, ...g.results.map(r => r.teams[t].value)]);
  const last = g.results[g.results.length - 1];
  const board = last ? tids.map(t => {
    const x = last.teams[t];
    return { id: t, rank: x.rank, value: x.value, netWorth: x.netWorth, netProfit: x.netProfit, cumProfit: x.cumProfit, share: x.share, brand: x.brand, quality: x.quality, cash: x.cash, loan: x.loan };
  }).sort((a, b) => a.rank - b.rank) : [];
  const market = g.results.map(r => ({ round: r.round, ...r.market }));
  return { board, series, market, lastRound: last ? last.round : 0 };
}
function common(g) {
  const subs = g.subs["r" + g.round] || {};
  return {
    serverNow: Date.now(), code: g.code, status: g.status, round: g.round, totalRounds: g.config.totalRounds,
    startCash: g.config.startCash, deadline: g.deadline || null, lastClosed: lastClosed(g),
    teams: g.config.teams.map(t => ({ id: t.id, name: t.name, players: Object.values(g.players).filter(p => p.teamId === t.id).length, submitted: g.status === "open" && !!subs[t.id] })),
    ...publicBoard(g)
  };
}
function hostView(g) {
  const online = onlineSet(g.code);
  const names = {}; for (const [pid, p] of Object.entries(g.players)) names[pid] = p.name;
  const subsNow = {};
  for (const [tid, s] of Object.entries(g.subs["r" + g.round] || {})) subsNow[tid] = { ...s, byName: names[s.by] || "A player" };
  return {
    role: "host", ...common(g), hostKey: g.hostKey, events: g.config.events,
    players: Object.entries(g.players).map(([pid, p]) => ({ pid, name: p.name, teamId: p.teamId, joinedAt: p.joinedAt, online: online.has(pid) })),
    subsNow, results: g.results, log: g.log.slice(-400)
  };
}
function playerView(g, pid) {
  const me = g.players[pid];
  if (!me) return { role: "player", ...common(g), me: null, revealedEvents: [] };
  const tid = me.teamId;
  const revealed = g.status === "lobby" ? 0 : g.round;
  const v = {
    role: "player", ...common(g), me: { pid, name: me.name, teamId: tid },
    revealedEvents: g.config.events.slice(0, revealed)
  };
  if (tid) {
    v.teammates = Object.entries(g.players).filter(([, p]) => p.teamId === tid).map(([id, p]) => ({ name: p.name, me: id === pid }));
    v.state = stateAfter(g, tid, lastClosed(g));
    v.history = g.results.map(r => ({ round: r.round, event: r.market.event, ...r.teams[tid] }));
    const s = (g.subs["r" + g.round] || {})[tid];
    v.mySub = g.status === "open" && s ? { dec: s.dec, at: s.at, byName: playerName(g, s.by), byMe: s.by === pid } : null;
    v.defaultDec = lastDecision(g, tid);
  }
  return v;
}
function screenView(g) {
  return { role: "screen", ...common(g), currentEvent: g.status === "lobby" ? null : g.config.events[g.round - 1] };
}

/* ---------- server ---------- */
const app = express();
app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public"), { maxAge: "5m" }));
app.get("/qr.svg", async (req, res) => {
  try {
    const svg = await QRCode.toString(String(req.query.t || "").slice(0, 400), { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    res.type("image/svg+xml").set("Cache-Control", "public, max-age=3600").send(svg);
  } catch (e) { res.status(400).send("bad"); }
});
app.get("/healthz", (req, res) => res.send("ok"));

const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e5, pingInterval: 20000, pingTimeout: 25000 });

const pending = new Set();
function broadcast(code) {
  if (pending.has(code)) return;
  pending.add(code);
  setTimeout(async () => {
    pending.delete(code);
    const g = games[code]; if (!g) return;
    const sockets = await io.in(code).fetchSockets();
    let hv = null, sv = null; const pv = {};
    for (const s of sockets) {
      const { role, pid } = s.data;
      if (role === "host") s.emit("view", hv || (hv = hostView(g)));
      else if (role === "screen") s.emit("view", sv || (sv = screenView(g)));
      else if (role === "player") s.emit("view", pv[pid] || (pv[pid] = playerView(g, pid)));
    }
  }, 60);
}
const ok = (cb, x) => typeof cb === "function" && cb({ ok: true, ...x });
const fail = (cb, error) => typeof cb === "function" && cb({ ok: false, error });
const hostGame = (d) => { const g = games[clean(d && d.code, 8).toUpperCase()]; return g && d.key && d.key === g.hostKey ? g : null; };

io.on("connection", socket => {
  socket.on("host:create", (d, cb) => {
    try {
      if (Object.keys(games).length >= MAX_GAMES) prune();
      if (Object.keys(games).length >= MAX_GAMES) return fail(cb, "The server is full. Try again later.");
      const n = E.clamp(Math.round(E.num(d.n, 6)), 4, 10);
      const rounds = E.clamp(Math.round(E.num(d.rounds, 6)), 4, 8);
      const names = Array.isArray(d.teamNames) ? d.teamNames : [];
      const teams = Array.from({ length: n }, (_, i) => ({ id: "t" + (i + 1), name: clean(names[i], 28) || "Team " + (i + 1) }));
      const events = Array.from({ length: rounds }, (_, i) => E.EVENTS[d.events && d.events[i]] ? d.events[i] : E.SCHEDULES[rounds][i]);
      const startCash = Math.round(E.clamp(E.num(d.startCashLakh, 50), 10, 500) * 1e5);
      const code = newCode();
      const g = games[code] = {
        code, hostKey: crypto.randomBytes(12).toString("base64url"), createdAt: Date.now(), updatedAt: Date.now(),
        title: clean(d.title, 60), config: { teams, events, totalRounds: rounds, startCash },
        status: "lobby", round: 0, deadline: null, players: {}, subs: {}, subLog: [], results: [], log: []
      };
      addLog(g, `Game created with ${n} teams and ${rounds} quarters`, "host");
      touch(g);
      ok(cb, { code, key: g.hostKey });
    } catch (e) { fail(cb, e.message); }
  });

  socket.on("host:attach", (d, cb) => {
    const g = hostGame(d); if (!g) return fail(cb, "Game not found or host key is wrong.");
    socket.data = { role: "host", code: g.code }; socket.join(g.code);
    ok(cb); broadcast(g.code);
  });

  socket.on("host:action", (d, cb) => {
    const g = hostGame(d); if (!g) return fail(cb, "Not authorised.");
    const a = d.action, total = g.config.totalRounds;
    try {
      if (a === "openRound") {
        if (!(g.status === "lobby" || g.status === "closed")) return fail(cb, "A quarter is already open.");
        const r = lastClosed(g) + 1; if (r > total) return fail(cb, "All quarters are done.");
        const mins = E.clamp(E.num(d.minutes, 0), 0, 120);
        g.status = "open"; g.round = r; g.openedAt = Date.now(); g.deadline = mins > 0 ? Date.now() + mins * 60000 : null;
        addLog(g, `Quarter ${r} opened: ${E.EVENTS[g.config.events[r - 1]].name}${mins ? ` (${mins}-minute timer)` : ""}`, "host");
      } else if (a === "closeRound") {
        if (g.status !== "open") return fail(cb, "No quarter is open.");
        const r = g.round, prev = {}, decs = {}, subs = g.subs["r" + r] || {};
        for (const t of g.config.teams) {
          prev[t.id] = stateAfter(g, t.id, r - 1);
          const s = subs[t.id];
          decs[t.id] = s ? { dec: s.dec, by: playerName(g, s.by), at: s.at, auto: false } : { dec: lastDecision(g, t.id), auto: true };
        }
        const res = E.simulate(g.config, r, prev, decs);
        g.results.push({ round: r, closedAt: Date.now(), ...res });
        g.status = r >= total ? "finished" : "closed"; g.deadline = null;
        const missing = g.config.teams.filter(t => decs[t.id].auto).map(t => t.name);
        addLog(g, `Quarter ${r} closed and results published${missing.length ? ` (auto-decisions for ${missing.join(", ")})` : ""}`, "host");
      } else if (a === "reopen") {
        if (!g.results.length || g.status === "open") return fail(cb, "Nothing to reopen.");
        const rr = g.results.pop(); g.status = "open"; g.round = rr.round; g.deadline = null;
        addLog(g, `Quarter ${rr.round} reopened by the facilitator`, "host");
      } else if (a === "extend") {
        if (g.status !== "open") return fail(cb, "No quarter is open.");
        g.deadline = Math.max(Date.now(), g.deadline || Date.now()) + 120000;
        addLog(g, `Timer extended by 2 minutes`, "host");
      } else if (a === "stopTimer") {
        g.deadline = null;
      } else if (a === "kick") {
        const pid = clean(d.pid, 40); const p = g.players[pid]; if (!p) return fail(cb, "Player not found.");
        delete g.players[pid];
        addLog(g, `${p.name} was removed by the facilitator`, "host");
        io.in(g.code).fetchSockets().then(ss => ss.forEach(s => { if (s.data.pid === pid) s.emit("kicked"); }));
      } else if (a === "moveTeam") {
        const pid = clean(d.pid, 40); const p = g.players[pid]; const tid = clean(d.teamId, 8);
        if (!p || !g.config.teams.some(t => t.id === tid)) return fail(cb, "Player or team not found.");
        p.teamId = tid; addLog(g, `${p.name} moved to ${teamName(g, tid)} by the facilitator`, "host");
      } else if (a === "endGame") {
        g.status = "finished"; g.deadline = null; addLog(g, "Facilitator ended the game", "host");
      } else return fail(cb, "Unknown action.");
      touch(g); ok(cb); broadcast(g.code);
    } catch (e) { console.error(e); fail(cb, "Something went wrong: " + e.message); }
  });

  socket.on("screen:attach", (d, cb) => {
    const g = games[clean(d && d.code, 8).toUpperCase()]; if (!g) return fail(cb, "Game not found.");
    socket.data = { role: "screen", code: g.code }; socket.join(g.code); ok(cb); broadcast(g.code);
  });

  socket.on("player:join", (d, cb) => {
    const g = games[clean(d && d.code, 8).toUpperCase()]; if (!g) return fail(cb, "No game with that code. Check the code with your facilitator.");
    const pid = clean(d.pid, 40); const name = clean(d.name, 30);
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(pid)) return fail(cb, "Bad player id.");
    let p = g.players[pid];
    if (!p) {
      if (!name) return fail(cb, "Enter your name.");
      if (Object.keys(g.players).length >= MAX_PLAYERS) return fail(cb, "This game is full.");
      p = g.players[pid] = { name, teamId: null, joinedAt: Date.now() };
      addLog(g, `${name} joined the game`, "join"); touch(g);
    } else if (name && name !== p.name) { addLog(g, `${p.name} is now called ${name}`, "join"); p.name = name; touch(g); }
    socket.data = { role: "player", code: g.code, pid }; socket.join(g.code);
    ok(cb); broadcast(g.code);
  });

  socket.on("player:pickTeam", (d, cb) => {
    const { code, pid } = socket.data || {}; const g = games[code]; const p = g && g.players[pid];
    if (!p) return fail(cb, "Join the game first.");
    const tid = clean(d && d.teamId, 8);
    if (!g.config.teams.some(t => t.id === tid)) return fail(cb, "Team not found.");
    if (p.teamId && g.status !== "lobby") return fail(cb, "Teams are locked once the game starts. Ask the facilitator to move you.");
    if (g.status === "finished") return fail(cb, "This game has finished.");
    p.teamId = tid; addLog(g, `${p.name} joined ${teamName(g, tid)}`, "join");
    touch(g); ok(cb); broadcast(g.code);
  });

  socket.on("player:leaveTeam", (d, cb) => {
    const { code, pid } = socket.data || {}; const g = games[code]; const p = g && g.players[pid];
    if (!p) return fail(cb, "Join the game first.");
    if (g.status !== "lobby") return fail(cb, "Teams are locked once the game starts.");
    p.teamId = null; touch(g); ok(cb); broadcast(g.code);
  });

  socket.on("player:submit", (d, cb) => {
    const { code, pid } = socket.data || {}; const g = games[code]; const p = g && g.players[pid];
    if (!p || !p.teamId) return fail(cb, "Pick a team first.");
    if (g.status !== "open") return fail(cb, "This quarter is closed. Wait for the next one.");
    const tid = p.teamId; const st = stateAfter(g, tid, lastClosed(g));
    const dec = E.normDec(d && d.dec, st);
    const key = "r" + g.round; g.subs[key] = g.subs[key] || {};
    const at = Date.now();
    g.subs[key][tid] = { dec, by: pid, at };
    g.subLog.push({ round: g.round, teamId: tid, by: pid, byName: p.name, at, dec });
    addLog(g, `${p.name} submitted Quarter ${g.round} for ${teamName(g, tid)}: price ₹${dec.price}, make ${dec.production.toLocaleString("en-IN")}`, "submit");
    touch(g); ok(cb, { dec }); broadcast(g.code);
  });
});

server.listen(PORT, () => {
  console.log(`\nLedger League is running on port ${PORT}`);
  console.log(`  On this computer:   http://localhost:${PORT}`);
  for (const list of Object.values(os.networkInterfaces())) for (const a of list || [])
    if (a.family === "IPv4" && !a.internal) console.log(`  On the same Wi-Fi:  http://${a.address}:${PORT}`);
  console.log("");
});

function saveNow() { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(DATA_FILE, JSON.stringify(games)); } catch (e) {} }
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { saveNow(); process.exit(0); });
