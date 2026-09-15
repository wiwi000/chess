# XiangqiBot

Repo này gồm hai phần độc lập:

- Extension Chrome ở thư mục gốc: `manifest.json`, `content.js`, `popup.js` và `background.js`.
- Backend Pikafish ở [server](server): HTTP API bọc engine UCI.

Extension hiện mặc định chạy Pikafish WebAssembly trực tiếp trong Web Worker,
không cần backend hoặc URL forwarding. Module WASM đã đóng gói mạng NNUE trong
`pikafish.data`. Có thể đổi sang `mock` khi cần debug; chế độ này chỉ có bộ
đánh giá chiến thuật nông và không thay thế Pikafish.

## Chạy backend

Đặt binary `pikafish` và file `pikafish.nnue` vào `server/` (hoặc cấu hình `PIKAFISH_BIN` và `PIKAFISH_NNUE`), sau đó chạy:

```bash
cd server
npm install
npm start
```

API mặc định lắng nghe ở `http://localhost:3000`. Có thể đổi cổng bằng biến môi trường `PORT`.

Khi URL Codespaces thay đổi hoặc deploy server lên domain khác, đổi `WORKER_URL`
trong `content.js` và URL tương ứng trong `host_permissions` của `manifest.json`.

## Chat API

`server/chat_api.py` là CLI tùy chọn, dùng dependency trong `server/requirements.txt` và các biến môi trường trong `server/.env.example`.