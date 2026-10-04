# BGMI Esports Bot (Scrims + Tournaments + Moderation)

A Discord bot for running BGMI scrims and tournaments, plus server
utility/moderation tools — built as an original implementation inspired by
the feature categories of bots like Quo (Scrims Management, Tournament
System, Utility & Moderation). This is fresh code, not a copy of anyone's
source.

## 1. Install

```bash
npm install
```

## 2. Set up your bot in the Discord Developer Portal

1. Go to https://discord.com/developers/applications and create a new application.
2. Go to the **Bot** tab → click **Reset Token** → copy the token.
3. You don't need any Privileged Gateway Intents toggles for this bot — it's slash-command only.
4. Go to **OAuth2 → URL Generator**. Check scopes: `bot` and `applications.commands`.
   Under Bot Permissions check: `Kick Members`, `Ban Members`, `Moderate Members`,
   `Manage Messages`, `Send Messages`, `Embed Links`, `Use Slash Commands`.
   Copy the generated URL and open it to invite the bot to your server.

## 3. Configure

Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN`, `CLIENT_ID`, and `GUILD_ID`
(enable Developer Mode in Discord → right-click your server icon → Copy Server ID).

## 3b. Set up PostgreSQL (so data survives redeploys)

All bot data (registrations, verifications, teams, settings, embeds) is
stored in PostgreSQL. Without it, data only lives in a local `data.json`
file, which is wiped every time a host like Railway rebuilds/redeploys
the app.

1. In Railway: your project → **New** → **Database** → **Add PostgreSQL**.
   Railway automatically injects a `DATABASE_URL` variable into every
   service in the same project — if your bot service is in the same
   project as the new Postgres service, you don't need to copy/paste
   anything, it just appears.
2. Elsewhere (Render, a VPS, etc.): create a Postgres database however
   that host provides one, and set the `DATABASE_URL` env var yourself,
   e.g. `postgresql://user:password@host:5432/dbname`.
3. That's it — no manual table creation needed, the bot creates its own
   table on first boot. The very first time it starts with `DATABASE_URL`
   set, it also copies over anything already in `data.json` (if that
   file exists) so you don't lose existing registrations when switching
   over.

Running locally without `DATABASE_URL` set still works (falls back to
`data.json` only) — useful for quick local testing, just don't rely on
it for anything you want to keep.

## 4. Register the slash commands

The bot now registers its slash commands with Discord automatically every
time it starts up (as long as `CLIENT_ID` is set in your `.env`) — so on
a host that only runs `npm start` (Railway, Render, etc.) you don't need
to do anything extra here.

If you'd rather register commands manually/immediately without restarting
the bot, you can still run:

```bash
npm run deploy
```

## 5. Run the bot

```bash
npm start
```

Keep this running continuously (VPS, Raspberry Pi, Railway, Render, etc.).

## Three systems, one bot (Rebound · T3 · Tournament)

This one bot runs three systems side by side. They are kept apart on purpose,
so nothing one system does can trigger another:

| | Rebound (scrims) | T3 (scrims) | Tournament |
|---|---|---|---|
| Files | plain names (`register-handlers.js` ...) | `t3-*.js` + `t3-router.js` | `tn-*.js`, `cmd-tn-*.js`, `pcmd-tn-*.js` + `tn-router.js` |
| Buttons / menus / modals | `scrim_*`, `reg_*`, `verify_*`, `admin_panel:` ... | `t3*`, `admin_*` | `tourney_*`, `staffp:`, `staffactivity_*`, `ssvp*`, `qualify_select_teams:`, `cancel_select_teams:` |
| Data | `bot_storage` table / `data.json` | its own T3 store | `tournament_guilds` table / `tournament-data.json` |

**Tournament commands** (only these are new):

| Command | What it does |
|---|---|
| `!tournament` (`!tourney`) | Tournament panel — create / switch / manage tournaments. Everything else (groups, registration panel, slot manager, rounds, swaps, punishments, exports) is driven by buttons inside it |
| `!export_tournament [name]` | CSV of a tournament's registrations |
| `!import_tournament [name]` | Load a registration CSV into a tournament |
| `!staff` | Staff activity / control panel |
| `!tourney_open` / `!tourney_close` (`!topen` / `!tclose`) | Open / close a tournament group channel — run inside the group channel |
| `/create-role`, `/owner`, `/ss-verify-panel`, `/set-ai-channel`, `/disable-ai-channel`, `/set-welcome-channel`, `/disable-welcome-channel` | Tournament-side slash commands |

**Why `!tourney_open` / `!tourney_close`:** Rebound already owns `!open` and
`!close` (for its own group channels, and T3 uses `!t3open`). The tournament
versions were renamed so the three never answer the same command. Startup
throws if any two commands ever share a name or alias, so a collision can't
slip in unnoticed.

**Who may use tournament features:** same rules as the standalone tournament
bot — a user ID listed in `ALLOWED_USER_IDS`, or the `TOURNAMENT ADMIN` /
`TOURNAMENT ELITE` role (created by `/create-role`). Public player panels
(Register Team, Slot Manager, group swaps) work for everyone. Rebound's and T3's
permissions are unchanged (Manage Server).

**Extra environment variables** (all optional): `ALLOWED_USER_IDS`,
`TOURNAMENT_TZ` (default `Asia/Kolkata`), `GEMINI_API_KEY(S)` / `GEMINI_VISION_MODEL`
(screenshot verification), `AUTO_IMPORT_CSV` + `AUTO_IMPORT_GUILD_ID` +
`AUTO_IMPORT_TOURNAMENT_NAME` (one-time CSV import at boot). `GROQ_API_KEY`,
`OWNER_ID`, `PREFIX`, `DATABASE_URL`, `DATA_DIR` are shared with the rest of the bot.

**Moving over data from the standalone tournament bot:** it already stores data
in `tournament-data.json` / the `tournament_guilds` table — the same names this
bot uses. Either point `DATABASE_URL` at the same database, or copy
`tournament-data.json` into this bot's `DATA_DIR`. To import tournaments that
still sit in an old Rebound `data.json`, run
`npm run migrate:tournament -- /path/to/old/data.json` once with the bot stopped.
Tournament panels posted by the *other* bot account won't respond here (Discord
sends clicks to the bot that posted the message) — post fresh ones with `!tournament`.

**Permissions to add when inviting:** Manage Roles, Manage Channels, Attach Files,
Read Message History (tournaments create group roles / channels). Keep the bot's
role above the roles it hands out. Developer Portal intents needed: Server Members
and Message Content (already required by the rest of the bot).

## Project structure

Everything lives flat in one folder — no subfolders — so it's easy to
upload on mobile (GitHub's mobile uploader doesn't handle folder uploads
well). Each command file is named `cmd-<name>.js` and the bot scans for
that prefix automatically.

```
cmd-scrim-open.js, cmd-scrim-register.js, ...   one file per slash command (data + execute)
storage.js      per-guild data access (in-memory cache, backed by PostgreSQL — see db.js)
db.js           PostgreSQL connection + load/save of the stored data
embeds.js       shared embed builders for slot lists & tournament groups
index.js        loads every cmd-*.js file, handles interactions
deploy-commands.js   registers all commands with Discord
data.json       auto-created at runtime, holds all server data
```

To add a new command, drop a new file named `cmd-yourname.js` in this same
folder following the same `{ data, execute }` shape, then run
`npm run deploy` again.

## Commands

### Scrims Management
| Command | Who | What it does |
|---|---|---|
| `/scrim-open slots:25 name:"Scrim 1"` | Admin | Opens registration, resets slot list |
| `/panel` | Admin | Posts a **Register Team** button — the button walks players through a 3-step form (Team Name, Owner Name, WhatsApp, then each Player's IGN + Game UID) and only registers them once every field across all 3 steps is filled in |
| `/scrim-register team:... player1:... player2:... player3:... player4:...` | Anyone | Slash-command alternative to the button flow, same slot-assignment logic |
| `/scrim-slotlist` | Anyone | Posts the current slot list as an embed |
| `/scrim-cancel slot:7` | Admin | Frees up slot 7 |
| `/scrim-close` | Admin | Stops further registrations |

**Button registration flow:** run `/scrim-open` to open a scrim, then `/panel`
to post the "Register Team" button in a channel. Clicking it pops up a Discord
modal form (Step 1/3: Team Name, Owner Full Name, WhatsApp Number, Player 1
IGN + UID → Step 2/3: Player 2 & 3 IGN + UID → Step 3/3: Player 4 IGN + UID).
Every field is marked required by Discord itself, and the number/UID fields
are also validated (digits only) before moving to the next step. After each
step, the player clicks a Continue button to open the next part of the form.
If anything is invalid or a step is abandoned, nothing is saved and the player
has to click **Register Team** again to restart. Registration only writes to
`data.json` after step 3 succeeds with all 11 fields present.

### Tournament System
| Command | Who | What it does |
|---|---|---|
| `/tournament-create name:"Winter Cup" groups:4 teams_per_group:16` | Admin | Creates a tournament with lettered groups (A, B, C...) |
| `/tournament-register team:... player1:... ... group:A` | Anyone | Registers into a specific group, or auto-balances across groups if omitted |
| `/tournament-groups` | Anyone | Shows all groups and their teams |
| `/tournament-qualify team:"Team Alpha"` | Admin | Marks a team as qualified for the next stage |
| `/tournament-qualified` | Anyone | Lists all qualified teams |
| `/tournament-reset` | Admin | Wipes tournament data to start a new one |

### Utility & Moderation
| Command | Who | What it does |
|---|---|---|
| `/kick user:@x reason:...` | Admin (Kick Members) | Kicks a member |
| `/ban user:@x reason:... delete_days:1` | Admin (Ban Members) | Bans a member, optionally deleting recent messages |
| `/timeout user:@x minutes:60 reason:...` | Admin (Moderate Members) | Times out (mutes) a member |
| `/untimeout user:@x` | Admin (Moderate Members) | Removes an active timeout |
| `/warn user:@x reason:...` | Admin (Moderate Members) | Logs a warning against a member |
| `/warnings user:@x` | Admin (Moderate Members) | Shows a member's warning history |
| `/clear amount:50` | Admin (Manage Messages) | Bulk-deletes recent messages in the channel |
| `/userinfo user:@x` | Anyone | Shows account/member info |
| `/serverinfo` | Anyone | Shows server info |

## Notes

- **Storage**: everything lives in `data.json`, one entry per server. Fine
  for a single bot instance; move to SQLite/Postgres if you deploy on a
  platform with an ephemeral filesystem.
- **Permissions**: admin-only commands default to specific Discord
  permissions (Manage Server, Kick Members, etc.) rather than a specific
  role — adjust the `PermissionFlagsBits` in each command file if you want
  a custom "Scrim Host" or "Moderator" role instead.
- **Bulk delete limit**: Discord's API can't bulk-delete messages older
  than 14 days — `/clear` will silently skip those.
- **Not included**: a payment/premium system, since that's account billing
  infrastructure specific to a bot's own business, not scrim/tournament
  functionality — happy to help with that separately if you want to
  monetize your own bot down the line (e.g. Discord's built-in
  Monetization or a Stripe integration).
