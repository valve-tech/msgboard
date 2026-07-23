// FIRST import — sets the global Buffer polyfill before any module (App → ZK witness builders →
// circomlibjs) evaluates and references `Buffer`. Order matters: this must precede the App import.
import './setup-buffer'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
