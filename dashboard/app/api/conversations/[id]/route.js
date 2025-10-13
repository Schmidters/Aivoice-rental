export async function GET(_, { params }) {
  const { id } = params;

  const threads = {
    "1": [
      { sender: "lead", text: "Hi, is there parking?", time: "2m ago" },
      { sender: "bot", text: "Hello! Unfortunately there isn’t any parking at this unit, but there is free street parking nearby.", time: "1m ago" },
    ],
    "2": [
      { sender: "lead", text: "Still available?", time: "15m ago" },
      { sender: "bot", text: "Yes, it’s still available. Would you like to book a showing?", time: "10m ago" },
    ],
    "3": [
      { sender: "lead", text: "Can I book a viewing?", time: "1h ago" },
      { sender: "bot", text: "Sure! I can help schedule that. What time works for you?", time: "58m ago" },
    ],
  };

  return Response.json(threads[id] || []);
}
