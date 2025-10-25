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
    "https://aivoice-rental.digitalocean.com";

  useEffect(() => {
    async function load() {
      try {
        const [leadsRes, bookingsRes, propertiesRes] = await Promise.all([
          fetch(`${BACKEND}/api/leads`),
          fetch(`${BACKEND}/api/bookings`),
          fetch(`${BACKEND}/api/propertiesr`),
        ]);
        const [leads, bookings, properties] = await Promise.all([
          leadsRes.json(),
          bookingsRes.json(),
          propertiesRes.json(),
        ]);

        // --- Build weekly buckets ---
        const weeks = {};
        const now = new Date();
        const getWeekKey = (date) => {
          const d = new Date(date);
          const week = Math.ceil(d.getDate() / 7);
          return `${d.getMonth() + 1}/${week}`;
        };

        (leads.data || []).forEach((l) => {
          const k = getWeekKey(l.createdAt);
          weeks[k] = weeks[k] || { week: k, leads: 0, bookings: 0 };
          weeks[k].leads++;
        });

        (bookings.data || []).forEach((b) => {
          const k = getWeekKey(b.datetime);
          weeks[k] = weeks[k] || { week: k, leads: 0, bookings: 0 };
          weeks[k].bookings++;
        });

        const chartData = Object.values(weeks).sort(
          (a, b) => new Date(a.week) - new Date(b.week)
        );

        setData({
          leads: leads.data?.length || 0,
          bookings: bookings.data?.length || 0,
          properties: properties.data?.length || 0,
          chartData,
        });
      } catch (err) {
        console.error("Failed to load analytics:", err);
      }
      setLoading(false);
    }

    load();
  }, [BACKEND]);

  if (loading) return <LoadingState label="Loading analytics..." />;

  return (
    <div className="p-8">
      <PageHeader title="Analytics Overview" />

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mb-8">
        <StatCard label="Total Leads" value={data.leads} color="text-emerald-600" />
        <StatCard
          label="Confirmed Bookings"
          value={data.bookings}
          color="text-blue-600"
        />
        <StatCard
          label="Active Properties"
          value={data.properties}
          color="text-indigo-600"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <div className="bg-white rounded-xl p-6 shadow">
          <h2 className="text-lg font-semibold mb-4">Leads & Bookings (Weekly)</h2>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={data.chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="week" />
              <YAxis />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="leads" stroke="#22c55e" />
              <Line type="monotone" dataKey="bookings" stroke="#3b82f6" />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-white rounded-xl p-6 shadow">
          <h2 className="text-lg font-semibold mb-4">Conversion Rate</h2>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={data.chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="week" />
              <YAxis />
              <Tooltip />
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

function StatCard({ label, value, color }) {
  return (
    <div className="rounded-xl bg-white p-5 shadow hover:shadow-md transition">
      <div className="text-sm text-gray-500">{label}</div>
      <div className={`text-3xl font-semibold mt-1 ${color}`}>{value}</div>
    </div>
  );
}
