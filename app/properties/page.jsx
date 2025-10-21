"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

const BACKEND = process.env.NEXT_PUBLIC_AI_BACKEND_URL;

export default function PropertyDataPage() {
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(null);

  async function loadData() {
    setLoading(true);
    try {
      const res = await fetch(`${BACKEND}/api/property-editor`);
      const json = await res.json();
      if (json.ok) setProperties(json.data);
    } catch (err) {
      console.error("Error fetching properties:", err);
    }
    setLoading(false);
  }

  useEffect(() => {
    loadData();
    // Listen for save events from the editor
    const handler = () => loadData();
    window.addEventListener("propertyDataUpdated", handler);
    return () => window.removeEventListener("propertyDataUpdated", handler);
  }, []);

  if (loading) return <div className="p-6 text-gray-500">Loading properties…</div>;

  return (
    <div className="p-6 space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-semibold text-gray-800">🏢 Property Data</h1>
        <div className="flex gap-2">
          <Button onClick={loadData} variant="secondary">
            Refresh
          </Button>
          <Link href="/property-editor">
            <Button className="bg-green-600 hover:bg-green-700 text-white">
              + New Property
            </Button>
          </Link>
        </div>
      </div>

      {/* Main table */}
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm border border-gray-200 rounded-lg bg-white shadow-sm">
          <thead className="bg-gray-100 text-gray-700">
            <tr>
              <th className="px-4 py-2 text-left">Building</th>
              <th className="px-4 py-2 text-left">Address</th>
              <th className="px-4 py-2 text-left">Lease Type</th>
              <th className="px-4 py-2 text-left">Managed By</th>
              <th className="px-4 py-2 text-left">Units</th>
              <th className="px-4 py-2 text-left">Last Updated</th>
              <th className="px-4 py-2 text-left">Actions</th>
            </tr>
          </thead>
          <tbody>
            {properties.map((p, i) => {
              const facts = p.facts || {};
              const isExpanded = expanded === i;
              const updatedTime = p.updatedAt
                ? new Date(p.updatedAt).toLocaleTimeString()
                : "";

              return (
                <React.Fragment key={p.slug}>
                  <tr
                    className="border-t hover:bg-gray-50 cursor-pointer"
                    onClick={() => setExpanded(isExpanded ? null : i)}
                  >
                    <td className="px-4 py-2 font-medium">{facts.buildingName || "-"}</td>
                    <td className="px-4 py-2">{facts.address || p.address || "-"}</td>
                    <td className="px-4 py-2">{facts.leaseType || "-"}</td>
                    <td className="px-4 py-2">{facts.managedBy || "-"}</td>
                    <td className="px-4 py-2">
                      {Array.isArray(facts.units) ? facts.units.length : 0}
                    </td>
                    <td className="px-4 py-2">
                      {p.updatedAt ? (
                        <Badge className="bg-green-100 text-green-700">
                          {updatedTime}
                        </Badge>
                      ) : (
                        "-"
                      )}
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

                  {isExpanded && (
                    <tr className="bg-gray-50">
                      <td colSpan="7" className="p-4">
                        <Card className="bg-white border shadow-inner">
                          <CardContent className="space-y-3 text-gray-700">
                            <p>
                              <strong>Description:</strong>{" "}
                              {facts.description || "—"}
                            </p>
                            <p>
                              <strong>Amenities:</strong>{" "}
                              {facts.amenities || "—"}
                            </p>
                            <p>
                              <strong>Pet Policy:</strong>{" "}
                              {facts.petPolicy || "—"}
                            </p>
                            {Array.isArray(facts.units) && facts.units.length > 0 && (
                              <div className="mt-3">
                                <strong>Unit Types:</strong>
                                <ul className="list-disc list-inside mt-1 space-y-1">
                                  {facts.units.map((u, idx) => (
                                    <li key={idx}>
                                      {u.unitType || "Unit"} — {u.bedrooms || "?"} bd /{" "}
                                      {u.bathrooms || "?"} ba — ${u.rent || "?"}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </CardContent>
                        </Card>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
