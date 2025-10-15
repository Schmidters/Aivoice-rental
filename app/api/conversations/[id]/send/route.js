// app/api/conversations/[id]/send/route.js

export async function POST(request, context) {
  const id = decodeURIComponent(context.params.id);
  const aiBackendBase = process.env.NEXT_PUBLIC_AI_BACKEND_URL;
  const url = `${aiBackendBase}/send/sms`;

  try {
    const body = await request.json();
    const text = body.text?.trim();
    const agentId = body.agentId || 'dashboard';

    if (!text) {
      return new Response(
        JSON.stringify({ ok: false, error: 'Missing text' }),
        { headers: { 'Content-Type': 'application/json' }, status: 400 }
      );
    }

    // 🔹 Send to backend
    console.log(`➡️ Sending human message to backend: ${id}`);
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: id,
        text,
        agentId,
      }),
    });

    const j = await r.json().catch(() => ({}));

    if (!r.ok || !j.ok) {
      throw new Error(j.error || `Backend returned ${r.status}`);
    }

    console.log(`✅ Sent to backend for ${id}: ${text}`);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    });
  } catch (err) {
    console.error('❌ Error in send route:', err);
    return new Response(
      JSON.stringify({ ok: false, error: err.message }),
      { headers: { 'Content-Type': 'application/json' }, status: 500 }
    );
  }
}
