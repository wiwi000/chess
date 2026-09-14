'use strict';

let isEnabled = false;
let pollTimer = null;

const $status      = document.getElementById('status');
const $colorBadge  = document.getElementById('colorBadge');
const $colorIcon   = document.getElementById('colorIcon');
const $colorText   = document.getElementById('colorText');
const $engineState = document.getElementById('engineState');
const $depthDisp   = document.getElementById('depthDisplay');
const $redCount    = document.getElementById('redCount');
const $blkCount    = document.getElementById('blkCount');
const $moveFrom    = document.getElementById('moveFrom');
const $moveTo      = document.getElementById('moveTo');
const $captureTag  = document.getElementById('captureTag');
const $moveDesc    = document.getElementById('moveDesc');
const $toggle      = document.getElementById('toggleBtn');
const $now         = document.getElementById('nowBtn');
const $reset       = document.getElementById('resetBtn');
const $depthSel    = document.getElementById('depthSel');
const $colorSel    = document.getElementById('colorSel');

/* ── Piece data ── */
const PIECE_DATA = {
  R_KING:     { vi: 'Tướng', zh: '帅', red: true  },
  R_ADVISOR:  { vi: 'Sĩ',    zh: '仕', red: true  },
  R_ELEPHANT: { vi: 'Tượng', zh: '相', red: true  },
  R_HORSE:    { vi: 'Mã',    zh: '傌', red: true  },
  R_CHARIOT:  { vi: 'Xe',    zh: '俥', red: true  },
  R_CANNON:   { vi: 'Pháo',  zh: '炮', red: true  },
  R_PAWN:     { vi: 'Tốt',   zh: '兵', red: true  },
  B_KING:     { vi: 'Tướng', zh: '将', red: false },
  B_ADVISOR:  { vi: 'Sĩ',    zh: '士', red: false },
  B_ELEPHANT: { vi: 'Tượng', zh: '象', red: false },
  B_HORSE:    { vi: 'Mã',    zh: '馬', red: false },
  B_CHARIOT:  { vi: 'Xe',    zh: '車', red: false },
  B_CANNON:   { vi: 'Pháo',  zh: '炮', red: false },
  B_PAWN:     { vi: 'Tốt',   zh: '卒', red: false },
};

function pieceSvgHtml(zh, isRed, size = 38) {
  const fill   = isRed ? '#c84b31' : '#2a2a2a';
  const stroke = isRed ? '#e0795c' : '#666';
  const ring   = isRed ? 'rgba(255,200,150,0.35)' : 'rgba(200,200,200,0.2)';
  return `<svg viewBox="0 0 40 40" width="${size}" height="${size}">
    <circle cx="20" cy="20" r="18" fill="${fill}" stroke="${stroke}" stroke-width="2.5"/>
    <circle cx="20" cy="20" r="13" fill="none" stroke="${ring}" stroke-width="1.5"/>
    <text x="20" y="27" text-anchor="middle" fill="#fff" font-size="16" font-family="serif" font-weight="bold">${zh}</text>
  </svg>`;
}

function emptySquareSvg(size = 38) {
  return `<svg viewBox="0 0 40 40" width="${size}" height="${size}">
    <circle cx="20" cy="20" r="17" fill="none" stroke="#252540" stroke-width="1.5" stroke-dasharray="4,3"/>
  </svg>`;
}

function colorKingSvg(isRed) {
  const fill   = isRed ? '#c84b31' : '#2a2a2a';
  const stroke = isRed ? '#e0795c' : '#666';
  const ring   = isRed ? 'rgba(255,200,150,0.35)' : 'rgba(200,200,200,0.2)';
  const zh     = isRed ? '帅' : '将';
  return `<circle cx="20" cy="20" r="18" fill="${fill}" stroke="${stroke}" stroke-width="2.5"/>
    <circle cx="20" cy="20" r="13" fill="none" stroke="${ring}" stroke-width="1.5"/>
    <text x="20" y="27" text-anchor="middle" fill="#fff" font-size="15" font-family="serif" font-weight="bold">${zh}</text>`;
}

/* ── Coord format ── */
function coordStr(row, col) {
  const cols = 'abcdefghi';
  return cols[col] + (10 - row);
}

/* ── Messaging ── */
function sendToContent(type, data = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { target: 'content', type, ...data },
      (resp) => {
        if (chrome.runtime.lastError) resolve(null);
        else resolve(resp);
      }
    );
  });
}

/* ── Move piece panel ── */
function renderPieceCell(container, pieceInfo, row, col) {
  if (!pieceInfo) {
    container.innerHTML = `
      <div class="piece-icon">${emptySquareSvg()}</div>
      <div class="piece-label" style="color:#333">Ô trống</div>
      <div class="piece-coord">—</div>`;
    container.className = 'move-piece';
    return;
  }
  const sideClass = pieceInfo.red ? 'piece-side-red' : 'piece-side-blk';
  const sideName  = pieceInfo.red ? 'Đỏ' : 'Đen';
  container.innerHTML = `
    <div class="piece-icon">${pieceSvgHtml(pieceInfo.zh, pieceInfo.red)}</div>
    <div class="piece-label">${pieceInfo.vi} ${sideName}</div>
    <div class="piece-coord">${coordStr(row, col)}</div>`;
  container.className = `move-piece ${sideClass}`;
}

function updateMoveFrame(detail) {
  if (!detail) {
    renderPieceCell($moveFrom, null, 0, 0);
    renderPieceCell($moveTo,   null, 0, 0);
    $captureTag.style.display = 'none';
    $moveDesc.textContent = 'Chưa có nước gợi ý';

    // Dim arrow
    const arrowSvg = document.querySelector('.arrow-svg');
    if (arrowSvg) {
      arrowSvg.querySelectorAll('line, polygon').forEach(el => {
        el.setAttribute('stroke', '#252540');
        el.setAttribute('fill', '#252540');
      });
    }
    return;
  }

  const { from, to, captured, fromCoord, toCoord } = detail;

  renderPieceCell($moveFrom, from ? PIECE_DATA[from.key] : null,
    from ? from.row : 0, from ? from.col : 0);

  // "to" shows the captured piece (if any) or empty square
  renderPieceCell($moveTo, captured ? PIECE_DATA[captured.key] : null,
    to ? to.row : 0, to ? to.col : 0);

  const isCapture = !!captured;
  $captureTag.style.display = isCapture ? 'inline-block' : 'none';

  // Arrow color
  const arrowColor = isCapture ? '#c84b31' : '#2ecc71';
  const arrowSvg = document.querySelector('.arrow-svg');
  if (arrowSvg) {
    arrowSvg.querySelectorAll('line').forEach(el => {
      el.setAttribute('stroke', arrowColor);
    });
    arrowSvg.querySelectorAll('polygon').forEach(el => {
      el.setAttribute('fill', arrowColor);
    });
    arrowSvg.style.opacity = '1';
  }

  // Description
  if (from) {
    const fromPd = PIECE_DATA[from.key];
    const sideName = fromPd ? (fromPd.red ? 'Đỏ' : 'Đen') : '';
    const pieceName = fromPd ? fromPd.vi : '?';
    const fc = fromCoord || '?';
    const tc = toCoord   || '?';
    if (isCapture) {
      const capPd = PIECE_DATA[captured.key];
      const capName = capPd ? capPd.vi : '?';
      const capSide = capPd ? (capPd.red ? 'Đỏ' : 'Đen') : '';
      $moveDesc.textContent = `${pieceName} ${sideName} (${fc}) ăn ${capName} ${capSide} (${tc})`;
    } else {
      $moveDesc.textContent = `${pieceName} ${sideName}: ${fc} → ${tc}`;
    }
  } else {
    $moveDesc.textContent = '—';
  }
}

/* ── Main UI update ── */
function updateUI(resp) {
  if (!resp || !resp.ok) {
    $status.textContent   = 'KHÔNG TRÊN TRANG GAME';
    $status.className     = 'val warn';
    $colorText.textContent = '—';
    $colorIcon.style.display = 'none';
    $engineState.textContent = '—';
    $engineState.className   = 'val dim';
    $redCount.textContent = '0';
    $blkCount.textContent = '0';
    $toggle.disabled  = true;
    $toggle.textContent = '▶ BẬT HIGHLIGHT';
    $toggle.className = 'off';
    $now.disabled = true;
    isEnabled = false;
    updateMoveFrame(null);
    return;
  }

  $toggle.disabled = false;
  isEnabled = resp.enabled;

  // Status
  if (resp.enabled) {
    $status.textContent = resp.computing ? '◉ ĐANG TÍNH' : '◉ ACTIVE';
    $status.className   = 'val green' + (resp.computing ? ' blink' : '');
  } else {
    $status.textContent = 'IDLE';
    $status.className   = 'val dim';
  }

  // Color badge
  if (resp.color === 'RED' || resp.color === 'BLACK') {
    const isRed = resp.color === 'RED';
    $colorIcon.innerHTML = colorKingSvg(isRed);
    $colorIcon.setAttribute('viewBox', '0 0 40 40');
    $colorIcon.style.display = 'inline';
    $colorText.textContent = isRed ? 'Đỏ (Red)' : 'Đen (Black)';
    $colorText.className   = 'val ' + (isRed ? '' : 'dim');
    $colorText.style.color = isRed ? '#e0795c' : '#aaa';
    $colorSel.value = isRed ? 'red' : 'black';
  } else {
    $colorIcon.style.display = 'none';
    $colorText.textContent = 'Tự động';
    $colorText.className   = 'val dim';
    $colorText.style.color = '';
    $colorSel.value = 'auto';
  }

  // Engine
  $engineState.textContent = resp.computing ? 'ĐANG TÍNH...' : 'IDLE';
  $engineState.className   = 'val ' + (resp.computing ? 'green blink' : 'dim');

  // Depth display
  $depthDisp.textContent = resp.depth > 0 ? 'Depth ' + resp.depth : 'Movetime 3s';

  // Piece counts
  $redCount.textContent = resp.redCount || 0;
  $blkCount.textContent = resp.blkCount || 0;

  // Move info frame
  updateMoveFrame(resp.lastMoveDetail || null);

  // Buttons
  $toggle.textContent = resp.enabled ? '⏹ TẮT HIGHLIGHT' : '▶ BẬT HIGHLIGHT';
  $toggle.className   = resp.enabled ? 'on' : 'off';
  $now.disabled       = !resp.enabled || resp.computing;
}

async function refresh() {
  const resp = await sendToContent('BOT_STATUS');
  updateUI(resp);
}

/* ── Depth selector ── */
$depthSel.addEventListener('change', async () => {
  const d = parseInt($depthSel.value, 10);
  $depthDisp.textContent = d > 0 ? 'Depth ' + d : 'Movetime 3s';
  await sendToContent('SET_DEPTH', { depth: d });
  chrome.storage.local.set({ depth: d });
});

/* ── Color selector ── */
$colorSel.addEventListener('change', async () => {
  await sendToContent('SET_COLOR', { color: $colorSel.value });
  await new Promise(r => setTimeout(r, 200));
  await refresh();
});

/* ── Toggle ── */
$toggle.addEventListener('click', async () => {
  $toggle.disabled = true;
  $now.disabled    = true;
  const type = isEnabled ? 'HIGHLIGHT_DISABLE' : 'HIGHLIGHT_ENABLE';
  await sendToContent(type);
  await new Promise(r => setTimeout(r, 600));
  await refresh();
});

/* ── Now ── */
$now.addEventListener('click', async () => {
  $now.disabled = true;
  await sendToContent('HIGHLIGHT_NOW');
  await new Promise(r => setTimeout(r, 300));
  await refresh();
});

/* ── Reset ── */
$reset.addEventListener('click', async () => {
  await sendToContent('BOT_RESET');
  await new Promise(r => setTimeout(r, 300));
  await refresh();
});

/* ── Init: load saved depth ── */
chrome.storage.local.get(['depth'], (data) => {
  const d = data.depth !== undefined ? data.depth : 15;
  $depthSel.value = String(d);
  $depthDisp.textContent = d > 0 ? 'Depth ' + d : 'Movetime 3s';
  sendToContent('SET_DEPTH', { depth: d });
});

refresh();
pollTimer = setInterval(refresh, 1500);
window.addEventListener('unload', () => clearInterval(pollTimer));
