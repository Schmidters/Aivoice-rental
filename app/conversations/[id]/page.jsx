'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import ChatBubble from '@/components/ChatBubble';
import ChatInput from '@/components/ChatInput';

export default function ConversationPage({ params }) {
  const id = decodeURIComponent(params.id); // phone in E.164
  const [data, setData] = useState(null);
  const [sending, setSending] = useState(false);
  const listRef = useRef(null);

  const aiBackendBase = useMemo(() => {
    const b = process.env.NEXT_PUBLIC_AI_BACKEND_URL || '';
    return b.replace(/\/$/, '');
  }, []);

  // 🔹 Load initial conversation history
  async function load() {
    try {
      const url = `/api/conversations/${encodeURIComponent(id)}`;
      console.log('Fetching from:', url);
      const r = await fetch(url, { cache: 'no-store' });
      const j = await r.json();
      console.log('📦 Conversation data received:', j);

      if (j?.ok) {
        setData({
          ok: true,
          id,
          lead: j.lead,
          mode: j.mode || 'auto',
          handoffReason: j.handoffReason || '',
          owner: j.owner || '',
          messages: j.messages || [],
          properties: j.properties || [],
        });
      }
    } catch (err) {
      console.error('Failed to load conversation history:', err);
    }
  }

  // 🔹 Scroll to bottom when messages update
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [data?.messages?.length]);

  // 🔹 SSE live updates
  useEffect(() => {
    load(); // Initial fetch

    if (!aiBackendBase) return;
    const url = `${aiBackendBase}/events/conversation/${encodeURIComponent(id)}`;
    const es = new EventSource(url, { withCredentials: false });

    es.onmessage = (e) => {
      try {
        const evt = JSON.parse(e.data);
        if (evt.type === 'snapshot') {
          setData((d) => ({
            ...d,
            mode: evt.mode || 'auto',
            handoffReason: evt.handoffReason || '',
            owner: evt.owner || d?.owner || '',
          }));
        } else if (evt.type === 'message' && evt.item) {
          setData((d) => ({
            ...d,
            messages: [...(d?.messages || []), evt.item],
          }));
        } else if (evt.type === 'mode') {
          setData((d) => ({
            ...d,
            mode: evt.mode || d?.mode,
            handoffReason: evt.handoffReason || '',
            owner: evt.owner || d?.owner || '',
          }));
        }
      } catch (err) {
        console.warn('SSE parse error:', err);
      }
    };

    es.addEventListener('ping', () => {}); // heartbeat
    es.onerror = (e) => console.warn('SSE error:', e);

    return () => es.close();
  }, [id, aiBackendBase]);

  // 🔹 Send human message (switches to human mode)
  async function onSend(text) {
    if (!text?.trim()) return;
    setSending(true);
    try {
      const r = await fetch(`/api/conversations/${encodeURIComponent(id)}/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      await r.json().catch(() => ({}));
    } finally {
      setSending(false);
    }
  }

  // 🧱 If still loading
  if (!data) {
    return (
      <div className="flex h-[calc(100vh-64px)] items-center justify-center text-gray-500">
        Loading conversation...
      </div>
    );
  }

  const isHuman = data.mode === 'human';

  // 🔹 Render
  return (
    <div className="flex h-[calc(100vh-64px)] flex-col">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex flex-col">
          <h2 className="text-lg font-semibold">{data.lead || id}</h2>
          <div className="flex items-center gap-2">
            <ModeChip mode={data.mode} reason={data.handoffReason} owner={data.owner} />
            {!!data.properties?.length && (
              <span className="text-xs text-gray-500">
                Linked: {data.properties.join(', ')}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto bg-white p-4 dark:bg-gray-900"
      >
        {(data.messages || []).map((m, idx) => (
          <ChatBubble
            key={idx}
            role={m.role} // 'user' | 'assistant' | 'agent'
            text={m.content}
            time={m.t}
            meta={m.meta}
          />
        ))}
      </div>

      {/* Composer */}
      <div className="border-t p-3">
        <ChatInput
          disabled={sending}
          placeholder={
            isHuman
              ? 'Reply as leasing agent…'
              : 'AI is active. Replying will switch to human mode.'
          }
          onSend={onSend}
        />
      </div>
    </div>
  );
}

function ModeChip({ mode, reason, owner }) {
  if (mode === 'human') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-200">
        Human mode
        {owner ? <span className="opacity-70">• {owner}</span> : null}
        {reason ? <span className="opacity-70">• {reason}</span> : null}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200">
      AI mode
    </span>
  );
}
