"use client";

import { useEffect, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  BarChart,
  Bar,
  Legend,
} from "recharts";
import PageHeader from "@/components/ui/PageHeader";
import LoadingState from "@/components/ui/LoadingState";

export default function AnalyticsPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const BACKEND =
    process.env.NEXT_PUBLIC_AI_BACKEND_URL ||
    "https://api.cubbylockers.com";

  // 🔁 Load from backend summary endpoint
  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`${BACKEND}/api/analytics`, { cache: "no-store" });
        const json = await res.json();

        if (json.ok) {
          const d = json.data;
          setData({
            leads: d.leadsThisMonth,
            bookings: d.showingsBooked,
            properties: d.properties,
            chartData: d.chart || [],
          });
        }
      } catch (err) {
        console.error("❌ Failed to load analytics:", err);
      }
      setLoading(false);
    }

    load();

    // ⏱ Auto-refresh every 60 seconds
    const interval = setInterval(load, 60000);
    return () => clearInterval(interval);
  }, [BACKEND]);

  if (loading) return <LoadingState label="Loading analytics..." />;

  return (
    <div className="p-8">
      <PageHeader title="Analytics Overview" />

      {/* KPI CARDS */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-8">
        <StatCard label="Leads This Month" value={data.leads} color="text-emerald-600" />
        <StatCard label="Showings Booked" value={data.bookings} color="text-blue-600" />
        <StatCard label="Active Properties" value={data.properties} color="text-indigo-600" />
      </div>

      {/* CHARTS */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Line Chart */}
        <div className="bg-white rounded-xl p-6 shadow">
          <h2 className="text-lg font-semibold mb-4">Leads & Bookings (Last 7 Days)</h2>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={data.chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="day" />
              <YAxis />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="leads" stroke="#22c55e" name="Leads" />
              <Line type="monotone" dataKey="bookings" stroke="#3b82f6" name="Bookings" />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Bar Chart */}
        <div className="bg-white rounded-xl p-6 shadow">
          <h2 className="text-lg font-semibold mb-4">Conversion Rate</h2>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={data.chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="day" />
              <YAxis />
              <Tooltip />
              <Legend />
              <Bar
                dataKey="bookings"
                fill="#3b82f6"
                name="Bookings"
                radius={[6, 6, 0, 0]}
              />
              <Bar
                dataKey="leads"
                fill="#22c55e"
                name="Leads"
                radius={[6, 6, 0, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

// Simple stat card component
function StatCard({ label, value, color }) {
  return (
    <div className="rounded-xl bg-white p-5 shadow hover:shadow-md transition">
      <div className="text-sm text-gray-500">{label}</div>
      <div className={`text-3xl font-semibold mt-1 ${color}`}>{value}</div>
    </div>
  );
}
