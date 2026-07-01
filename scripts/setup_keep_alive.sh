#!/bin/bash

# ==============================================================================
# Commonplace Keep-Alive Setup Script
# ==============================================================================
# This script sets up a macOS Launch Agent that runs the keep-alive ping script
# once every 24 hours.
#
# To bypass macOS TCC sandbox restrictions (which block launchd from running
# scripts directly inside iCloud Drive/Documents folders), this script copies
# the keep-alive script and its credentials to:
#   ~/.commonplace/
#
# If you migrate to a new Mac, simply run this script once to register it:
#   bash scripts/setup_keep_alive.sh
# ==============================================================================

# Directories
PROJECT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )/.." && pwd )"
SETTINGS_FILE="$PROJECT_DIR/app-settings.json"

LOCAL_CONFIG_DIR="$HOME/.commonplace"
LOCAL_CONFIG_FILE="$LOCAL_CONFIG_DIR/config.json"
LOCAL_SCRIPT="$LOCAL_CONFIG_DIR/keep_alive.sh"

PLIST_FILE="com.commonplace.keepalive.plist"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_FILE"
LOG_DIR="$HOME/Library/Logs"

echo "====================================================="
echo "Setting up Commonplace background agent..."
echo "====================================================="

# 1. Read app-settings.json to extract keys
if [ -f "$SETTINGS_FILE" ]; then
  fetch_service_url=$(grep -o '"fetchServiceUrl"[[:space:]]*:[[:space:]]*"[^"]*"' "$SETTINGS_FILE" | cut -d'"' -f4)
  anon_key=$(grep -o '"supabaseAnonKey"[[:space:]]*:[[:space:]]*"[^"]*"' "$SETTINGS_FILE" | cut -d'"' -f4)
  
  if [ -z "$fetch_service_url" ] || [ -z "$anon_key" ]; then
    echo "Error: Could not extract keys from $SETTINGS_FILE" >&2
    exit 1
  fi
else
  echo "Error: app-settings.json not found at $SETTINGS_FILE" >&2
  exit 1
fi

# 2. Create the ~/.commonplace folder and write local config.json
# This folder is outside iCloud Drive and is not protected by macOS TCC filesystem restrictions.
mkdir -p "$LOCAL_CONFIG_DIR"
cat <<EOF > "$LOCAL_CONFIG_FILE"
{
  "fetchServiceUrl": "$fetch_service_url",
  "supabaseAnonKey": "$anon_key"
}
EOF
chmod 600 "$LOCAL_CONFIG_FILE" # Secure permissions
echo "✓ Generated local credentials configuration at $LOCAL_CONFIG_FILE"

# 3. Copy keep_alive.sh to local folder and make it executable
cp "$PROJECT_DIR/scripts/keep_alive.sh" "$LOCAL_SCRIPT"
chmod +x "$LOCAL_SCRIPT"
echo "✓ Instantiated local keep-alive script at $LOCAL_SCRIPT"

# 4. Ensure system log directory exists
mkdir -p "$LOG_DIR"

# 5. Create the Launch Agent PLIST pointing to the local home folder script
cat <<EOF > "$PLIST_PATH"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.commonplace.keepalive</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$LOCAL_SCRIPT</string>
    </array>
    <key>StartInterval</key>
    <integer>86400</integer> <!-- Run every 24 hours (86400 seconds) -->
    <key>StandardOutPath</key>
    <string>$LOG_DIR/com.commonplace.keepalive.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/com.commonplace.keepalive.log</string>
    <key>RunAtLoad</key>
    <true/> <!-- Run immediately upon system boot/login -->
</dict>
</plist>
EOF

echo "✓ Generated launchd PLIST configuration at:"
echo "  $PLIST_PATH"

# 6. Load the Launch Agent into macOS system services
# Unload first if it was already loaded to prevent duplicate/stale configurations
launchctl unload "$PLIST_PATH" 2>/dev/null
launchctl load "$PLIST_PATH"

echo "====================================================="
echo "✓ Success: Keep-alive agent is registered and loaded!"
echo "====================================================="
echo "• Frequency: Runs every 24 hours (and immediately on Mac startup/login)."
echo "• Log File:  $LOG_DIR/com.commonplace.keepalive.log"
echo "• Test command to see if it works:"
echo "  cat $LOG_DIR/com.commonplace.keepalive.log"
echo "====================================================="
