'use client';
import { useEffect, useState } from 'react';
export default function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(()=>{document.documentElement.classList.toggle('dark', dark)},[dark]);
  return <button onClick={()=>setDark(!dark)} className='p-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600'>{dark?'🌙':'☀️'}</button>;
}
