#!/usr/bin/env python3
import os
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv

load_dotenv(Path(__file__).with_name(".env"))

API_URL = os.getenv("JUSTWOKER_API_URL", "https://api.justwoker.icu/v1/chat/completions")
MODEL = os.getenv("JUSTWOKER_MODEL", "gpt-4o-mini")


def get_api_key():
    api_key = os.getenv("JUSTWOKER_API_KEY")
    if not api_key:
        raise RuntimeError(
            "Thiếu biến môi trường JUSTWOKER_API_KEY.\n"
            "Hãy chạy: export JUSTWOKER_API_KEY='your_key_here'\n"
            "Hoặc tạo file .env theo mẫu .env.example"
        )
    return api_key


def chat_once(messages):
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {get_api_key()}",
    }

    payload = {
        "model": MODEL,
        "messages": messages,
    }

    response = requests.post(API_URL, headers=headers, json=payload, timeout=60)

    try:
        data = response.json()
    except ValueError:
        raise RuntimeError(f"Phản hồi không hợp lệ từ API: {response.text}")

    if response.status_code >= 400:
        error_msg = data.get("error", {}).get("message", response.text)
        raise RuntimeError(f"API lỗi ({response.status_code}): {error_msg}")

    return data["choices"][0]["message"]["content"]


def main():
    messages = [
        {
            "role": "system",
            "content": "Bạn là trợ lý AI thân thiện, trả lời ngắn gọn, rõ ràng và dễ hiểu.",
        }
    ]

    print("Bắt đầu hội thoại với API JustWoker.")
    print("Gõ 'exit' để thoát.")

    while True:
        user_input = input("Bạn: ").strip()
        if not user_input:
            continue
        if user_input.lower() in {"exit", "quit", "bye"}:
            print("Tạm biệt!")
            break

        messages.append({"role": "user", "content": user_input})

        try:
            reply = chat_once(messages)
        except Exception as exc:
            print(f"Lỗi: {exc}", file=sys.stderr)
            break

        print(f"AI: {reply}")
        messages.append({"role": "assistant", "content": reply})


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nDừng hội thoại.")
        sys.exit(0)
