/**
 * XiangqiBot — Pikafish API Server v1.0.0
 *
 * Bọc Pikafish binary (UCI stdin/stdout) thành HTTP API.
 * Extension gọi: POST / với { fen, depth, timeLimitMs }
 *                          → { move: "h2e2" }
 *
 * Cách dùng:
 *   1. Đặt binary Pikafish Linux vào thư mục này, đặt tên là "pikafish"
 *      (từ thư mục Linux/ trong release zip của bạn)
 *   2. chmod +x pikafish
 *   3. npm install && node server.js
 */

import express     from 'express';
import cors        from 'cors';
import { spawn }   from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs          from 'fs';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const PORT       = process.env.PORT || 3000;
const BIN_PATH   = process.env.PIKAFISH_BIN  || join(__dirname, 'pikafish');
const NNUE_DIR   = process.env.PIKAFISH_NNUE || __dirname;   // thư mục chứa pikafish.nnue

/* ── Kiểm tra binary tồn tại ────────────────────────────── */
if (!fs.existsSync(BIN_PATH)) {
  console.error(`[Server] Pikafish binary không tìm thấy: ${BIN_PATH}`);
  console.error('[Server] Đặt file "pikafish" (Linux binary) vào cùng thư mục với server.js');
  process.exit(1);
}

/* ── Pikafish process singleton ─────────────────────────── */
let _proc      = null;
let _ready     = false;
let _listeners = [];
let _queue     = Promise.resolve();

function onLine(line) {
  line = line.trim();
  if (!line) return;
  // console.log('[Pikafish]', line);   // bỏ comment để debug
  for (const fn of [..._listeners]) fn(line);
}

function waitFor(predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      _listeners = _listeners.filter(f => f !== handler);
      reject(new Error(`Timeout ${timeoutMs}ms chờ engine`));
    }, timeoutMs);
    function handler(line) {
      if (predicate(line)) {
        clearTimeout(t);
        _listeners = _listeners.filter(f => f !== handler);
        resolve(line);
      }
    }
    _listeners.push(handler);
  });
}

function send(cmd) {
  if (!_proc || _proc.stdin.destroyed) return;
  try {
    _proc.stdin.write(cmd + '\n');
  } catch (e) {
    // Bỏ qua EPIPE — process đã thoát
  }
}

async function startEngine() {
  _ready = false;

  _proc = spawn(BIN_PATH, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: NNUE_DIR,   // Pikafish tìm pikafish.nnue theo cwd
  });

  // Bắt lỗi stdin EPIPE — tránh crash Node khi binary thoát sớm
  _proc.stdin.on('error', () => {});

  let buf = '';
  _proc.stdout.on('data', chunk => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop();               // giữ dòng chưa kết thúc
    for (const l of lines) onLine(l);
  });

  _proc.stderr.on('data', d => console.error('[Pikafish STDERR]', d.toString().trim()));

  _proc.on('close', code => {
    console.warn(`[Server] Pikafish thoát (code ${code}) — khởi động lại sau 2s...`);
    _ready = false;
    _proc  = null;
    setTimeout(startEngine, 2000);
  });

  // UCI handshake
  send('uci');
  await waitFor(l => l === 'uciok', 10000);

  send('isready');
  await waitFor(l => l === 'readyok', 10000);

  // Cấu hình — điều chỉnh theo RAM server
  send('setoption name Hash value 128');
  send('setoption name Threads value 2');
  send('setoption name MultiPV value 1');

  _ready = true;
  console.log('[Server] Pikafish ready — xiangqi engine active');
}

/* ── Search ─────────────────────────────────────────────── */
function enqueue(fn) {
  const next = _queue.then(fn);
  _queue = next.catch(() => {});
  return next;
}

async function search(fen, depth, timeLimitMs) {
  if (!_ready) throw new Error('Engine chưa sẵn sàng');

  // Dừng search cũ
  send('stop');
  await waitFor(l => l.startsWith('bestmove'), 1000).catch(() => {});

  send('position fen ' + fen);
  send('isready');
  await waitFor(l => l === 'readyok', 5000);

  if (depth && depth > 0) {
    send('go depth ' + depth);
  } else {
    const ms = Math.max(100, Math.min(timeLimitMs || 3000, 30000));
    send('go movetime ' + ms);
  }

  const bestLine = await waitFor(l => l.startsWith('bestmove'), 120000);
  const move = bestLine.split(/\s+/)[1];
  if (!move || move === '(none)') return null;
  return move.toLowerCase();
}

/* ── Express server ─────────────────────────────────────── */
const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', engine: 'pikafish', ready: _ready });
});

// Engine endpoint
app.post('/', async (req, res) => {
  const { fen, depth = 15, timeLimitMs = 3000 } = req.body || {};

  if (!fen || typeof fen !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid "fen" field' });
  }
  if (!_ready) {
    return res.status(503).json({ error: 'Engine chưa sẵn sàng — thử lại sau' });
  }

  try {
    const move = await enqueue(() => search(fen, depth, timeLimitMs));
    res.json({ move: move || null });
  } catch (err) {
    console.error('[Server] Search error:', err.message);
    res.status(500).json({ error: String(err.message) });
  }
});

/* ── Start ──────────────────────────────────────────────── */
// HTTP server khởi động ngay — Railway cần app bind port trước
app.listen(PORT, () => {
  console.log(`[Server] Listening on port ${PORT}`);
  // Engine khởi động sau, không block HTTP
  startEngine().catch(err => {
    console.error('[Server] Engine init failed:', err.message);
    // Tự thử lại sau 5s thay vì crash toàn server
    setTimeout(() => startEngine().catch(() => {}), 5000);
  });
});
