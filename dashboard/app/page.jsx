"use client";

import { useEffect, useState } from "react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";
import ThemeToggle from "@/components/ThemeToggle";
import Button from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export default function Page() {
  const [metrics, setMetrics] = useState({ leads: 0, conversations: 0, bookings: 0, rate: 0 });
  const [recent, setRecent] = useState([]);

  useEffect(() => {
    // Mock data load
    setMetrics({ leads: 58, conversations: 12, bookings: 9, rate: 15.5 });
    setRecent([
      { id: 1, message: "Lead from Jamie Chen for 215 16 St SE", time: "2m ago" },
      { id: 2, message: "AI booked viewing for Bevis", time: "15m ago" },
      { id: 3, message: "New inquiry received (parser)", time: "1h ago" },
    ]);
  }, []);

  const chartData = [
    { label: "Mon", leads: 3, bookings: 1 },
    { label: "Tue", leads: 5, bookings: 2 },
    { label: "Wed", leads: 7, bookings: 3 },
    { label: "Thu", leads: 10, bookings: 3 },
    { label: "Fri", leads: 6, bookings: 1 },
  ];

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Top Bar */}
      <div className="border-b border-gray-200 dark:border-gray-800">
        <div className="container flex items-center justify-between py-4">
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-xl bg-gray-900 dark:bg-gray-100" />
            <h1 className="text-xl font-semibold text-gray-800 dark:text-gray-100">AI Leasing Dashboard</h1>
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={() => alert('New Property (placeholder)')}>New Property</Button>
            <ThemeToggle />
          </div>
        </div>
      </div>

      {/* Metrics */}
      <div className="container py-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card>
          <CardHeader><CardTitle>Leads This Month</CardTitle></CardHeader>
          <CardContent><p className="text-3xl font-bold text-gray-900 dark:text-gray-100">{metrics.leads}</p></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Active Conversations</CardTitle></CardHeader>
          <CardContent><p className="text-3xl font-bold text-gray-900 dark:text-gray-100">{metrics.conversations}</p></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Showings Booked</CardTitle></CardHeader>
          <CardContent><p className="text-3xl font-bold text-gray-900 dark:text-gray-100">{metrics.bookings}</p></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Booking Rate</CardTitle></CardHeader>
          <CardContent><p className="text-3xl font-bold text-gray-900 dark:text-gray-100">{metrics.rate}%</p></CardContent>
        </Card>
      </div>

      {/* Chart + Activity */}
      <div className="container pb-10 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>Leads vs Bookings</CardTitle></CardHeader>
          <CardContent>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData}>
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

        <Card>
          <CardHeader><CardTitle>Recent Activity</CardTitle></CardHeader>
          <CardContent>
            <ul className="space-y-4">
              {recent.map(item => (
                <li key={item.id} className="flex justify-between items-center border-b border-gray-200 dark:border-gray-800 pb-3">
                  <span className="text-gray-700 dark:text-gray-300">{item.message}</span>
                  <span className="text-xs text-gray-400">{item.time}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
