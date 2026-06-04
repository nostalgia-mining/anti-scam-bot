# Changelog

## [0.5.5] - 2026-06-04
### Changed
- Auto-ban keyword matching now applies l33tspeak normalization before checking (`1→i`, `0→o`, `3→e`, `5→s`, `8→b`)
- A single keyword like `childporn` now catches `ch1ldporn`, `ch1ldp0rn`, `ch..1ld..por!!n`, etc.

## [0.5.4] - 2026-06-03
### Fixed
- Bot admin bots not returned by Telegram's `getChatAdministrators()` API (e.g. captcha bots) were incorrectly triggering fuzzy impersonation checks
- When a mute/ban attempt fails with "user is an administrator" error, the bot now automatically fetches the user's details, adds them to the in-memory admin list, and rebuilds the admin set — skipping all future checks for that user
- Improved error message parsing using `e.message`, `e.description`, and `String(e)` fallback for more robust error detection

## [0.5.3] - 2026-06-03
### Changed
- Admin check in `checkMember` uses strict equality (`===`) for ID comparison

## [0.5.2] - 2026-06-03
### Added
- Debug logging `[bot-msg]` for messages received from other bots

## [0.5.1] - 2026-06-02
### Fixed
- Bot-to-bot message processing: bot now correctly receives and processes messages from other bots in the group (requires "Bot-to-Bot Communication" enabled in BotFather)
- Captcha poll messages containing auto-ban keywords are now deleted immediately

## [0.5.0] - 2026-05-30
### Added
- **Auto-Ban Keywords** feature — silent ban on join if member name matches keyword
- Bot message monitoring — delete messages from other bots if text contains auto-ban keyword (catches captcha polls with spammer names)
- Auto-ban keywords menu in inline config: Add / Remove / List
- Minimum 6-character length enforced for auto-ban keywords
- Cross-list conflict detection: adding a keyword already in name blacklist moves it with a warning
- Keywords stored in `environment.ts` as `autoBanKeywords: []`
### Changed
- Name normalization for keyword matching strips all spaces and punctuation before comparing

## [0.4.1] - 2026-05-14
### Added
- Departing impersonator warning: when a user leaves or gets banned while using a name resembling an admin (any of the 4 detection layers), bot posts a public warning to the group advising members not to respond to unsolicited DMs from that name

## [0.4.0] - 2026-05-10
### Added
- **4-layer impersonation detection system**:
  - Layer 1: Exact normalized name match → Ban
  - Layer 2: Homoglyph normalization (Cyrillic/Greek lookalikes → Latin) → Ban
  - Layer 3: Substring containment ≥ 85% similarity → Mute
  - Layer 4: Jaro-Winkler fuzzy similarity ≥ 85% → Mute
- `normalizeHomoglyphs()` — maps visually similar characters to Latin equivalents
- `jaroWinkler()` — similarity algorithm implementation
- `userShouldBeMuted()` — fuzzy detection separate from exact match ban
- Minimum name length threshold of 4 characters for impersonation detection
- Startup warning when admin has a name too short for reliable detection
- Separate alert messages for fuzzy impersonation vs blacklisted names
### Changed
- Upgraded Telegraf 3.x → 4.x (`Markup.inlineKeyboard`, `Markup.button.callback`, `banChatMember`, `launch`)
- Upgraded TypeORM 0.1.x → 0.3.x (`DataSource`, `findOneBy`, `delete`)
- Upgraded TypeScript 2.9 → 4.9, sqlite3 4.x → 5.x, pg 7.x → 8.x, ts-node 5.x → 10.x

## [0.3.1] - original zenchain release
### Added
- Content moderation rules: bad words, URLs, wallet addresses, images, audio, video
- Configurable warnings before ban
- Permanent bans
- Member join/leave tracking with SQLite
- Inline configuration menu via private chat

---

*Versions 0.3.1 and below are from the original [zenchain-protocol/telegram-bot-monitor](https://github.com/zenchain-protocol/telegram-bot-monitor).*
*Versions 0.4.0 and above are maintained by nostalgia.*
