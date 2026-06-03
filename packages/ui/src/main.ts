import { mount } from 'svelte'
import App from './App.svelte'
import './app.css'
import './lib/theme.svelte' // initialize theme + keep "system" in sync with the OS

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
