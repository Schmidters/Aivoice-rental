"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const BACKEND = process.env.NEXT_PUBLIC_AI_BACKEND_URL;

export default function PropertyDataPage() {
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${BACKEND}/api/property-editor`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json.ok && Array.isArray(json.data)) {
        setProperties(json.data);
      } else {
        throw new Error("Invalid data format");
      }
    } catch (err) {
      console.error("Error loading properties:", err);
      setError("Failed to load property data");
    }
    setLoading(false);
  }

  useEffect(() => {
    loadData();
    // Listen for live updates (from editor)
    const onUpdate = () => loadData();
    window.addEventListener("propertyDataUpdated", onUpdate);
    return () => window.removeEventListener("propertyDataUpdated", onUpdate);
  }, []);

  if (loading) return <div className="p-6 text-gray-500">Loading properties…</div>;
  if (error) return <div className="p-6 text-red-500">{error}</div>;

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-4">
        <h1 className="text-xl font-semibold">🏢 Property Data</h1>
        <div className="flex gap-2">
          <Link href="/property-editor">
            <Button className="bg-green-600 hover:bg-green-700 text-white">
              + New Property
            </Button>
          </Link>
          <Button
            onClick={loadData}
            className="bg-blue-600 hover:bg-blue-700 text-white"
          >
            Refresh
          </Button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg shadow border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-100 text-gray-700">
            <tr>
              <th className="px-4 py-2 text-left">Building</th>
              <th className="px-4 py-2 text-left">Address</th>
              <th className="px-4 py-2 text-left">Units</th>
              <th className="px-4 py-2 text-left">Rent Range</th>
              <th className="px-4 py-2 text-left">Updated</th>
              <th className="px-4 py-2 text-left">Actions</th>
            </tr>
          </thead>
          <tbody>
            {properties.length === 0 ? (
              <tr>
                <td colSpan="6" className="p-4 text-center text-gray-500">
                  No properties found.
                </td>
              </tr>
            ) : (
              properties.map((p, i) => {
                const facts = p?.facts ?? {};
                const units = Array.isArray(facts.units) ? facts.units : [];


                const rentValues = units
                  .map((u) => parseFloat(u.rent))
                  .filter((r) => !isNaN(r));
                const rentRange =
                  rentValues.length > 0
                    ? `$${Math.min(...rentValues)} - $${Math.max(...rentValues)}`
                    : facts.rent || "-";

                return (
                  <tr
                    key={i}
                    className="border-t hover:bg-gray-50 transition-all"
                  >
                    <td className="px-4 py-2 font-medium text-gray-900">
                      {facts.buildingName || "—"}
                    </td>
                    <td className="px-4 py-2 text-gray-700">
                      {facts.address || p.address || "—"}
                    </td>
                    <td className="px-4 py-2 text-gray-700">
                      {units.length > 0 ? (
                        <Badge className="bg-blue-100 text-blue-800">
                          {units.length} types
                        </Badge>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-gray-700">{rentRange}</td>
                    <td className="px-4 py-2 text-gray-600">
  {facts?.updatedAt
    ? new Date(facts.updatedAt).toLocaleDateString()
    : p.updatedAt
    ? new Date(p.updatedAt).toLocaleDateString()
    : "—"}
</td>


                    <td className="px-4 py-2">
                      <Link
                        href={`/property-editor?slug=${p.slug}`}
                        className="text-blue-600 hover:underline"
                      >
                        Edit
                      </Link>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
