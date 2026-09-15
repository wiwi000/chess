# XiangqiBot Server

Backend độc lập cho extension, cung cấp HTTP API để chạy Pikafish qua giao thức UCI.

## Cài đặt

Đặt binary `pikafish` và file NNUE vào thư mục này, hoặc dùng:

```bash
export PIKAFISH_BIN=/path/to/pikafish
export PIKAFISH_NNUE=/path/to/nnue-directory
```

Sau đó:

```bash
npm install
npm start
```

Biến môi trường `PORT` mặc định là `3000`.

## Endpoint

- `GET /`: kiểm tra trạng thái server và engine.
- `POST /`: nhận `{ "fen": "...", "depth": 15, "timeLimitMs": 3000 }` và trả về nước đi tốt nhất.

`chat_api.py` là CLI chat tùy chọn, không thuộc luồng xử lý engine của extension.

## Cấu hình API token cho chat

Tạo file `server/.env` từ `.env.example`, sau đó điền token thật:

```bash
cp .env.example .env
```

```env
JUSTWOKER_API_KEY=token_cua_ban
JUSTWOKER_API_URL=https://api.justwoker.icu/v1/chat/completions
JUSTWOKER_MODEL=gpt-4o-mini
```

Cài dependency và chạy:

```bash
pip install -r requirements.txt
python chat_api.py
```

Không commit file `.env` hoặc gửi API token vào chat.