import {
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  integer,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const authProviderEnum = pgEnum("auth_provider", ["Github", "Google", "Local"]);
export const messageRoleEnum = pgEnum("message_role", ["User", "Assistant"]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    provider: authProviderEnum("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    passwordHash: text("password_hash"),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    providerAccountUnique: unique("users_provider_account_unique").on(
      table.provider,
      table.providerAccountId,
    ),
    emailIndex: index("users_email_idx").on(table.email),
  }),
);

export const conversations = pgTable("conversations", {
  id: uuid("id").defaultRandom().primaryKey(),
  title: text("title"),
  slug: text("slug").notNull(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const messages = pgTable("messages", {
  id: integer("id").generatedAlwaysAsIdentity().primaryKey(),
  context: text("context").notNull(),
  role: messageRoleEnum("role").notNull(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
