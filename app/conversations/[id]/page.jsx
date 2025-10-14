'use client';
import { useEffect, useState } from 'react';
import ChatBubble from '@/components/ChatBubble';
import ChatInput from '@/components/ChatInput';

export default function ConversationDetail({ params }) {
  const id = decodeURIComponent(params.id);
  const [data, setData] = useState(null);

  useEffect(() => {
    (async () => {
      const r = await fetch(`/api/conversations/${encodeURIComponent(id)}`);
      const j = await r.json();
      if (j.ok) setData(j);
    })();
  }, [id]);

  if (!data) return <div className="p-6 text-gray-500">Loading…</div>;

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      <div className="border-b border-gray-200 dark:border-gray-800 p-4">
        <h1 className="text-lg font-semibold">{id}</h1>
        {data.properties?.[0] && (
          <p className="text-sm text-gray-500">{data.properties[0]}</p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {data.messages.map((m, idx) => (
          <ChatBubble key={idx} role={m.role} message={m.content} />
        ))}
      </div>

      {/* sending will hook to your ai-backend later; for now just echo */}
      <ChatInput onSend={(msg) => {
        // optimistic append
        setData((old) => ({
          ...old,
          messages: [...(old?.messages || []), { role: 'user', content: msg, t: new Date().toISOString() }]
        }));
      }} />
    </div>
  );
}
