# Product Requirements Document (PRD): GoTouch Manager

## 1. Product Overview

**Name:** GoTouch Manager

**Objective:** A self-hosted, lightweight Node.js web application that orchestrates multi-connection file downloads using `aria2c`, automatically uploads completed files to GoFile, stores record metadata in local JSON flat-files, and runs a scheduled "Touch Manager" daemon to keep hosted files active.

**Target Audience:** Single-user / Self-hosted Admin.

**Deployment Environment:** Single VPS instance bound to `localhost:6258` and exposed securely via Cloudflare Tunnels (Zero Trust).

---

## 2. System Architecture & Tech Stack

* **Runtime & Framework:** Node.js (v18+) with Express.js for REST API endpoints and web server handling.
* **Storage Engine:** Lightweight JSON flat-file storage located in a dedicated `data/` directory (zero external database dependencies).
* **Downloader Engine:** `aria2c` daemon executing via JSON-RPC.
* **HTTP Client:** Axios or native `fetch` for GoFile REST API interaction and ping routines.
* **Task Scheduler:** `node-cron` for automated daily touch execution.
* **Version Control:** Git repository configured with strict rules to prevent committing credentials, local data, or temporary download artifacts.

---

## 3. Core Features & Functional Requirements

### 3.1 Authentication

* **Access Control:** All UI views and API routes are protected by a single PIN entry screen.
* **Validation:** The submitted PIN is validated against the `ADMIN_PIN` defined in the `.env` file.
* **Session Management:** Successful verification issues an HTTP-only, encrypted session cookie or JWT valid for admin operations.

### 3.2 Aria2c Orchestration

* **Task Submission:** User enters a remote file URL (HTTP/FTP/Magnet) in the dashboard.
* **16-Connection Enforcement:** The Node.js backend connects to `aria2c` via JSON-RPC (`aria2.addUri`) and passes explicit parameters:
* `max-connection-per-server: "16"` (`-x 16`)
* `split: "16"` (`-s 16`)


* **Event Handling:** The backend subscribes to `aria2c` WebSocket events or polls RPC statuses to catch `aria2.onDownloadComplete`.

### 3.3 GoFile Upload Pipeline

* **Server Selection:** Upon download completion, issue a `GET [https://api.gofile.io/servers](https://api.gofile.io/servers)` request to select the optimal upload node.
* **File Transfer:** Streams the completed file from the local server to `https://{server}.gofile.io/uploadFile` via `multipart/form-data`.
* **Metadata Extraction:** Parses `fileId`, `downloadPage`, and `adminCode` from the GoFile response.
* **Data Persistence:** Appends the record to `data/files.json` with initial state (`status = "LIVE"`, `last_touched = CURRENT_TIMESTAMP`).
* **Cleanup:** Automatically deletes the downloaded temporary file from the VPS disk immediately after upload confirmation.

### 3.4 Daily Touch Manager

* **Schedule:** Executes every 24 hours via `node-cron`.
* **Target Selection:** Reads `data/files.json` and filters for entries where `status === "LIVE"` and `last_touched` is older than 23 hours.
* **Execution & Rate Limiting:** Iterates through selected items, making an HTTP `GET` request to the file's `downloadPage`. Introduces a random delay (2–7 seconds) between pings to prevent IP rate limits.
* **State Updates:**
* **Success (200 OK):** Updates `last_touched` timestamp in `data/files.json`.
* **Failure (404 Not Found):** Updates `status` to `"DEAD"`.



---

## 4. File Storage Structure & Data Schemas

All persistent storage resides strictly inside a `data/` directory at the project root.

### 4.1 Folder Structure

```text
gotouch-manager/
├── data/
│   ├── files.json       # Ledger storing all download/upload records
│   └── downloads/      # Temporary download folder for aria2c
├── .env                # Environment secrets
├── .gitignore          # Version control ignore rules
├── server.js           # Main Express server entry point
└── package.json

```

### 4.2 Data Schema (`data/files.json`)

```json
[
  {
    "id": "gt_17112026_001",
    "filename": "archive_sample.zip",
    "gofile_id": "c8a1d2e0",
    "download_url": "https://gofile.io/d/c8a1d2e0",
    "admin_code": "adm_x89f2a",
    "created_at": "2026-07-24T00:00:00.000Z",
    "last_touched": "2026-07-24T00:00:00.000Z",
    "status": "LIVE"
  }
]

```

---

## 5. Environment & Git Configuration

### 5.1 Environment Variables (`.env`)

```env
PORT=6258
ADMIN_PIN=123456
ARIA2_RPC_URL=http://127.0.0.1:6800/jsonrpc
ARIA2_RPC_SECRET=your_aria2_secret_here
GOFILE_API_TOKEN=your_optional_gofile_token
DATA_DIR=./data

```

### 5.2 Version Control Ignoring (`.gitignore`)

To ensure sensitive data, local downloads, and database records remain private and uncommitted, the project uses the following `.gitignore` rules:

```gitignore
# Dependency & Build Artifacts
node_modules/
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# Environment & Credentials
.env
.env.local
.env.production

# Local Data Storage & Downloads
data/
downloads/
temp/

# OS/Editor Files
.DS_Store
Thumbs.db
.vscode/
.idea/

```

---

## 6. User Interface Specifications

The frontend will consist of a clean, single-page application served directly by Node.js.

* **Login Gateway:** Simple PIN keypad or password box. Blocks access to dashboard endpoints until authenticated.
* **Submission Panel:** Input box for adding new download URLs, displaying active `aria2c` progress bars (percentage, download speed, status).
* **File Management Ledger:** Interactive list loaded from `data/files.json`.
* **Columns:** Filename, GoFile Download Link, Status (`LIVE` / `DEAD`), Last Touched Date.
* **Actions:** Manual "Touch Now" trigger and a "Copy Link" button.