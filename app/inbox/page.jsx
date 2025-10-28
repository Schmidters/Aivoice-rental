"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";

export default function InboxPage() {
  const [conversations, setConversations] = useState([]);
  const [selected, setSelected] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);
  const esRef = useRef(null);

  const BACKEND = process.env.NEXT_PUBLIC_AI_BACKEND_URL || "";

  // 🧠 Helper: strip trailing slashes
  const backendBase = useMemo(() => BACKEND.replace(/\/$/, ""), [BACKEND]);

  // 📨 Load all conversations (metadata)
  async function loadConversations() {
    try {
      const res = await fetch(`${backendBase}/api/conversations`);
      const json = await res.json();
      if (json.ok) {
        setConversations(json.data || []);
        if (!selected && json.data?.length) {
          const first = json.data[0];
          loadThread(first.phone);
        }
      }
    } catch (err) {
      console.error("Failed to load conversations:", err);
    }
  }

  useEffect(() => {
    loadConversations();
    const interval = setInterval(loadConversations, 30000); // 🔁 auto-refresh metadata
    return () => clearInterval(interval);
  }, [backendBase]);

  // 💬 Load selected conversation
async function loadThread(phone) {
  setSelected(phone);
  setLoading(true);
  try {
    // ✅ FIX: use the actual backend endpoint that exists
    const res = await fetch(`${backendBase}/history/${encodeURIComponent(phone)}`);
    const json = await res.json();
    if (json.ok) setMessages(json.messages || []);
  } catch (err) {
    console.error("Failed to load thread:", err);
  } finally {
    setLoading(false);
  }

  // 🔌 Close previous SSE connection
  if (esRef.current) {
    esRef.current.close();
    esRef.current = null;
  }

  // 🧠 Subscribe to SSE for live updates
  const es = new EventSource(`${backendBase}/events/conversation/${encodeURIComponent(phone)}`);

  es.onmessage = (e) => {
    try {
      const evt = JSON.parse(e.data);
      if (evt.type === "message" && evt.item) {
        setMessages((msgs) => [...msgs, evt.item]);
        // 🔼 Move updated conversation to top
        setConversations((prev) => {
          const idx = prev.findIndex((c) => c.phone === phone);
          if (idx === -1) return prev;
          const updated = {
            ...prev[idx],
            lastMessage: evt.item.content,
            lastTime: evt.item.t,
          };
          const rest = [...prev.slice(0, idx), ...prev.slice(idx + 1)];
          return [updated, ...rest];
        });
      }
    } catch (err) {
      console.warn("SSE parse error:", err);
    }
  };

  es.onerror = (err) => console.warn("SSE error:", err);
  esRef.current = es;
}

return (
  <div className="flex h-[calc(100vh-80px)] bg-gray-50">
    {/* LEFT PANEL */}
    <div className="w-80 border-r border-gray-200 bg-white flex flex-col">
      <div className="p-4 border-b bg-gray-100">
        <Input placeholder="Search leads..." />
      </div>

      <ScrollArea className="flex-1">
        {conversations.length === 0 && (
          <p className="text-gray-500 p-4">No conversations yet</p>
        )}

        {conversations.map((c) => (
          <div
            key={c.id}
            onClick={() => loadThread(c.phone)}
            className={`p-3 cursor-pointer border-b hover:bg-gray-100 ${
              selected === c.phone
                ? "bg-gray-100 border-l-4 border-indigo-500"
                : ""
            }`}
          >
            <p className="font-semibold text-gray-900">
              {c.leadName || c.phone}
            </p>
            <p className="text-sm text-gray-500 truncate">{c.lastMessage}</p>
            <div className="text-xs text-gray-400 mt-1">
              {c.propertySlug || ""}
            </div>
          </div>
        ))}
      </ScrollArea>
    </div>

    {/* RIGHT PANEL */}
    <div className="flex-1 flex flex-col">
      {selected ? (
        <>
          <div className="p-4 border-b bg-white">
            <h2 className="text-lg font-semibold">{selected}</h2>
          </div>

          <ScrollArea className="flex-1 p-4 space-y-3">
            {loading ? (
              <div className="text-gray-400 text-center mt-10">
                Loading messages...
              </div>
            ) : (
              messages.map((m, i) => {
                const text = m.text || m.content || "(no message)";
                const timeRaw = m.createdAt || m.t;
                const time =
                  timeRaw && !isNaN(new Date(timeRaw))
                    ? new Date(timeRaw).toLocaleString()
                    : "Unknown time";

                return (
                  <Card
                    key={i}
                    className={`max-w-xl ${
                      m.sender === "ai"
                        ? "self-start bg-indigo-50"
                        : "self-end bg-gray-100"
                    }`}
                  >
                    <CardContent className="p-3">
                      <p className="text-gray-800">{text}</p>
                      <p className="text-xs text-gray-400 mt-1">{time}</p>
                    </CardContent>
                  </Card>
                );
              })
            )}
          </ScrollArea>

          <div className="p-4 border-t bg-white flex gap-2">
            <Input placeholder="Type a message..." className="flex-1" />
            <Button>Send</Button>
          </div>
        </>
      ) : (
        <div className="flex items-center justify-center flex-1 text-gray-500">
          Select a conversation to view messages
        </div>
      )}
    </div>
  </div> // ✅ closes outermost div
);
}