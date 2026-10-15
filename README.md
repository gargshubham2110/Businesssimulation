# Ledger League

A live business simulation for 4–10 teams, with all money in Indian rupees (₹). Each team runs a competing consumer-products company. Players use their own phones or laptops, with no sign-up or login. The facilitator runs each quarter from a control room and keeps the full record.

## What's inside

| File | Purpose |
|---|---|
| `server.js` | Game server (Node.js + Socket.IO). Holds all games and pushes live updates. |
| `public/index.html` | The whole web app: home page, host console, player screen and projector screen. |
| `public/engine.js` | The simulation maths (demand, costs, P&L, rankings). |
| `render.yaml` | One-click deploy settings for Render.com. |

Saved games go to `data/games.json` and are kept for 14 days.

---

## Option A: put it online for free (Render.com), recommended

This gives you a public link like `https://ledger-league.onrender.com` that works on any phone.

1. Create a free account at **github.com**. Make a new repository, then upload all the files in this folder **except** `node_modules` (use "Add file → Upload files").
2. Create a free account at **render.com** and sign in with GitHub.
3. Click **New → Web Service** and pick your repository. Render reads `render.yaml` and fills in the settings. If it asks, use:
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: Free
4. Click **Deploy**. After 2–3 minutes your link is live.

**Free-plan notes:**
- The app sleeps after 15 minutes with no visitors. The first visit after that takes about a minute to wake it, so open your link 5 minutes before the session starts. It stays awake while people are playing.
- A free server's saved files are wiped when it restarts or redeploys. **At the end of every session, download the record** (Full record → Download results).
- If you need saved games to survive restarts, add a paid disk on Render and set the environment variable `DATA_DIR` to the disk's path.

Railway.app and Fly.io work the same way. Any host that runs `npm start` on Node 18 or newer will do.

## Option B: run it on your laptop

You need Node.js 18 or newer (from nodejs.org).

```bash
npm install
npm start
```

The terminal prints two addresses:
- `http://localhost:3000` is for you, on this laptop.
- `http://192.168.x.x:3000` is for phones and laptops **on the same Wi-Fi**.

**Players on mobile data or another network?** Make a temporary public link in a second terminal:

```bash
npx cloudflared tunnel --url http://localhost:3000
```

It prints a `https://….trycloudflare.com` link. Share that link; the QR code in the app uses whatever address you opened it on. Keep the laptop awake and the terminal open during the game.

---

## Running a session

1. Open your link and click **Host a new game**. Choose the number of teams (4–10), the team names, the number of quarters (4–8, default 6), the starting cash (₹50 L default) and each quarter's market news.
2. **Create game.** You get a 5-letter game code and a QR code. Click **Open projector screen** and put that tab on the projector.
3. Players scan the QR (or open the link and type the code), enter their name and pick their team. Each team can have any number of players.
4. Click **Open Quarter 1**. You can set a timer; 10 minutes works well. Teams see that quarter's market news and submit:
   - selling price per unit
   - units to produce
   - marketing spend
   - R&D / quality spend
   - factory expansion
   - borrowing or repayment

   Anyone on a team can submit, and the latest submission counts. Their screen shows a live cost preview before they submit.
5. Watch submissions arrive in the **Control room**. Then click **Close Quarter and publish results**. A team that doesn't submit repeats last quarter's decisions automatically.
6. Discuss the leaderboard, then open the next quarter. After the last quarter, the team with the highest **company value** wins.

**Facilitator tools**
- **Full record:** every decision, who submitted it and when, and every result. Download it as a CSV, along with the activity log.
- **Players:** see who is online and remove anyone who joined the wrong team. Removed players can rejoin and pick again.
- **Reopen quarter:** undo a quarter you closed too early.
- **Host link (keep private):** lets you run the game from another device. Anyone who has this link can control the game.

**What players can see:** their own team's numbers and the public league table. They can't see other teams' decisions, or market news for quarters that haven't opened yet.

## How the market works

- Every team starts the same: ₹50 L cash, a 10,000-unit factory, a ₹30 L factory book value, brand 50 and quality 50.
- Market size is about 9,000 units per team per quarter. It grows 3% each quarter, shifts with the market news, and shrinks when average prices go up.
- Each team's share depends on price (relative to ₹500), brand and quality.
- Running out of stock loses those customers; half of them buy from rivals that still have stock.
- Unit cost is ₹250, adjusted by market news and quality. Producing at 80% of capacity or more saves 5%.
- Fixed costs each quarter: ₹5 L overhead, ₹20 per unit of capacity, ₹15 per unsold unit, 5% depreciation, 3% interest on loans, 25% tax on profit.
- New capacity costs ₹400 per unit and is ready next quarter. The loan limit is ₹1 Cr. If cash goes negative, the bank adds an emergency loan with a 5% fee.
- **Company value** = cash + stock + factory − loans + brand × ₹50,000 + quality × ₹30,000.

You can change any of these numbers in `public/engine.js` (the `START`, `K` and `EVENTS` blocks at the top).
