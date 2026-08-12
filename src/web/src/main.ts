import { createApp } from 'vue'
import { router } from './router'
import App from './App.vue'
import './styles/global.css'

const savedTheme = localStorage.getItem('lac-theme') === 'light' ? 'light' : 'dark'
document.documentElement.setAttribute('data-theme', savedTheme)

const app = createApp(App)
app.use(router)
app.mount('#app')
