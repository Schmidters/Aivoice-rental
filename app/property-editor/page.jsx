'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Button from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';

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
  const slugFromUrl = searchParams.get('slug');

  const [property, setProperty] = useState(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!slugFromUrl) return;
    const loadProperty = async () => {
      setLoading(true);
      try {
        const res = await fetch(`${BACKEND}/api/properties/${slugFromUrl}`);
        const json = await res.json();
        if (json.ok) setProperty(json.data);
        else toast.error('Property not found');
      } catch (err) {
        console.error('Error fetching property:', err);
        toast.error('Failed to load property');
      }
      setLoading(false);
    };
    loadProperty();
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
    const res = await fetch(`${process.env.NEXT_PUBLIC_AI_BACKEND_URL}/api/properties/${property.slug}`, {
      method: property.id ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(property),
    });
    const json = await res.json();
    if (json.ok) {
      toast.success("✅ Property saved!");
    } else {
      toast.error("Save failed: " + (json.error || "Unknown error"));
    }
  } catch (err) {
    toast.error("Network error saving changes");
  }
  setSaving(false);
};


  if (loading)
    return <div className="p-6 text-sm text-gray-500">Loading property…</div>;

  if (!property)
    return (
      <div className="p-6 text-sm text-gray-500">
        No property selected. Go back to{' '}
        <a href="/properties" className="text-blue-600 underline">
          Property Data
        </a>
        .
      </div>
    );

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-xl font-semibold">Edit Property</h1>
      <div className="grid grid-cols-2 gap-4 max-w-3xl">
        {[
          ['Address', 'address'],
          ['Rent', 'rent'],
          ['Bedrooms', 'bedrooms'],
          ['Bathrooms', 'bathrooms'],
          ['Sqft', 'sqft'],
          ['Parking', 'parking'],
          ['Utilities', 'utilities'],
          ['Availability', 'availability'],
        ].map(([label, key]) => (
          <div key={key}>
            <Label>{label}</Label>
            <Input
              value={property[key] || ''}
              onChange={(e) => handleChange(key, e.target.value)}
            />
          </div>
        ))}

        <div className="flex items-center gap-2">
          <Switch
            checked={property.petsAllowed || false}
            onCheckedChange={(v) => handleChange('petsAllowed', v)}
          />
          <Label>Pets Allowed</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            checked={property.furnished || false}
            onCheckedChange={(v) => handleChange('furnished', v)}
          />
          <Label>Furnished</Label>
        </div>

        <div className="col-span-2">
          <Label>Notes</Label>
          <Textarea
            value={property.notes || ''}
            onChange={(e) => handleChange('notes', e.target.value)}
            rows={3}
          />
        </div>
      </div>

      <Button onClick={handleSave} disabled={saving}>
        {saving ? 'Saving…' : 'Save Changes'}
      </Button>
    </div>
  );
}
