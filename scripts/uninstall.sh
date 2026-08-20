#!/bin/bash

# ==============================================================================
# Commonplace Self-Hosted Uninstaller
# Supports Linux (systemd) and macOS (launchd)
# ==============================================================================

# Detect directories
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( dirname "$SCRIPT_DIR" )"
SERVER_DIR="$PROJECT_DIR/server"
DATA_DIR="$PROJECT_DIR/data"

echo "=============================================================================="
echo "Starting Commonplace Self-Hosted Uninstallation..."
echo "=============================================================================="

# 1. Detect OS and stop background services
OS_TYPE=$(uname -s)

if [ "$OS_TYPE" = "Darwin" ]; then
  echo "Detected macOS. Removing LaunchAgent..."
  PLIST_PATH="$HOME/Library/LaunchAgents/com.commonplace.server.plist"
  
  if [ -f "$PLIST_PATH" ]; then
    echo "Stopping background service..."
    launchctl unload "$PLIST_PATH" || true
    echo "Removing plist file..."
    rm -f "$PLIST_PATH"
    echo "macOS background service removed successfully."
  else
    echo "No background service plist found."
  fi

elif [ "$OS_TYPE" = "Linux" ]; then
  echo "Detected Linux..."
  SERVICE_NAME="commonplace.service"
  SERVICE_PATH="/etc/systemd/system/$SERVICE_NAME"
  
  if [ -f "$SERVICE_PATH" ]; then
    if [ "$EUID" -ne 0 ]; then
      echo "Error: systemd service exists at $SERVICE_PATH. Please run uninstall.sh with sudo to remove it:" >&2
      echo "  sudo ./uninstall.sh" >&2
      exit 1
    else
      echo "Stopping systemd service..."
      systemctl stop "$SERVICE_NAME" || true
      echo "Disabling systemd service..."
      systemctl disable "$SERVICE_NAME" || true
      echo "Removing service configuration file..."
      rm -f "$SERVICE_PATH"
      echo "Reloading systemd daemon..."
      systemctl daemon-reload
      echo "Linux background service removed successfully."
    fi
  else
    echo "No systemd service configuration found."
  fi
fi

# 2. Cleanup files
echo ""
read -p "Do you want to delete the local database and stored articles? (y/N): " CONFIRM_DB
if [[ "$CONFIRM_DB" =~ ^[Yy]$ ]]; then
  echo "Removing database and local files in $DATA_DIR..."
  rm -rf "$DATA_DIR"
  echo "Database files deleted."
else
  echo "Kept database files in $DATA_DIR."
fi

read -p "Do you want to delete installed node_modules dependencies? (y/N): " CONFIRM_DEPS
if [[ "$CONFIRM_DEPS" =~ ^[Yy]$ ]]; then
  echo "Removing server node_modules..."
  rm -rf "$SERVER_DIR/node_modules"
  rm -f "$SERVER_DIR/package-lock.json"
  echo "Node modules deleted."
else
  echo "Kept server node_modules."
fi

echo "=============================================================================="
echo "Uninstallation complete!"
echo "=============================================================================="
