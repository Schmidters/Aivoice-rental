"use client";
import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import ChatBubble from "../../components/ChatBubble";
import ChatInput from "../../components/ChatInput";

export default function ConversationThread() {
  const { id } = useParams();
  const router = useRouter();
  const [messages, setMessages] = useState([]);
  const [leadInfo, setLeadInfo] = useState(null);

  useEffect(() => {
    fetch(`/api/conversations/${id}`)
      .then((res) => res.json())
      .then(setMessages);

    fetch("/api/conversations")
      .then((res) => res.json())
      .then((list) => setLeadInfo(list.find((i) => i.id === id)));
  }, [id]);

  const handleSend = (text) => {
    const newMsg = { sender: "bot", text, time: "just now" };
    setMessages((prev) => [...prev, newMsg]);
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100 flex flex-col">
      <div className="border-b border-gray-200 dark:border-gray-800 p-4 flex justify-between items-center">
        <div>
          <button
            onClick={() => router.push("/conversations")}
            className="text-sm text-gray-500 hover:underline"
          >
            ← Back
          </button>
          <h1 className="text-lg font-semibold">
            {leadInfo
              ? `${leadInfo.lead} - ${leadInfo.property}`
              : "Conversation"}
          </h1>
        </div>
        <div className="flex gap-2">
          <button className="rounded-xl bg-green-500 px-3 py-1 text-sm text-white hover:bg-green-600">
            Book Showing
          </button>
          <button className="rounded-xl bg-gray-300 dark:bg-gray-700 px-3 py-1 text-sm text-gray-900 dark:text-gray-100 hover:opacity-80">
            Mark Closed
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4">
        {messages.map((m, i) => (
          <ChatBubble key={i} {...m} />
        ))}
      </div>

      <ChatInput onSend={handleSend} />
    </div>
  );
}
