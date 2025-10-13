"use client";

import { useEffect, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import ThemeToggle from "@/components/ThemeToggle";
import Button from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

export default function Page() {
  const [metrics, setMetrics] = useState({
    leads: 0,
    conversations: 0,
    bookings: 0,
    rate: 0,
  });
  const [recentActivity, setRecentActivity] = useState([]);
  const [recentChats, setRecentChats] = useState([]);

  useEffect(() => {
    // Mock dashboard data
    setMetrics({ leads: 58, conversations: 12, bookings: 9, rate: 15.5 });
    setRecentActivity([
      { id: 1, message: "Lead from Jamie Chen for 215 16 St SE", time: "2m ago" },
      { id: 2, message: "AI booked viewing for Bevis", time: "15m ago" },
      { id: 3, message: "New inquiry received (parser)", time: "1h ago" },
    ]);

    // Fetch mock conversations dynamically
    fetch("/api/conversations")
      .then((res) => res.json())
      .then((data) => setRecentChats(data.slice(0, 3))) // only show top 3
      .catch(() => setRecentChats([]));
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
            <h1 className="text-xl font-semibold text-gray-800 dark:text-gray-100">
              AI Leasing Dashboard
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={() => alert("New Property (placeholder)")}>
              New Property
            </Button>
            <ThemeToggle />
          </div>
        </div>
      </div>

      {/* Metric Cards */}
      <div className="container py-8 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Leads This Month</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-gray-900 dark:text-gray-100">
              {metrics.leads}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Active Conversations</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-gray-900 dark:text-gray-100">
              {metrics.conversations}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Showings Booked</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-gray-900 dark:text-gray-100">
              {metrics.bookings}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Booking Rate</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-gray-900 dark:text-gray-100">
              {metrics.rate}%
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Chart + Activity */}
      <div className="container pb-10 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Leads vs Bookings</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData}>
                  <XAxis dataKey="label" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Line
                    type="monotone"
                    dataKey="leads"
                    stroke="#6366f1"
                    strokeWidth={3}
                    dot={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="bookings"
                    stroke="#10b981"
                    strokeWidth={3}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent Activity</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-4">
              {recentActivity.map((item) => (
                <li
                  key={item.id}
                  className="flex justify-between items-center border-b border-gray-200 dark:border-gray-800 pb-3"
                >
                  <span className="text-gray-700 dark:text-gray-300">
                    {item.message}
                  </span>
                  <span className="text-xs text-gray-400">{item.time}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      {/* Recent Conversations Tile */}
      <div className="container pb-10 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-3">
          <div className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-sm">
            <div className="flex justify-between items-center border-b border-gray-200 dark:border-gray-700 px-5 py-4">
              <h3 className="text-sm font-semibold tracking-wide text-gray-600 dark:text-gray-300 uppercase">
                Recent Conversations
              </h3>
              <a
                href="/conversations"
                className="text-sm text-blue-500 hover:text-blue-600 dark:hover:text-blue-400"
              >
                View All →
              </a>
            </div>

            {recentChats.length > 0 ? (
              <div className="divide-y divide-gray-100 dark:divide-gray-700">
                {recentChats.map((c) => (
                  <a
                    key={c.id}
                    href={`/conversations/${c.id}`}
                    className="block px-5 py-4 hover:bg-gray-50 dark:hover:bg-gray-700 transition"
                  >
                    <div className="flex justify-between items-center mb-1">
                      <p className="font-medium text-gray-900 dark:text-gray-100">
                        {c.lead}
                      </p>
                      <span className="text-xs text-gray-400">{c.time}</span>
                    </div>
                    <p className="text-sm text-gray-600 dark:text-gray-300">
                      {c.property}
                    </p>
                    <p className="text-sm mt-1 text-gray-500 dark:text-gray-400 italic">
                      {c.lastMessage}
                    </p>
                  </a>
                ))}
              </div>
            ) : (
              <p className="p-5 text-sm text-gray-500 dark:text-gray-400">
                No recent conversations.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
