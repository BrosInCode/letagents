import { createApp } from "vue";
import MessageViewportHarness from "./MessageViewportHarness.vue";
import "../../renderer/src/styles.css";

// Dev-only page for RoomMessageViewport with fake messages; no preload bridge.
// Vite builds only apps/desktop/index.html, so this page is never part of the
// packaged renderer.
//
// Open it:
//   cd apps/desktop && npm run dev:renderer
//   http://127.0.0.1:5174/demos/message-viewport/index.html?n=2000
// Query: n = loaded messages (default 2000), older = messages the fake server
// still holds for "load older" (default 300, pages of 50).
// window.__viewportHarness has remount(), appendMessage(), jump(id), search(q),
// stepSearch(1|-1), switchRoom(), openThread(id) and snapshot() for scripted checks.
createApp(MessageViewportHarness).mount("#app");
