import type { Dispatch, SetStateAction } from "react";
import type { Event, Message, Part, SessionId } from "@bai/shared";

/** Pure reducer applying session-stream events to the message list. */
export function applyEvent(setMessages: Dispatch<SetStateAction<Message[]>>, evt: Event): void {
  switch (evt.type) {
    case "message.created": {
      const { messageId, role } = evt.payload;
      setMessages((prev) => [
        ...prev,
        {
          id: messageId,
          sessionId: (evt.sessionId ?? "") as SessionId,
          role,
          createdAt: evt.ts,
          parts: [],
        },
      ]);
      return;
    }
    case "message.part.delta": {
      const { messageId, partId, delta } = evt.payload;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId ? { ...m, parts: appendDelta(m, partId, delta) } : m,
        ),
      );
      return;
    }
    case "message.part.updated": {
      const { messageId, partId, kind, payload } = evt.payload;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                parts: m.parts.some((p) => p.id === partId)
                  ? m.parts.map((p) => (p.id === partId ? { ...p, kind, payload } : p))
                  : [
                      ...m.parts,
                      { id: partId, messageId, ord: m.parts.length, kind, payload },
                    ],
              }
            : m,
        ),
      );
      return;
    }
    default:
      return;
  }
}

/** Coalesce adjacent deltas into the text part (the render-tick buffer). */
function appendDelta(message: Message, partId: Part["id"], delta: string): Part[] {
  const existing = message.parts.find((p) => p.id === partId);
  if (existing !== undefined) {
    const current = (existing.payload as { text?: string } | null)?.text ?? "";
    return message.parts.map((p) =>
      p.id === partId ? { ...p, payload: { text: current + delta } } : p,
    );
  }
  return [
    ...message.parts,
    {
      id: partId,
      messageId: message.id,
      ord: message.parts.length,
      kind: "text",
      payload: { text: delta },
    },
  ];
}

/** Flatten a message's text parts for display. */
export function messageText(message: Message): string {
  return message.parts
    .map((p) => (p.kind === "text" ? ((p.payload as { text?: string } | null)?.text ?? "") : ""))
    .join("");
}
