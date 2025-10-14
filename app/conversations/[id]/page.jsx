'use client';
import { useEffect, useState } from 'react';
import ChatBubble from '@/components/ChatBubble';
import ChatInput from '@/components/ChatInput';
import PropertyDrawer from '@/components/PropertyDrawer';

export default function ConversationDetail({ params }) {
  const id = decodeURIComponent(params.id);
  const [data, setData] = useState(null);
  const [sending, setSending] = useState(false);

  async function load() {
    const r = await fetch(`/api/conversations/${encodeURIComponent(id)}`, { cache: 'no-store' });
    const j = await r.json();
    if (j.ok) setData(j);
  }

  useEffect(() => {
    (async () => {
      // mark read first
      await fetch(`/api/conversations/${encodeURIComponent(id)}/read`, { method: 'POST' });
      await load();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!data) return <div className="p-6 text-gray-500">Loading…</div>;

  async function handleSend(msg) {
    if (!msg || sending) return;
    setSending(true);
    try {
      // optimistic append
      setData((old) => ({
        ...old,
        messages: [...(old?.messages || []), { role: 'assistant', content: msg, t: new Date().toISOString() }]
      }));

      const res = await fetch(`/api/conversations/${encodeURIComponent(id)}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
      });
      const j = await res.json();
      if (!j.ok) {
        alert(j.error || 'Failed to send');
        // optional: roll back optimistic append by reloading thread
        await load();
      }
    } catch (e) {
      alert('Network error sending message');
      await load();
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      <div className="border-b border-gray-200 dark:border-gray-800 p-4">
        <h1 className="text-lg font-semibold">{id}</h1>
        {data.properties?.[0] && (
          <div className="text-sm text-gray-500">
            <PropertyDrawer slug={data.properties[0]} trigger="View property details" />
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {data.messages.map((m, idx) => (
          <div key={idx}>
            <ChatBubble role={m.role} message={m.content} />
            {m.t && (
              <div className="text-[10px] text-gray-400 mt-1 pl-2">
                {new Date(m.t).toLocaleString()}
              </div>
            )}
          </div>
        ))}
      </div>

      <ChatInput onSend={handleSend} />
    </div>
  );
}
