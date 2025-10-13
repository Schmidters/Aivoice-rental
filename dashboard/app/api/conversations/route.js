export async function GET() {
  const conversations = [
    {
      id: "1",
      lead: "Bevis",
      property: "215 16 Street SE",
      lastMessage: "Is there parking?",
      time: "2m ago",
      status: "new",
    },
    {
      id: "2",
      lead: "Megan",
      property: "303 Elm Street",
      lastMessage: "Still available?",
      time: "15m ago",
      status: "open",
    },
    {
      id: "3",
      lead: "Jamie",
      property: "42 Willow Ave",
      lastMessage: "Can I book a viewing?",
      time: "1h ago",
      status: "booked",
    },
  ];
  return Response.json(conversations);
}
