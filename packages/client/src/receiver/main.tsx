import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../common/styles.css';
import App from './App.js';
import { store } from '../common/store.js';
import { CAST_NAMESPACE } from '../common/cast.js';

// Initialize Cast before React mounts so listeners are registered immediately,
// before the sender's retries fire and before SENDER_CONNECTED can be missed.
const _cast = (window as { cast?: any }).cast;
if (_cast?.framework?.CastReceiverContext) {
  const ctx = _cast.framework.CastReceiverContext.getInstance();
  ctx.addEventListener(_cast.framework.system.EventType.SENDER_CONNECTED, (event: any) => {
    try { ctx.sendCustomMessage(CAST_NAMESPACE, event.senderId, { type: 'ready' }); } catch { /* noop */ }
  });
  ctx.addCustomMessageListener(CAST_NAMESPACE, (event: any) => {
    const code = event?.data?.code;
    if (code) void store.receiverSubscribe(String(code));
  });
  ctx.start();
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
