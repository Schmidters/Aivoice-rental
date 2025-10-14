'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

export default function ConversationsPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/conversations');
        const data = await r.json();
        if (data.ok) setRows(data.conversations);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div className="p-6 text-gray-500">Loading conversations…</div>;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Conversations</h1>
      <div className="grid gap-4">
        {rows.map((c) => (
          <Card key={c.id} className="hover:bg-gray-50 dark:hover:bg-gray-800 transition">
            <CardHeader>
              <CardTitle>{c.id}</CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-1">
              {c.property && <p><strong>Property:</strong> {c.property}</p>}
              {c.intent && <p><strong>Intent:</strong> {c.intent}</p>}
              {c.lastMessage && (
                <p className="italic text-gray-600 dark:text-gray-300">
                  “{c.lastMessage}”
                  {c.lastTime && <span className="ml-2 text-xs text-gray-400">({new Date(c.lastTime).toLocaleString()})</span>}
                </p>
              )}
              <Link className="text-indigo-600 hover:text-indigo-800 text-sm font-medium"
                    href={`/conversations/${encodeURIComponent(c.id)}`}>
                Open →
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
