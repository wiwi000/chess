'use strict';
/* =========================================================
   XiangqiBot — Background Service Worker v6.0.0

   Architecture v6.0 (Cloud Engine):
   - Engine đã chuyển lên Cloudflare Worker (Pikafish WASM)
   - content.js gọi engine trực tiếp qua fetch() — không cần
     Offscreen Document hay message relay phức tạp nữa.

   Trách nhiệm còn lại của background.js:
   1. Relay tin nhắn từ popup → content script
   ========================================================= */

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ highlightEnabled: false });
  console.log('[XiangqiBot] Installed v6.0.0 — Pikafish cloud engine');
});

/* ── Message router ─────────────────────────────────────── */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  /* ── Relay: popup → content script ── */
  if (msg.target === 'content') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) {
        sendResponse({ ok: false, err: 'no active tab' });
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, msg, (resp) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, err: chrome.runtime.lastError.message });
        } else {
          sendResponse(resp || { ok: false, err: 'no response' });
        }
      });
    });
    return true;
  }
});
