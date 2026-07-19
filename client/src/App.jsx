import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8080";
const API_URL = `${API_BASE}/conversation`;
const ANON_CONVERSATIONS_KEY = "anon_conversations_v1";
const ANON_ACTIVE_KEY = "anon_active_conversation_v1";
const ANON_MESSAGE_COUNT_KEY = "anon_message_count_v1";
const ANON_MESSAGE_LIMIT = 5;

function parseSources(raw) {
  const start = raw.indexOf("<SOURCES>");
  const end = raw.indexOf("</SOURCES>");
  if (start === -1 || end === -1 || end <= start) return { text: raw, sources: [] };

  const text = raw.slice(0, start).trim();
  const json = raw.slice(start + "<SOURCES>".length, end).trim();

  try {
    const sources = JSON.parse(json);
    return { text, sources: Array.isArray(sources) ? sources : [] };
  } catch {
    return { text: raw, sources: [] };
  }
}

function extractTagContent(raw, tagName) {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i");
  const match = raw.match(regex);
  return match?.[1]?.trim() ?? "";
}

function splitSuggestionItems(raw) {
  if (!raw) return [];

  return raw
    .split(/\n|\r|\d+[.)]\s+|[-*]\s+/)
    .map((item) =>
      item
        .replace(/<[^>]+>/g, "")
        .replace(/^[:\-\s]+/, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .filter(Boolean);
}

function parseAssistantResponse(rawText) {
  const answer = extractTagContent(rawText, "ANSWER");
  const followUp = splitSuggestionItems(extractTagContent(rawText, "FOLLOW_UP"));
  const question = splitSuggestionItems(extractTagContent(rawText, "QUESTION"));

  const suggestions = Array.from(new Set([...followUp, ...question])).slice(0, 4);

  if (answer) {
    return { answer, suggestions };
  }

  const cleaned = rawText
    .replace(/<\/?ANSWER>/gi, "")
    .replace(/<\/?FOLLOW_UP>/gi, "")
    .replace(/<\/?QUESTION>/gi, "")
    .trim();

  return { answer: cleaned || rawText, suggestions };
}

function parseAssistantPayload(raw) {
  const { text, sources } = parseSources(raw);
  const { answer, suggestions } = parseAssistantResponse(text);
  return { text: answer, sources, suggestions };
}

function makeLocalConversationId() {
  return `anon-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function getTitleFromMessages(messages) {
  const firstUser = messages.find((msg) => msg.role === "user");
  return firstUser?.text?.slice(0, 80) || "Untitled conversation";
}

export default function App() {
  const [authLoading, setAuthLoading] = useState(true);
  const [user, setUser] = useState(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState([]);
  const [conversations, setConversations] = useState([]);
  const [activeConversationId, setActiveConversationId] = useState(null);
  const [suggestedPrompts, setSuggestedPrompts] = useState([]);
  const [suggestionsExpanded, setSuggestionsExpanded] = useState(false);
  const [authActionLoading, setAuthActionLoading] = useState(false);
  const [authPopupOpen, setAuthPopupOpen] = useState(false);
  const [anonMessageCount, setAnonMessageCount] = useState(0);

  const canSend = useMemo(() => query.trim().length > 0 && !loading, [query, loading]);

  useEffect(() => {
    const lastAssistant = [...messages].reverse().find((msg) => msg.role === "assistant");
    const nextSuggestions = lastAssistant?.suggestions ?? [];
    setSuggestedPrompts(nextSuggestions);
    setSuggestionsExpanded(false);
  }, [messages]);

  useEffect(() => {
    void loadSession();
  }, []);

  useEffect(() => {
    if (user) return;
    const raw = localStorage.getItem(ANON_CONVERSATIONS_KEY);
    const active = localStorage.getItem(ANON_ACTIVE_KEY);
    const messageCount = Number(localStorage.getItem(ANON_MESSAGE_COUNT_KEY) ?? 0);
    const parsed = raw ? JSON.parse(raw) : [];
    setConversations(parsed);
    setActiveConversationId(active || null);
    setAnonMessageCount(Number.isFinite(messageCount) ? messageCount : 0);
    if (active) {
      const conversation = parsed.find((c) => c.id === active);
      const restoredMessages = conversation?.messages ?? [];
      setMessages(restoredMessages);
    }
  }, [user]);

  useEffect(() => {
    if (!user && anonMessageCount >= ANON_MESSAGE_LIMIT) {
      setAuthPopupOpen(true);
    }
  }, [anonMessageCount, user]);

  function persistAnonymous(nextConversations, nextActiveId) {
    localStorage.setItem(ANON_CONVERSATIONS_KEY, JSON.stringify(nextConversations));
    if (nextActiveId) {
      localStorage.setItem(ANON_ACTIVE_KEY, nextActiveId);
    } else {
      localStorage.removeItem(ANON_ACTIVE_KEY);
    }
  }

  function incrementAnonMessageCount() {
    setAnonMessageCount((prev) => {
      const next = prev + 1;
      localStorage.setItem(ANON_MESSAGE_COUNT_KEY, String(next));
      return next;
    });
  }

  function clearAnonymousSessionStorage() {
    localStorage.removeItem(ANON_CONVERSATIONS_KEY);
    localStorage.removeItem(ANON_ACTIVE_KEY);
    localStorage.removeItem(ANON_MESSAGE_COUNT_KEY);
    setAnonMessageCount(0);
  }

  async function migrateAnonymousConversations() {
    const raw = localStorage.getItem(ANON_CONVERSATIONS_KEY);
    if (!raw) return;

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      clearAnonymousSessionStorage();
      return;
    }

    const payload = parsed.map((conversation) => ({
      title: conversation.title,
      messages: Array.isArray(conversation.messages)
        ? conversation.messages
            .filter((message) => message && typeof message.text === "string")
            .map((message) => ({ role: message.role, text: message.text }))
        : [],
    }));

    const response = await fetch(`${API_BASE}/conversations/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ conversations: payload }),
    });

    if (response.ok) {
      clearAnonymousSessionStorage();
    }
  }

  async function loadSession() {
    try {
      const response = await fetch(`${API_BASE}/auth/me`, {
        credentials: "include",
      });

      if (!response.ok) {
        setUser(null);
        return;
      }

      const data = await response.json();
      setUser(data.user);
      await migrateAnonymousConversations();
      await loadConversations(true);
    } finally {
      setAuthLoading(false);
    }
  }

  async function loadConversations(ignoreUserGuard = false) {
    if (!ignoreUserGuard && !user) return;
    const response = await fetch(`${API_BASE}/conversations`, {
      credentials: "include",
    });
    if (!response.ok) return;
    const data = await response.json();
    setConversations(data.conversations ?? []);
  }

  async function openConversation(conversationId) {
    if (!user) {
      const conversation = conversations.find((c) => c.id === conversationId);
      setActiveConversationId(conversationId);
      const nextMessages = conversation?.messages ?? [];
      setMessages(nextMessages);
      persistAnonymous(conversations, conversationId);
      return;
    }

    const response = await fetch(`${API_BASE}/conversations/${conversationId}/messages`, {
      credentials: "include",
    });
    if (!response.ok) return;

    const data = await response.json();
    const mappedMessages = (data.messages ?? []).map((msg) => {
      const isAssistant = msg.role !== "User";
      const parsed = isAssistant ? parseAssistantResponse(msg.context) : null;

      return {
        id: `stored-${msg.id}`,
        role: msg.role === "User" ? "user" : "assistant",
        text: isAssistant ? parsed.answer : msg.context,
        sources: [],
        suggestions: isAssistant ? parsed.suggestions : [],
      };
    });

    setMessages(mappedMessages);
    setActiveConversationId(conversationId);
  }

  async function deleteConversation(conversationId) {
    if (!window.confirm("Delete this conversation?")) return;

    if (!user) {
      const next = conversations.filter((c) => c.id !== conversationId);
      const nextActiveId = activeConversationId === conversationId ? null : activeConversationId;
      setConversations(next);
      if (!nextActiveId) setMessages([]);
      setActiveConversationId(nextActiveId);
      persistAnonymous(next, nextActiveId);
      return;
    }

    const response = await fetch(`${API_BASE}/conversations/${conversationId}`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!response.ok) return;
    await loadConversations();
    if (activeConversationId === conversationId) {
      setActiveConversationId(null);
      setMessages([]);
    }
  }

  async function logout() {
    setAuthActionLoading(true);
    try {
      await fetch(`${API_BASE}/auth/logout`, {
        method: "POST",
        credentials: "include",
      });
      setUser(null);
      setMessages([]);
      setConversations([]);
      setActiveConversationId(null);
      setAnonMessageCount(0);
    } finally {
      setAuthActionLoading(false);
    }
  }

  async function deleteAccount() {
    if (!window.confirm("Delete account and all conversations permanently?")) return;

    setAuthActionLoading(true);
    try {
      await fetch(`${API_BASE}/auth/account`, {
        method: "DELETE",
        credentials: "include",
      });
      setUser(null);
      setMessages([]);
      setConversations([]);
      setActiveConversationId(null);
      setAnonMessageCount(0);
    } finally {
      setAuthActionLoading(false);
    }
  }

  function beginNewConversation() {
    setActiveConversationId(null);
    setMessages([]);
    if (!user) {
      persistAnonymous(conversations, null);
    }
  }

  async function runConversation(messageText) {
    const trimmed = messageText.trim();
    if (!trimmed || loading) return;

    if (!user && anonMessageCount >= ANON_MESSAGE_LIMIT) {
      setAuthPopupOpen(true);
      return;
    }

    if (!user) {
      incrementAnonMessageCount();
    }

    const userMsg = { id: crypto.randomUUID(), role: "user", text: trimmed };
    const assistantId = crypto.randomUUID();
    const existingMessages = messages;

    setMessages((prev) => [
      ...prev,
      userMsg,
      { id: assistantId, role: "assistant", text: "", sources: [], suggestions: [] },
    ]);
    setQuery("");
    setLoading(true);

    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ message: trimmed, conversationId: user ? activeConversationId : undefined }),
      });

      if (!response.ok || !response.body) {
        throw new Error(`Request failed (${response.status})`);
      }

      const returnedConversationId = response.headers.get("X-Conversation-Id");
      if (user && returnedConversationId) {
        setActiveConversationId(returnedConversationId);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fullText += decoder.decode(value, { stream: true });
        const { text, sources, suggestions } = parseAssistantPayload(fullText);
        setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, text, sources, suggestions } : m)),
        );
      }

      fullText += decoder.decode();
      const { text, sources, suggestions } = parseAssistantPayload(fullText);
      const finalMessages = existingMessages
        .concat(userMsg)
        .concat([{ id: assistantId, role: "assistant", text, sources, suggestions }]);

      setMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, text, sources, suggestions } : m)),
      );

      if (user) {
        await loadConversations();
      } else {
        const nextId = activeConversationId || makeLocalConversationId();
        const nextMessages = finalMessages.filter((m) => m.text !== "");
        const nextConversations = [
          ...conversations.filter((c) => c.id !== nextId),
          {
            id: nextId,
            title: getTitleFromMessages(nextMessages),
            messages: nextMessages,
            createdAt: new Date().toISOString(),
          },
        ];
        setConversations(nextConversations);
        setActiveConversationId(nextId);
        persistAnonymous(nextConversations, nextId);
      }
    } catch (error) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === assistantId
            ? {
                ...m,
                text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
                sources: [],
              }
            : m,
        ),
      );
    } finally {
      setLoading(false);
    }
  }

  async function startConversation(e) {
    e.preventDefault();
    await runConversation(query);
  }

  async function sendSuggestedPrompt(prompt) {
    if (loading) return;
    await runConversation(prompt);
  }

  if (authLoading) {
    return (
      <div className="app-shell loading-view">
        <p>Checking session...</p>
      </div>
    );
  }

  return (
    <div className="app-shell app-grid">
      <header className="topbar">
        <div className="brand-dot" />
        <h1>Ishenium</h1>

        {user ? (
          <div className="user-chip">{user.name}</div>
        ) : (
          <div className="user-chip">Anonymous ({Math.max(ANON_MESSAGE_LIMIT - anonMessageCount, 0)} left)</div>
        )}
        {!user ? (
          <button className="plain-btn" onClick={() => setAuthPopupOpen(true)}>Sign in</button>
        ) : (
          <>
            <button className="plain-btn" onClick={logout} disabled={authActionLoading}>Logout</button>
            <button className="danger-btn" onClick={deleteAccount} disabled={authActionLoading}>Delete Account</button>
          </>
        )}
      </header>

      <aside className="sidebar">
        <button className="new-chat-btn" onClick={beginNewConversation}>New Chat</button>
        <div className="sidebar-title">Recent</div>
        <div className="conversation-list">
          {conversations.map((conversation) => (
            <div key={conversation.id} className="conversation-row">
              <button
                className={`conversation-item ${activeConversationId === conversation.id ? "active" : ""}`}
                onClick={() => openConversation(conversation.id)}
              >
                {conversation.title || conversation.slug || "Untitled conversation"}
              </button>
              <button className="delete-conversation-btn" onClick={() => deleteConversation(conversation.id)}>x</button>
            </div>
          ))}
        </div>
      </aside>

      <main className="chat-area">
        {messages.length === 0 ? (
          <section className="welcome">
            <h2>What do you want to know?</h2>
            <p>Ask anything to start your first conversation.</p>
          </section>
        ) : (
          <section className="messages">
            {messages.map((msg) => (
              <article key={msg.id} className={`message message-${msg.role}`}>
                <div className="role">{msg.role === "user" ? "You" : "Answer"}</div>
                <div className="bubble">
                  {msg.role === "assistant" ? (
                    <ReactMarkdown className="bubble-markdown">
                      {msg.text || (loading ? "Thinking..." : "")}
                    </ReactMarkdown>
                  ) : (
                    msg.text || ""
                  )}
                </div>

                {msg.role === "assistant" && Array.isArray(msg.sources) && msg.sources.length > 0 ? (
                  <div className="sources">
                    <div className="sources-title">Sources</div>
                    <ul>
                      {msg.sources.map((s, i) => (
                        <li key={`${s.url}-${i}`}>
                          <a href={s.url} target="_blank" rel="noreferrer">
                            {s.title || s.url}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </article>
            ))}
          </section>
        )}
      </main>

      <form className="composer" onSubmit={startConversation}>
        {suggestedPrompts.length > 0 ? (
          <div className="composer-suggestions composer-suggestions-accordion" aria-label="Suggested follow-up questions">
            <button
              type="button"
              className="suggestions-toggle"
              onClick={() => setSuggestionsExpanded((prev) => !prev)}
            >
              {suggestionsExpanded
                ? "Hide suggested questions"
                : `Suggested questions (${suggestedPrompts.length})`}
            </button>
            {suggestionsExpanded ? (
              <div className="composer-suggestions-list">
                {suggestedPrompts.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    className="suggestion-chip"
                    onClick={() => sendSuggestedPrompt(prompt)}
                    disabled={loading}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ask anything..."
          disabled={loading}
        />
        <button className="ask-btn" type="submit" disabled={!canSend}>{loading ? "Running" : "Ask"}</button>
      </form>

      {authPopupOpen ? (
        <div
          className="auth-modal-backdrop"
          role="button"
          tabIndex={0}
          onClick={() => setAuthPopupOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              setAuthPopupOpen(false);
            }
          }}
        >
          <div
            className="auth-modal"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setAuthPopupOpen(false);
              }
            }}
          >
            <h3>Sign in</h3>
            <p>
              Use your account to sync conversations across devices.
              {!user && anonMessageCount >= ANON_MESSAGE_LIMIT
                ? " Anonymous mode has a 5-message limit."
                : ""}
            </p>
            <div className="auth-actions">
              <a className="auth-btn" href={`${API_BASE}/auth/google`}>Continue with Google</a>
              <a className="auth-btn" href={`${API_BASE}/auth/github`}>Continue with GitHub</a>
            </div>
            <button className="plain-btn" onClick={() => setAuthPopupOpen(false)}>Close</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
