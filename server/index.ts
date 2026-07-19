import express from "express";
import cors from "cors";
import cookieSession from "cookie-session";
import bcrypt from "bcryptjs";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { Strategy as GithubStrategy } from "passport-github2";
import { and, desc, eq } from "drizzle-orm";
import { tavily } from "@tavily/core";
import { GoogleGenAI } from "@google/genai";
import { db } from "./db/client";
import { conversations, messages, users } from "./db/schema";
import { PROMPT_TEMPLATE, SYSTEM_PROMPT } from "./prompt";

const tavilyClient = tavily({
  apiKey: process.env.TAVILY_API_KEY,
});
const ai = new GoogleGenAI({});

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
const port = Number(process.env.PORT ?? 8080);
const apiBaseUrl = process.env.API_BASE_URL ?? `http://localhost:${port}`;
const clientUrl = process.env.CLIENT_URL ?? "http://localhost:5173";
const sessionSecret = process.env.SESSION_SECRET;

if (!sessionSecret) {
  throw new Error("SESSION_SECRET is required");
}

if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
  throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required");
}

if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
  throw new Error("GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are required");
}

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser(async (id: string, done) => {
  try {
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    done(null, user ?? false);
  } catch (error) {
    done(error as Error);
  }
});

async function upsertOAuthUser(input: {
  provider: "Google" | "Github";
  providerAccountId: string;
  email: string;
  name: string;
}) {
  const [existing] = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.provider, input.provider),
        eq(users.providerAccountId, input.providerAccountId),
      ),
    )
    .limit(1);

  if (existing) {
    return existing;
  }

  const [created] = await db
    .insert(users)
    .values({
      email: input.email,
      provider: input.provider,
      providerAccountId: input.providerAccountId,
      name: input.name,
    })
    .returning();

  return created;
}

async function findLocalUserByEmail(email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const [user] = await db
    .select()
    .from(users)
    .where(
      and(
        eq(users.provider, "Local"),
        eq(users.providerAccountId, normalizedEmail),
      ),
    )
    .limit(1);

  return user ?? null;
}

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${apiBaseUrl}/auth/google/callback`,
    },
    async (
      _accessToken: string,
      _refreshToken: string,
      profile: any,
      done: (error: Error | null, user?: Express.User | false) => void,
    ) => {
      try {
        const email = profile.emails?.[0]?.value ?? `${profile.id}@google.local`;
        const name = profile.displayName ?? "Google User";
        const user = await upsertOAuthUser({
          provider: "Google",
          providerAccountId: profile.id,
          email,
          name,
        });
        done(null, user);
      } catch (error) {
        done(error as Error);
      }
    },
  ),
);

passport.use(
  new GithubStrategy(
    {
      clientID: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      callbackURL: `${apiBaseUrl}/auth/github/callback`,
    },
    async (
      _accessToken: string,
      _refreshToken: string,
      profile: any,
      done: (error: Error | null, user?: Express.User | false) => void,
    ) => {
      try {
        const email = profile.emails?.[0]?.value ?? `${profile.username ?? profile.id}@github.local`;
        const name = profile.displayName ?? profile.username ?? "GitHub User";
        const user = await upsertOAuthUser({
          provider: "Github",
          providerAccountId: profile.id,
          email,
          name,
        });
        done(null, user);
      } catch (error) {
        done(error as Error);
      }
    },
  ),
);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        callback(null, true);
        return;
      }

      const defaultLocalOrigins = ["http://localhost:3000", "http://localhost:5173"];
      const allowedOrigins = new Set([...defaultLocalOrigins, clientUrl]);

      if (allowedOrigins.has(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error("CORS origin not allowed"));
    },
    credentials: true,
    exposedHeaders: ["X-Conversation-Id"],
  }),
);
app.use(
  cookieSession({
    name: "auth",
    keys: [sessionSecret],
    maxAge: 1000 * 60 * 60 * 24 * 30,
    httpOnly: true,
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    secure: process.env.NODE_ENV === "production",
  }),
);
app.use((req, _res, next) => {
  const session = (req as any).session;
  if (session && typeof session.regenerate !== "function") {
    session.regenerate = (cb: (err?: unknown) => void) => cb();
  }
  if (session && typeof session.save !== "function") {
    session.save = (cb: (err?: unknown) => void) => cb();
  }
  next();
});
app.use(passport.initialize());
app.use(passport.session());
app.use(express.json());
const STREAM_DEBUG = process.env.STREAM_DEBUG === "1";
const CONTEXT_CHARS_PER_TOKEN = 4;
const CONTEXT_MAX_INPUT_TOKENS = 5500;
const CONTEXT_RECENT_TURNS = 8;

function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) {
  if (!req.isAuthenticated() || !req.user) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  next();
}

function requireUser(req: express.Request) {
  if (!req.user) {
    throw new Error("user_not_found");
  }
  return req.user;
}

function makeSlug(input: string) {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40);
  return `${base || "conversation"}-${Date.now()}`;
}

function extractChunk(event: unknown) {
  const e = event as any;
  const delta = e?.delta;
  if (typeof delta === "string") return delta;
  if (typeof delta?.text === "string") return delta.text;
  if (typeof delta?.output_text === "string") return delta.output_text;
  if (typeof e?.text === "string") return e.text;
  if (typeof e?.output_text === "string") return e.output_text;
  return "";
}

function estimateTokens(text: string) {
  return Math.ceil(text.length / CONTEXT_CHARS_PER_TOKEN);
}

type StoredMessage = {
  role: "User" | "Assistant";
  context: string;
};

function formatConversationTurns(turns: StoredMessage[]) {
  return turns
    .map((turn) => `${turn.role}: ${turn.context.trim()}`)
    .join("\n\n")
    .trim();
}

async function summarizeOlderTurns(
  olderTurns: StoredMessage[],
  currentQuestion: string,
) {
  const olderTranscript = formatConversationTurns(olderTurns).slice(0, 18000);
  const summaryPrompt = [
    "Summarize the earlier conversation for context compression.",
    "Focus on: user intent, constraints, key facts, decisions, and unresolved items.",
    "Do not add new information.",
    "Keep it concise (8-12 bullet points).",
    "",
    `Current user question: ${currentQuestion}`,
    "",
    "Earlier conversation:",
    olderTranscript,
  ].join("\n");

  const summaryStream = await ai.interactions.create({
    model: "gemini-3.5-flash",
    input: summaryPrompt,
    system_instruction: "Return plain text bullets only.",
    stream: true,
  });

  let summary = "";
  for await (const event of summaryStream) {
    summary += extractChunk(event);
  }

  return summary.trim();
}

async function buildOptimizedConversationContext(
  conversationId: string,
  currentQuestion: string,
) {
  const rows = await db
    .select({
      role: messages.role,
      context: messages.context,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(messages.createdAt);

  const turns: StoredMessage[] = rows
    .filter((row) => typeof row.context === "string" && row.context.trim().length > 0)
    .map((row) => ({ role: row.role, context: row.context }));

  if (turns.length === 0) {
    return "";
  }

  const fullTranscript = formatConversationTurns(turns);
  const fullTokens = estimateTokens(fullTranscript);

  if (fullTokens <= CONTEXT_MAX_INPUT_TOKENS) {
    return fullTranscript;
  }

  const recentTurns = turns.slice(-CONTEXT_RECENT_TURNS);
  const olderTurns = turns.slice(0, -CONTEXT_RECENT_TURNS);

  let olderSummary = "";
  if (olderTurns.length > 0) {
    try {
      olderSummary = await summarizeOlderTurns(olderTurns, currentQuestion);
    } catch (error) {
      if (STREAM_DEBUG) {
        console.warn("[conversation] context summary failed", error);
      }
    }
  }

  const recentTranscript = formatConversationTurns(recentTurns);
  const sections: string[] = [];
  if (olderSummary) {
    sections.push(`Earlier conversation summary:\n${olderSummary}`);
  }
  sections.push(`Recent turns:\n${recentTranscript}`);

  let optimizedContext = sections.join("\n\n").trim();

  // If still too large, keep shrinking recent turns from oldest to newest.
  let shrinkTurns = [...recentTurns];
  while (estimateTokens(optimizedContext) > CONTEXT_MAX_INPUT_TOKENS && shrinkTurns.length > 2) {
    shrinkTurns = shrinkTurns.slice(1);
    const compactRecent = formatConversationTurns(shrinkTurns);
    const compactSections: string[] = [];
    if (olderSummary) compactSections.push(`Earlier conversation summary:\n${olderSummary}`);
    compactSections.push(`Recent turns:\n${compactRecent}`);
    optimizedContext = compactSections.join("\n\n").trim();
  }

  return optimizedContext;
}

app.get("/auth/google", passport.authenticate("google", { scope: ["profile", "email"] }));
app.post("/auth/signup", async (req, res) => {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const nameInput = typeof req.body?.name === "string" ? req.body.name.trim() : "";

    if (!email || !password) {
      res.status(400).json({ error: "email_and_password_required" });
      return;
    }

    if (password.length < 8) {
      res.status(400).json({ error: "password_too_short" });
      return;
    }

    const existing = await findLocalUserByEmail(email);
    if (existing) {
      res.status(409).json({ error: "account_already_exists" });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const fallbackName = email.split("@")[0] || "User";

    const [createdUser] = await db
      .insert(users)
      .values({
        email,
        provider: "Local",
        providerAccountId: email,
        passwordHash,
        name: (nameInput || fallbackName).slice(0, 80),
      })
      .returning();

    if (!createdUser) {
      res.status(500).json({ error: "signup_failed" });
      return;
    }

    req.login(createdUser, (error) => {
      if (error) {
        res.status(500).json({ error: "login_failed" });
        return;
      }

      res.json({
        ok: true,
        user: {
          id: createdUser.id,
          email: createdUser.email,
          name: createdUser.name,
          provider: createdUser.provider,
        },
      });
    });
  } catch (error) {
    console.error("[auth/signup] error", error);
    res.status(500).json({ error: "signup_failed" });
  }
});

app.post("/auth/signin", async (req, res) => {
  try {
    const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";

    if (!email || !password) {
      res.status(400).json({ error: "email_and_password_required" });
      return;
    }

    const user = await findLocalUserByEmail(email);
    if (!user || !user.passwordHash) {
      res.status(401).json({ error: "invalid_credentials" });
      return;
    }

    const passwordValid = await bcrypt.compare(password, user.passwordHash);
    if (!passwordValid) {
      res.status(401).json({ error: "invalid_credentials" });
      return;
    }

    req.login(user, (error) => {
      if (error) {
        res.status(500).json({ error: "login_failed" });
        return;
      }

      res.json({
        ok: true,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          provider: user.provider,
        },
      });
    });
  } catch (error) {
    console.error("[auth/signin] error", error);
    res.status(500).json({ error: "signin_failed" });
  }
});

app.get(
  "/auth/google/callback",
  passport.authenticate("google", { failureRedirect: `${clientUrl}?auth_error=google` }),
  (_req, res) => {
    res.redirect(clientUrl);
  },
);

app.get("/auth/github", passport.authenticate("github", { scope: ["user:email"] }));
app.get(
  "/auth/github/callback",
  passport.authenticate("github", { failureRedirect: `${clientUrl}?auth_error=github` }),
  (_req, res) => {
    res.redirect(clientUrl);
  },
);

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/auth/me", (req, res) => {
  if (!req.isAuthenticated() || !req.user) {
    res.status(401).json({ authenticated: false });
    return;
  }

  res.json({
    authenticated: true,
    user: {
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      provider: req.user.provider,
    },
  });
});

app.post("/auth/logout", (req, res) => {
  req.logout(() => {
    (req as any).session = null;
    res.json({ ok: true });
  });
});

app.delete("/auth/account", requireAuth, async (req, res) => {
  const user = requireUser(req);
  await db.delete(users).where(eq(users.id, user.id));
  req.logout(() => {
    (req as any).session = null;
    res.json({ ok: true });
  });
});

app.get("/conversations", requireAuth, async (req, res) => {
  const user = requireUser(req);
  const rows = await db
    .select({
      id: conversations.id,
      title: conversations.title,
      slug: conversations.slug,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .where(eq(conversations.userId, user.id))
    .orderBy(desc(conversations.createdAt));

  res.json({ conversations: rows });
});

app.post("/conversations/import", requireAuth, async (req, res) => {
  const user = requireUser(req);
  const input = req.body?.conversations;

  if (!Array.isArray(input)) {
    res.status(400).json({ error: "conversations_required" });
    return;
  }

  let imported = 0;

  for (const conversation of input) {
    if (!conversation || typeof conversation !== "object") continue;

    const titleRaw =
      typeof conversation.title === "string" && conversation.title.trim().length > 0
        ? conversation.title.trim()
        : "Imported conversation";

    const [createdConversation] = await db
      .insert(conversations)
      .values({
        userId: user.id,
        title: titleRaw.slice(0, 80),
        slug: makeSlug(titleRaw),
      })
      .returning({ id: conversations.id });

    if (!createdConversation) continue;

    const incomingMessages = Array.isArray((conversation as any).messages)
      ? (conversation as any).messages
      : [];

    const messageRows = incomingMessages
      .filter((message: any) => message && typeof message.text === "string" && message.text.trim())
      .map((message: any) => ({
        conversationId: createdConversation.id,
        role: message.role === "user" ? "User" : "Assistant",
        context: message.text.trim(),
      }));

    if (messageRows.length > 0) {
      await db.insert(messages).values(messageRows);
    }

    imported += 1;
  }

  res.json({ ok: true, imported });
});

app.get("/conversations/:id/messages", requireAuth, async (req, res) => {
  const user = requireUser(req);
  const conversationParam = req.params.id;
  const conversationId =
    typeof conversationParam === "string" ? conversationParam : null;
  if (!conversationId) {
    res.status(400).json({ error: "conversation_id_required" });
    return;
  }
  const [conversation] = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.userId, user.id),
      ),
    )
    .limit(1);

  if (!conversation) {
    res.status(404).json({ error: "conversation_not_found" });
    return;
  }

  const rows = await db
    .select({
      id: messages.id,
      role: messages.role,
      context: messages.context,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversation.id))
    .orderBy(messages.createdAt);

  res.json({ messages: rows });
});

app.delete("/conversations/:id", requireAuth, async (req, res) => {
  const user = requireUser(req);
  const conversationParam = req.params.id;
  const conversationId =
    typeof conversationParam === "string" ? conversationParam : null;

  if (!conversationId) {
    res.status(400).json({ error: "conversation_id_required" });
    return;
  }

  const [deleted] = await db
    .delete(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.userId, user.id),
      ),
    )
    .returning({ id: conversations.id });

  if (!deleted) {
    res.status(404).json({ error: "conversation_not_found" });
    return;
  }

  res.json({ ok: true });
});

async function handleConversation(
  req: express.Request,
  res: express.Response,
) {
  try {
    const user = req.user ?? null;
    const { message, conversationId } = req.body;
    if (typeof message !== "string" || message.trim().length === 0) {
      res.status(400).json({ error: "message_required" });
      return;
    }

    const trimmedMessage = message.trim();
    let activeConversationId = conversationId as string | undefined;

    if (user) {
      if (activeConversationId) {
        const [existingConversation] = await db
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(conversations.id, activeConversationId),
              eq(conversations.userId, user.id),
            ),
          )
          .limit(1);
        if (!existingConversation) {
          res.status(404).json({ error: "conversation_not_found" });
          return;
        }
      } else {
        const [createdConversation] = await db
          .insert(conversations)
          .values({
            userId: user.id,
            slug: makeSlug(trimmedMessage),
            title: trimmedMessage.slice(0, 80),
          })
          .returning({ id: conversations.id });
        if (!createdConversation) {
          res.status(500).json({ error: "conversation_create_failed" });
          return;
        }
        activeConversationId = createdConversation.id;
      }

      await db.insert(messages).values({
        conversationId: activeConversationId,
        role: "User",
        context: trimmedMessage,
      });
    }

    if (STREAM_DEBUG) {
      console.log("[conversation] request", {
        hasMessage: true,
        messageLength: trimmedMessage.length,
        conversationId: activeConversationId,
      });
    }

    const response = await tavilyClient.search(trimmedMessage, {
      includeSources: true,
      includeAnswer: true,
      searchDepth: "basic",
    });
    const results = response.results;

    let conversationContext = "";
    if (user && activeConversationId) {
      conversationContext = await buildOptimizedConversationContext(
        activeConversationId,
        trimmedMessage,
      );
    }

    const queryWithContext = conversationContext
      ? [
          "Use this conversation context to maintain continuity.",
          "",
          conversationContext,
          "",
          `Current user question: ${trimmedMessage}`,
        ].join("\n")
      : trimmedMessage;

    const input = PROMPT_TEMPLATE.replace(
      "{{web_search_results}}",
      JSON.stringify(results),
    ).replace("{{user_query}}", queryWithContext);

    const interaction_stream = await ai.interactions.create({
      model: "gemini-3.5-flash",
      input: input,
      system_instruction: SYSTEM_PROMPT,
      stream: true,
    });

    res.header("Cache-Control", "no-cache");
    res.header("Content-Type", "text/event-stream; charset=utf-8");
    if (activeConversationId) {
      res.header("X-Conversation-Id", activeConversationId);
    }
    res.flushHeaders?.();

    let writtenChars = 0;
    let assistantText = "";
    for await (const event of interaction_stream) {
      if (STREAM_DEBUG) {
        console.log("[conversation] event", {
          eventType: (event as any)?.event_type,
          keys: Object.keys((event as any) ?? {}),
        });
      }

      const chunk = extractChunk(event);

      if (chunk) {
        writtenChars += chunk.length;
        assistantText += chunk;
        res.write(chunk);
      }
    }

    if (user && activeConversationId) {
      await db.insert(messages).values({
        conversationId: activeConversationId,
        role: "Assistant",
        context: assistantText,
      });
    }

    if (STREAM_DEBUG) {
      console.log("[conversation] stream done", { writtenChars });
    }

    res.write("\n<SOURCES>\n");
    res.write(
      JSON.stringify(
        results.map((result) => ({
          url: result.url,
          title: result.title,
        })),
      ),
    );
    res.write("\n</SOURCES>\n");
    res.end();
  } catch (error) {
    console.error("[conversation] error", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "conversation_failed" });
      return;
    }
    res.end();
  }
}

app.post("/conversation", handleConversation);

app.post("/conversation/followup", async (req, res) => {
  await handleConversation(req, res);
});

app.listen(port, () => {
  console.log(`Server is up and running on port ${port}`);
});
