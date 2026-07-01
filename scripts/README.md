# Supabase Keep-Alive Agent (macOS)

This agent runs a daily database query in the background to prevent Supabase from pausing your free project.

---

## 🚀 Setup (or migrate to a new Mac)

Open your terminal in this directory and run:

```bash
bash scripts/setup_keep_alive.sh
```

**That’s it.** The script automatically creates the local runner, extracts your keys securely without exposing them to git, and schedules the daily background task.

---

## 🧹 Uninstall (Stop & Remove)

If you ever want to completely remove this agent from your Mac, run:

```bash
# 1. Stop and unload the agent
launchctl unload ~/Library/LaunchAgents/com.commonplace.keepalive.plist

# 2. Delete the scheduling file
rm ~/Library/LaunchAgents/com.commonplace.keepalive.plist

# 3. Clean up the local folder
rm -rf ~/.commonplace
```
