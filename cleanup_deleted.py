#!/usr/bin/env python3
"""
cleanup_deleted.py
Uses the existing Telethon session to find and kick deleted accounts from the group.
Reuses the session file created by export_members.py — no login needed.
Requires: pip3 install telethon
"""

import asyncio
import sqlite3
import time
from telethon import TelegramClient
from telethon.errors import FloodWaitError, UserAdminInvalidError, ChatAdminRequiredError

# ── Configuration ────────────────────────────────────────────────────────────
API_ID   = 0           # same as export_members.py
API_HASH = ''          # same as export_members.py
CHAT_ID  = -1001701085050
DB_PATH  = None        # set to 'zenchain_bot_sqlite.db' for the main group, None for others
DRY_RUN  = True        # set to False to actually kick — True just reports without kicking
# ─────────────────────────────────────────────────────────────────────────────

async def main():
    client = TelegramClient('member_export_session', API_ID, API_HASH)
    await client.start()

    print(f"Scanning for deleted accounts in chat {CHAT_ID}...")
    if DRY_RUN:
        print("DRY RUN mode — no one will be kicked. Set DRY_RUN = False to kick.")
    print()

    conn   = sqlite3.connect(DB_PATH) if DB_PATH else None
    cursor = conn.cursor() if conn else None

    deleted_found = []
    count = 0

    async for user in client.iter_participants(CHAT_ID):
        count += 1
        if count % 200 == 0:
            print(f"  Scanned {count} members...")

        if user.deleted:
            deleted_found.append(user)
            print(f"  Deleted account found: ID {user.id}")

    print(f"\nScan complete. Scanned {count} members, found {len(deleted_found)} deleted accounts.")

    if not deleted_found:
        print("Nothing to do.")
        await client.disconnect()
        if conn: conn.close()
        return

    if DRY_RUN:
        print("\nDRY RUN — would have kicked the above accounts.")
        print("Set DRY_RUN = False and run again to actually kick them.")
        await client.disconnect()
        if conn: conn.close()
        return

    # Kick deleted accounts
    kicked  = 0
    failed  = 0
    now     = int(time.time())

    print(f"\nKicking {len(deleted_found)} deleted accounts...")

    for user in deleted_found:
        try:
            await client.kick_participant(CHAT_ID, user)
            print(f"  Kicked: ID {user.id}")
            kicked += 1

            # Update DB if connected
            if conn and cursor:
                cursor.execute('''
                    UPDATE chatMembers
                    SET status = 'banned'
                    WHERE chatMemberId = ?
                ''', (user.id,))

                cursor.execute('''
                    INSERT INTO membersHistory (
                        chatId, chatMemberId, chatMemberFirstName, chatMemberLastName,
                        chatMemberUserName, isAdmin, isBot, status, joinDate, banDate, reason
                    ) VALUES (?, ?, ?, ?, ?, 0, 0, 'banned', ?, ?, ?)
                ''', (
                    str(CHAT_ID),
                    user.id,
                    'Deleted Account',
                    '',
                    '',
                    now,
                    now,
                    'Kicked — deleted Telegram account'
                ))
                conn.commit()

            # Small delay to avoid hitting rate limits
            await asyncio.sleep(0.5)

        except FloodWaitError as e:
            print(f"  Rate limited — waiting {e.seconds}s...")
            await asyncio.sleep(e.seconds)
        except (UserAdminInvalidError, ChatAdminRequiredError):
            print(f"  Skipped ID {user.id} — bot lacks permission or user is admin")
            failed += 1
        except Exception as e:
            print(f"  Failed to kick ID {user.id}: {e}")
            failed += 1

    await client.disconnect()
    if conn: conn.close()

    print(f"\nDone.")
    print(f"  Kicked:  {kicked}")
    print(f"  Failed:  {failed}")
    print(f"  DB updated for kicked accounts.")

asyncio.run(main())
