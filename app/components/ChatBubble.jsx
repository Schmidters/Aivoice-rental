'use client';
export default function ChatBubble({ text, sender, time }) {
  const isUser = sender?.toLowerCase() === 'you' || sender === 'lead';
  return (
    <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} w-full mb-3`}>
      <div className={`max-w-[75%] px-4 py-2 rounded-2xl shadow-sm ${isUser ? 'bg-blue-500 text-white rounded-br-none' : 'bg-gray-200 dark:bg-gray-700 text-gray-900 dark:text-gray-100 rounded-bl-none'}`}>
        <p className='text-sm leading-relaxed'>{text}</p>
      </div>
      <span className='text-xs mt-1 text-gray-400'>{time}</span>
    </div>
  );
}
