'use client';

import { useState } from 'react';

export default function PropertyDrawer({ slug, trigger }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resp, setResp] = useState(null);

  async function load() {
    setLoading(true);
    try {
      const r = await fetch(`/api/property/${encodeURIComponent(slug)}`, { cache: 'no-store' });
      const j = await r.json();
      setResp(j);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <button
        onClick={() => { setOpen(true); load(); }}
        className="underline text-indigo-600 hover:text-indigo-800"
      >
        {trigger || slug}
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex">
          {/* backdrop */}
          <div className="flex-1 bg-black/40" onClick={() => setOpen(false)} />

          {/* panel */}
          <div className="w-full sm:w-[480px] h-full bg-white dark:bg-gray-900 shadow-2xl p-4 overflow-y-auto">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-lg font-semibold">Property: {slug}</h2>
              <button
                className="text-sm px-2 py-1 rounded border border-gray-300 dark:border-gray-700"
                onClick={() => setOpen(false)}
              >
                Close
              </button>
            </div>

            {loading ? (
              <div className="text-gray-500">Loading…</div>
            ) : !resp?.ok ? (
              <div className="text-gray-500">No details found.</div>
            ) : (
              <div className="space-y-3">
                {Object.entries(resp.data).map(([k, v]) => (
                  <div key={k} className="rounded-lg border border-gray-200 dark:border-gray-800 p-3">
                    <div className="text-xs text-gray-400 mb-1">{k}</div>
                    <pre className="text-xs whitespace-pre-wrap break-all">
                      {typeof v === 'string' ? v : JSON.stringify(v, null, 2)}
                    </pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
