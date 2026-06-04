# Anti-Scam Bot for Telegram — by nostalgia

A Telegram group moderation bot focused on detecting and banning admin impersonators and spam bots, with layered content moderation features.

> Based on [ZenchainSoftware/telegram-bot-monitor](https://github.com/ZenchainSoftware/telegram-bot-monitor), significantly extended and refactored.

---

## What's new vs the original zenchain bot

The original zenchain bot offered basic content moderation (bad words, URLs, wallet addresses, media). This fork adds a completely new security layer focused on **scammer and impersonator detection**, plus several quality-of-life improvements.

### Impersonation Detection — 4-layer system

The original bot had no impersonation detection at all. This fork builds a full multi-layer system:

| Layer | Method | Action |
|-------|--------|--------|
| 1 | Exact normalized name match | **Ban** |
| 2 | Homoglyph normalization (Cyrillic/Greek lookalikes → Latin) | **Ban** |
| 3 | Substring containment ≥ 85% similarity | **Mute** |
| 4 | Jaro-Winkler fuzzy similarity ≥ 85% | **Mute** |

- Layers 1 & 2 result in an **immediate ban** with group notification
- Layers 3 & 4 result in a **mute** with a scammer alert posted to the group
- All 4 layers run on **every message** and on **every join event**
- Admin names shorter than 4 characters are flagged at startup with a warning

### Departing Impersonator Warnings

When a user **leaves or gets banned** while using a name that resembles an admin (any of the 4 layers), the bot posts a public warning to the group:

> ⚠️ Warning: Member with ID: X left the group using the name "Y". They may attempt to impersonate an admin via private messages. Do not respond to any unsolicited DMs claiming to be from [admin]. Always verify authenticity of such messages here in public.

### Name Blacklist

A configurable list of banned display names. Any member whose name contains a blacklisted keyword gets **muted** and a group alert is posted. Managed via the inline config menu.

### Auto-Ban Keywords (Silent Ban)

A separate keyword list for **silent, zero-noise bans**. Designed for obvious spam bots (e.g. CSAM advertisers):

- On **join**: if the member's display name contains a keyword → **silent ban** (no group message)
- On **bot message**: if the message text contains a keyword → **silent delete**
- Normalization strips all punctuation and spaces before matching, so `CHI .LD PO.RN` matches `childporn`
- **L33tspeak normalization**: digit substitutions applied before matching (`1→i`, `0→o`, `3→e`, `5→s`, `8→b`), so `ch1ldp0rn` matches `childporn`
- Minimum 6 characters enforced to reduce false positive risk
- Conflict detection: adding a keyword already in the name blacklist moves it to the correct list with a warning

### Bot-to-Bot Message Processing

Enabled via BotFather's "Bot-to-Bot Communication" mode. The bot now reads messages from other bots in the group. Combined with auto-ban keywords, it can **delete captcha poll messages** sent by other bots if their text contains a banned keyword (e.g. a CSAM advertiser joining triggers a captcha with their name in it — the captcha itself gets deleted immediately).

### Self-Healing Admin Detection

Telegram's `getChatAdministrators()` API does not always return all admin bots. When a mute or ban attempt fails with "user is an administrator" error, the bot automatically:

1. Catches the error
2. Fetches the user's details
3. Adds them to the in-memory admin list
4. Rebuilds the admin set

All future checks for that user are skipped. No manual configuration needed.

### Impersonator Report Command

`/report@botname` posted in the group chat replies with the last 10 banned impersonators — names, usernames, IDs, and ban dates.

### Upgraded Dependencies

The original bot used Telegraf 3.x, TypeORM 0.1.x, and TypeScript 2.9. This fork upgrades to:

- **Telegraf 4.x** — updated API (`Markup.inlineKeyboard`, `banChatMember`, `launch`)
- **TypeORM 0.3.x** — `DataSource`, `findOneBy`, `delete`
- **TypeScript 4.9**
- **sqlite3 5.x**, **pg 8.x**, **ts-node 10.x**

---

## Full Feature List

- **4-layer admin impersonation detection** — exact, homoglyph, substring, fuzzy (Jaro-Winkler)
- **Departing impersonator warnings** — public alert when a suspected impersonator leaves
- **Name blacklist** — mute members matching configurable keywords
- **Auto-ban keywords** — silent ban on join + delete bot messages, with l33tspeak normalization
- **Bot-to-bot message processing** — reads and acts on messages from other bots
- **Self-healing admin detection** — auto-adds bot admins missed by Telegram API
- **Content moderation** — configurable rules for bad words, URLs, wallet addresses, images, audio, video
- **Warning system** — configurable number of warnings before a ban
- **Permanent bans** — all bans are permanent (not temporary kicks)
- **Member management** — export/import member list, cross-check for deleted/banned accounts
- **Impersonator report** — `/report@botname` shows last 10 banned impersonators
- **Daily log rotation** — logs rotate daily with timestamped filenames
- **Telegram config menu** — all settings configurable via inline keyboard in private chat with the bot

---

## Requirements

- Node.js 14+
- Python 3.10+ (for member management scripts)
- SQLite3
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- Bot must be a group **administrator** with ban and delete message permissions
- Telethon API credentials (from [my.telegram.org](https://my.telegram.org)) — for member management features only

---

## Setup Guide

### Step 1 — Create your bot with BotFather

1. Open [@BotFather](https://t.me/botfather) on Telegram
2. Send `/newbot`
3. Enter a display name for your bot, e.g. `MyGroupAntiScamBot`
4. Enter a username (must end in `bot`), e.g. `MyGroupAntiScamBotbot`
5. BotFather will reply with your **bot token** — save it, you'll need it in Step 4

### Step 2 — Configure bot settings in BotFather

These settings must be applied **before** adding the bot to your group.

**Disable privacy mode** (required so the bot can read all group messages):

1. Send `/mybots` to BotFather
2. Select your bot
3. Go to **Bot Settings → Group Privacy → Turn off**

**Enable reading messages from other bots** (required for captcha poll deletion):

1. In the same Bot Settings menu, go to **Bot Settings → Allow Groups → Turn on**
2. Then go to **Bot Settings** and look for **Group and Channel Messages** — enable **"Allow reading all group messages from bots"**

> Note: This option was introduced by Telegram in May 2026. If you don't see it, update your Telegram app.

**Allow joining groups:**

1. In Bot Settings, go to **Allow Groups → All Groups**

### Step 3 — Add the bot to your group as administrator

1. Open your Telegram group
2. Tap the group name in the header → **Add Member**
3. Search for your bot's username and add it
4. Go to group **Settings → Administrators → Add Admin**, select your bot
5. Grant the following permissions:
   - ✅ Delete messages
   - ✅ Ban users
   - ✅ Add new admins (optional, not required)
   - Leave everything else at default

### Step 4 — Get your group's Chat ID

1. Send any message to your group
2. Open this URL in your browser (replace `<botToken>` with your actual token):
   ```
   https://api.telegram.org/bot<botToken>/getUpdates
   ```
3. Look for `"chat":{"id":` in the response — that negative number is your Chat ID (e.g. `-1001234567890`)

### Step 5 — Install and configure the bot

1. **Clone the repo**
   ```bash
   git clone https://github.com/nostalgia-mining/anti-scam-bot.git
   cd anti-scam-bot
   ```

2. **Install Node dependencies**
   ```bash
   npm install
   ```

3. **Install Python dependencies** (member management scripts only)
   ```bash
   pip3 install telethon requests
   ```

4. **Create the config file**
   ```bash
   cp src/environments/environment.ts.dist src/environments/environment.ts
   ```
   Edit `src/environments/environment.ts` and set:
   - `botToken` — your bot token from Step 1
   - `chatId` — your group's Chat ID from Step 4

   > **Important:** `src/environments/environment.ts` is listed in `.gitignore` and will never be committed. It contains your bot token and must never be pushed to any repository. The `.dist` file is the safe placeholder kept in the repo for reference.

5. **Set up the database**
   ```bash
   sqlite3 zenchain_bot_sqlite.db < db/bot_db_sqlite.sql
   ```

6. **Start the bot**
   ```bash
   chmod +x start.sh
   ./start.sh
   ```

   You should see the startup banner with the bot version, followed by confirmation of the group name and member count.

---

## Configuration

All settings can be changed via the bot's inline config menu. Send `menu` to the bot in a **private chat** (not the group) to access it.

Available settings:
- Enable/disable each moderation rule
- Set number of warnings before ban
- Set custom reply messages
- Manage banned words
- Add/remove name blacklist keywords
- Add/remove auto-ban keywords
- Configure Telethon API credentials for member management

---

## Member Management

The bot includes Python scripts for bulk member operations:

- **Export** — fetch all group members via Telethon
- **Import** — import exported members into the local DB
- **Scan** — scan for deleted accounts (Telethon)
- **Scan & Ban** — scan and ban deleted accounts
- **Cross-check (report)** — compare DB vs export, identify missing members via Bot API
- **Cross-check & Ban** — same as above but also bans confirmed deleted/banned accounts

Access these via the **Member Management** button in the config menu.

---

## Running as a Service

To keep the bot running after you close your terminal and auto-restart on failure:

```ini
# /etc/systemd/system/telegram-bot.service
[Unit]
Description=Telegram Anti-Scam Bot
After=network.target

[Service]
Type=simple
User=YOUR_USERNAME
WorkingDirectory=/path/to/anti-scam-bot
ExecStart=/bin/bash /path/to/anti-scam-bot/start.sh
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable telegram-bot
sudo systemctl start telegram-bot
```

---

## Credits

- Original project: [ZenchainSoftware/telegram-bot-monitor](https://github.com/ZenchainSoftware/telegram-bot-monitor)
- Extended and maintained by: nostalgia
