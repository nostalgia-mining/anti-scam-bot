#!/usr/bin/env python3
"""
import_members.py
Reads members.json and imports them into the SQLite database.
Skips members that already exist. Does not overwrite existing records.
"""

import json
import sqlite3
import time

# ── Configuration ────────────────────────────────────────────────────────────
INPUT   = 'members.json'
DB_PATH = 'zenchain_bot_sqlite.db'
CHAT_ID = '-1001701085050'
# ─────────────────────────────────────────────────────────────────────────────

def main():
    with open(INPUT, 'r', encoding='utf-8') as f:
        members = json.load(f)

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    inserted  = 0
    skipped   = 0
    deleted   = 0
    now       = int(time.time())

    for m in members:
        member_id = m['id']

        # Check if already in DB
        cursor.execute('SELECT chatMemberId, status FROM chatMembers WHERE chatMemberId = ?', (member_id,))
        existing = cursor.fetchone()

        if m['is_deleted']:
            if existing:
                # Update existing record to mark as deleted
                if existing[1] != 'deleted':
                    cursor.execute('UPDATE chatMembers SET status = ?, chatMemberFirstName = ? WHERE chatMemberId = ?',
                                   ('deleted', 'Deleted Account', member_id))
                    deleted += 1
                else:
                    skipped += 1
            else:
                # Insert new deleted record
                cursor.execute('''
                    INSERT INTO chatMembers (
                        chatId, chatMemberId, chatMemberFirstName, chatMemberLastName,
                        chatMemberUserName, isAdmin, isBot, status,
                        warning, warningBadWord, warningWalletKey,
                        warningAudio, warningVideo, warningImage,
                        warningAnyFile, warningUrl, joinDate
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, ?)
                ''', (CHAT_ID, member_id, 'Deleted Account', '', '', 0, 0, 'deleted', now))
                deleted += 1
            continue

        if existing:
            skipped += 1
            continue

        # New active member — insert
        cursor.execute('''
            INSERT INTO chatMembers (
                chatId, chatMemberId, chatMemberFirstName, chatMemberLastName,
                chatMemberUserName, isAdmin, isBot, status,
                warning, warningBadWord, warningWalletKey,
                warningAudio, warningVideo, warningImage,
                warningAnyFile, warningUrl, joinDate
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, ?)
        ''', (
            CHAT_ID,
            member_id,
            m['first_name'],
            m['last_name'],
            m['username'],
            0,
            1 if m['is_bot'] else 0,
            'active',
            now
        ))
        inserted += 1

    conn.commit()
    conn.close()

    print(f"Import complete.")
    print(f"  Inserted:                    {inserted}")
    print(f"  Skipped (already existed):   {skipped}")
    print(f"  Deleted accounts found/updated: {deleted}")

if __name__ == '__main__':
    main()
