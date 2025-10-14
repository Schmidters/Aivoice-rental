'use client';
import { useEffect, useState } from 'react';

export default function useUnreadCount(pollMs = 15000) {
  const [count, setCount] = useState(0);

  async function load() {
    try {
      const r = await fetch('/api/conversations', { cache: 'no-store' });
      const j = await r.json();
      if (j?.ok && Array.isArray(j.conversations)) {
        setCount(j.conversations.filter(c => c.unread).length);
      } else {
        setCount(0);
      }
    } catch {
      setCount(0);
    }
  }

  useEffect(() => {
    load();
    const id = setInterval(load, pollMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return count;
}
