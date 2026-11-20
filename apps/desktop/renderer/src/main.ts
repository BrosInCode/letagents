import { createApp } from "vue";
import App from "./App.vue";
import "./styles.css";
import { setupCodeBlockCopyListener } from "../../../../shared/code-highlighting.mjs";
import { copyTextToClipboard } from "../../../../shared/ui/clipboard";

setupCodeBlockCopyListener(copyTextToClipboard);

createApp(App).mount("#app");
