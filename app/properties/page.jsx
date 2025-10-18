"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";

const BACKEND = process.env.NEXT_PUBLIC_AI_BACKEND_URL;

export default function PropertyDataPage() {
  const [properties, setProperties] = useState([]);
  const [selected, setSelected] = useState(null);
  const [loading, setLoading] = useState(true);

  async function loadData() {
    setLoading(true);
    try {
      const res = await fetch(`${BACKEND}/api/properties`);
      const json = await res.json();
      if (json.ok) setProperties(json.data);
      else console.error("Failed to load properties:", json);
    } catch (err) {
      console.error("Error fetching properties:", err);
    }
    setLoading(false);
  }

  useEffect(() => {
    loadData();
  }, []);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Property Data</h1>
        <button
          onClick={loadData}
          className="bg-blue-500 text-white px-3 py-1.5 rounded-md text-sm hover:bg-blue-600"
        >
          Refresh
        </button>
      </div>

      {/* Loading state */}
      {loading ? (
        <div className="text-sm text-gray-500">Loading properties…</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Property List */}
          <div className="lg:col-span-2 rounded-xl border overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-4 py-2">Slug</th>
                  <th className="text-left px-4 py-2">Summary</th>
                  <th className="text-left px-4 py-2">Updated</th>
                  <th className="text-left px-4 py-2 w-20">Edit</th>
                </tr>
              </thead>
              <tbody>
                {properties.map((p) => (
                  <tr
                    key={p.id}
                    className="border-t hover:bg-gray-100"
                    onClick={() => setSelected(p)}
                  >
                    <td className="px-4 py-2 font-medium text-gray-700">
                      {p.slug}
                    </td>
                    <td className="px-4 py-2 text-gray-600">
                      {p.summary
                        ? p.summary.slice(0, 60) + "…"
                        : "(no summary)"}
                    </td>
                    <td className="px-4 py-2 text-gray-500">
                      {new Date(p.updatedAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-2 text-center">
                      <Link
                        href={`/property-editor?slug=${p.slug}`}
                        className="text-blue-600 hover:underline text-xs font-medium"
                        onClick={(e) => e.stopPropagation()}
                      >
                        Edit
                      </Link>
                    </td>
                  </tr>
                ))}
                {properties.length === 0 && (
                  <tr>
                    <td
                      colSpan="4"
                      className="px-4 py-6 text-center text-gray-500"
                    >
                      No properties found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Property Details */}
          <div className="lg:col-span-1">
            <div className="rounded-xl border p-4 bg-white">
              {!selected ? (
                <div className="text-gray-500 text-sm">
                  Select a property to view details
                </div>
              ) : (
                <div>
                  <h2 className="font-medium mb-2 text-gray-900">
                    {selected.slug}
                  </h2>
                  <p className="text-xs text-gray-500 mb-4">
                    Updated: {new Date(selected.updatedAt).toLocaleString()}
                  </p>
                  <pre className="text-xs bg-gray-100 p-3 rounded overflow-auto max-h-[400px]">
                    {JSON.stringify(selected.rawJson, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
