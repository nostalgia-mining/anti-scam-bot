#!/usr/bin/env python3
"""
export_members.py
Fetches all participants from the Telegram group and saves them to members.json.
Requires: pip3 install telethon
"""

import json
import asyncio
from telethon import TelegramClient
from telethon.tl.types import UserStatusEmpty, UserStatusRecently, UserStatusLastWeek, UserStatusLastMonth

# ── Configuration ────────────────────────────────────────────────────────────
API_ID   = 0           # replace with your api_id (integer)
API_HASH = ''          # replace with your api_hash (string)
CHAT_ID  = -1001701085050
OUTPUT   = 'members.json'
# ─────────────────────────────────────────────────────────────────────────────

async def main():
    client = TelegramClient('member_export_session', API_ID, API_HASH)
    await client.start()

    print(f"Fetching participants from chat {CHAT_ID}...")
    print("This may take several minutes for large groups. Telethon handles rate limits automatically.")

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
        if count % 100 == 0:
            print(f"  Fetched {count} members so far...")

    await client.disconnect()

    with open(OUTPUT, 'w', encoding='utf-8') as f:
        json.dump(members, f, ensure_ascii=False, indent=2)

    deleted = sum(1 for m in members if m['is_deleted'])
    bots    = sum(1 for m in members if m['is_bot'])

    print(f"\nDone. Total: {count} members")
    print(f"  Deleted accounts: {deleted}")
    print(f"  Bots:             {bots}")
    print(f"  Saved to:         {OUTPUT}")

asyncio.run(main())
