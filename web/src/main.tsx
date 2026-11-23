import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App as NativeApp } from '@capacitor/app'
import App from './App'
import './index.css'
import { isNative, loadToken } from './platform'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } },
})

if (isNative) {
  // Android back button: go back in the app, and leave it from the first screen.
  void NativeApp.addListener('backButton', ({ canGoBack }) => {
    if (canGoBack) window.history.back()
    else void NativeApp.exitApp()
  })
}

// The app's sign-in token lives in native storage; read it before the first request.
await loadToken()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
