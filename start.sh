#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS_DIR="$SCRIPT_DIR/logs"
RESTART_DELAY=10
DISCONNECT_TIMEOUT=180  # seconds before restarting after a disconnect
FIFO="/tmp/telegram-bot-fifo-$$"
PID_FILE="/tmp/telegram-bot-node.pid"

mkdir -p "$LOGS_DIR"

# Returns a formatted timestamp: [27/04/2026, 08:44:51]
ts() {
    date +"[%d/%m/%Y, %H:%M:%S]"
}

# Archive log files older than 7 days
archive_old_logs() {
    OLD_LOGS=$(find "$LOGS_DIR" -maxdepth 1 -name "bot-*.log" -mtime +7)
    if [ -n "$OLD_LOGS" ]; then
        ARCHIVE="$LOGS_DIR/archive-$(date +"%Y-%m-%d").tar.gz"
        echo "Archiving old logs into $ARCHIVE..."
        tar -czf "$ARCHIVE" -C "$LOGS_DIR" $(basename -a $OLD_LOGS)
        rm -f $OLD_LOGS
    fi
}

# Reads bot output line by line, handles log rotation and network disconnect detection
rotate_and_log() {
    local current_date
    current_date=$(date +"%Y-%m-%d")
    local log_file="$LOGS_DIR/bot-$current_date.log"
    local disconnect_timer_pid=""

    while IFS= read -r line; do
        local today
        today=$(date +"%Y-%m-%d")

        # Date changed — open new log file and archive old ones
        if [ "$today" != "$current_date" ]; then
            current_date="$today"
            log_file="$LOGS_DIR/bot-$today.log"
            echo "========================================" >> "$log_file"
            echo "Log rotated at $(date +"%Y-%m-%dT%H:%M:%S%z")" >> "$log_file"
            echo "========================================" >> "$log_file"
            archive_old_logs
        fi

        # Detect Telegraf's "Failed to fetch updates" lines
        # Telegraf format: "Failed to fetch updates. Waiting: Xs <error>"
        if echo "$line" | grep -q "Failed to fetch updates"; then
            local reason
            # Strip everything up to and including "Waiting: Xs "
            # then also strip any URL containing the bot token
            reason=$(echo "$line" | sed 's/.*Failed to fetch updates\. Waiting: [0-9]*s //' | sed 's|request to https://api\.telegram\.org/bot[^/]*/[^ ]* failed, reason: ||')
            line="$(ts) Network: Failed to fetch updates — $reason"

            # Start a real background timer on first disconnect.
            # Kills the node process directly after timeout — no dependency on new lines arriving.
            if [ -z "$disconnect_timer_pid" ]; then
                echo "$(ts) Network disconnection detected. Will restart in ${DISCONNECT_TIMEOUT}s if not recovered..." | tee -a "$log_file"
                (
                    sleep "$DISCONNECT_TIMEOUT"
                    if [ -f "$PID_FILE" ]; then
                        local pid
                        pid=$(cat "$PID_FILE")
                        echo "$(ts) Network did not recover in ${DISCONNECT_TIMEOUT}s. Forcing restart..." >> "$log_file"
                        kill "$pid" 2>/dev/null
                    fi
                ) &
                disconnect_timer_pid=$!
            fi
        else
            # Any non-error line — cancel the disconnect timer
            if [ -n "$disconnect_timer_pid" ]; then
                kill "$disconnect_timer_pid" 2>/dev/null
                wait "$disconnect_timer_pid" 2>/dev/null
                disconnect_timer_pid=""
                echo "$(ts) Network recovered." | tee -a "$log_file"
            fi
        fi

        # Scrub bot token from any line before printing/logging — catches all Telegraf error formats
        line=$(echo "$line" | sed 's|/bot[0-9]*:[A-Za-z0-9_-]*/|/bot[REDACTED]/|g')

        echo "$line" | tee -a "$log_file"
    done

    # Clean up timer if still running when bot exits normally
    if [ -n "$disconnect_timer_pid" ]; then
        kill "$disconnect_timer_pid" 2>/dev/null
        wait "$disconnect_timer_pid" 2>/dev/null
    fi
}

# Cleanup on script exit (Ctrl+C etc.)
cleanup() {
    rm -f "$FIFO" "$PID_FILE"
    exit 0
}
trap cleanup EXIT INT TERM

archive_old_logs

# Restart loop
while true; do
    TODAY=$(date +"%Y-%m-%d")
    LOG_FILE="$LOGS_DIR/bot-$TODAY.log"

    echo "========================================" >> "$LOG_FILE"
    echo "Bot started at $(date +"%Y-%m-%dT%H:%M:%S%z")" >> "$LOG_FILE"
    echo "========================================" >> "$LOG_FILE"

    # Create a named pipe for this run
    mkfifo "$FIFO"

    # Check for a pending DB operation (import or cleanup triggered via bot menu)
    PENDING_FLAG="$SCRIPT_DIR/pending_operation.json"
    if [ -f "$PENDING_FLAG" ]; then
        TS=$(date +"%d/%m/%Y, %H:%M:%S")
        echo "[$TS] Pending DB operation detected. Running before restart..." | tee -a "$LOG_FILE"
        COMMAND=$(python3 -c "import json,sys; d=json.load(open('$PENDING_FLAG')); print(d['command'])" 2>/dev/null)
        ADMIN_ID=$(python3 -c "import json,sys; d=json.load(open('$PENDING_FLAG')); print(d['adminId'])" 2>/dev/null)
        BOT_TOKEN=$(python3 -c "import json,sys; d=json.load(open('$PENDING_FLAG')); print(d['botToken'])" 2>/dev/null)
        rm -f "$PENDING_FLAG"
        python3 "$SCRIPT_DIR/manage_members.py" "$COMMAND" "$ADMIN_ID" "$BOT_TOKEN" 2>&1 | tee -a "$LOG_FILE"
        echo "$(ts) DB operation complete. Starting bot..." | tee -a "$LOG_FILE"
    fi

    # Start node writing to the FIFO, save its PID
    node "$SCRIPT_DIR/node_modules/ts-node/dist/bin.js" "$SCRIPT_DIR/src/bot.ts" > "$FIFO" 2>&1 &
    NODE_PID=$!
    echo "$NODE_PID" > "$PID_FILE"

    # Read from the FIFO through rotate_and_log (blocks until node exits)
    rotate_and_log < "$FIFO"

    # Wait for node to finish and clean up
    wait "$NODE_PID" 2>/dev/null
    rm -f "$FIFO"
    rm -f "$PID_FILE"

    TODAY=$(date +"%Y-%m-%d")
    LOG_FILE="$LOGS_DIR/bot-$TODAY.log"
    echo "$(ts) Bot process exited. Restarting in ${RESTART_DELAY}s..." | tee -a "$LOG_FILE"
    sleep $RESTART_DELAY
done
