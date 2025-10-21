"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { motion, AnimatePresence } from "framer-motion"; // ✅ <— add this line

const BACKEND = process.env.NEXT_PUBLIC_AI_BACKEND_URL;

export default function PropertyDataPage() {
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expandedIndex, setExpandedIndex] = useState(null);

  async function loadData() {
    setLoading(true);
    setError(null);
    try {
      console.log("🔍 Fetching properties from:", `${BACKEND}/api/property-editor`);
      const res = await fetch(`${BACKEND}/api/property-editor`, { cache: "no-store" });

      if (!res.ok) {
        const hint =
          res.status === 502
            ? "Backend unreachable (502 Bad Gateway)"
            : res.status === 404
            ? "Property data route not found (404)"
            : `HTTP ${res.status}`;
        throw new Error(hint);
      }

      const json = await res.json();
      if (json.ok && Array.isArray(json.data)) {
        setProperties(json.data);
        console.log(`✅ Loaded ${json.data.length} properties`);
      } else {
        console.error("⚠️ Invalid response structure:", json);
        throw new Error("Unexpected data format from backend");
      }
    } catch (err) {
      console.error("❌ Error loading properties:", err);
      const msg =
        err.message?.includes("Failed to fetch") ||
        err.message?.includes("502") ||
        err.message?.includes("CORS")
          ? "Backend is unreachable — check Render status or CORS config."
          : err.message || "Unknown error";
      setError(`Failed to load property data: ${msg}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
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
          <Button onClick={loadData} className="bg-blue-600 hover:bg-blue-700 text-white">
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
            {Array.isArray(properties) && properties.length > 0 ? (
              properties.map((p, i) => {
                if (!p) return null;
                const facts = p?.facts ?? {};
                const units = Array.isArray(facts.units) ? facts.units : [];

                let rentRange = "-";
                if (units.length > 0) {
                  const rents = units.map((u) => parseFloat(u?.rent)).filter((r) => !isNaN(r));
                  if (rents.length > 0) {
                    rentRange = `$${Math.min(...rents)} - $${Math.max(...rents)}`;
                  }
                } else if (facts.rent) {
                  rentRange = `$${facts.rent}`;
                }

                const isExpanded = expandedIndex === i;

                return (
                  <React.Fragment key={i}>
                    {/* Main Row */}
                    <tr
                      className="border-t hover:bg-gray-50 transition-all cursor-pointer"
                      onClick={() => setExpandedIndex(isExpanded ? null : i)}
                    >
                      <td className="px-4 py-2 font-medium text-gray-900 flex items-center gap-2">
                        <motion.span
                          animate={{ rotate: isExpanded ? 90 : 0 }}
                          transition={{ duration: 0.2 }}
                        >
                          ▶
                        </motion.span>
                        {facts?.buildingName || "—"}
                      </td>
                      <td className="px-4 py-2 text-gray-700">
                        {facts?.address || p?.address || "—"}
                      </td>
                      <td className="px-4 py-2 text-gray-700">
                        {units.length > 0 ? (
                          <Badge className="bg-blue-100 text-blue-800">{units.length} types</Badge>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-gray-700">{rentRange}</td>
                      <td className="px-4 py-2 text-gray-600">
                        {facts?.updatedAt
                          ? new Date(facts.updatedAt).toLocaleDateString()
                          : p?.updatedAt
                          ? new Date(p.updatedAt).toLocaleDateString()
                          : "—"}
                      </td>
                      <td className="px-4 py-2">
                        <Link
                          href={`/property-editor?slug=${encodeURIComponent(p.slug)}`}
                          className="text-blue-600 hover:underline"
                        >
                          Edit
                        </Link>
                      </td>
                    </tr>

                    {/* Animated Expandable Row */}
                    <AnimatePresence initial={false}>
                      {isExpanded && (
                        <motion.tr
                          key={`expanded-${i}`}
                          className="bg-gray-50 border-t"
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: "auto" }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{ duration: 0.3, ease: "easeInOut" }}
                          layout
                        >
                          <td colSpan="6" className="p-4">
                            <motion.div
                              initial={{ opacity: 0, y: -10 }}
                              animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0, y: -10 }}
                              transition={{ duration: 0.3 }}
                              className="text-sm text-gray-700 space-y-2"
                            >
                              <p><strong>Description:</strong> {facts.description || "—"}</p>
                              <p><strong>Building Type:</strong> {facts.buildingType || "—"}</p>
                              <p><strong>Lease Type:</strong> {facts.leaseType || "—"}</p>
                              <p><strong>Managed By:</strong> {facts.managedBy || "—"}</p>

                              {units.length > 0 && (
                                <div className="mt-3">
                                  <strong>Units:</strong>
                                  <ul className="mt-2 ml-4 list-disc">
                                    {units.map((u, j) => (
                                      <li key={j}>
                                        {u.unitType || "Unit"} — {u.bedrooms || "?"} bed /{" "}
                                        {u.bathrooms || "?"} bath — {u.sqft || "?"} sqft — $
                                        {u.rent || "?"}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            </motion.div>
                          </td>
                        </motion.tr>
                      )}
                    </AnimatePresence>
                  </React.Fragment>
                );
              })
            ) : (
              <tr>
                <td colSpan="6" className="p-4 text-center text-gray-500">
                  No properties found.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
