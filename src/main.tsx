import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import '@fontsource-variable/figtree'
import '@fontsource-variable/fraunces'
import App from './App'
import { applyStoredTheme } from './theme'
import './index.css'

applyStoredTheme()

const root = document.getElementById('root')
if (root === null) throw new Error('index.html has no #root element')

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
