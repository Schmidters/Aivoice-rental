'use client';
import { useState } from 'react';

export default function ChatInput({ onSend }) {
  const [message, setMessage] = useState('');

  const handleSend = () => {
    if (!message.trim()) return;
    onSend(message);
    setMessage('');
  };

  return (
    <div className="flex items-center gap-2 p-4 border-t border-gray-200 dark:border-gray-800">
      <input
        type="text"
        placeholder="Type a message..."
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && handleSend()}
        className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
      />
      <button
        onClick={handleSend}
        className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg"
      >
        Send
      </button>
    </div>
  );
}
