'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

export default function LeadsPage() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchLeads() {
      try {
        const res = await fetch('/api/leads');
        const data = await res.json();
        if (data.ok) setLeads(data.leads);
      } catch (err) {
        console.error('Failed to load leads', err);
      } finally {
        setLoading(false);
      }
    }
    fetchLeads();
  }, []);

  if (loading) return <p className="p-6 text-gray-500">Loading leads...</p>;

  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-6 text-gray-800 dark:text-gray-100">Leads</h1>
      <div className="grid gap-4">
        {leads.map((lead, i) => {
          const phone = lead.key.match(/\+?\d+/)?.[0] || 'Unknown';
          const intent = lead.type === 'string' && lead.data ? lead.data : '';
          const summary =
            lead.key.includes(':summary') && typeof lead.data === 'string'
              ? lead.data.slice(0, 200) + '...'
              : '';

          return (
            <Card key={i} className="hover:bg-gray-50 dark:hover:bg-gray-800 transition">
              <CardHeader>
                <CardTitle>{phone}</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-gray-600 dark:text-gray-300 mb-2">
                  <strong>Type:</strong> {lead.type}
                </p>
                {intent && (
                  <p className="text-gray-600 dark:text-gray-300 mb-2">
                    <strong>Intent:</strong> {intent}
                  </p>
                )}
                {summary && (
                  <p className="text-gray-500 dark:text-gray-400 text-sm mb-2 whitespace-pre-wrap">
                    {summary}
                  </p>
                )}
                <Link
                  href={`/conversations/${phone}`}
                  className="text-indigo-600 hover:text-indigo-800 text-sm font-medium"
                >
                  View Conversation →
                </Link>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
