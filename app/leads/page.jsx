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
        {leads.map((lead, i) => (
          <Card key={i} className="hover:bg-gray-50 dark:hover:bg-gray-800 transition">
            <CardHeader>
              <CardTitle>{lead.phone || 'Unknown Lead'}</CardTitle>
            </CardHeader>
            <CardContent>
              {lead.property && (
                <p className="text-gray-600 dark:text-gray-300 mb-1">
                  <strong>Property:</strong> {lead.property}
                </p>
              )}
              {lead.intent && (
                <p className="text-gray-600 dark:text-gray-300 mb-1">
                  <strong>Intent:</strong> {lead.intent}
                </p>
              )}
              {lead.lastMessage && (
                <p className="text-gray-500 dark:text-gray-400 text-sm mb-2 italic">
                  “{lead.lastMessage}”
                </p>
              )}
              {lead.summary && (
                <p className="text-gray-500 dark:text-gray-400 text-xs whitespace-pre-wrap mb-2">
                  {lead.summary}
                </p>
              )}
              <Link
                href={`/conversations/${lead.phone}`}
                className="text-indigo-600 hover:text-indigo-800 text-sm font-medium"
              >
                View Conversation →
              </Link>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
