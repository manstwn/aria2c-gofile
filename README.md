# 🚀 GoTouch Manager (`aria2c-gofile`)

> **Automated Dual-Stage Remote Downloader & GoFile Retention Manager with Full Metadata Telemetry.**

GoTouch Manager seamlessly bridges high-speed multi-connection `aria2c` remote downloading with live streaming uploads to **GoFile**. It automatically extracts multimedia metadata (resolution, dimensions, duration, format signatures) and features an automated daily touch scheduler to reset GoFile inactivity timers, keeping your cloud files permanently active!

---

## ✨ Features

- ⚡ **16-Connection High-Speed Downloading (`aria2c`):** Dual local Windows & VPS Linux auto-daemon spawning.
- ☁️ **Live GoFile Upload Telemetry:** Real-time chunk-by-chunk streaming upload progress bar (`0.0%` ➔ `100.0%`), uploaded byte counters, and live upload speed (`⚡ MB/s`).
- 🔍 **Automated Metadata Extraction:** Binary magic byte header inspection auto-detects formats (`MP4`, `MOV`, `WEBM`, `MKV`, `PNG`, `JPG`, `GIF`, `WEBP`) and extracts video resolutions (e.g., `1280x720`), image dimensions, and media duration.
- 🏷️ **Dual-Name Tracking:** Supports optional custom display titles while preserving the original downloaded filename from remote servers.
- ⚡ **GoTouch Daily Scheduler:** Daily cron daemon (`0 0 * * *`) with randomized rate-limited pings to reset GoFile inactivity expiration countdowns.
- 🔍 **Interactive Metadata Inspector:** Spacious 760px dashboard modal to inspect full file specs, retention status, GoFile admin codes, and UTC timestamps.
- 🔒 **PIN Authentication Overlay:** JWT-backed PIN access control.
- 🧹 **Automatic Storage Cleanup:** Guaranteed removal of local temporary download files and `.aria2` control files upon upload completion or task cancellation.

---

## 🛠️ Quick Start

### 1. Installation
```bash
# Clone the repository
git clone https://github.com/manstwn/aria2c-gofile.git
cd aria2c-gofile

# Install dependencies
npm install
```

### 2. Environment Configuration
Copy `.env.example` to `.env` and configure your environment variables:
```bash
cp .env.example .env
```

Edit `.env`:
```env
PORT=6258
ADMIN_PIN=3331
GOFILE_API_TOKEN=your_gofile_api_token_here
AUTO_START_ARIA2=true
ARIA2_PATH=C:\Program Portable\aria2c\aria2c.exe
```

### 3. Run the Server
```bash
node server.js
```
Open **`http://localhost:6258`** in your browser!

---

## 🚀 Deployment (VPS Linux)

For Linux VPS deployment:
```bash
sudo apt update && sudo apt install -y aria2
export ARIA2_PATH=/usr/bin/aria2c
node server.js
```

---

## 📜 License
MIT License
