import { createApp } from 'vue'
import { router } from './router'
import App from './App.vue'
import './styles/global.css'
import { setupCodeBlockCopyListener } from '../../../shared/code-highlighting.mjs'
import { copyTextToClipboard } from './domain/clipboard'

setupCodeBlockCopyListener(copyTextToClipboard)

const savedTheme = localStorage.getItem('lac-theme') === 'light' ? 'light' : 'dark'
document.documentElement.setAttribute('data-theme', savedTheme)

const app = createApp(App)
app.use(router)
app.mount('#app')
