// /app/api/conversations/[id]/route.js
export async function GET(req, { params }) {
  const id = decodeURIComponent(params.id);
  const aiBackendBase = process.env.NEXT_PUBLIC_AI_BACKEND_URL;
  const url = `${aiBackendBase}/history/${encodeURIComponent(id)}`;

  try {
    const r = await fetch(url, { cache: 'no-store' });
    const j = await r.json();

    // 🔄 Normalize backend format → dashboard format
    const messages = (j.messages || []).map((m) => ({
      t: m.ts,
      role:
        m.sender === 'lead'
          ? 'user'
          : m.sender === 'ai'
          ? 'assistant'
          : 'agent',
      content: m.text,
      meta: m.meta,
    }));

    return Response.json({
      ok: true,
      id,
      lead: j.phone || id,
      mode: j.mode || 'auto',
      handoffReason: j.handoffReason || '',
      owner: j.owner || '',
      messages,
      properties: [],
    });
  } catch (err) {
    console.error('Error fetching history:', err);
    return Response.json({ ok: false, error: err.message });
  }
}
