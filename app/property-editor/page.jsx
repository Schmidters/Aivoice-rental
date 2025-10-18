"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import Button from "@/components/ui/button";
import { toast } from "sonner";

const BACKEND = process.env.NEXT_PUBLIC_AI_BACKEND_URL;

export default function PropertyEditorPage() {
  return (
    <Suspense fallback={<div className="p-6 text-gray-500">Loading editor…</div>}>
      <PropertyEditorContent />
    </Suspense>
  );
}

function PropertyEditorContent() {
  const searchParams = useSearchParams();
  const slugFromUrl = searchParams.get("slug");
  const [property, setProperty] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Load property if slug provided
  useEffect(() => {
    if (!slugFromUrl) return;
    const loadProperty = async () => {
      setLoading(true);
      try {
        const res = await fetch(`${BACKEND}/api/properties/${slugFromUrl}`);
        const json = await res.json();
        if (json.ok) {
          setProperty(json.data);
        } else {
          toast.error("Property not found");
        }
      } catch (err) {
        console.error("Error loading property:", err);
        toast.error("Failed to load property");
      }
      setLoading(false);
    };
    loadProperty();
  }, [slugFromUrl]);

  // Create blank new property if no slug
  useEffect(() => {
    if (!slugFromUrl) {
      setProperty({
        slug: "",
        address: "",
        rent: "",
        bedrooms: "",
        bathrooms: "",
        sqft: "",
        parking: "",
        utilities: "",
        availability: "",
        petsAllowed: false,
        furnished: false,
        notes: "",
      });
    }
  }, [slugFromUrl]);

  const handleChange = (field, value) => {
    setProperty((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  const handleSave = async () => {
    if (!property) return;
    setSaving(true);
    try {
      const method = property.id ? "PUT" : "POST";
      const url = property.id
        ? `${BACKEND}/api/properties/${property.slug}`
        : `${BACKEND}/api/properties`;

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(property),
      });

      const json = await res.json();
      if (json.ok) {
        toast.success("✅ Property saved!");
        setTimeout(() => (window.location.href = "/properties"), 800);
      } else {
        toast.error("Save failed");
      }
    } catch (err) {
      console.error("Save error:", err);
      toast.error("Network error saving changes");
    }
    setSaving(false);
  };

  if (loading)
    return (
      <div className="p-6 text-sm text-gray-500">Loading property…</div>
    );

  if (!property)
    return (
      <div className="p-6 text-sm text-gray-500">
        No property selected. Go back to{" "}
        <Link href="/properties" className="text-blue-600 underline">
          Property Data
        </Link>
        .
      </div>
    );

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-xl font-semibold">
        {slugFromUrl ? "Edit Property" : "Add New Property"}
      </h1>
      <div className="grid grid-cols-2 gap-4 max-w-3xl">
        <div>
          <Label>Slug</Label>
          <Input
            value={property.slug || ""}
            onChange={(e) => handleChange("slug", e.target.value)}
            placeholder="e.g. 215-16-street-southeast"
            disabled={!!slugFromUrl}
          />
        </div>
        <div>
          <Label>Address</Label>
          <Input
            value={property.address || ""}
            onChange={(e) => handleChange("address", e.target.value)}
          />
        </div>
        <div>
          <Label>Rent</Label>
          <Input
            value={property.rent || ""}
            onChange={(e) => handleChange("rent", e.target.value)}
          />
        </div>
        <div>
          <Label>Bedrooms</Label>
          <Input
            value={property.bedrooms || ""}
            onChange={(e) => handleChange("bedrooms", e.target.value)}
          />
        </div>
        <div>
          <Label>Bathrooms</Label>
          <Input
            value={property.bathrooms || ""}
            onChange={(e) => handleChange("bathrooms", e.target.value)}
          />
        </div>
        <div>
          <Label>Sqft</Label>
          <Input
            value={property.sqft || ""}
            onChange={(e) => handleChange("sqft", e.target.value)}
          />
        </div>
        <div>
          <Label>Parking</Label>
          <Input
            value={property.parking || ""}
            onChange={(e) => handleChange("parking", e.target.value)}
          />
        </div>
        <div>
          <Label>Utilities</Label>
          <Input
            value={property.utilities || ""}
            onChange={(e) => handleChange("utilities", e.target.value)}
          />
        </div>
        <div>
          <Label>Availability</Label>
          <Input
            value={property.availability || ""}
            onChange={(e) => handleChange("availability", e.target.value)}
          />
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={property.petsAllowed || false}
            onCheckedChange={(v) => handleChange("petsAllowed", v)}
          />
          <Label>Pets Allowed</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={property.furnished || false}
            onCheckedChange={(v) => handleChange("furnished", v)}
          />
          <Label>Furnished</Label>
        </div>
        <div className="col-span-2">
          <Label>Notes</Label>
          <Textarea
            value={property.notes || ""}
            onChange={(e) => handleChange("notes", e.target.value)}
            rows={3}
          />
        </div>
      </div>
      <Button onClick={handleSave} disabled={saving}>
        {saving ? "Saving…" : "Save Changes"}
      </Button>
    </div>
  );
}
