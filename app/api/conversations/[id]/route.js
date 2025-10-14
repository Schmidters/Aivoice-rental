export async function GET(req,{params}){
  const {id}=params;
  const mockMessages={
    '1':[
      {id:1,sender:'lead',text:'Is there parking?',time:'2m ago'},
      {id:2,sender:'bot',text:'Street parking only for this property.',time:'1m ago'}
    ],
    '2':[
      {id:1,sender:'lead',text:'Still available?',time:'15m ago'},
      {id:2,sender:'bot',text:'Yes, still available!',time:'14m ago'}
    ],
    '3':[
      {id:1,sender:'lead',text:'Can I book a viewing?',time:'1h ago'},
      {id:2,sender:'bot',text:'Sure! What time works for you?',time:'1h ago'}
    ]
  };
  return new Response(JSON.stringify({id,messages:mockMessages[id]||[]}),{status:200});
}
