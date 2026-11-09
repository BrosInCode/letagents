import { createApp } from "vue";
import "../../renderer/src/styles.css";
import { installFakeReceiptBridge } from "./fake-receipts";
import MessageReceiptsHarness from "./MessageReceiptsHarness.vue";

// Dev-only page for the receipt mark and popover with a fake bridge; no server.
// Vite builds only apps/desktop/index.html, so this page is never packaged.
//
// Open it:
//   cd apps/desktop && npm run dev:renderer
//   http://127.0.0.1:5174/demos/message-receipts/index.html
installFakeReceiptBridge();
createApp(MessageReceiptsHarness).mount("#app");
