'use client';
import { useState } from 'react';
export default function ChatInput({ onSend }) {
  const [message,setMessage]=useState('');
  const submit=(e)=>{e.preventDefault();if(!message.trim())return;onSend(message);setMessage('');};
  return (
    <form onSubmit={submit} className='flex items-center gap-2 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2 bg-white dark:bg-gray-800'>
      <input type='text' placeholder='Type a message...' value={message} onChange={(e)=>setMessage(e.target.value)} className='flex-1 bg-transparent outline-none text-gray-900 dark:text-gray-100 text-sm'/>
      <button type='submit' className='bg-blue-500 text-white text-sm px-4 py-1.5 rounded-lg hover:bg-blue-600 transition'>Send</button>
    </form>
  );
}
