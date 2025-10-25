"use client";

import { useEffect, useState } from "react";
import LoadingState from "@/components/ui/LoadingState"; // we’ll add this if missing
import PageHeader from "@/components/ui/PageHeader"; // reusable header
import { cn } from "@/lib/utils";

export default function InboxPage() {
  const [threads, setThreads] = useState([]);
  const [loading, setLoading] = useState(true);

  async function loadConversations() {
    try {
      const res = await fetch(
        `${process.env.NEXT_PUBLIC_AI_BACKEND_URL}/api/conversations`
      );
      const json = await res.json();
      if (json.ok) setThreads(json.conversations || []);
    } catch (err) {
      console.error("Failed to load conversations:", err);
    }
    setLoading(false);
  }

  useEffect(() => {
    loadConversations();
  }, []);

  if (loading) return <LoadingState label="Loading conversations..." />;

  return (
    <div>
      <PageHeader title="Inbox" />

      {threads.length === 0 ? (
        <div className="mt-10 text-center text-gray-500">
          No conversations yet.
        </div>
      ) : (
        <div className="grid gap-3">
          {threads.map((t) => (
            <div
              key={t.id}
              className={cn(
                "rounded-xl border bg-white p-4 shadow-sm hover:bg-gray-50 transition-all"
              )}
            >
              <div className="text-sm text-gray-500">{t.property || "—"}</div>
              <div className="mt-1 font-medium">{t.lastMessage}</div>
              <div className="text-xs text-gray-400">
                {new Date(t.lastTime).toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
