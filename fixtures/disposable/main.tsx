import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
function Preview() {
  const [message, setMessage] = useState('Connecting to the disposable API…');
  useEffect(() => { fetch('/api/message', { signal: AbortSignal.timeout(5000) }).then(r => { if (!r.ok) throw new Error('API unavailable'); return r.json(); }).then(data => setMessage(data.message)).catch(() => setMessage('API request failed.')); }, []);
  return <p>{message}</p>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
