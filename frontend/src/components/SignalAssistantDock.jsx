import { useEffect, useRef, useState } from "react";
import "../styles/signal-ai.css";

const QUICK_PROMPTS = [
  "Which stocks are most exposed here?",
  "What is the actual trade thesis?",
  "What should I watch next?",
];

function SignalAssistantDock({ chatUrl }) {
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState([]);
  const [isSending, setIsSending] = useState(false);
  const messagesRef = useRef(null);

  useEffect(() => {
    const container = messagesRef.current;
    if (!container) {
      return;
    }
    container.scrollTop = container.scrollHeight;
  }, [messages]);

  const handleSend = async () => {
    const cleaned = draft.trim();
    if (!cleaned || isSending) {
      return;
    }

    const userMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: cleaned,
    };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setDraft("");
    setIsSending(true);

    try {
      const response = await fetch(chatUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: cleaned,
          history: nextMessages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        }),
      });
      if (!response.ok) {
        throw new Error(`assistant chat failed: ${response.status}`);
      }

      const payload = await response.json();
      setMessages((current) => [
        ...current,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: String(payload?.reply || "").trim() || "No response returned.",
        },
      ]);
    } catch {
      setMessages((current) => [
        ...current,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          content: "Signal AI could not reach the backend model layer.",
        },
      ]);
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyDown = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  };

  const handlePromptClick = (prompt) => {
    setDraft(prompt);
  };

  return (
    <section className="sai-inline-panel sai-inline-panel--open">
      <header className="sai-inline-panel__header">
        <div>
          <p className="sai-inline-panel__eyebrow">Signal AI</p>
          <h3 className="sai-inline-panel__title">Quick chat</h3>
        </div>
      </header>

      <div id="signal-ai-inline-body" className="sai-panel sai-panel--inline">
        <div className="sai-panel__messages" ref={messagesRef}>
          {messages.length === 0 ? (
            <div className="sai-panel__empty">
              <p className="sai-panel__empty-title">Ask for a ticker, setup, or risk read.</p>
              <div className="sai-panel__prompt-list">
                {QUICK_PROMPTS.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    className="sai-panel__prompt"
                    onClick={() => handlePromptClick(prompt)}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message) => (
              <article
                key={message.id}
                className={
                  message.role === "assistant"
                    ? "sai-message sai-message--assistant"
                    : "sai-message sai-message--user"
                }
              >
                <div className="sai-message__role">
                  {message.role === "assistant" ? "Signal AI" : "You"}
                </div>
                <div className="sai-message__content">
                  {message.content.split("\n").map((line, index) => (
                    <p key={`${message.id}-${index}`}>{line}</p>
                  ))}
                </div>
              </article>
            ))
          )}
        </div>

        <div className="sai-panel__composer">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            className="sai-panel__input"
            placeholder="Ask Signal AI..."
            rows={3}
          />
          <button
            type="button"
            className="sai-panel__send"
            onClick={handleSend}
            disabled={!draft.trim() || isSending}
          >
            {isSending ? "..." : "Send"}
          </button>
        </div>
      </div>
    </section>
  );
}

export default SignalAssistantDock;
