import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../common/styles.css';
import App from './App.js';
import { store } from '../common/store.js';

// Wire up the handler for Cast codes arriving after React boots.
// Codes that arrived before React loaded are stored in window.__castPendingCode
// by the inline script in receiver.html.
(window as any).__castOnCode = (code: string) => void store.receiverSubscribe(code);
const pending = (window as any).__castPendingCode as string | null;
if (pending) void store.receiverSubscribe(pending);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
