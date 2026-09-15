'use strict';
/* =========================================================
   XiangqiBot — Content Script v6.0.0
   Pikafish cloud engine via Cloudflare Worker

   Changes from v5.2.x:
   - Engine chuyển lên Cloudflare Worker (Pikafish WASM).
   - Không còn Offscreen Document, engine_worker.js, WASM local.
   - engineBestMove() dùng fetch() gọi thẳng CF Worker URL.
   - background.js đơn giản hơn: chỉ relay popup↔content.
   - Không còn giới hạn MV3 service worker timeout.
   ========================================================= */

/* ══════════════════════════════════════════════════════
   XQ — Inline constants + essential move helpers
   ══════════════════════════════════════════════════════ */
const XQ = (() => {
  const EMPTY=0, RED=1, BLACK=-1;
  const R_KING=1, R_ADVISOR=2, R_ELEPHANT=3, R_HORSE=4,
        R_CHARIOT=5, R_CANNON=6, R_PAWN=7;
  const B_KING=-1, B_ADVISOR=-2, B_ELEPHANT=-3, B_HORSE=-4,
        B_CHARIOT=-5, B_CANNON=-6, B_PAWN=-7;

  function pieceColor(p) { return p>0 ? RED : p<0 ? BLACK : 0; }
  function absPiece(p)   { return p < 0 ? -p : p; }
  function inBounds(r,c) { return r>=0&&r<10&&c>=0&&c<9; }
  function inRedPalace(r,c)   { return r>=7&&r<=9&&c>=3&&c<=5; }
  function inBlackPalace(r,c) { return r>=0&&r<=2&&c>=3&&c<=5; }

  function getMoves(board, r, c) {
    const piece = board[r][c]; if (!piece) return [];
    const side  = pieceColor(piece);
    const ap    = absPiece(piece);
    const moves = [];
    switch (ap) {
      case 1: { // King
        const inP = side===RED ? inRedPalace : inBlackPalace;
        for (const [dr,dc] of [[0,1],[0,-1],[1,0],[-1,0]]) {
          const tr=r+dr,tc=c+dc;
          if (inBounds(tr,tc)&&inP(tr,tc)&&pieceColor(board[tr][tc])!==side)
            moves.push([r,c,tr,tc]);
        }
        break;
      }
      case 2: { // Advisor
        const inP = side===RED ? inRedPalace : inBlackPalace;
        for (const [dr,dc] of [[1,1],[1,-1],[-1,1],[-1,-1]]) {
          const tr=r+dr,tc=c+dc;
          if (inBounds(tr,tc)&&inP(tr,tc)&&pieceColor(board[tr][tc])!==side)
            moves.push([r,c,tr,tc]);
        }
        break;
      }
      case 3: { // Elephant
        for (const [dr,dc] of [[2,2],[2,-2],[-2,2],[-2,-2]]) {
          const tr=r+dr,tc=c+dc;
          if (!inBounds(tr,tc)) continue;
          if (side===RED&&tr<5) continue;
          if (side===BLACK&&tr>4) continue;
          if (board[r+dr/2][c+dc/2]!==EMPTY) continue;
          if (pieceColor(board[tr][tc])!==side) moves.push([r,c,tr,tc]);
        }
        break;
      }
      case 4: { // Horse
        for (const [dr1,dc1,dr2,dc2] of [
          [1,0,1,1],[1,0,1,-1],[-1,0,-1,1],[-1,0,-1,-1],
          [0,1,1,1],[0,1,-1,1],[0,-1,1,-1],[0,-1,-1,-1],
        ]) {
          if (!inBounds(r+dr1,c+dc1)) continue;
          if (board[r+dr1][c+dc1]!==EMPTY) continue;
          const tr=r+dr1+dr2,tc=c+dc1+dc2;
          if (!inBounds(tr,tc)) continue;
          if (pieceColor(board[tr][tc])!==side) moves.push([r,c,tr,tc]);
        }
        break;
      }
      case 5: { // Chariot
        for (const [dr,dc] of [[0,1],[0,-1],[1,0],[-1,0]]) {
          let tr=r+dr,tc=c+dc;
          while (inBounds(tr,tc)) {
            if (board[tr][tc]!==EMPTY) {
              if (pieceColor(board[tr][tc])!==side) moves.push([r,c,tr,tc]);
              break;
            }
            moves.push([r,c,tr,tc]); tr+=dr; tc+=dc;
          }
        }
        break;
      }
      case 6: { // Cannon
        for (const [dr,dc] of [[0,1],[0,-1],[1,0],[-1,0]]) {
          let tr=r+dr,tc=c+dc,jumped=false;
          while (inBounds(tr,tc)) {
            if (!jumped) {
              if (board[tr][tc]!==EMPTY) jumped=true;
              else moves.push([r,c,tr,tc]);
            } else {
              if (board[tr][tc]!==EMPTY) {
                if (pieceColor(board[tr][tc])!==side) moves.push([r,c,tr,tc]);
                break;
              }
            }
            tr+=dr; tc+=dc;
          }
        }
        break;
      }
      case 7: { // Pawn
        const fwd = side===RED ? -1 : 1;
        const crossed = side===RED ? r<=4 : r>=5;
        const tr=r+fwd;
        if (inBounds(tr,c)&&pieceColor(board[tr][c])!==side) moves.push([r,c,tr,c]);
        if (crossed) {
          for (const dc of [-1,1])
            if (inBounds(r,c+dc)&&pieceColor(board[r][c+dc])!==side)
              moves.push([r,c,r,c+dc]);
        }
        break;
      }
    }
    return moves;
  }

  function getAllMoves(board, side) {
    const moves=[];
    for (let r=0;r<10;r++)
      for (let c=0;c<9;c++)
        if (pieceColor(board[r][c])===side)
          moves.push(...getMoves(board,r,c));
    return moves;
  }

  function makeMove(board, move) {
    const [fr,fc,tr,tc]=move;
    const nb=board.map(row=>row.slice());
    nb[tr][tc]=nb[fr][fc]; nb[fr][fc]=EMPTY;
    return {board:nb};
  }

  function findKing(board, side) {
    const kp=side===RED?R_KING:B_KING;
    for (let r=0;r<10;r++)
      for (let c=0;c<9;c++)
        if (board[r][c]===kp) return [r,c];
    return null;
  }

  function squareAttackedBy(board, r, c, bySide) {
    return getAllMoves(board,bySide).some(([,,tr,tc])=>tr===r&&tc===c);
  }

  function flyingGeneral(board) {
    let rr=-1,rc=-1,br=-1,bc=-1;
    for (let r=0;r<10;r++)
      for (let c=0;c<9;c++) {
        if (board[r][c]===R_KING){rr=r;rc=c;}
        if (board[r][c]===B_KING){br=r;bc=c;}
      }
    if (rc!==bc) return false;
    const lo=Math.min(rr,br),hi=Math.max(rr,br);
    for (let r=lo+1;r<hi;r++) if (board[r][rc]!==EMPTY) return false;
    return true;
  }

  function isInCheck(board, side) {
    const kp=findKing(board,side);
    if (!kp) return false;
    if (squareAttackedBy(board,kp[0],kp[1],-side)) return true;
    if (flyingGeneral(board)) return true;
    return false;
  }

  function isLegalMove(board, move, side) {
    const {board:nb}=makeMove(board,move);
    const kp=findKing(nb,side);
    if (!kp) return false;
    if (squareAttackedBy(nb,kp[0],kp[1],-side)) return false;
    if (flyingGeneral(nb)) return false;
    return true;
  }

  function getLegalMoves(board, side) {
    return getAllMoves(board,side).filter(m=>isLegalMove(board,m,side));
  }

  return {
    EMPTY,RED,BLACK,
    R_KING,R_ADVISOR,R_ELEPHANT,R_HORSE,R_CHARIOT,R_CANNON,R_PAWN,
    B_KING,B_ADVISOR,B_ELEPHANT,B_HORSE,B_CHARIOT,B_CANNON,B_PAWN,
    pieceColor,getMoves,getLegalMoves,makeMove,findKing,isInCheck,
  };
})();

const LOG = (...a) => console.log('[XiangqiBot]', ...a);

/* ── Piece info table ────────────────────────────────── */
const PIECE_INFO = {
  /* Red */
  [1]:  { vi: 'Tướng', zh: '帅', key: 'R_KING',     red: true  },
  [2]:  { vi: 'Sĩ',    zh: '仕', key: 'R_ADVISOR',  red: true  },
  [3]:  { vi: 'Tượng', zh: '相', key: 'R_ELEPHANT', red: true  },
  [4]:  { vi: 'Mã',    zh: '傌', key: 'R_HORSE',    red: true  },
  [5]:  { vi: 'Xe',    zh: '俥', key: 'R_CHARIOT',  red: true  },
  [6]:  { vi: 'Pháo',  zh: '炮', key: 'R_CANNON',   red: true  },
  [7]:  { vi: 'Tốt',   zh: '兵', key: 'R_PAWN',     red: true  },
  /* Black */
  [-1]: { vi: 'Tướng', zh: '将', key: 'B_KING',     red: false },
  [-2]: { vi: 'Sĩ',    zh: '士', key: 'B_ADVISOR',  red: false },
  [-3]: { vi: 'Tượng', zh: '象', key: 'B_ELEPHANT', red: false },
  [-4]: { vi: 'Mã',    zh: '馬', key: 'B_HORSE',    red: false },
  [-5]: { vi: 'Xe',    zh: '車', key: 'B_CHARIOT',  red: false },
  [-6]: { vi: 'Pháo',  zh: '炮', key: 'B_CANNON',   red: false },
  [-7]: { vi: 'Tốt',   zh: '卒', key: 'B_PAWN',     red: false },
};

function pieceSvgHtml(zh, isRed, size = 26) {
  const fill   = isRed ? '#c84b31' : '#2a2a2a';
  const stroke = isRed ? '#e0795c' : '#666';
  const ring   = isRed ? 'rgba(255,200,150,0.35)' : 'rgba(200,200,200,0.2)';
  return `<svg viewBox="0 0 40 40" width="${size}" height="${size}" style="vertical-align:middle">` +
    `<circle cx="20" cy="20" r="18" fill="${fill}" stroke="${stroke}" stroke-width="2.5"/>` +
    `<circle cx="20" cy="20" r="13" fill="none" stroke="${ring}" stroke-width="1.5"/>` +
    `<text x="20" y="27" text-anchor="middle" fill="#fff" font-size="16" font-family="serif" font-weight="bold">${zh}</text>` +
    `</svg>`;
}

/* ── Config ──────────────────────────────────────────── */
const CFG = {
  ENGINE_MODE: 'wasm', // 'wasm' chạy Pikafish trực tiếp, 'mock' dùng evaluator offline
  THINK_MS:  3000,   // movetime fallback (ms)
  DEPTH:     15,     // search depth (0 = use movetime instead)
  SETTLE_MS: 400,
  POLL_MS:   900,
};

/* ── State ───────────────────────────────────────────── */
let highlightEnabled = false;
let myColor          = null;
let lastBoardKey     = '';
let computing        = false;
let lastMove         = null;
let observer         = null;
let mutationTimer    = null;
let timerHistory     = [];

let _sqCache   = [];
let _sqCacheTs = 0;
let lastMoveDetail = null;   // { from, to, captured, fromCoord, toCoord }

/* Chống tính lại cùng vị trí + lượt */
let lastComputedKey    = '';   // boardKey + '|' + side
/* Board trước để detect lượt qua board-diff */
let prevBoardSnapshot  = null;

/* v6.1.1 FIX — Hàng đợi "bàn mới nhất" khi engine đang bận.
   Trước đây: mutation/poll bị chặn hoàn toàn bởi `computing`, nên nếu
   cloud engine tính lâu (depth cao / mạng chậm), mọi nước đi xảy ra
   trong lúc đó bị bỏ sót → highlight cũ đứng hình nhiều nước liền.
   Giờ: mọi thay đổi bàn cờ luôn được ghi nhận ngay (xoá highlight cũ +
   lưu vào pendingBoard/pendingTurn); khi engine rảnh, xử lý ngay bàn
   mới nhất thay vì chờ vòng poll kế tiếp. */
let pendingBoard = null;
let pendingTurn  = null;

/* ══════════════════════════════════════════════════════
   ENGINE — Pikafish via Cloudflare Worker (Cloud API)

   v6.0.0: Engine đã chuyển lên Cloudflare Worker.
   ─────────────────────────────────────────────────────
   Lý do chuyển lên cloud:
   - MV3 service worker bị Chrome kill giữa chừng khi
     engine đang tính depth cao → mất kết quả.
   - SharedArrayBuffer / WASM multi-thread chỉ hoạt động
     trong Offscreen Document — dễ vỡ theo Chrome policy.
   - WASM binary (>5MB) phải đóng gói vào extension.

   Kiến trúc mới:
     content.js
       → fetch(WORKER_URL, { fen, depth, timeLimitMs })
       → Cloudflare Worker (Pikafish WASM — single-thread)
       ← { move: "h2e2" }

   Pikafish là fork của Stockfish viết riêng cho cờ tướng,
   mạnh hơn Fairy-Stockfish nhờ NNUE được train chuyên biệt.
   ══════════════════════════════════════════════════════ */

let _reqId = 0;
let wasmAssetsPromise = null;

function loadWasmAssets() {
  if (wasmAssetsPromise) return wasmAssetsPromise;

  const extensionUrl = file => chrome.runtime.getURL(file);
  wasmAssetsPromise = Promise.all([
    fetch(extensionUrl('engine_worker.js')).then(response => response.text()),
    fetch(extensionUrl('pikafish.js')).then(response => response.text()),
    fetch(extensionUrl('pikafish.wasm')).then(response => response.blob()),
    fetch(extensionUrl('pikafish.data')).then(response => response.blob()),
  ]).then(([workerSource, engineSource, wasmBlob, dataBlob]) => ({
    workerUrl: URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' })),
    engineScriptUrl: URL.createObjectURL(new Blob([engineSource], { type: 'text/javascript' })),
    assets: {
      'pikafish.wasm': URL.createObjectURL(wasmBlob),
      'pikafish.data': URL.createObjectURL(dataBlob),
    },
  })).catch(error => {
    wasmAssetsPromise = null;
    throw error;
  });

  return wasmAssetsPromise;
}

const OFFLINE_VALUES = {
  1: 10000, 2: 20, 3: 20, 4: 40, 5: 90, 6: 45, 7: 10,
};

function offlineMaterial(board, side) {
  return board.flat().reduce((score, piece) => {
    if (!piece) return score;
    const value = OFFLINE_VALUES[Math.abs(piece)] || 0;
    return score + (XQ.pieceColor(piece) === side ? value : -value);
  }, 0);
}

function offlineEvaluate(board, side) {
  if (!XQ.findKing(board, side)) return -Infinity;
  if (!XQ.findKing(board, -side)) return Infinity;

  const ownMoves = XQ.getLegalMoves(board, side);
  const enemyMoves = XQ.getLegalMoves(board, -side);
  let score = offlineMaterial(board, side);
  score += (ownMoves.length - enemyMoves.length) * 0.2;
  if (XQ.isInCheck(board, side)) score -= 500;
  if (XQ.isInCheck(board, -side)) score += 500;
  return score;
}

function offlineBestMove(board, side) {
  const legalMoves = XQ.getLegalMoves(board, side);
  let bestMove = null;
  let bestScore = -Infinity;

  for (const move of legalMoves) {
    const next = XQ.makeMove(board, move).board;
    let score = offlineEvaluate(next, side);
    const replies = XQ.getLegalMoves(next, -side);

    // Chọn nước có kết quả xấu nhất sau phản đòn tốt nhất của đối thủ.
    if (replies.length) {
      const worstReply = Math.min(...replies.map(reply => {
        const replyBoard = XQ.makeMove(next, reply).board;
        return offlineEvaluate(replyBoard, side);
      }));
      score = (score * 0.35) + (worstReply * 0.65);
    }

    if (score > bestScore) {
      bestScore = score;
      bestMove = move;
    }
  }

  LOG(`OFFLINE_ENGINE: ${legalMoves.length} moves, score=${bestScore.toFixed(1)}`);
  return bestMove;
}

/* prewarmEngine không cần nữa với cloud engine,
   giữ lại stub để không phá code gọi nó ở toggleHighlight. */
function prewarmEngine() {
  LOG('Cloud engine — no pre-warm needed');
}

/* ── FEN serialisation ───────────────────────────────── */
const FEN_PIECE = {
  [XQ.R_CHARIOT]:'R', [XQ.R_HORSE]:'H', [XQ.R_ELEPHANT]:'E',
  [XQ.R_ADVISOR]:'A', [XQ.R_KING]:'K',  [XQ.R_CANNON]:'C', [XQ.R_PAWN]:'P',
  [XQ.B_CHARIOT]:'r', [XQ.B_HORSE]:'h', [XQ.B_ELEPHANT]:'e',
  [XQ.B_ADVISOR]:'a', [XQ.B_KING]:'k',  [XQ.B_CANNON]:'c', [XQ.B_PAWN]:'p',
};

function boardToFen(board, side) {
  const rows = [];
  for (let r = 0; r < 10; r++) {
    let row = '';
    let empty = 0;
    for (let c = 0; c < 9; c++) {
      const p = board[r][c];
      if (p === XQ.EMPTY) {
        empty++;
      } else {
        if (empty) { row += empty; empty = 0; }
        row += (FEN_PIECE[p] || '?');
      }
    }
    if (empty) row += empty;
    rows.push(row);
  }
  const sideChar = side === XQ.RED ? 'r' : 'b';
  return rows.join('/') + ' ' + sideChar + ' - - 0 1';
}

/* Parse Pikafish/UCI algebraic move to internal [fr,fc,tr,tc] */
function parseSfMove(sfMove) {
  if (!sfMove || sfMove.length < 4) return null;
  const m = sfMove.match(/^([a-i])(\d+)([a-i])(\d+)$/);
  if (!m) return null;
  const fc = m[1].charCodeAt(0) - 97;
  const fr = 9 - parseInt(m[2], 10);   // UCI rank 0–9 (0=red back rank) → internal row 9–0
  const tc = m[3].charCodeAt(0) - 97;
  const tr = 9 - parseInt(m[4], 10);   // UCI rank 0–9 (0=red back rank) → internal row 9–0
  if (fr<0||fr>9||tr<0||tr>9||fc<0||fc>8||tc<0||tc>8) return null;
  return [fr, fc, tr, tc];
}

/* Main engine call — chạy Pikafish WASM trực tiếp trong Web Worker */
async function wasmBestMove(board, side) {
  const wasmAssets = await loadWasmAssets();
  return new Promise((resolve, reject) => {
    const worker = new Worker(wasmAssets.workerUrl);
    const timeoutMs = CFG.DEPTH > 0 ? 120000 : CFG.THINK_MS + 30000;
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('Engine timeout — Pikafish WASM không phản hồi'));
    }, timeoutMs);

    const finish = (callback, value) => {
      clearTimeout(timer);
      worker.terminate();
      callback(value);
    };

    worker.onmessage = event => {
      const data = event.data || {};
      if (data.type === 'bestmove') finish(resolve, parseSfMove(data.move));
      else if (data.type === 'error') finish(reject, new Error(data.error));
    };
    worker.onerror = event => finish(reject, new Error(event.message || 'Pikafish WASM worker error'));
    worker.postMessage({
      fen: boardToFen(board, side),
      depth: CFG.DEPTH,
      timeLimitMs: CFG.THINK_MS,
      engineScriptUrl: wasmAssets.engineScriptUrl,
      assets: wasmAssets.assets,
    });
  });
}

async function engineBestMove(board, side) {
  if (CFG.ENGINE_MODE === 'mock') return offlineBestMove(board, side);
  const id = ++_reqId;
  LOG(`ENGINE_COMPUTE #${id} | mode=WASM | depth=${CFG.DEPTH}`);
  return wasmBestMove(board, side);
}

/* ══════════════════════════════════════════════════════
   PIECE IDENTIFICATION
   ══════════════════════════════════════════════════════ */
function parsePieceFromImgClass(img) {
  if (!img) return null;
  const cls = img.className || '';
  if (!cls.includes('img-holder')) return null;
  const isRed   = cls.includes('-red-');
  const isBrown = cls.includes('-brown-');
  if (!isRed && !isBrown) {
    return parsePieceFromSrc(img.getAttribute('src') || '');
  }
  const R = t => isRed ? XQ['R_' + t] : XQ['B_' + t];
  if (cls.includes('rook'))     return R('CHARIOT');
  if (cls.includes('horse'))    return R('HORSE');
  if (cls.includes('elephant')) return R('ELEPHANT');
  if (cls.includes('advisor'))  return R('ADVISOR');
  if (cls.includes('king'))     return R('KING');
  if (cls.includes('cannon'))   return R('CANNON');
  if (cls.includes('pawn'))     return R('PAWN');
  return null;
}

function parsePieceFromSrc(url) {
  if (!url || !url.includes('cn-')) return null;
  const m = url.match(/cn-(red|black)-/i);
  if (!m) return null;
  const isRed = m[1].toLowerCase() === 'red';
  const R = t => isRed ? XQ['R_' + t] : XQ['B_' + t];
  const l = url.toLowerCase();
  if (l.includes('chariot'))  return R('CHARIOT');
  if (l.includes('horse'))    return R('HORSE');
  if (l.includes('elephant')) return R('ELEPHANT');
  if (l.includes('advisor'))  return R('ADVISOR');
  if (l.includes('king'))     return R('KING');
  if (l.includes('cannon'))   return R('CANNON');
  if (l.includes('soldier'))  return R('PAWN');
  return null;
}

/* ══════════════════════════════════════════════════════
   SQUARE POSITION
   ══════════════════════════════════════════════════════ */
function getPosFromSquare(el) {
  if (!el) return null;
  const cls = el.className || '';
  const m = cls.match(/\bsquare\s+(\d+)-([a-i])\b/);
  if (!m) return null;
  return { row: 10 - parseInt(m[1]), col: m[2].charCodeAt(0) - 97 };
}

function getSquareCenters(forceRefresh) {
  if (!forceRefresh && Date.now() - _sqCacheTs < 3000 && _sqCache.length) return _sqCache;
  _sqCache = [];
  for (const el of document.querySelectorAll('[class*="square "]')) {
    const pos = getPosFromSquare(el);
    if (!pos) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1) continue;
    _sqCache.push({
      row: pos.row, col: pos.col,
      x: (r.left + r.right)  / 2,
      y: (r.top  + r.bottom) / 2,
    });
  }
  _sqCacheTs = Date.now();
  return _sqCache;
}

function getSquareScreenPx(engineRow, engineCol) {
  const centers = getSquareCenters();
  for (const sq of centers) {
    if (sq.row === engineRow && sq.col === engineCol) return { x: sq.x, y: sq.y };
  }
  const ref = document.querySelector('.board-bg') || document.querySelector('[class*="BoardBorder"]');
  if (!ref) return null;
  const r = ref.getBoundingClientRect();
  const scaleX = r.width  / 371;
  const scaleY = r.height / 415;
  return {
    x: r.left + (10 + engineCol * 44) * scaleX,
    y: r.top  + (11 + engineRow * 44) * scaleY,
  };
}

/* ══════════════════════════════════════════════════════
   BOARD READING
   ══════════════════════════════════════════════════════ */
function readBoard() {
  const board = Array.from({ length: 10 }, () => new Array(9).fill(XQ.EMPTY));
  let detected = 0;

  const squares = getSquareCenters();
  if (!squares.length) return { board, detected };

  const pieceImgs = document.querySelectorAll('img.img-holder');
  if (!pieceImgs.length) return { board, detected };

  for (const img of pieceImgs) {
    const piece = parsePieceFromImgClass(img);
    if (piece === null) continue;

    const r = img.getBoundingClientRect();
    if (r.width < 1) continue;
    const cx = (r.left + r.right)  / 2;
    const cy = (r.top  + r.bottom) / 2;

    let best = null, bestD = Infinity;
    for (const sq of squares) {
      const d = Math.abs(cx - sq.x) + Math.abs(cy - sq.y);
      if (d < bestD) { bestD = d; best = sq; }
    }

    if (best && bestD < 30) {
      board[best.row][best.col] = piece;
      detected++;
    }
  }

  LOG(`Board read: ${detected} pieces`);
  return { board, detected };
}

function boardKey(board) { return board.flat().join(','); }

/* ══════════════════════════════════════════════════════
   NHẬN DIỆN MÀU CỦA TÔI
   ══════════════════════════════════════════════════════ */
function detectMyColor() {
  const squares = getSquareCenters();
  if (!squares.length) return null;

  let minY = Infinity, maxY = -Infinity;
  for (const sq of squares) {
    if (sq.y < minY) minY = sq.y;
    if (sq.y > maxY) maxY = sq.y;
  }
  const midY = (minY + maxY) / 2;

  let redBot = 0, blackBot = 0;
  for (const img of document.querySelectorAll('img.img-holder')) {
    const piece = parsePieceFromImgClass(img);
    if (piece === null) continue;
    const r = img.getBoundingClientRect();
    if (r.width < 1) continue;
    const cy = (r.top + r.bottom) / 2;
    if (cy > midY) {
      if (XQ.pieceColor(piece) === XQ.RED)   redBot++;
      if (XQ.pieceColor(piece) === XQ.BLACK) blackBot++;
    }
  }

  if (!redBot && !blackBot) return null;
  const detected = blackBot > redBot ? XQ.BLACK : XQ.RED;
  LOG(`Color detect: redBot=${redBot} blackBot=${blackBot} → ${detected === XQ.RED ? 'RED' : 'BLACK'}`);
  return detected;
}

/* ══════════════════════════════════════════════════════
   NHẬN DIỆN LƯỢT — timer-based
   ══════════════════════════════════════════════════════ */
function readTimerSecs(position) {
  for (const w of document.querySelectorAll('[class*="playerWrapper"]')) {
    const cls = w.className || '';
    if (!cls.toLowerCase().includes(position)) continue;
    const m = w.textContent.match(/(\d{1,2}):(\d{2})/);
    if (m) return parseInt(m[1]) * 60 + parseInt(m[2]);
  }
  return null;
}

function detectCurrentTurn() {
  const botSecs = readTimerSecs('bottom');
  const topSecs = readTimerSecs('top');
  if (botSecs === null || topSecs === null) return null;

  timerHistory.push({ ts: Date.now(), bot: botSecs, top: topSecs });
  if (timerHistory.length > 10) timerHistory.shift();
  if (timerHistory.length < 3) return null;

  const old = timerHistory[0];
  const cur = timerHistory[timerHistory.length - 1];
  if (cur.ts - old.ts < 1500) return null;

  const botDec = cur.bot < old.bot;
  const topDec = cur.top < old.top;

  if (botDec && !topDec) return myColor;
  if (topDec && !botDec) {
    if (myColor === null) return null;
    return myColor === XQ.RED ? XQ.BLACK : XQ.RED;
  }
  return null;
}

/* ══════════════════════════════════════════════════════
   SVG HIGHLIGHT OVERLAY
   ══════════════════════════════════════════════════════ */
const OVERLAY_ID = 'xqb-highlight-overlay';

function removeHighlight() {
  const old = document.getElementById(OVERLAY_ID);
  if (old) old.remove();
  lastMove = null;
  lastMoveDetail = null;
}

function drawHighlight(move, side) {
  removeHighlight();
  if (!move) return;

  const [fr, fc, tr, tc] = move;
  lastMove = move;

  const fromPx = getSquareScreenPx(fr, fc);
  const toPx   = getSquareScreenPx(tr, tc);
  if (!fromPx || !toPx) {
    LOG('drawHighlight: cannot get square positions');
    return;
  }

  const squares = getSquareCenters();
  let cellSize = 44;
  if (squares.length >= 2) {
    const sorted = [...squares].sort((a, b) => a.row - b.row || a.col - b.col);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].row === sorted[i-1].row && sorted[i].col === sorted[i-1].col + 1) {
        cellSize = sorted[i].x - sorted[i-1].x; break;
      }
    }
  }
  const R = cellSize * 0.34;

  const dx   = toPx.x - fromPx.x;
  const dy   = toPx.y - fromPx.y;
  const dist = Math.sqrt(dx*dx + dy*dy) || 1;

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.id = OVERLAY_ID;
  svg.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483646;overflow:visible';

  function mkCircle(x, y, fill, stroke, opacity) {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', R);
    c.setAttribute('fill', fill);
    c.setAttribute('stroke', stroke);
    c.setAttribute('stroke-width', '3');
    c.setAttribute('opacity', opacity || '1');
    svg.appendChild(c);
  }

  if (dist > R * 2) {
    const nx = dx/dist, ny = dy/dist;
    const ln = document.createElementNS(NS, 'line');
    ln.setAttribute('x1', fromPx.x + nx*R);
    ln.setAttribute('y1', fromPx.y + ny*R);
    ln.setAttribute('x2', toPx.x  - nx*R);
    ln.setAttribute('y2', toPx.y  - ny*R);
    ln.setAttribute('stroke', 'rgba(255,255,255,0.85)');
    ln.setAttribute('stroke-width', '2.5');
    ln.setAttribute('stroke-linecap', 'round');
    ln.setAttribute('marker-end', 'url(#xqb-arrow)');
    svg.appendChild(ln);

    const defs   = document.createElementNS(NS, 'defs');
    const marker = document.createElementNS(NS, 'marker');
    marker.setAttribute('id', 'xqb-arrow');
    marker.setAttribute('markerWidth', '8');
    marker.setAttribute('markerHeight', '8');
    marker.setAttribute('refX', '6');
    marker.setAttribute('refY', '3');
    marker.setAttribute('orient', 'auto');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M0,0 L0,6 L8,3 z');
    path.setAttribute('fill', 'rgba(255,255,255,0.85)');
    marker.appendChild(path);
    defs.appendChild(marker);
    svg.insertBefore(defs, svg.firstChild);
  }

  mkCircle(fromPx.x, fromPx.y, 'rgba(230,126,34,0.5)', '#e67e22', '0.9');
  mkCircle(toPx.x,   toPx.y,   'rgba(39,174,96,0.6)',  '#2ecc71', '0.9');

  document.body.appendChild(svg);

  const cols = 'abcdefghi';
  LOG(`Highlight: ${cols[fc]}${10-fr} → ${cols[tc]}${10-tr} | side=${side===XQ.RED?'RED':'BLACK'}`);
}

/* ══════════════════════════════════════════════════════
   DETECT TURN FROM BOARD DIFF
   So sánh bàn trước / sau để xác định phe vừa đi, rồi
   trả về phe sắp đến lượt.  Đáng tin hơn timer nhiều.

   v6.1.1 FIX — Bản cũ đánh dấu "cả hai phe đổi" mỗi khi có ăn quân
   (ô đích chuyển từ quân đối phương → quân mình khiến cả redChanged
   và blackChanged cùng true), nên luôn trả null ở MỌI nước ăn quân —
   tức gần như luôn thất bại vì cờ tướng ăn quân rất thường xuyên.
   Fix: chỉ quy nước đi cho MÀU CỦA QUÂN VỪA ĐẾN (ô != EMPTY sau khi
   đổi) hoặc MÀU CỦA QUÂN VỪA RỜI ĐI (ô == EMPTY sau khi đổi) — không
   bao giờ gán cho quân bị ăn.
   ══════════════════════════════════════════════════════ */
function detectTurnFromBoardDiff(prev, curr) {
  if (!prev) return null;
  let redMoved = false, blackMoved = false;
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 9; c++) {
      const p = prev[r][c], q = curr[r][c];
      if (p === q) continue;
      if (q !== XQ.EMPTY) {
        // Có quân xuất hiện ở đây → màu của quân ĐÓ vừa đi tới
        // (đúng cho cả nước thường lẫn nước ăn quân)
        if (q > 0) redMoved = true; else blackMoved = true;
      } else {
        // Ô trở thành trống → quân từng ở đây vừa rời đi
        if (p > 0) redMoved = true; else blackMoved = true;
      }
    }
  }
  // Phe nào vừa đi thì lượt kế là phe kia
  if (redMoved && !blackMoved) return XQ.BLACK;
  if (blackMoved && !redMoved) return XQ.RED;
  return null;   // cả hai thay đổi (gộp ≥2 nước cùng lúc) hoặc không thay đổi
}

/* ══════════════════════════════════════════════════════
   MAIN LOGIC
   ══════════════════════════════════════════════════════ */
async function computeAndHighlight(board, turn) {
  if (!myColor) myColor = detectMyColor();
  if (myColor && turn !== myColor) {
    LOG(`Skip highlight: waiting for ${myColor === XQ.RED ? 'RED' : 'BLACK'} turn, detected ${turn === XQ.RED ? 'RED' : 'BLACK'}`);
    removeHighlight();
    const oppName = turn === XQ.RED ? 'Đỏ' : 'Đen';
    setPanelStatus(`⏳ Lượt ${oppName} — chờ...`);
    return;
  }

  if (computing) {
    /* v6.1.1 FIX — trước đây return thẳng ở đây khiến nước đi này bị
       bỏ luôn (không có gì gọi lại computeAndHighlight cho nó nữa
       ngoài vòng poll kế tiếp — mà vòng poll đó lại bị chặn bởi
       computing y hệt). Giờ: xếp hàng, xử lý ngay khi engine rảnh. */
    pendingBoard = board;
    pendingTurn  = turn;
    return;
  }

  /* Chống tính lại cùng vị trí + lượt */
  const ck = boardKey(board) + '|' + turn;
  if (ck === lastComputedKey) {
    LOG('Cùng vị trí + lượt đã tính — bỏ qua');
    return;
  }

  computing = true;
  lastComputedKey = ck;
  const boardSnapshot = boardKey(board);   // snapshot để phát hiện bàn thay đổi
  const sideName = turn === XQ.RED ? 'Đỏ' : 'Đen';
  const engineName = CFG.ENGINE_MODE === 'mock' ? 'Offline evaluator' : 'Pikafish WASM';
  setPanelStatus(`🧠 ${engineName} tính... (${sideName})`);

  try {
    const legalMoves = XQ.getLegalMoves(board, turn);
    if (!legalMoves.length) {
      setPanelStatus('Không có nước đi hợp lệ');
      removeHighlight();
      return;
    }
    const move = await engineBestMove(board, turn);

    // Kiểm tra bàn có thay đổi trong lúc engine tính không
    const { board: nowBoard, detected: nowDetected } = readBoard();
    if (nowDetected >= 4 && boardKey(nowBoard) !== boardSnapshot) {
      /* v6.1.1 FIX — trước đây chỉ reset key rồi return, KHÔNG xoá
         highlight cũ (vẫn đang hiện nước đã lỗi thời) và phải chờ
         vòng poll/mutation TIẾP THEO mới xử lý lại. Giờ: xoá ngay +
         xếp bàn mới nhất vào hàng đợi, xử lý ngay khi hàm này thoát
         (xem finally bên dưới) — không phải chờ thêm một chu kỳ nữa. */
      LOG('Bàn thay đổi trong lúc engine tính — huỷ kết quả cũ, xử lý bàn mới ngay');
      removeHighlight();
      const diffTurn = detectTurnFromBoardDiff(prevBoardSnapshot, nowBoard);
      pendingBoard = nowBoard;
      pendingTurn  = diffTurn || detectCurrentTurn() || myColor || XQ.RED;
      prevBoardSnapshot = nowBoard.map(row => row.slice());
      lastBoardKey = boardKey(nowBoard);
      return;
    }

    if (move) {
      const [fr, fc, tr, tc] = move;
      const cols = 'abcdefghi';
      const movedPiece    = board[fr][fc];
      const capturedPiece = board[tr][tc];
      const fromCoord = cols[fc] + (10 - fr);
      const toCoord   = cols[tc] + (10 - tr);
      lastMoveDetail = {
        from:     movedPiece    ? { key: PIECE_INFO[movedPiece]?.key,    row: fr, col: fc, ...PIECE_INFO[movedPiece]    } : null,
        to:       { row: tr, col: tc },
        captured: capturedPiece ? { key: PIECE_INFO[capturedPiece]?.key, row: tr, col: tc, ...PIECE_INFO[capturedPiece] } : null,
        fromCoord, toCoord,
      };
      drawHighlight(move, turn);
      updateMoveFrame();
      setPanelStatus(`✔ ${sideName}: ${fromCoord} → ${toCoord}`);
    } else {
      lastMoveDetail = null;
      setPanelStatus('Engine không trả về nước');
    }
  } catch (e) {
    LOG('Engine error:', e);
    setPanelStatus('Lỗi: ' + e.message);
  } finally {
    computing = false;
    updatePanel();
    /* v6.1.1 FIX — nếu trong lúc vừa tính có bàn mới hơn đã xếp hàng
       (do người chơi/đối thủ đi tiếp), xử lý NGAY, không chờ poll. */
    if (pendingBoard) {
      const nb = pendingBoard, nt = pendingTurn;
      pendingBoard = null; pendingTurn = null;
      computeAndHighlight(nb, nt);
    }
  }
}

async function onBoardChanged(board) {
  if (!highlightEnabled) return;
  removeHighlight();   // bàn vừa đổi → highlight cũ chắc chắn lỗi thời, xoá ngay
  if (!myColor) myColor = detectMyColor();

  /* Ưu tiên: board-diff > timer > myColor > RED */
  const turnFromDiff  = detectTurnFromBoardDiff(prevBoardSnapshot, board);
  const turn = turnFromDiff || detectCurrentTurn() || myColor || XQ.RED;
  LOG(`BOARD_CHANGE: diff=${turnFromDiff === XQ.RED ? 'RED' : turnFromDiff === XQ.BLACK ? 'BLACK' : 'unknown'} → turn=${turn === XQ.RED ? 'RED' : 'BLACK'}`);

  /* Lưu bản copy bàn hiện tại cho lần diff kế tiếp */
  prevBoardSnapshot = board.map(row => row.slice());

  if (computing) {
    /* v6.1.1 FIX — engine đang bận với một bàn cũ hơn; kết quả của nó
       sẽ lỗi thời ngay khi trả về. Xếp bàn MỚI NHẤT vào hàng đợi thay
       vì bỏ qua hoàn toàn — computeAndHighlight() sẽ xử lý nó ngay khi
       xong việc hiện tại (xem finally trong computeAndHighlight). */
    pendingBoard = board;
    pendingTurn  = turn;
    setPanelStatus('⏳ Bàn vừa đổi — xếp hàng chờ engine...');
    return;
  }

  await computeAndHighlight(board, turn);
}

/* ══════════════════════════════════════════════════════
   MUTATION OBSERVER
   ══════════════════════════════════════════════════════ */
function getPiecesContainer() {
  return (
    document.querySelector('.pieces-container') ||
    document.querySelector('[class*="pieces-container"]') ||
    document.querySelector('[class*="BoardBorder"]') ||
    document.querySelector('.board-bg')
  );
}

function startObserver() {
  _sqCacheTs = 0;

  const target = getPiecesContainer();
  if (!target) {
    LOG('No pieces container found, retrying...');
    setPanelStatus('Chờ board load...');
    setTimeout(startObserver, 1500);
    return;
  }
  LOG('Observing:', (target.className || '').slice(0, 60));

  if (observer) observer.disconnect();
  observer = new MutationObserver(() => {
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(async () => {
      /* v6.1.1 FIX — bỏ điều kiện `|| computing` khỏi đây. Trước đây
         nó khiến MỌI thay đổi bàn cờ xảy ra trong lúc engine đang tính
         bị bỏ sót hoàn toàn (không đọc bàn, không cập nhật lastBoardKey,
         không gọi onBoardChanged) — đó là nguyên nhân chính khiến
         highlight cũ "đứng hình" qua nhiều nước khi cloud engine chậm.
         onBoardChanged() giờ tự xử lý việc engine đang bận (xếp hàng). */
      if (!highlightEnabled) return;
      _sqCacheTs = 0;
      const { board, detected } = readBoard();
      if (detected < 4) return;
      const key = boardKey(board);
      if (key === lastBoardKey) return;
      lastBoardKey = key;
      await onBoardChanged(board);
    }, CFG.SETTLE_MS);
  });

  observer.observe(target, {
    childList: true, subtree: true,
    attributes: true, attributeFilter: ['style', 'class'],
  });

  const boardEl = document.querySelector('[class*="BoardBorder"]') ||
                  document.querySelector('.board-bg');
  if (boardEl && boardEl !== target) {
    observer.observe(boardEl, { childList: true, subtree: true });
  }

  LOG('MutationObserver started');
}

// Polling fallback
setInterval(async () => {
  /* v6.1.1 FIX — cùng lý do như MutationObserver ở trên: không được
     bỏ qua việc phát hiện thay đổi bàn cờ chỉ vì engine đang bận. */
  if (!highlightEnabled) return;
  const { board, detected } = readBoard();
  if (detected < 4) return;
  const key = boardKey(board);
  if (key === lastBoardKey) return;
  lastBoardKey = key;
  await onBoardChanged(board);
}, CFG.POLL_MS);

// SPA navigation
let lastPath = location.pathname;
setInterval(() => {
  if (location.pathname !== lastPath) {
    lastPath = location.pathname;
    LOG('SPA nav:', lastPath);
    myColor = null; lastBoardKey = ''; timerHistory = []; _sqCacheTs = 0;
    lastComputedKey   = '';
    prevBoardSnapshot = null;
    pendingBoard = null; pendingTurn = null;
    removeHighlight();
    if (highlightEnabled) setTimeout(startObserver, 1500);
  }
}, 800);

/* ══════════════════════════════════════════════════════
   FLOATING PANEL
   ══════════════════════════════════════════════════════ */
let panelBuilt = false;

function buildPanel() {
  if (panelBuilt || document.getElementById('xqb-panel')) return;
  panelBuilt = true;

  const panel = document.createElement('div');
  panel.id = 'xqb-panel';
  panel.innerHTML = `
    <div id="xqb-head">⚔ XiangqiBot <span id="xqb-ver">v6.1.1</span></div>
    <button id="xqb-toggle">▶ BẬT HIGHLIGHT</button>
    <div id="xqb-status">Chưa kích hoạt</div>

    <!-- Piece count bar -->
    <div id="xqb-pieces-bar">
      <div class="xqb-side-cnt xqb-red">
        <svg viewBox="0 0 40 40" width="18" height="18"><circle cx="20" cy="20" r="18" fill="#c84b31" stroke="#8b1a0a" stroke-width="2"/><circle cx="20" cy="20" r="13" fill="none" stroke="rgba(255,180,130,0.35)" stroke-width="1.5"/><text x="20" y="27" text-anchor="middle" fill="#fff" font-size="15" font-family="serif" font-weight="bold">帅</text></svg>
        <span id="xqb-red-cnt">0</span>
      </div>
      <span style="color:#252540;font-size:13px;">|</span>
      <div class="xqb-side-cnt xqb-blk">
        <svg viewBox="0 0 40 40" width="18" height="18"><circle cx="20" cy="20" r="18" fill="#2a2a2a" stroke="#555" stroke-width="2"/><circle cx="20" cy="20" r="13" fill="none" stroke="rgba(200,200,200,0.2)" stroke-width="1.5"/><text x="20" y="27" text-anchor="middle" fill="#ddd" font-size="15" font-family="serif" font-weight="bold">将</text></svg>
        <span id="xqb-blk-cnt">0</span>
      </div>
    </div>

    <!-- Move info frame -->
    <div id="xqb-move-box">
      <div class="xqb-move-label">NƯỚC TỐT NHẤT</div>
      <div id="xqb-move-row">
        <div class="xqb-mpiece" id="xqb-from">
          <div id="xqb-from-icon" class="xqb-piece-icon"></div>
          <div id="xqb-from-name" class="xqb-pname">—</div>
          <div id="xqb-from-coord" class="xqb-coord">—</div>
        </div>
        <div class="xqb-marrow">
          <svg viewBox="0 0 44 12" width="44" height="12" id="xqb-arrow-svg">
            <line x1="2" y1="6" x2="34" y2="6" stroke="#2a2a50" stroke-width="2" stroke-linecap="round"/>
            <polygon points="32,2 42,6 32,10" fill="#2a2a50"/>
          </svg>
          <div id="xqb-capture-tag" style="display:none">ĂN</div>
        </div>
        <div class="xqb-mpiece" id="xqb-to">
          <div id="xqb-to-icon" class="xqb-piece-icon"></div>
          <div id="xqb-to-name" class="xqb-pname">—</div>
          <div id="xqb-to-coord" class="xqb-coord">—</div>
        </div>
      </div>
      <div id="xqb-move-desc">Chưa có nước gợi ý</div>
    </div>

    <!-- Settings -->
    <div class="xqb-row">
      <span>Depth</span>
      <select id="xqb-depth">
        <option value="5">5 — Nhanh</option>
        <option value="10">10 — Cơ bản</option>
        <option value="15" selected>15 — Chuẩn</option>
        <option value="20">20 — Mạnh</option>
        <option value="25">25 — Rất mạnh</option>
        <option value="0">Movetime 3s</option>
      </select>
    </div>
    <div class="xqb-row">
      <span>Màu của bạn</span>
      <select id="xqb-colsel">
        <option value="auto">Tự động</option>
        <option value="red">Đỏ</option>
        <option value="black">Đen</option>
      </select>
    </div>
    <button id="xqb-now" disabled>💡 Tính ngay</button>
  `;
  document.body.appendChild(panel);
  injectPanelStyles();

  // Drag touch
  let dt = null;
  panel.addEventListener('touchstart', e => {
    if (['BUTTON','SELECT','INPUT'].includes(e.target.tagName)) return;
    const t = e.touches[0];
    dt = { x: t.clientX - panel.offsetLeft, y: t.clientY - panel.offsetTop };
  }, { passive: true });
  window.addEventListener('touchmove', e => {
    if (!dt) return;
    panel.style.left = (e.touches[0].clientX - dt.x) + 'px';
    panel.style.top  = (e.touches[0].clientY - dt.y) + 'px';
    panel.style.right = 'auto'; panel.style.bottom = 'auto';
  }, { passive: true });
  window.addEventListener('touchend', () => { dt = null; });

  // Drag mouse
  let dm = null;
  panel.addEventListener('mousedown', e => {
    if (['BUTTON','SELECT','INPUT'].includes(e.target.tagName)) return;
    dm = { x: e.clientX - panel.offsetLeft, y: e.clientY - panel.offsetTop };
  });
  window.addEventListener('mousemove', e => {
    if (!dm) return;
    panel.style.left = (e.clientX - dm.x) + 'px';
    panel.style.top  = (e.clientY - dm.y) + 'px';
    panel.style.right = 'auto'; panel.style.bottom = 'auto';
  });
  window.addEventListener('mouseup', () => { dm = null; });

  document.getElementById('xqb-toggle').addEventListener('click', toggleHighlight);

  document.getElementById('xqb-now').addEventListener('click', async () => {
    if (!highlightEnabled) return;
    _sqCacheTs = 0;
    const { board, detected } = readBoard();
    if (detected < 4) { setPanelStatus(`Chỉ đọc ${detected} quân — thử lại`); return; }
    if (!myColor) myColor = detectMyColor();
    const side = myColor || XQ.RED;
    const legalMoves = XQ.getLegalMoves(board, side);
    if (!legalMoves.length) { setPanelStatus('Không có nước đi hợp lệ'); return; }
    computing = true;
    setPanelStatus(`🧠 Tính (depth ${CFG.DEPTH > 0 ? CFG.DEPTH : 'movetime'})...`);
    try {
      const move = await engineBestMove(board, side);
      if (move) {
        const [fr, fc, tr, tc] = move;
        const cols = 'abcdefghi';
        const movedPiece    = board[fr][fc];
        const capturedPiece = board[tr][tc];
        lastMoveDetail = {
          from:     movedPiece    ? { key: PIECE_INFO[movedPiece]?.key,    row: fr, col: fc, ...PIECE_INFO[movedPiece]    } : null,
          to:       { row: tr, col: tc },
          captured: capturedPiece ? { key: PIECE_INFO[capturedPiece]?.key, row: tr, col: tc, ...PIECE_INFO[capturedPiece] } : null,
          fromCoord: cols[fc] + (10 - fr),
          toCoord:   cols[tc] + (10 - tr),
        };
        drawHighlight(move, side);
        updateMoveFrame();
        setPanelStatus(`✔ ${side===XQ.RED?'Đỏ':'Đen'}: ${cols[fc]}${10-fr} → ${cols[tc]}${10-tr}`);
      }
    } catch(e) {
      setPanelStatus('Lỗi: ' + e.message);
    } finally {
      computing = false;
      updatePanel();
    }
  });

  document.getElementById('xqb-colsel').addEventListener('change', e => {
    const v = e.target.value;
    if (v === 'auto') myColor = detectMyColor();
    else              myColor = v === 'red' ? XQ.RED : XQ.BLACK;
    timerHistory = [];
    updatePanel();
  });

  document.getElementById('xqb-depth').addEventListener('change', e => {
    CFG.DEPTH = parseInt(e.target.value, 10);
    chrome.storage.local.set({ depth: CFG.DEPTH });
    updatePanel();
  });

  updatePanel();
}

function injectPanelStyles() {
  if (document.getElementById('xqb-style')) return;
  const s = document.createElement('style');
  s.id = 'xqb-style';
  s.textContent = `
    #xqb-panel {
      position: fixed; bottom: 20px; right: 12px; z-index: 2147483647;
      width: 240px; padding: 11px 12px 12px;
      background: #0b0b18; border: 1.5px solid #c84b31; border-radius: 12px;
      font-family: 'Segoe UI', Arial, sans-serif; font-size: 11px;
      box-shadow: 0 6px 32px rgba(200,75,49,0.45);
      touch-action: none; user-select: none; color: #e0e0e0;
    }
    #xqb-head {
      font-size: 12px; font-weight: 800; letter-spacing: 2px;
      color: #c84b31; text-align: center; margin-bottom: 7px;
      text-transform: uppercase;
    }
    #xqb-ver { color: #444; font-size: 9px; font-weight: 400; letter-spacing: 1px; }
    #xqb-toggle {
      width: 100%; padding: 9px 0; margin-bottom: 7px;
      background: linear-gradient(135deg,#1a7a45,#27ae60);
      color: #fff; border: none; border-radius: 7px;
      font-family: inherit; font-size: 12px;
      font-weight: 800; letter-spacing: 2px; cursor: pointer;
      text-transform: uppercase;
    }
    #xqb-toggle.on { background: linear-gradient(135deg,#9b1e0e,#c0392b); }
    #xqb-status {
      font-size: 10px; color: #aaa; text-align: center;
      min-height: 14px; margin-bottom: 5px; word-break: break-all;
    }
    /* Piece count bar */
    #xqb-pieces-bar {
      display: flex; justify-content: space-around; align-items: center;
      background: #111125; border: 1px solid #1a1a35; border-radius: 7px;
      padding: 5px 8px; margin-bottom: 7px;
    }
    .xqb-side-cnt { display: flex; align-items: center; gap: 4px; font-weight: 700; font-size: 12px; }
    .xqb-red { color: #e0795c; }
    .xqb-blk { color: #888; }
    /* Move info box */
    #xqb-move-box {
      background: #111125; border: 1px solid #1a1a35; border-radius: 7px;
      padding: 7px 8px; margin-bottom: 7px;
    }
    .xqb-move-label {
      font-size: 8px; letter-spacing: 2px; color: #333;
      text-transform: uppercase; font-weight: 600; margin-bottom: 6px;
    }
    #xqb-move-row {
      display: flex; align-items: center; justify-content: space-between; gap: 4px;
    }
    .xqb-mpiece { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px; }
    .xqb-piece-icon { line-height: 1; min-height: 28px; display: flex; align-items: center; justify-content: center; }
    .xqb-pname { font-size: 9px; font-weight: 700; color: #bbb; text-align: center; }
    .xqb-coord { font-size: 8px; color: #333; font-family: 'Courier New', monospace; letter-spacing: 1px; }
    .xqb-marrow { display: flex; flex-direction: column; align-items: center; gap: 2px; flex: 0 0 auto; }
    #xqb-capture-tag {
      font-size: 7px; font-weight: 800; letter-spacing: 1px; color: #c84b31;
      background: rgba(200,75,49,0.15); border: 1px solid rgba(200,75,49,0.4);
      border-radius: 3px; padding: 1px 4px;
    }
    #xqb-move-desc {
      font-size: 9px; color: #444; text-align: center; margin-top: 5px;
      min-height: 12px; letter-spacing: 0.3px;
    }
    /* Settings rows */
    .xqb-row {
      display: flex; justify-content: space-between; align-items: center;
      margin-top: 6px; font-size: 10px; color: #555;
    }
    #xqb-colsel, #xqb-depth {
      background: #0d0d20; border: 1px solid #252545; color: #bbb;
      border-radius: 5px; padding: 2px 5px; font-size: 9px; outline: none; cursor: pointer;
    }
    #xqb-colsel:focus, #xqb-depth:focus { border-color: #c84b31; }
    #xqb-now {
      width: 100%; padding: 7px 0; margin-top: 8px;
      background: #161b25; color: #f1c40f;
      border: 1px solid #f1c40f; border-radius: 6px;
      font-family: inherit; font-size: 11px; font-weight: 700;
      cursor: pointer; letter-spacing: 1px;
    }
    #xqb-now:disabled { opacity: 0.3; cursor: not-allowed; }
    #xqb-now:hover:not(:disabled) { background: #1e2530; }
  `;
  document.head.appendChild(s);
}

function toggleHighlight() {
  highlightEnabled = !highlightEnabled;
  const btn = document.getElementById('xqb-toggle');
  if (!btn) return;

  if (highlightEnabled) {
    btn.textContent = '⏹ TẮT HIGHLIGHT';
    btn.className   = 'on';
    myColor           = null;
    lastBoardKey      = '';
    timerHistory      = [];
    _sqCacheTs        = 0;
    lastComputedKey   = '';
    lastMoveDetail    = null;
    prevBoardSnapshot = null;
    pendingBoard      = null;
    pendingTurn       = null;
    setPanelStatus('Đang phân tích...');
    // Cloud engine — không cần prewarm
    startObserver();
    setTimeout(async () => {
      myColor = detectMyColor();
      const { board, detected } = readBoard();
      LOG(`Initial read: ${detected} pieces, myColor=${myColor===XQ.RED?'RED':myColor===XQ.BLACK?'BLACK':'null'}`);
      if (detected >= 4) {
        lastBoardKey = boardKey(board);
        prevBoardSnapshot = board.map(row => row.slice());
        const turn = detectCurrentTurn() || myColor || XQ.RED;
        await computeAndHighlight(board, turn);
      } else {
        setPanelStatus(`Đọc được ${detected} quân — chờ ván cờ load`);
      }
    }, 1000);
  } else {
    btn.textContent = '▶ BẬT HIGHLIGHT';
    btn.className   = '';
    if (observer) { observer.disconnect(); observer = null; }
    removeHighlight();
    lastComputedKey   = '';
    prevBoardSnapshot = null;
    pendingBoard      = null;
    pendingTurn       = null;
    setPanelStatus('Highlight đã tắt');
  }
  updatePanel();
}

function setPanelStatus(msg) {
  const el = document.getElementById('xqb-status');
  if (el) el.textContent = msg;
}

/* ── Move frame renderer (floating panel) ────────────── */
function updateMoveFrame() {
  const detail = lastMoveDetail;

  const fromIcon  = document.getElementById('xqb-from-icon');
  const fromName  = document.getElementById('xqb-from-name');
  const fromCoord = document.getElementById('xqb-from-coord');
  const toIcon    = document.getElementById('xqb-to-icon');
  const toName    = document.getElementById('xqb-to-name');
  const toCoord   = document.getElementById('xqb-to-coord');
  const capTag    = document.getElementById('xqb-capture-tag');
  const descEl    = document.getElementById('xqb-move-desc');
  const arrowSvg  = document.getElementById('xqb-arrow-svg');
  if (!fromIcon) return;

  const EMPTY_CIRCLE = `<svg viewBox="0 0 40 40" width="26" height="26"><circle cx="20" cy="20" r="16" fill="none" stroke="#252540" stroke-width="1.5" stroke-dasharray="4,3"/></svg>`;

  if (!detail) {
    fromIcon.innerHTML  = EMPTY_CIRCLE;
    fromName.textContent = '—';
    fromCoord.textContent = '—';
    toIcon.innerHTML    = EMPTY_CIRCLE;
    toName.textContent  = '—';
    toCoord.textContent = '—';
    if (capTag) capTag.style.display = 'none';
    if (descEl) descEl.textContent = 'Chưa có nước gợi ý';
    return;
  }

  const { from, to, captured, fromCoord: fc, toCoord: tc } = detail;

  // From piece
  if (from && PIECE_INFO[Object.keys(PIECE_INFO).find(k => PIECE_INFO[k].key === from.key)]) {
    const pi = from;
    fromIcon.innerHTML = pieceSvgHtml(pi.zh, pi.red, 26);
    fromName.textContent = pi.vi + (pi.red ? ' Đỏ' : ' Đen');
    fromName.style.color = pi.red ? '#e0795c' : '#aaa';
  } else {
    fromIcon.innerHTML = EMPTY_CIRCLE;
    fromName.textContent = '?';
    fromName.style.color = '#555';
  }
  fromCoord.textContent = fc || '—';

  // To piece (captured or empty)
  if (captured) {
    const pi = captured;
    toIcon.innerHTML = pieceSvgHtml(pi.zh, pi.red, 26);
    toName.textContent = pi.vi + (pi.red ? ' Đỏ' : ' Đen');
    toName.style.color = pi.red ? '#e0795c' : '#aaa';
    if (capTag) capTag.style.display = 'inline-block';
    if (arrowSvg) {
      arrowSvg.querySelectorAll('line').forEach(el => el.setAttribute('stroke', '#c84b31'));
      arrowSvg.querySelectorAll('polygon').forEach(el => el.setAttribute('fill', '#c84b31'));
    }
  } else {
    toIcon.innerHTML = EMPTY_CIRCLE;
    toName.textContent = 'Ô trống';
    toName.style.color = '#333';
    if (capTag) capTag.style.display = 'none';
    if (arrowSvg) {
      arrowSvg.querySelectorAll('line').forEach(el => el.setAttribute('stroke', '#2ecc71'));
      arrowSvg.querySelectorAll('polygon').forEach(el => el.setAttribute('fill', '#2ecc71'));
    }
  }
  toCoord.textContent = tc || '—';

  // Description
  if (descEl && from) {
    const sideName = from.red ? 'Đỏ' : 'Đen';
    if (captured) {
      const capSide = captured.red ? 'Đỏ' : 'Đen';
      descEl.textContent = `${from.vi} ${sideName} (${fc}) ăn ${captured.vi} ${capSide} (${tc})`;
    } else {
      descEl.textContent = `${from.vi} ${sideName}: ${fc} → ${tc}`;
    }
  }
}

function updatePanel() {
  const nowBtn = document.getElementById('xqb-now');
  const colSel = document.getElementById('xqb-colsel');
  const redCntEl = document.getElementById('xqb-red-cnt');
  const blkCntEl = document.getElementById('xqb-blk-cnt');
  const depthSel = document.getElementById('xqb-depth');

  const { board } = readBoard();
  let redCnt = 0, blkCnt = 0;
  board.flat().forEach(p => {
    if (p > 0) redCnt++;
    else if (p < 0) blkCnt++;
  });
  if (redCntEl) redCntEl.textContent = redCnt;
  if (blkCntEl) blkCntEl.textContent = blkCnt;

  if (nowBtn)  nowBtn.disabled  = !highlightEnabled || computing;
  if (colSel) {
    if      (myColor === XQ.RED)   colSel.value = 'red';
    else if (myColor === XQ.BLACK) colSel.value = 'black';
    else                           colSel.value = 'auto';
  }
  if (depthSel) depthSel.value = String(CFG.DEPTH);
}

/* ══════════════════════════════════════════════════════
   CHROME MESSAGE HANDLER
   ══════════════════════════════════════════════════════ */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case 'HIGHLIGHT_ENABLE':
      if (!highlightEnabled) toggleHighlight();
      sendResponse({ ok: true });
      break;
    case 'HIGHLIGHT_DISABLE':
      if (highlightEnabled) toggleHighlight();
      sendResponse({ ok: true });
      break;
    case 'HIGHLIGHT_NOW':
      if (highlightEnabled) {
        _sqCacheTs = 0;
        const { board, detected } = readBoard();
        if (detected >= 4) {
          const turn = detectCurrentTurn() || myColor || XQ.RED;
          computeAndHighlight(board, turn);
        }
      }
      sendResponse({ ok: true });
      break;
    case 'BOT_STATUS': {
      const { board, detected } = readBoard();
      let redCount = 0, blkCount = 0;
      board.flat().forEach(p => { if (p > 0) redCount++; else if (p < 0) blkCount++; });
      sendResponse({
        ok: true, enabled: highlightEnabled,
        color: myColor === XQ.RED ? 'RED' : myColor === XQ.BLACK ? 'BLACK' : '???',
        computing, pieces: detected, lastMove,
        redCount, blkCount,
        depth: CFG.DEPTH,
        lastMoveDetail,
      });
      break;
    }
    case 'BOT_RESET':
      myColor = null; lastBoardKey = ''; timerHistory = []; _sqCacheTs = 0;
      lastMoveDetail    = null;
      lastComputedKey   = '';
      prevBoardSnapshot = null;
      pendingBoard      = null;
      pendingTurn       = null;
      removeHighlight();
      myColor = detectMyColor();
      updatePanel();
      updateMoveFrame();
      sendResponse({ ok: true });
      break;
    case 'SET_DEPTH': {
      const d = parseInt(msg.depth, 10);
      if (!isNaN(d)) {
        CFG.DEPTH = d;
        const el = document.getElementById('xqb-depth');
        if (el) el.value = String(d);
        chrome.storage.local.set({ depth: d });
      }
      sendResponse({ ok: true });
      break;
    }
    case 'SET_COLOR': {
      const v = msg.color;
      if (v === 'auto')  myColor = detectMyColor();
      else if (v === 'red')   myColor = XQ.RED;
      else if (v === 'black') myColor = XQ.BLACK;
      timerHistory = [];
      updatePanel();
      sendResponse({ ok: true });
      break;
    }
  }
  return true;
});

/* ══════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════ */
LOG('Content script v6.1.1 loaded — Pikafish cloud engine (highlight fix) | URL:', location.href);

// Load saved depth setting
chrome.storage.local.get(['depth'], (data) => {
  if (data.depth !== undefined) CFG.DEPTH = parseInt(data.depth, 10) || 15;
  const el = document.getElementById('xqb-depth');
  if (el) el.value = String(CFG.DEPTH);
});

buildPanel();
setTimeout(buildPanel, 1000);
setTimeout(buildPanel, 3000);
setInterval(updatePanel, 2000);
