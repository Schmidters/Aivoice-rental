"use client";
import { useEffect, useState } from "react";
import Link from "next/link";

export default function ConversationsPage() {
  const [conversations, setConversations] = useState([]);

  useEffect(() => {
    fetch("/api/conversations")
      .then((res) => res.json())
      .then(setConversations);
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100">
      <div className="container py-8">
        <h1 className="text-2xl font-bold mb-6">Conversations</h1>
        <div className="space-y-4">
          {conversations.map((c) => (
            <Link
              key={c.id}
              href={`/conversations/${c.id}`}
              className="block rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 hover:bg-gray-100 dark:hover:bg-gray-700 transition"
            >
              <div className="flex justify-between items-center mb-1">
                <h2 className="font-semibold">{c.lead}</h2>
                <span className="text-xs text-gray-400">{c.time}</span>
              </div>
              <p className="text-sm text-gray-600 dark:text-gray-300">
                {c.property}
              </p>
              <p className="text-sm mt-1 text-gray-500 dark:text-gray-400 italic">
                {c.lastMessage}
              </p>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
