"use client";
import { useEffect } from "react";

export function useEventSource(url, onMessage) {
  useEffect(() => {
    if (!url) return;

    const evtSource = new EventSource(url);

    evtSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        onMessage(data);
      } catch {
        // ignore keepalive pings or malformed JSON
      }
    };

    evtSource.onerror = () => {
      console.warn("SSE connection lost — retrying...");
      evtSource.close();
      setTimeout(() => useEventSource(url, onMessage), 3000);
    };

    return () => evtSource.close();
  }, [url, onMessage]);
}
