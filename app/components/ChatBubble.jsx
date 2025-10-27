"use client";
import React from "react";

export default function ChatBubble({ role, message, time }) {
  const isUser = role === "user";        // renter
  const isAva = role === "assistant";    // AI
  const isHuman = role === "agent";      // optional for future

  const alignment =
    isUser ? "justify-start" : "justify-end";

  const bubbleStyle = isUser
    ? "bg-gray-200 text-gray-900 rounded-br-2xl rounded-t-2xl rounded-bl-sm"
    : "bg-indigo-600 text-white rounded-bl-2xl rounded-t-2xl rounded-br-sm";

  return (
    <div className={`flex ${alignment} mb-2`}>
      <div
        className={`px-4 py-2 max-w-[75%] text-sm shadow-sm ${bubbleStyle}`}
      >
        <div className="whitespace-pre-wrap">{message}</div>
        {time && (
          <div className="text-[11px] opacity-60 mt-1 text-right">
            {new Date(time).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}
          </div>
        )}
      </div>
    </div>
  );
}
