#!/usr/bin/env python3
"""
manage_members.py
Member management script for the Telegram bot monitor.
Runs independently of the Node.js bot process.
Communicates back to the admin via Telegram messages using the bot token.

Usage:
    python3 manage_members.py <command> <admin_chat_id> <bot_token>

Commands:
    export      — fetch all members from the Telegram group, save to members.json
    import      — import members.json into the SQLite DB
    scan        — scan Telegram group for deleted accounts (Telethon, no bans)
    cleanup     — scan Telegram group for deleted accounts and ban them (Telethon)
    crosscheck  — cross-reference DB vs export, verify missing members via Bot API,
                  update names, and ban confirmed deleted/banned accounts

API_ID and API_HASH are read from telethon_config.json (set via the bot config menu).
Called by the bot when admin clicks buttons in the config menu.
"""

import sys
import json
import asyncio
import sqlite3
import time
import requests
import os

from telethon import TelegramClient
from telethon.errors import FloodWaitError, UserAdminInvalidError, ChatAdminRequiredError

# ── Configuration ────────────────────────────────────────────────────────────
CHAT_ID   = -1001701085050           # the group to manage
DB_PATH   = 'zenchain_bot_sqlite.db'
JSON_PATH = 'members.json'
SESSION   = 'member_export_session'  # reuse existing session file
CONFIG_FILE = 'telethon_config.json'
# ─────────────────────────────────────────────────────────────────────────────

def load_telethon_config():
    """Load API_ID and API_HASH from telethon_config.json."""
    if not os.path.exists(CONFIG_FILE):
        raise FileNotFoundError(f"{CONFIG_FILE} not found. Set API credentials via the bot config menu.")
    with open(CONFIG_FILE, 'r') as f:
        cfg = json.load(f)
    if not cfg.get('api_id') or not cfg.get('api_hash'):
        raise ValueError("API credentials incomplete. Set them via the bot config menu.")
    return int(cfg['api_id']), cfg['api_hash']

BOT_TOKEN = ''  # set at runtime from command line argument
API_ID    = 0   # set at runtime from telethon_config.json
API_HASH  = ''  # set at runtime from telethon_config.json

def send(chat_id: int, text: str):
    """Send a message to the admin via the bot token."""
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    try:
        requests.post(url, json={'chat_id': chat_id, 'text': text}, timeout=10)
    except Exception as e:
        print(f"Failed to send message: {e}")

def send_with_menu(chat_id: int, text: str):
    """Send a message with the Member Management menu attached."""
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/sendMessage"
    buttons = [
        [{'text': 'Export members from Telegram',  'callback_data': 'mmExport'     }],
        [{'text': 'Import members to DB',          'callback_data': 'mmImport'     }],
        [{'text': 'Scan for deleted accounts',     'callback_data': 'mmScan'       }],
        [{'text': 'Scan and ban deleted accounts', 'callback_data': 'mmCleanup'    }],
        [{'text': 'Cross-check & ban deleted',     'callback_data': 'mmCrosscheck'    }],
        [{'text': 'Cross-check report only',       'callback_data': 'mmCrosscheckDry' }],
        [{'text': 'Back to Main Menu',             'callback_data': 'mainMenu'     }],
    ]
    payload = {
        'chat_id': chat_id,
        'text': text,
        'reply_markup': {'inline_keyboard': buttons}
    }
    try:
        requests.post(url, json=payload, timeout=10)
    except Exception as e:
        print(f"Failed to send message with menu: {e}")

def log(text: str):
    """Print to console with timestamp."""
    ts = time.strftime("[%d/%m/%Y, %H:%M:%S]")
    print(f"{ts} {text}")

# ── Export ────────────────────────────────────────────────────────────────────
async def cmd_export(admin_id: int):
    send(admin_id, "📥 Starting member export from Telegram group...\nThis may take several minutes.")
    log("Starting export...")

    client = TelegramClient(SESSION, API_ID, API_HASH)
    await client.start()

    members = []
    count = 0

    async for user in client.iter_participants(CHAT_ID):
        members.append({
            'id':         user.id,
            'first_name': user.first_name or '',
            'last_name':  user.last_name  or '',
            'username':   user.username   or '',
            'is_bot':     user.bot,
            'is_deleted': user.deleted
        })
        count += 1
        if count % 500 == 0:
            log(f"Exported {count} members so far...")
            send(admin_id, f"⏳ Exported {count} members so far...")

    await client.disconnect()

    with open(JSON_PATH, 'w', encoding='utf-8') as f:
        json.dump(members, f, ensure_ascii=False, indent=2)

    deleted = sum(1 for m in members if m['is_deleted'])
    bots    = sum(1 for m in members if m['is_bot'])

    msg = (f"✅ Export complete.\n"
           f"Total members: {count}\n"
           f"Deleted accounts: {deleted}\n"
           f"Bots: {bots}\n"
           f"Saved to: {JSON_PATH}")
    log(msg)
    send_with_menu(admin_id, msg)

# ── Import ────────────────────────────────────────────────────────────────────
async def cmd_import(admin_id: int):
    send(admin_id, "📤 Starting import from members.json into database...")
    log("Starting import...")

    try:
        with open(JSON_PATH, 'r', encoding='utf-8') as f:
            members = json.load(f)
    except FileNotFoundError:
        msg = "❌ members.json not found. Run export first."
        log(msg)
        send(admin_id, msg)
        return

    conn   = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    inserted = 0
    skipped  = 0
    deleted  = 0
    now      = int(time.time())

    for m in members:
        cursor.execute('SELECT chatMemberId FROM chatMembers WHERE chatMemberId = ?', (m['id'],))
        if cursor.fetchone():
            skipped += 1
            continue

        if m['is_deleted']:
            status     = 'deleted'
            first_name = 'Deleted Account'
            last_name  = ''
            username   = ''
            deleted   += 1
        else:
            status     = 'active'
            first_name = m['first_name']
            last_name  = m['last_name']
            username   = m['username']

        cursor.execute('''
            INSERT INTO chatMembers (
                chatId, chatMemberId, chatMemberFirstName, chatMemberLastName,
                chatMemberUserName, isAdmin, isBot, status,
                warning, warningBadWord, warningWalletKey,
                warningAudio, warningVideo, warningImage,
                warningAnyFile, warningUrl, joinDate
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, ?)
        ''', (
            str(CHAT_ID), m['id'], first_name, last_name, username,
            0, 1 if m['is_bot'] else 0, status, now
        ))
        inserted += 1

    conn.commit()
    conn.close()

    msg = (f"✅ Import complete.\n"
           f"Inserted: {inserted}\n"
           f"Skipped (already existed): {skipped}\n"
           f"Deleted accounts found: {deleted}")
    log(msg)
    send_with_menu(admin_id, msg)

# ── Cross-check (DB vs export, verify via Bot API, update names, ban deleted) ──
async def cmd_crosscheck(admin_id: int, ban: bool = False):
    """
    1. Loads members.json (run export first)
    2. Finds DB active members missing from the export
    3. Calls Bot API getChat on each missing member
    4. If first_name is empty → deleted/banned → ban them (if ban=True)
    5. If first_name is not empty → update their name/username in DB
    """
    if not os.path.exists(JSON_PATH):
        send(admin_id, "❌ members.json not found. Run Export first.")
        return

    action = "Cross-checking & banning" if ban else "Cross-checking (report only)"
    send(admin_id, f"🔍 {action}: comparing DB against export...\nThis may take a few minutes.")
    log(f"Starting cross-check (ban={ban})...")

    with open(JSON_PATH, 'r', encoding='utf-8') as f:
        export_data = json.load(f)

    export_ids = {m['id'] for m in export_data}

    conn   = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("SELECT chatMemberId, chatMemberFirstName, chatMemberUserName FROM chatMembers WHERE status = 'active'")
    db_members = cursor.fetchall()

    # Find members in DB but not in export
    missing = [(mid, fname, uname) for (mid, fname, uname) in db_members if mid not in export_ids]

    log(f"DB active members: {len(db_members)}, in export: {len(export_ids)}, missing from export: {len(missing)}")
    send(admin_id, f"⏳ Found {len(missing)} members in DB not in export. Verifying via Bot API...")

    deleted_found = []
    updated       = 0
    marked_inactive = 0
    updated_list  = []  # track who was updated for the log
    now           = int(time.time())

    checked = 0
    for (member_id, db_first_name, db_username) in missing:
        checked += 1
        if checked % 50 == 0:
            log(f"Cross-check progress: {checked}/{len(missing)}...")
            send(admin_id, f"⏳ Checked {checked}/{len(missing)} members...")

        url = f"https://api.telegram.org/bot{BOT_TOKEN}/getChat"
        try:
            resp = requests.get(url, params={'chat_id': member_id}, timeout=5)
            data = resp.json()

            if not data.get('ok'):
                # Bot API can't find them — they left or were removed, mark as inactive
                cursor.execute("UPDATE chatMembers SET status = 'inactive' WHERE chatMemberId = ?", (member_id,))
                conn.commit()
                marked_inactive += 1
                log(f"Marked inactive (not in group): ID {member_id} (@{db_username})")
            else:
                result    = data['result']
                new_first = result.get('first_name', '')
                new_last  = result.get('last_name', '')
                new_user  = result.get('username', '')

                if not new_first:
                    # Empty first_name = deleted/banned account
                    deleted_found.append((member_id, new_user or db_username or ''))
                    log(f"Deleted/banned account: ID {member_id} (@{new_user or db_username})")
                else:
                    # Still active — update their name/username in DB
                    cursor.execute('''
                        UPDATE chatMembers
                        SET chatMemberFirstName = ?, chatMemberLastName = ?, chatMemberUserName = ?
                        WHERE chatMemberId = ?
                    ''', (new_first, new_last, new_user, member_id))
                    conn.commit()
                    updated += 1
                    old_name = f"{db_first_name}".strip() or f"ID:{member_id}"
                    new_name = f"{new_first} {new_last}".strip()
                    new_at   = f"@{new_user}" if new_user else "(no username)"
                    updated_list.append(f"  {old_name} → {new_name} {new_at}")
                    log(f"Updated: ID {member_id} → {new_first} {new_last} (@{new_user})")

        except Exception as e:
            log(f"Error checking ID {member_id}: {e}")

        await asyncio.sleep(0.05)  # 20 calls/second

    # Log full update list to console/log file
    if updated_list:
        log("Names updated in DB:\n" + '\n'.join(updated_list))

    if not deleted_found and updated == 0 and marked_inactive == 0:
        msg = f"✅ Cross-check complete.\nChecked {len(missing)} missing members — all still active, no changes needed."
        log(msg)
        send_with_menu(admin_id, msg)
        conn.close()
        return

    if not deleted_found:
        msg = (f"✅ Cross-check complete.\n"
               f"Checked: {len(missing)} missing members\n"
               f"Names updated: {updated} (see bot log for details)\n"
               f"Marked inactive (left/removed): {marked_inactive}\n"
               f"Deleted/banned: 0")
        log(msg)
        send_with_menu(admin_id, msg)
        conn.close()
        return

    if not ban:
        # Report only — simple summary to Telegram, full detail in log
        ids = '\n'.join([f"  ID: {mid} (@{uname})" if uname else f"  ID: {mid}" for mid, uname in deleted_found])
        msg = (f"✅ Cross-check complete (report only).\n"
               f"Checked: {len(missing)} missing members\n"
               f"Names updated: {updated} (see bot log for details)\n"
               f"Marked inactive (left/removed): {marked_inactive}\n"
               f"Would ban: {len(deleted_found)} deleted/banned account(s):\n{ids}\n\n"
               f"Use 'Cross-check & Ban' to actually ban them.")
        log(msg)
        log("Cross-check finished. Check the log file for full name update details.")
        send_with_menu(admin_id, msg)
        conn.close()
        return

    # Ban deleted/banned accounts
    send(admin_id, f"🚫 Banning {len(deleted_found)} deleted/banned account(s)...")
    banned = 0
    failed = 0

    for (member_id, username) in deleted_found:
        url = f"https://api.telegram.org/bot{BOT_TOKEN}/banChatMember"
        try:
            resp = requests.post(url, json={'chat_id': CHAT_ID, 'user_id': member_id}, timeout=10)
            if resp.json().get('ok'):
                cursor.execute("UPDATE chatMembers SET status = 'banned' WHERE chatMemberId = ?", (member_id,))
                cursor.execute('''
                    INSERT INTO membersHistory (
                        chatId, chatMemberId, chatMemberFirstName, chatMemberLastName,
                        chatMemberUserName, isAdmin, isBot, status, joinDate, banDate, reason
                    ) VALUES (?, ?, ?, ?, ?, 0, 0, 'banned', ?, ?, ?)
                ''', (str(CHAT_ID), member_id, 'Deleted Account', '', username, now, now,
                      'Banned — deleted/deactivated Telegram account'))
                conn.commit()
                log(f"Banned: ID {member_id} (@{username})")
                banned += 1
            else:
                log(f"Failed to ban ID {member_id}: {resp.json()}")
                failed += 1
        except Exception as e:
            log(f"Error banning ID {member_id}: {e}")
            failed += 1

        await asyncio.sleep(0.05)

    conn.close()

    msg = (f"✅ Cross-check & ban complete.\n"
           f"Checked: {len(missing)} missing members\n"
           f"Names updated: {updated} (see bot log for details)\n"
           f"Marked inactive (left/removed): {marked_inactive}\n"
           f"Banned: {banned} deleted/banned accounts\n"
           f"Failed: {failed}")
    log(msg)
    log("Cross-check & ban finished. Check the log file for full name update details.")
    log("─" * 50)
    send_with_menu(admin_id, msg)

# ── Scan ──────────────────────────────────────────────────────────────────────
    send(admin_id, "🔍 Scanning group for deleted accounts...\nThis may take several minutes.")
    log("Starting scan...")

    client = TelegramClient(SESSION, API_ID, API_HASH)
    await client.start()

    deleted_found = []
    count = 0

    async for user in client.iter_participants(CHAT_ID):
        count += 1
        if count % 500 == 0:
            log(f"Scanned {count} members...")
            send(admin_id, f"⏳ Scanned {count} members...")
        if user.deleted:
            deleted_found.append(user)

    await client.disconnect()

    if not deleted_found:
        msg = f"✅ Scan complete. Scanned {count} members — no deleted accounts found."
    else:
        ids = '\n'.join([f"  ID: {u.id}" for u in deleted_found])
        msg = (f"✅ Scan complete. Scanned {count} members.\n"
               f"Found {len(deleted_found)} deleted account(s):\n{ids}\n\n"
               f"Run 'cleanup' command to ban them.")
    log(msg)
    send_with_menu(admin_id, msg)

# ── Cleanup ───────────────────────────────────────────────────────────────────
async def cmd_cleanup(admin_id: int):
    send(admin_id, "🔍 Scanning group for deleted accounts before cleanup...\nThis may take several minutes.")
    log("Starting cleanup scan...")

    client = TelegramClient(SESSION, API_ID, API_HASH)
    await client.start()

    deleted_found = []
    count = 0

    async for user in client.iter_participants(CHAT_ID):
        count += 1
        if count % 500 == 0:
            log(f"Scanned {count} members...")
            send(admin_id, f"⏳ Scanned {count} members...")
        if user.deleted:
            deleted_found.append(user)

    if not deleted_found:
        await client.disconnect()
        msg = f"✅ Scan complete. Scanned {count} members — no deleted accounts found. Nothing to ban."
        log(msg)
        send_with_menu(admin_id, msg)
        return

    send(admin_id, f"✅ Scan complete. Found {len(deleted_found)} deleted account(s). Banning them now...")
    log(f"Found {len(deleted_found)} deleted accounts. Banning...")

    conn   = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    now    = int(time.time())
    banned = 0
    failed = 0

    for user in deleted_found:
        try:
            await client.kick_participant(CHAT_ID, user)
            log(f"Banned: ID {user.id}")
            banned += 1

            cursor.execute('UPDATE chatMembers SET status = ? WHERE chatMemberId = ?', ('banned', user.id))
            cursor.execute('''
                INSERT INTO membersHistory (
                    chatId, chatMemberId, chatMemberFirstName, chatMemberLastName,
                    chatMemberUserName, isAdmin, isBot, status, joinDate, banDate, reason
                ) VALUES (?, ?, ?, ?, ?, 0, 0, 'banned', ?, ?, ?)
            ''', (str(CHAT_ID), user.id, 'Deleted Account', '', '', now, now, 'Banned — deleted Telegram account'))
            conn.commit()

            await asyncio.sleep(0.5)

        except FloodWaitError as e:
            log(f"Rate limited — waiting {e.seconds}s...")
            send(admin_id, f"⏳ Rate limited by Telegram. Waiting {e.seconds}s...")
            await asyncio.sleep(e.seconds)
        except (UserAdminInvalidError, ChatAdminRequiredError):
            log(f"Skipped ID {user.id} — insufficient permissions")
            failed += 1
        except Exception as e:
            log(f"Failed to ban ID {user.id}: {e}")
            failed += 1

    await client.disconnect()
    conn.close()

    msg = (f"✅ Cleanup complete.\n"
           f"Scanned: {count} members\n"
           f"Banned: {banned} deleted accounts\n"
           f"Failed: {failed}")
    log(msg)
    send_with_menu(admin_id, msg)

# ── Entry point ───────────────────────────────────────────────────────────────
async def main():
    global BOT_TOKEN

    if len(sys.argv) < 4:
        print("Usage: python3 manage_members.py <command> <admin_chat_id> <bot_token>")
        print("Commands: export, import, scan, cleanup")
        sys.exit(1)

    command   = sys.argv[1].lower()
    try:
        admin_id = int(sys.argv[2])
    except ValueError:
        print(f"Invalid admin_chat_id: {sys.argv[2]}")
        sys.exit(1)

    BOT_TOKEN = sys.argv[3]

    # Load Telethon credentials
    try:
        api_id, api_hash = load_telethon_config()
    except (FileNotFoundError, ValueError) as e:
        send(admin_id, f"❌ {e}")
        sys.exit(1)

    # Patch the session to use loaded credentials
    global API_ID, API_HASH
    API_ID   = api_id
    API_HASH = api_hash

    if command == 'export':
        await cmd_export(admin_id)
    elif command == 'import':
        await cmd_import(admin_id)
    elif command == 'scan':
        await cmd_scan(admin_id)
    elif command == 'cleanup':
        await cmd_cleanup(admin_id)
    elif command == 'crosscheck':
        await cmd_crosscheck(admin_id, ban=True)
    elif command == 'crosscheckdry':
        await cmd_crosscheck(admin_id, ban=False)
    else:
        send(admin_id, f"❌ Unknown command: {command}")
        print(f"Unknown command: {command}")
        sys.exit(1)

asyncio.run(main())
