'use client';

import { useEffect, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import ThemeToggle from '@/components/ThemeToggle';
import Button from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import PropertyDrawer from '@/components/PropertyDrawer';

export default function Page() {
  // dashboard metric cards (live from APIs)
  const [m, setM] = useState({ leads: 0, conversations: 0, bookings: 0, rate: 0 });

  // recent conversations list on home
  const [rows, setRows] = useState([]); // always an array
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [convRes, leadRes, bookRes] = await Promise.all([
          fetch('/api/conversations', { cache: 'no-store' }),
          fetch('/api/leads', { cache: 'no-store' }),
          fetch('/api/bookings', { cache: 'no-store' }),
        ]);
        const [convData, leadData, bookData] = await Promise.all([
          convRes.json(),
          leadRes.json(),
          bookRes.json(),
        ]);

        const convs = Array.isArray(convData?.conversations) ? convData.conversations : [];
        const leadsCount = Number.isFinite(leadData?.count) ? leadData.count : 0;
        const bookings = Number.isFinite(bookData?.count) ? bookData.count : 0;

        setRows(convs);

        const rate =
          leadsCount > 0
            ? Math.round(((bookings / leadsCount) * 100 + Number.EPSILON) * 10) / 10
            : 0;

        setM({
          leads: leadsCount,
          conversations: convs.length,
          bookings,
          rate,
        });
      } catch (e) {
        console.error('Failed to load dashboard data:', e);
        setRows([]);
        setM({ leads: 0, conversations: 0, bookings: 0, rate: 0 });
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // placeholder chart data (swap with real analytics later)
  const d = [
    { label: 'Mon', leads: 3, bookings: 1 },
    { label: 'Tue', leads: 5, bookings: 2 },
    { label: 'Wed', leads: 7, bookings: 3 },
    { label: 'Thu', leads: 10, bookings: 3 },
    { label: 'Fri', leads: 6, bookings: 1 },
  ];

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* top bar */}
      <div className="border-b border-gray-200 dark:border-gray-800">
        <div className="container flex items-center justify-between py-4">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-xl bg-gray-900 dark:bg-gray-100" />
            <h1 className="text-xl font-semibold text-gray-800 dark:text-gray-100">
              AI Leasing Dashboard
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={() => alert('New Property placeholder')}>New Property</Button>
            <ThemeToggle />
          </div>
        </div>
      </div>

      {/* metric cards */}
      <div className="container py-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card>
          <CardHeader><CardTitle>Leads This Month</CardTitle></CardHeader>
          <CardContent><p className="text-3xl font-bold">{m.leads}</p></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Active Conversations</CardTitle></CardHeader>
          <CardContent><p className="text-3xl font-bold">{m.conversations}</p></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Showings Booked</CardTitle></CardHeader>
          <CardContent><p className="text-3xl font-bold">{m.bookings}</p></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Booking Rate</CardTitle></CardHeader>
          <CardContent><p className="text-3xl font-bold">{m.rate}%</p></CardContent>
        </Card>
      </div>

      {/* chart */}
      <div className="container pb-10 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-3">
          <CardHeader><CardTitle>Leads vs Bookings</CardTitle></CardHeader>
          <CardContent>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={d}>
                  <XAxis dataKey="label" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="leads" stroke="#6366f1" strokeWidth={3} dot={false} />
                  <Line type="monotone" dataKey="bookings" stroke="#10b981" strokeWidth={3} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Recent Conversations */}
      <div className="container pb-10 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-3">
          <Card>
            <CardHeader><CardTitle>Recent Conversations</CardTitle></CardHeader>
            <CardContent>
              {loading ? (
                <div className="text-gray-500">Loading…</div>
              ) : rows.length === 0 ? (
                <div className="text-gray-500">No recent conversations yet.</div>
              ) : (
                rows.map((c) => (
                  <a
                    key={c.id}
                    href={`/conversations/${encodeURIComponent(c.id)}`}
                    className="block mb-3 p-3 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition"
                  >
                    <div className="flex justify-between">
                      <p className="font-medium">{c.id}</p>
                      <span className="text-xs text-gray-400">
                        {c.lastTime ? new Date(c.lastTime).toLocaleString() : ''}
                      </span>
                    </div>
                    {c.property && (
                      <p className="text-sm text-gray-600 dark:text-gray-300">
                        <span className="mr-1">Property:</span>
                        <PropertyDrawer slug={c.property} />
                      </p>
                    )}
                    {c.lastMessage && (
                      <p className="text-sm mt-1 text-gray-500 dark:text-gray-400 italic">
                        {c.lastMessage}
                      </p>
                    )}
                  </a>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
