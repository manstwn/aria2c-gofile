let currentPin = '';
let ledgerFiles = [];
let activeFilter = 'ALL';
let pollInterval = null;

document.addEventListener('DOMContentLoaded', () => {
  checkAuth();
});

/* ==========================================================================
   AUTHENTICATION LOGIC
   ========================================================================== */

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/check');
    if (res.ok) {
      const data = await res.json();
      if (data.authenticated) {
        showDashboard();
        return;
      }
    }
  } catch (err) {
    console.error('Auth check error:', err);
  }
  showLogin();
}

function showLogin() {
  document.getElementById('authOverlay').classList.remove('hidden');
  document.getElementById('mainDashboard').classList.add('hidden');
  disconnectSSE();
  clearPin();
}

function showDashboard() {
  document.getElementById('authOverlay').classList.add('hidden');
  document.getElementById('mainDashboard').classList.remove('hidden');

  fetchDownloads();
  fetchFiles();
  connectSSE();

  // Fast 1s polling interval for guaranteed live progress updates
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(() => {
    fetchDownloads();
  }, 1000);
}

let eventSource = null;

function connectSSE() {
  if (eventSource) eventSource.close();

  eventSource = new EventSource('/api/stream');

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);

      if (data.conn) {
        const badge = document.getElementById('aria2StatusBadge');
        const badgeText = document.getElementById('aria2StatusText');
        const dot = badge ? badge.querySelector('.status-dot') : null;

        if (badge && dot) {
          if (data.conn.online) {
            dot.className = 'status-dot online';
            badgeText.textContent = `Aria2 RPC v${data.conn.version}`;
          } else {
            dot.className = 'status-dot offline';
            badgeText.textContent = 'Aria2 Offline';
          }
        }
      }

      if (data.downloads) {
        renderActiveDownloads(data.downloads);
      }

      if (data.files) {
        ledgerFiles = data.files;
        renderLedger();
      }
    } catch (e) {
      console.error('Error parsing SSE event:', e);
    }
  };

  eventSource.onerror = () => {
    // Fallback polling if SSE drops
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(() => {
      fetchDownloads();
      fetchFiles();
    }, 3000);
  };
}

function disconnectSSE() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

function updatePinDots() {
  const dots = document.querySelectorAll('.pin-dots .dot');
  dots.forEach((dot, index) => {
    if (index < currentPin.length) {
      dot.classList.add('filled');
    } else {
      dot.classList.remove('filled');
    }
  });
  document.getElementById('pinInput').value = currentPin;
}

function appendPin(digit) {
  if (currentPin.length < 12) {
    currentPin += digit;
    updatePinDots();
  }
}

function clearPin() {
  currentPin = '';
  updatePinDots();
  document.getElementById('authError').classList.add('hidden');
}

async function handlePinSubmit(e) {
  if (e) e.preventDefault();
  if (!currentPin) return;

  const errorEl = document.getElementById('authError');
  errorEl.classList.add('hidden');

  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: currentPin })
    });

    const data = await res.json();
    if (res.ok && data.success) {
      showDashboard();
    } else {
      errorEl.textContent = data.error || 'Invalid PIN code.';
      errorEl.classList.remove('hidden');
      clearPin();
    }
  } catch (err) {
    errorEl.textContent = 'Connection error. Please try again.';
    errorEl.classList.remove('hidden');
  }
}

async function handleLogout() {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch (err) {}
  showLogin();
}

/* ==========================================================================
   DOWNLOAD TASK SUBMISSION & MONITORING
   ========================================================================== */

async function handleDownloadSubmit(e) {
  e.preventDefault();
  const inputUrl = document.getElementById('downloadUrlInput');
  const inputName = document.getElementById('customFilenameInput');
  const btn = document.getElementById('btnSubmitDownload');

  const url = inputUrl.value.trim();
  const filename = inputName ? inputName.value.trim() : '';

  if (!url) return;

  btn.disabled = true;
  btn.innerHTML = 'Submitting...';

  try {
    const res = await fetch('/api/downloads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, filename })
    });

    const data = await res.json();
    if (res.ok && data.success) {
      showToast('Download task started (16 connections enforced)', 'success');
      inputUrl.value = '';
      if (inputName) inputName.value = '';
      fetchDownloads();
    } else {
      showToast(data.error || 'Failed to submit download task', 'error');
    }
  } catch (err) {
    showToast('Network error while submitting URL', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg> Start Download`;
  }
}

async function fetchDownloads() {
  try {
    const res = await fetch('/api/downloads');
    if (res.status === 401) {
      showLogin();
      return;
    }
    const data = await res.json();

    // Update Aria2 status badge
    const badge = document.getElementById('aria2StatusBadge');
    const badgeText = document.getElementById('aria2StatusText');
    const dot = badge.querySelector('.status-dot');

    if (data.aria2Connection && data.aria2Connection.online) {
      dot.className = 'status-dot online';
      badgeText.textContent = `Aria2 RPC v${data.aria2Connection.version}`;
    } else {
      dot.className = 'status-dot offline';
      badgeText.textContent = 'Aria2 Offline';
    }

    renderActiveDownloads(data.downloads || []);
  } catch (err) {
    console.error('Error fetching downloads:', err);
  }
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function renderActiveDownloads(downloads) {
  const listEl = document.getElementById('activeDownloadsList');
  const emptyState = document.getElementById('downloadsEmptyState');

  if (!listEl || !emptyState) return;

  const activeTasks = downloads.filter(t => t.status !== 'UPLOADED');

  if (!activeTasks || activeTasks.length === 0) {
    listEl.innerHTML = '';
    emptyState.classList.remove('hidden');
    return;
  }

  emptyState.classList.add('hidden');

  const itemsHTML = activeTasks.map(task => {
    const speed = task.downloadSpeed ? `${formatBytes(task.downloadSpeed)}/s` : '0 B/s';
    const downloadedStr = formatBytes(task.completedLength || 0);
    const totalStr = formatBytes(task.totalLength || 0);
    const isUploading = task.status === 'UPLOADING';
    const isFailed = task.status === 'UPLOAD_FAILED' || task.status === 'error';

    let statusTag = `<span class="tech-tag">${task.status.toUpperCase()}</span>`;
    if (isUploading) {
      statusTag = `<span class="tech-tag" style="background: rgba(245,158,11,0.2); color: #f59e0b;">UPLOADING TO GOFILE...</span>`;
    } else if (isFailed) {
      statusTag = `<span class="tech-tag" style="background: rgba(239,68,68,0.2); color: #f87171;">FAILED</span>`;
    }

    const errorDetailsHTML = isFailed && task.errorMessage ? `
      <div style="margin-top: 8px; font-size: 0.8rem; color: #f87171; background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.2); padding: 6px 10px; border-radius: 6px;">
        ⚠️ <strong>Error Mitigation Report:</strong> ${escapeHtml(task.errorMessage)}
      </div>
    ` : '';

    // Stage 1: Downloading phase
    const downloadStageHTML = !isUploading ? `
      <div class="download-stats">
        <span>Aria2 Download: <strong>${task.progress}%</strong></span>
        <span>Downloaded: ${downloadedStr} / ${totalStr}</span>
        <span>Speed: ⚡ <strong>${speed}</strong></span>
      </div>
      <div class="progress-bar-bg" style="margin-top: 10px;">
        <div class="progress-bar-fill" style="width: ${task.progress}%"></div>
      </div>
    ` : '';

    // Stage 2: Uploading phase
    const uploadStageHTML = isUploading ? `
      <div class="download-stats" style="color: #f59e0b; font-weight: 500;">
        <span>☁️ GoFile Upload: <strong>${task.uploadProgress || 0}%</strong></span>
        <span>Uploaded: ${formatBytes(task.uploadLoaded || 0)} / ${formatBytes(task.uploadTotal || 0)}</span>
        <span>Upload Speed: ⚡ <strong>${formatBytes(task.uploadSpeed || 0)}/s</strong></span>
      </div>
      <div class="progress-bar-bg" style="margin-top: 10px;">
        <div class="progress-bar-fill uploading" style="width: ${task.uploadProgress || 0}%"></div>
      </div>
    ` : '';

    return `
      <div class="download-item-card">
        <div class="download-item-header">
          <span class="filename-title">${escapeHtml(task.filename)}</span>
          <div style="display: flex; align-items: center; gap: 10px;">
            ${statusTag}
            <button class="btn-cancel-task" onclick="cancelDownloadTask('${task.gid}')" title="Cancel Download Task">
              ✕ Cancel
            </button>
          </div>
        </div>
        ${downloadStageHTML}
        ${uploadStageHTML}
        ${errorDetailsHTML}
      </div>
    `;
  }).join('');

  listEl.innerHTML = itemsHTML;
}

async function cancelDownloadTask(gid) {
  if (!confirm('Are you sure you want to cancel this download task?')) return;

  try {
    const res = await fetch(`/api/downloads/${gid}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast('Download task cancelled.', 'info');
      fetchDownloads();
    } else {
      showToast(data.error || 'Failed to cancel download task', 'error');
    }
  } catch (err) {
    showToast('Network error while cancelling download', 'error');
  }
}

/* ==========================================================================
   FILE MANAGEMENT LEDGER
   ========================================================================== */

async function fetchFiles() {
  try {
    const res = await fetch('/api/files');
    if (res.status === 401) {
      showLogin();
      return;
    }
    const data = await res.json();
    ledgerFiles = data.files || [];
    renderLedger();
  } catch (err) {
    console.error('Error fetching file ledger:', err);
  }
}

function setFilter(filter, el) {
  activeFilter = filter;
  document.querySelectorAll('.filter-pill').forEach(pill => pill.classList.remove('active'));
  el.classList.add('active');
  renderLedger();
}

function formatUTC(dateString) {
  if (!dateString) return 'Never';
  const d = new Date(dateString);
  if (isNaN(d.getTime())) return dateString;

  const pad = n => n < 10 ? '0' + n : n;
  const year = d.getUTCFullYear();
  const month = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const hours = pad(d.getUTCHours());
  const mins = pad(d.getUTCMinutes());
  const secs = pad(d.getUTCSeconds());

  return `${year}-${month}-${day} ${hours}:${mins}:${secs} UTC`;
}

function formatRelativeTime(dateString) {
  if (!dateString) return 'Never';
  const d = new Date(dateString);
  const now = new Date();
  const diffMs = now - d;

  if (isNaN(diffMs)) return dateString;
  if (diffMs < 0) return 'Just now';

  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffSecs < 60) {
    return 'Just now';
  } else if (diffMins < 60) {
    return `${diffMins}m ago`;
  } else if (diffHours < 24) {
    const remainingMins = diffMins % 60;
    return remainingMins > 0 ? `${diffHours}h ${remainingMins}m ago` : `${diffHours}h ago`;
  } else {
    const remainingHours = diffHours % 24;
    return remainingHours > 0 ? `${diffDays}d ${remainingHours}h ago` : `${diffDays}d ago`;
  }
}

function renderLedger() {
  const search = (document.getElementById('searchInput').value || '').toLowerCase().trim();
  const tbody = document.getElementById('ledgerTableBody');
  const emptyState = document.getElementById('ledgerEmptyState');

  // Update counts
  const totalCount = ledgerFiles.length;
  const liveCount = ledgerFiles.filter(f => f.status === 'LIVE').length;
  const deadCount = ledgerFiles.filter(f => f.status === 'DEAD').length;

  document.getElementById('statLiveCount').textContent = liveCount;
  document.getElementById('countAll').textContent = totalCount;
  document.getElementById('countLive').textContent = liveCount;
  document.getElementById('countDead').textContent = deadCount;

  // Filter items
  const filtered = ledgerFiles.filter(file => {
    const matchesFilter = activeFilter === 'ALL' || file.status === activeFilter;
    const matchesSearch = !search ||
      file.filename.toLowerCase().includes(search) ||
      file.id.toLowerCase().includes(search) ||
      file.download_url.toLowerCase().includes(search);
    return matchesFilter && matchesSearch;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = '';
    emptyState.classList.remove('hidden');
    return;
  }

  emptyState.classList.add('hidden');

  tbody.innerHTML = filtered.map(file => {
    const isLive = file.status === 'LIVE';
    const statusBadge = isLive
      ? `<span class="badge-status live"><span class="status-dot online"></span> LIVE</span>`
      : `<span class="badge-status dead"><span class="status-dot offline"></span> DEAD</span>`;

    const lastTouchedRel = formatRelativeTime(file.last_touched);
    const createdAtRel = formatRelativeTime(file.created_at);
    const lastTouchedUTC = formatUTC(file.last_touched);
    const createdAtUTC = formatUTC(file.created_at);

    const meta = file.metadata || {};
    const cat = meta.category || 'file';
    const catIcon = cat === 'video' ? '🎬' : cat === 'image' ? '🖼️' : cat === 'audio' ? '🎵' : cat === 'archive' ? '📦' : '📄';

    let metaPills = [];
    if (meta.size_formatted && meta.size_formatted !== 'N/A') {
      metaPills.push(`<span class="meta-pill size">💾 ${escapeHtml(meta.size_formatted)}</span>`);
    } else if (meta.size_bytes > 0) {
      metaPills.push(`<span class="meta-pill size">💾 ${formatBytes(meta.size_bytes)}</span>`);
    }

    if (meta.resolution) {
      metaPills.push(`<span class="meta-pill res">📐 ${escapeHtml(meta.resolution)}</span>`);
    }

    if (meta.duration_formatted) {
      metaPills.push(`<span class="meta-pill duration">⏱️ ${escapeHtml(meta.duration_formatted)}</span>`);
    }

    if (file.source_url) {
      metaPills.push(`<a href="${escapeHtml(file.source_url)}" target="_blank" rel="noopener" class="meta-pill source" title="${escapeHtml(file.source_url)}">🌐 Source Link</a>`);
    }

    const displayName = file.custom_name || file.filename;
    const originalName = file.original_filename || file.filename;

    const originalRow = (originalName && originalName !== displayName)
      ? `<div class="original-name-row" title="Original Download Filename">📁 Original: ${escapeHtml(originalName)}</div>`
      : `<div class="original-name-row" title="Downloaded Filename">📁 Original: ${escapeHtml(originalName)}</div>`;

    const galleryBtn = (file.thumbnails && file.thumbnails.length > 0)
      ? `<button class="btn-table-action info" onclick="openGalleryModal('${file.id}')" title="View 15-Frame Screenshot Gallery (${file.thumbnails.length} frames)">🖼️ Gallery</button>`
      : '';

    return `
      <tr>
        <td class="filename-cell">
          <div class="file-title-row">
            <span class="cat-icon">${catIcon}</span>
            <span class="file-name-text">${escapeHtml(displayName)}</span>
          </div>
          ${originalRow}
        </td>
        <td class="link-cell">
          ${file.download_url ? `
            <div class="gofile-link-badge">
              <a href="${escapeHtml(file.download_url)}" target="_blank" rel="noopener">${escapeHtml(file.download_url)}</a>
              <button class="btn-copy-mini" onclick="copyToClipboard('${escapeHtml(file.download_url)}')" title="Copy GoFile Link">📋</button>
            </div>
          ` : '<span class="text-muted">N/A</span>'}
        </td>
        <td>${statusBadge}</td>
        <td><small class="utc-date-text" title="UTC: ${escapeHtml(lastTouchedUTC)}">${escapeHtml(lastTouchedRel)}</small></td>
        <td><small class="utc-date-text" title="UTC: ${escapeHtml(createdAtUTC)}">${escapeHtml(createdAtRel)}</small></td>
        <td class="text-right">
          <div class="action-buttons">
            ${galleryBtn}
            <button class="btn-table-action primary" onclick="showFileMetadata('${file.id}')" title="View Full File Metadata">🔍 Meta</button>
            <button class="btn-table-action" onclick="copyToClipboard('${escapeHtml(file.download_url)}')" title="Copy GoFile Link">📋 Copy</button>
            <button class="btn-table-action success" onclick="triggerSingleTouch('${file.id}')" title="Ping GoFile link now">⚡ Touch</button>
            <button class="btn-table-action danger" onclick="deleteRecord('${file.id}')" title="Delete ledger entry">🗑️</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

/* ==========================================================================
   METADATA INSPECTOR MODAL HANDLERS
   ========================================================================== */

function showFileMetadata(id) {
  const file = ledgerFiles.find(f => f.id === id);
  if (!file) return;

  const meta = file.metadata || {};
  const cat = meta.category || 'file';
  const catIcon = cat === 'video' ? '🎬' : cat === 'image' ? '🖼️' : cat === 'audio' ? '🎵' : cat === 'archive' ? '📦' : '📄';

  const displayName = file.custom_name || file.filename;
  const originalName = file.original_filename || file.filename;

  document.getElementById('metaCategoryIcon').textContent = catIcon;
  document.getElementById('metaModalTitle').textContent = displayName;
  document.getElementById('metaModalSub').textContent = `Record ID: ${file.id}`;

  const body = document.getElementById('metaModalBody');

  body.innerHTML = `
    <div class="meta-item span-2">
      <span class="meta-label">Display Name ${file.custom_name ? '(Custom)' : ''}</span>
      <div class="meta-value" style="font-size: 1.05rem; color: #fff;">${escapeHtml(displayName)}</div>
    </div>

    <div class="meta-item">
      <span class="meta-label">Original Download Filename</span>
      <div class="meta-value mono" style="color: #cbd5e1;">📁 ${escapeHtml(originalName)}</div>
    </div>

    <div class="meta-item">
      <span class="meta-label">Format & Category</span>
      <div class="meta-value" style="text-transform: uppercase;">${catIcon} ${escapeHtml(meta.extension || 'N/A')} (${cat})</div>
    </div>

    <div class="meta-item">
      <span class="meta-label">File Size</span>
      <div class="meta-value" style="color: #60a5fa;">💾 ${escapeHtml(meta.size_formatted || formatBytes(meta.size_bytes || 0))}</div>
    </div>

    <div class="meta-item">
      <span class="meta-label">Resolution / Dimensions</span>
      <div class="meta-value" style="color: #22d3ee;">${meta.resolution ? `📐 ${escapeHtml(meta.resolution)}` : '<span style="color:#64748b;">N/A</span>'}</div>
    </div>

    <div class="meta-item">
      <span class="meta-label">Media Duration</span>
      <div class="meta-value" style="color: #fbbf24;">${meta.duration_formatted ? `⏱️ ${escapeHtml(meta.duration_formatted)}` : '<span style="color:#64748b;">N/A</span>'}</div>
    </div>

    <div class="meta-item span-2">
      <span class="meta-label">GoFile Download Link</span>
      <div class="meta-value mono"><a href="${escapeHtml(file.download_url)}" target="_blank" rel="noopener" style="color:#3b82f6;">${escapeHtml(file.download_url)}</a></div>
    </div>

    <div class="meta-item">
      <span class="meta-label">GoFile Status</span>
      <div class="meta-value">${file.status === 'LIVE' ? '<span style="color:#34d399;">🟢 LIVE</span>' : '<span style="color:#f87171;">🔴 DEAD</span>'}</div>
    </div>

    ${file.source_url ? `
    <div class="meta-item full-width">
      <span class="meta-label">Original Remote Source URL</span>
      <div class="meta-value mono"><a href="${escapeHtml(file.source_url)}" target="_blank" rel="noopener" style="color:#9ca3af; text-decoration:underline;">${escapeHtml(file.source_url)}</a></div>
    </div>
    ` : ''}

    <div class="meta-item">
      <span class="meta-label">GoFile Admin Code</span>
      <div class="meta-value mono">${escapeHtml(file.admin_code || 'N/A')}</div>
    </div>

    <div class="meta-item">
      <span class="meta-label">Created Date (UTC)</span>
      <div class="meta-value mono" style="font-size:0.8rem;">${formatUTC(file.created_at)}</div>
    </div>

    <div class="meta-item">
      <span class="meta-label">Last Touched Date (UTC)</span>
      <div class="meta-value mono" style="font-size:0.8rem;">${formatUTC(file.last_touched)}</div>
    </div>

    ${(file.thumbnails && file.thumbnails.length > 0) ? `
    <div class="meta-item full-width" style="margin-top: 6px;">
      <span class="meta-label">🖼️ Screenshot Frame Gallery (${file.thumbnails.length} frames)</span>
      <div class="thumb-gallery-grid">
        ${file.thumbnails.map((tUrl, idx) => `
          <a href="${tUrl}" target="_blank" class="thumb-card" title="Frame ${idx + 1}">
            <img src="${tUrl}" alt="Frame ${idx + 1}" loading="lazy" />
            <span class="thumb-badge">#${idx + 1}</span>
          </a>
        `).join('')}
      </div>
    </div>
    ` : ''}
  `;

  document.getElementById('metaBtnTouch').onclick = () => { triggerSingleTouch(file.id); };
  document.getElementById('metaBtnCopyGoFile').onclick = () => { copyToClipboard(file.download_url); };

  document.getElementById('metadataModal').classList.remove('hidden');
}

function closeMetadataModal() {
  document.getElementById('metadataModal').classList.add('hidden');
}

async function triggerSingleTouch(id) {
  try {
    showToast('Pinging file download page...', 'info');
    const res = await fetch(`/api/files/${id}/touch`, { method: 'POST' });
    const data = await res.json();
    if (res.ok && data.success) {
      if (data.result.success) {
        showToast('Touch successful! Status: LIVE', 'success');
      } else {
        showToast(`Touch failed. Status updated to: ${data.result.status}`, 'error');
      }
      fetchFiles();
    } else {
      showToast(data.error || 'Touch trigger failed', 'error');
    }
  } catch (err) {
    showToast('Network error during touch ping', 'error');
  }
}

async function triggerTouchAll() {
  const btn = document.getElementById('btnTouchAll');
  btn.disabled = true;
  btn.textContent = 'Pinging files...';
  showToast('Initiating rate-limited Touch Manager routine...', 'info');

  try {
    const res = await fetch('/api/files/touch-all', { method: 'POST' });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast(`Touch complete. Processed ${data.count} file(s).`, 'success');
      fetchFiles();
    } else {
      showToast(data.error || 'Failed to execute touch routine', 'error');
    }
  } catch (err) {
    showToast('Network error during Touch routine', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"></path><path d="M1 20v-6h6"></path><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg> Touch All LIVE Files`;
  }
}

async function deleteRecord(id) {
  if (!confirm('Are you sure you want to delete this record from the ledger?')) return;

  try {
    const res = await fetch(`/api/files/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok && data.success) {
      showToast('Record deleted.', 'success');
      fetchFiles();
    } else {
      showToast(data.error || 'Failed to delete record', 'error');
    }
  } catch (err) {
    showToast('Network error deleting record', 'error');
  }
}

/* ==========================================================================
   UTILITY FUNCTIONS
   ========================================================================== */

function copyToClipboard(text) {
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    showToast('GoFile link copied to clipboard!', 'success');
  }).catch(() => {
    showToast('Failed to copy link', 'error');
  });
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(30px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>"']/g, match => {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return map[match];
  });
}

/* ==========================================================================
   GALLERY LIGHTBOX MODAL HANDLERS
   ========================================================================== */

let activeGalleryImages = [];
let currentGalleryIndex = 0;

function openGalleryModal(id) {
  const file = ledgerFiles.find(f => f.id === id);
  if (!file || !file.thumbnails || file.thumbnails.length === 0) {
    showToast('No screenshot thumbnails available for this file', 'info');
    return;
  }

  activeGalleryImages = file.thumbnails;
  currentGalleryIndex = 0;

  const displayName = file.custom_name || file.filename;
  document.getElementById('galleryModalTitle').textContent = `${displayName} — Screenshot Gallery`;

  renderGalleryState();
  document.getElementById('galleryModal').classList.remove('hidden');
}

function renderGalleryState() {
  if (!activeGalleryImages || activeGalleryImages.length === 0) return;

  const total = activeGalleryImages.length;
  document.getElementById('galleryModalSub').textContent = `Frame ${currentGalleryIndex + 1} of ${total}`;
  document.getElementById('galleryMainImage').src = activeGalleryImages[currentGalleryIndex];

  const strip = document.getElementById('galleryThumbStrip');
  strip.innerHTML = activeGalleryImages.map((tUrl, idx) => `
    <div class="gallery-thumb-item ${idx === currentGalleryIndex ? 'active' : ''}" onclick="setGalleryIndex(${idx})">
      <img src="${tUrl}" alt="Thumb ${idx + 1}" />
    </div>
  `).join('');
}

function setGalleryIndex(index) {
  if (index >= 0 && index < activeGalleryImages.length) {
    currentGalleryIndex = index;
    renderGalleryState();
  }
}

function prevGalleryImage() {
  if (activeGalleryImages.length === 0) return;
  currentGalleryIndex = (currentGalleryIndex - 1 + activeGalleryImages.length) % activeGalleryImages.length;
  renderGalleryState();
}

function nextGalleryImage() {
  if (activeGalleryImages.length === 0) return;
  currentGalleryIndex = (currentGalleryIndex + 1) % activeGalleryImages.length;
  renderGalleryState();
}

function closeGalleryModal() {
  document.getElementById('galleryModal').classList.add('hidden');
}

// Keyboard arrow key navigation support for Gallery Modal
document.addEventListener('keydown', (e) => {
  const modal = document.getElementById('galleryModal');
  if (modal && !modal.classList.contains('hidden')) {
    if (e.key === 'ArrowLeft') prevGalleryImage();
    if (e.key === 'ArrowRight') nextGalleryImage();
    if (e.key === 'Escape') closeGalleryModal();
  }
});
