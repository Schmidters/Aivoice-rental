'use client';
import { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

export default function BookingsPage() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/bookings', { cache: 'no-store' });
        const j = await r.json();
        if (j.ok) setRows(j.items || []);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) return <div className="p-6 text-gray-500">Loading bookings…</div>;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Bookings</h1>
      <Card>
        <CardHeader>
          <CardTitle>All Bookings ({rows.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <div className="text-gray-500">No bookings found.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left border-b border-gray-200 dark:border-gray-800">
                  <tr>
                    <th className="py-2 pr-4">Key</th>
                    <th className="py-2 pr-4">Phone</th>
                    <th className="py-2 pr-4">Property</th>
                    <th className="py-2 pr-4">Type</th>
                    <th className="py-2">Preview</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className="border-b border-gray-100 dark:border-gray-800">
                      <td className="py-2 pr-4">{r.key}</td>
                      <td className="py-2 pr-4">{r.phone || ''}</td>
                      <td className="py-2 pr-4">{r.property || ''}</td>
                      <td className="py-2 pr-4">{r.type}</td>
                      <td className="py-2 break-all">
                        <pre className="text-xs whitespace-pre-wrap">
                          {typeof r.data === 'string' ? r.data : JSON.stringify(r.data, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
