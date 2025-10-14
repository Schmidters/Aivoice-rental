'use client';
import { useEffect, useState } from 'react';
import ChatBubble from '@/components/ChatBubble';
import ChatInput from '@/components/ChatInput';

export default function ConversationDetail({ params }) {
  const id = decodeURIComponent(params.id);
  const [data, setData] = useState(null);

  useEffect(() => {
    (async () => {
      // mark read ASAP
      await fetch(`/api/conversations/${encodeURIComponent(id)}/read`, { method: 'POST' });
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

      <ChatInput onSend={(msg) => {
        // optimistic append (backend send hook later)
        setData((old) => ({
          ...old,
          messages: [...(old?.messages || []), { role: 'user', content: msg, t: new Date().toISOString() }]
        }));
      }} />
    </div>
  );
}
