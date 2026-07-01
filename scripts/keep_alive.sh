#!/bin/bash

# ==============================================================================
# Commonplace Keep-Alive Script
# ==============================================================================
# This script extracts your Supabase project credentials and runs a query
# to keep your database active.
#
# It looks for a local configuration file at:
#   ~/.commonplace/config.json
#
# If not found, it falls back to looking for:
#   ../app-settings.json
#
# NOTE: This script contains ZERO hardcoded credentials. It is 100% safe to commit
# to your public GitHub or Cloudflare Pages repositories.
# ==============================================================================

# Paths
LOCAL_CONFIG_DIR="$HOME/.commonplace"
LOCAL_CONFIG_FILE="$LOCAL_CONFIG_DIR/config.json"

# Print separator and timestamp in logs
echo "=============================================================================="
echo "Ping initiated on: $(date)"
echo "=============================================================================="

# 1. Determine which settings file to use
SETTINGS_FILE=""
if [ -f "$LOCAL_CONFIG_FILE" ]; then
  SETTINGS_FILE="$LOCAL_CONFIG_FILE"
  echo "Using local configuration file: $SETTINGS_FILE"
else
  # Fallback to checking relative to script location (for manual local runs)
  SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
  PROJECT_DIR="$( dirname "$SCRIPT_DIR" )"
  SETTINGS_FILE="$PROJECT_DIR/app-settings.json"
  echo "Using fallback settings file: $SETTINGS_FILE"
fi

if [ ! -f "$SETTINGS_FILE" ]; then
  echo "Error: Configuration file not found." >&2
  exit 1
fi

# 2. Extract configuration
# Using grep and cut to avoid dependency on 'jq'
fetch_service_url=$(grep -o '"fetchServiceUrl"[[:space:]]*:[[:space:]]*"[^"]*"' "$SETTINGS_FILE" | cut -d'"' -f4)
anon_key=$(grep -o '"supabaseAnonKey"[[:space:]]*:[[:space:]]*"[^"]*"' "$SETTINGS_FILE" | cut -d'"' -f4)

if [ -z "$fetch_service_url" ] || [ -z "$anon_key" ]; then
  echo "Error: Could not extract fetchServiceUrl or supabaseAnonKey from $SETTINGS_FILE" >&2
  exit 1
fi

# 3. Extract the base URL from the fetch service URL
base_url=$(echo "$fetch_service_url" | grep -o 'https://[^/]*')

if [ -z "$base_url" ]; then
  echo "Error: Could not extract base Supabase URL from $fetch_service_url" >&2
  exit 1
fi

echo "Targeting project URL: $base_url"

# 4. Perform the query via curl
# We query the 'bookmarks' table asking for just 1 record ID.
# This registers activity with Supabase and resets the 7-day inactivity timer.
http_code=$(curl -s -o /dev/null -w "%{http_code}" \
  -X GET "$base_url/rest/v1/bookmarks?select=id&limit=1" \
  -H "apikey: $anon_key" \
  -H "Authorization: Bearer $anon_key")

# 5. Output results
echo "HTTP response status: $http_code"

if [ "$http_code" -eq 200 ]; then
  echo "Success: Keep-alive database query succeeded."
  exit 0
elif [ "$http_code" -eq 503 ] || [ "$http_code" -eq 000 ]; then
  echo "Warning: Keep-alive failed (HTTP $http_code). The project might be paused." >&2
  echo "Please unpause your project in the Supabase dashboard." >&2
  exit 2
else
  echo "Warning: Keep-alive request returned HTTP status code $http_code" >&2
  exit 3
fi
