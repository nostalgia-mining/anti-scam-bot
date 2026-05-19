# Anti-Scam Bot for Telegram - by nostalgia

A Telegram group moderation bot focused on detecting and banning admin impersonators (scammers), with additional content moderation features.

> Based on [zenchain's telegram-bot-monitor](https://github.com/zenchain-protocol/telegram-bot-monitor), significantly extended and refactored.

---

## Features

- **Admin impersonation detection** — detects users whose name matches an admin's name and bans them automatically
- **Unicode-aware name normalization** — handles lookalike characters, zero-width spaces, and Cyrillic tricks
- **Content moderation** — configurable rules for bad words, URLs, wallet addresses, images, audio, video
- **Warning system** — configurable number of warnings before a ban
- **Permanent bans** — all bans are permanent (not temporary kicks)
- **Member management** — export/import member list, cross-check for deleted/banned accounts
- **Impersonator report** — `/report@botname` command shows last 10 banned impersonators in group chat
- **Network resilience** — auto-restart after network disconnection
- **Daily log rotation** — logs rotate daily with 7-day retention and automatic archiving
- **Telegram config menu** — all settings configurable via inline keyboard in private chat with the bot

---

## Requirements

- Node.js 14+
- Python 3.10+ (for member management scripts)
- SQLite3
- A Telegram bot token (from [@BotFather](https://t.me/BotFather))
- Telethon API credentials (from [my.telegram.org](https://my.telegram.org)) — for member management features

---

## Setup

1. **Clone the repo**
   ```bash
   git clone https://github.com/nostalgia-mining/anti-scam-bot.git
   cd anti-scam-bot
   ```

2. **Install Node dependencies**
   ```bash
   npm install
   ```

3. **Install Python dependencies**
   ```bash
   pip3 install telethon requests
   ```

4. **Configure the bot**
   ```bash
   cp src/environments/environment.ts.dist src/environments/environment.ts
   ```
   Edit `src/environments/environment.ts` and set:
   - `botToken` — your bot token from BotFather
   - `chatId` — your group's chat ID (negative number for supergroups)

   > **Important:** `src/environments/environment.ts` is listed in `.gitignore` and will never be committed. It contains your bot token and should never be pushed to any repository. The `.dist` file is the safe placeholder kept in the repo for reference.

5. **Set up the database**
   ```bash
   sqlite3 zenchain_bot_sqlite.db < db/bot_db_sqlite.sql
   ```

6. **Run the bot**
   ```bash
   chmod +x start.sh
   ./start.sh
   ```

---

## Configuration

All settings can be changed via the bot's inline config menu. Send `menu` to the bot in a private chat to access it.

Available settings:
- Enable/disable each moderation rule
- Set number of warnings before ban
- Set custom reply messages
- Manage banned words
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

To run the bot automatically on system startup:

```ini
# /etc/systemd/system/telegram-bot.service
[Unit]
Description=Telegram Anti-Scam Bot
After=network.target

[Service]
Type=simple
User=YOUR_USERNAME
WorkingDirectory=/path/to/nostalgia-anti-scam-bot
ExecStart=/bin/bash /path/to/nostalgia-anti-scam-bot/start.sh
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

- Original project: [zenchain-protocol/telegram-bot-monitor](https://github.com/zenchain-protocol/telegram-bot-monitor)
- Extended and maintained by: nostalgia
