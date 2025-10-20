"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";

console.log("NEXT_PUBLIC_AI_BACKEND_URL =", process.env.NEXT_PUBLIC_AI_BACKEND_URL);

const BACKEND = process.env.NEXT_PUBLIC_AI_BACKEND_URL;

export default function PropertyDataPage() {
  const [properties, setProperties] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);

  async function loadData() {
    setLoading(true);
    try {
      // 🧩 Force fresh data, never use cache
      const res = await fetch(`${BACKEND}/api/property-editor`, { cache: "no-store" });
      const json = await res.json();
      if (json.ok) setProperties(json.data);
      else console.error("Failed to load properties:", json);
    } catch (err) {
      console.error("Error fetching properties:", err);
    }
    setLoading(false);
  }

  // ✅ Single clean refresh system
  useEffect(() => {
    const handleRefresh = () => loadData();
    window.addEventListener("propertyDataUpdated", handleRefresh);

    // 🧩 If user navigated back from Property Editor
    if (sessionStorage.getItem("propertyDataNeedsRefresh") === "true") {
      sessionStorage.removeItem("propertyDataNeedsRefresh");
      loadData(); // force fresh DB fetch
    } else {
      loadData(); // normal first load
    }

    return () => window.removeEventListener("propertyDataUpdated", handleRefresh);
  }, []);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Property Data</h1>
        <div className="flex gap-2">
          <Link
            href="/property-editor"
            className="bg-green-500 text-white px-3 py-1.5 rounded-md text-sm hover:bg-green-600"
          >
            + New Property
          </Link>
          <button
            onClick={loadData}
            className="bg-blue-500 text-white px-3 py-1.5 rounded-md text-sm hover:bg-blue-600"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Loading state */}
      {loading ? (
        <div className="text-sm text-gray-500">Loading properties…</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Property List */}
          <div className="lg:col-span-2 rounded-xl border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-100">
                <tr>
                  <th className="px-4 py-2 text-left">Address</th>
                  <th className="px-4 py-2 text-left">Rent</th>
                  <th className="px-4 py-2 text-left">Bedrooms</th>
                  <th className="px-4 py-2 text-left">Bathrooms</th>
                  <th className="px-4 py-2 text-left">Actions</th>
                </tr>
              </thead>
              <tbody>
                {properties.map((p) => (
                  <tr key={p.slug} className="border-t">
                    <td className="px-4 py-2">{p.facts?.address || p.address}</td>
                    <td className="px-4 py-2">{p.facts?.rent || "-"}</td>
                    <td className="px-4 py-2">{p.facts?.bedrooms || "-"}</td>
                    <td className="px-4 py-2">{p.facts?.bathrooms || "-"}</td>
                    <td className="px-4 py-2">
                      <Link
                        href={`/property-editor?slug=${p.slug}`}
                        className="text-blue-600 hover:underline"
                      >
                        Edit
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
