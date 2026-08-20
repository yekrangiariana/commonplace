# Commonplace

Commonplace is a local-first research workspace that turns saved articles into usable writing material. Users can capture web articles, read them in a clean in-app reader, highlight key passages, organise research with tags and projects, follow sources through RSS, and draft project notes in Markdown—all inside one lightweight tool.

* **End-to-end research loop**: Capture, read, annotate, organise, and draft in one tool.
* **Project-aware research**: Articles are not just bookmarked, they are tied to active writing work.
* **Built for synthesis**: Highlights flow into project workspaces where writing happens.
* **RSS plus bookmarking**: Discovery and deep reading live together in one interface.
* **Flexible personal taxonomy**: Tags, projects, stages, and auto-tag rules adapt to your workflow.

---

## Self-Hosting Guide

You can self-host Commonplace natively on your old laptop or home server using the Node.js + SQLite backend. This replaces the Supabase Cloud database and ensures your data is hosted entirely on your own hardware without limitations.

### Prerequisites
To run the server, you need **Node.js** (version 18 or newer) and **npm** installed on your server:

* **Linux (Mint/Ubuntu/Debian)**:
  Install Node.js and npm via the standard package manager:
  ```bash
  sudo apt update
  sudo apt install -y nodejs npm
  ```
  *(If your package manager installs an older version, we recommend using NodeSource or NVM to install Node 20 LTS.)*
* **macOS**:
  Install via Homebrew:
  ```bash
  brew install node
  ```

### Installation
You can configure and start the entire app with a single copy-pasteable command. Open a terminal on your self-hosted machine and run:

```bash
git clone https://github.com/yekrangiariana/commonplace.git && cd commonplace && chmod +x scripts/install.sh && sudo ./scripts/install.sh
```

#### Running as a Background Service
If you want Commonplace to run automatically as a background service:
* **Linux (Mint/Ubuntu/Debian)**: Run the script above with `sudo`. It automatically registers and enables a `systemd` daemon (`commonplace.service`).
* **macOS**: The installer automatically registers a user-level `launchd` plist agent (`com.commonplace.server.plist`) which starts on login. No sudo is required! (On macOS, you can run `scripts/install.sh` without the `sudo` prefix).

### Configuration
* The server configuration is stored in the `server/.env` file. 
* By default, the server runs on port **`8383`**. If you need to change the port (e.g. to resolve conflicts), open `server/.env` and edit `PORT=8383`.
* Stored bookmarks, projects, feeds, and session tokens are saved in a single local database file: `data/commonplace.db`.

### Logging In & Password Security
1. On your first load of the dashboard (e.g., opening `http://localhost:8383`), select the **Create Account** button.
2. Enter your email and choose a secure master password. This password will be hashed using standard PBKDF2 cryptography and stored in the SQLite database.
3. You will remain logged in on that device indefinitely. If you connect from other devices (e.g. via Tailscale), you will log in using that same password.
4. You can change your password at any time in the **Settings -> Data** tab under the **Change Account Password** section.

### Uninstallation
To stop the background services and clean up installation files, run:
```bash
cd ~/commonplace && sudo ./scripts/uninstall.sh
```
*(On macOS, you do not need the `sudo` prefix: `cd ~/commonplace && ./scripts/uninstall.sh`)*