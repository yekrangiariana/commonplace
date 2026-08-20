#!/bin/bash

# ==============================================================================
# Commonplace Self-Hosted Installer
# Supports Linux (systemd) and macOS (launchd)
# ==============================================================================

# Exit on error
set -e

# Detect directories
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( dirname "$SCRIPT_DIR" )"
SERVER_DIR="$PROJECT_DIR/server"
DATA_DIR="$PROJECT_DIR/data"

echo "=============================================================================="
echo "Starting Commonplace Self-Hosted Installation..."
echo "Project root: $PROJECT_DIR"
echo "=============================================================================="

# 1. Dependency checks
echo "Checking Node.js & npm..."
if ! command -v node &> /dev/null; then
  echo "Error: Node.js is not installed. Please install Node.js (version 18+ recommended) and try again." >&2
  exit 1
fi

if ! command -v npm &> /dev/null; then
  echo "Error: npm is not installed. Please install npm and try again." >&2
  exit 1
fi

NODE_PATH=$(which node)
echo "Found Node.js at: $NODE_PATH"
echo "Node version: $(node -v)"

# 2. Install dependencies
echo "Installing server dependencies..."
cd "$SERVER_DIR"
npm install --no-audit --no-fund

# 3. Create default configuration
if [ ! -f "$SERVER_DIR/.env" ]; then
  echo "Creating default .env configuration file..."
  echo "PORT=8383" > "$SERVER_DIR/.env"
  echo "Default port set to 8383. You can modify this in $SERVER_DIR/.env later."
else
  echo ".env configuration already exists."
fi

# Ensure data directory exists
mkdir -p "$DATA_DIR"

# 4. OS-specific service installation
OS_TYPE=$(uname -s)

if [ "$OS_TYPE" = "Darwin" ]; then
  echo "Detected macOS..."
  PLIST_PATH="$HOME/Library/LaunchAgents/com.commonplace.server.plist"
  
  echo "Generating LaunchAgent plist..."
  cat <<EOF > "$PLIST_PATH"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.commonplace.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_PATH</string>
        <string>server.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>$SERVER_DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$DATA_DIR/server.log</string>
    <key>StandardErrorPath</key>
    <string>$DATA_DIR/server.err.log</string>
</dict>
</plist>
EOF

  echo "Unloading any existing agent..."
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
  
  echo "Loading background service..."
  launchctl load "$PLIST_PATH"
  echo "Background service registered successfully!"

elif [ "$OS_TYPE" = "Linux" ]; then
  echo "Detected Linux..."
  
  # Check if run with sudo for systemd registration
  if [ "$EUID" -ne 0 ]; then
    echo "------------------------------------------------------------------------------"
    echo "Note: To register Commonplace as a background service that automatically"
    echo "starts on system boot, please run the script with sudo:"
    echo "  sudo ./install.sh"
    echo "------------------------------------------------------------------------------"
    echo "Starting server manually in foreground for now..."
    echo "Press Ctrl+C to terminate."
    node server.js
  else
    # Sudo setup for systemd
    USER_NAME=$(logname || echo $SUDO_USER || echo $USER || whoami)
    SERVICE_PATH="/etc/systemd/system/commonplace.service"
    
    echo "Creating systemd service configuration for user: $USER_NAME..."
    cat <<EOF > "$SERVICE_PATH"
[Unit]
Description=Commonplace Self-Hosted Server
After=network.target

[Service]
Type=simple
User=$USER_NAME
WorkingDirectory=$SERVER_DIR
ExecStart=$NODE_PATH server.js
Restart=on-failure
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

    echo "Reloading systemd daemon..."
    systemctl daemon-reload
    
    echo "Enabling commonplace service on boot..."
    systemctl enable commonplace
    
    echo "Starting commonplace service..."
    systemctl restart commonplace
    
    echo "Background systemd service registered and started successfully!"
  fi
else
  echo "Unsupported OS type: $OS_TYPE. Please run 'npm start' manually inside $SERVER_DIR."
fi

# Print final confirmation
PORT_NUM=$(grep -o "PORT=[0-9]*" "$SERVER_DIR/.env" | cut -d'=' -f2 || echo "8383")
echo "=============================================================================="
echo "Installation complete!"
echo "Commonplace is running local database and web dashboard at:"
echo "  http://localhost:$PORT_NUM"
echo "  (Also check your Tailscale IP to access from other devices on your Tailnet)"
echo "=============================================================================="
