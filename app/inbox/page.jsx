"use client";

import { useEffect, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";

export default function InboxPage() {
  const [conversations, setConversations] = useState([]);
  const [selected, setSelected] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);

  const BACKEND = process.env.NEXT_PUBLIC_AI_BACKEND_URL;

  // 📨 Load all conversations (just metadata)
  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`${BACKEND}/api/conversations`);
        const json = await res.json();
        if (json.ok) {
          setConversations(json.data || []);
          // 👇 Auto-select first conversation on load
          if (json.data?.length && !selected) {
            const first = json.data[0];
            loadThread(first.phone);
          }
        }
      } catch (err) {
        console.error("Failed to load conversations:", err);
      }
    }
    load();
  }, [BACKEND]);

  // 💬 Load selected conversation messages
  async function loadThread(phone) {
    setSelected(phone);
    setLoading(true);
    try {
      const res = await fetch(`${BACKEND}/api/conversations/${encodeURIComponent(phone)}`);
      const json = await res.json();
      if (json.ok) setMessages(json.messages || []);
    } catch (err) {
      console.error("Failed to load thread:", err);
    } finally {
      setLoading(false);
    }
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
                selected === c.phone ? "bg-gray-100 border-l-4 border-indigo-500" : ""
              }`}
            >
              <p className="font-semibold text-gray-900">{c.leadName || c.phone}</p>
              <p className="text-sm text-gray-500 truncate">{c.lastMessage}</p>
              <div className="text-xs text-gray-400 mt-1">{c.propertySlug || ""}</div>
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
                <div className="text-gray-400 text-center mt-10">Loading messages...</div>
              ) : (
                messages.map((m, i) => (
                  <Card
                    key={i}
                    className={`max-w-xl ${
                      m.sender === "ai"
                        ? "self-start bg-indigo-50"
                        : "self-end bg-gray-100"
                    }`}
                  >
                    <CardContent className="p-3">
                      <p className="text-gray-800">{m.text}</p>
                      <p className="text-xs text-gray-400 mt-1">
                        {new Date(m.createdAt).toLocaleString()}
                      </p>
                    </CardContent>
                  </Card>
                ))
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
    </div>
  );
}
