import { useEffect, useRef, useState } from 'react';
import './WeatherChat.css';

const SUGGESTIONS = [
  "What's the weather in Delhi right now?",
  'Will it rain in London this weekend?',
  'Compare Mumbai and Bangalore today',
];

function newSessionId() {
  // crypto.randomUUID is only available in secure contexts (https/localhost).
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function WeatherChat() {
  const [sessionId, setSessionId] = useState(newSessionId);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  async function send(text) {
    const message = text.trim();
    if (!message || loading) return;

    setMessages((prev) => [...prev, { role: 'user', text: message }]);
    setInput('');
    setLoading(true);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      setMessages((prev) => [...prev, { role: 'assistant', text: data.reply }]);
    } catch (err) {
      setMessages((prev) => [...prev, { role: 'error', text: err.message }]);
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    fetch('/api/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {});
    setSessionId(newSessionId());
    setMessages([]);
  }

  return (
    <div className="wc">
      <header className="wc-header">
        <h1>Weather Agent</h1>
        <button className="wc-reset" onClick={reset} disabled={loading}>
          New chat
        </button>
      </header>

      <div className="wc-messages">
        {messages.length === 0 && (
          <div className="wc-empty">
            <p>Ask me about the weather anywhere in the world.</p>
            {SUGGESTIONS.map((s) => (
              <button key={s} className="wc-suggestion" onClick={() => send(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`wc-msg wc-${m.role}`}>
            {m.text}
          </div>
        ))}
        {loading && <div className="wc-msg wc-assistant wc-typing">Checking the skies…</div>}
        <div ref={bottomRef} />
      </div>

      <form
        className="wc-form"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. Do I need a jacket in Toronto tomorrow?"
          disabled={loading}
          maxLength={2000}
        />
        <button type="submit" disabled={loading || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

export default WeatherChat;
