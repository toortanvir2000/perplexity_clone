# Ishenium

Ishenium is a production-focused AI search and conversation app built for fast answers, persistent chat, and clean deployment. It combines web search, generative AI, conversation history, account-based sync, and a mobile-aware chat UI in a single fullstack project.

## What It Does

- Streams AI answers in a chat-first interface
- Uses live web search context for better responses
- Supports anonymous chatting with a capped free usage flow
- Supports account-based persistence with:
  - Google OAuth
  - GitHub OAuth
  - Email and password auth
- Saves conversations and messages for signed-in users
- Migrates anonymous conversations into a signed-in account
- Optimizes long conversation context with summarization
- Deploys as a single-origin app to avoid third-party cookie issues

## Stack

### Frontend

- React
- Vite
- React Markdown

### Backend

- Express 5
- TypeScript
- Passport
- Cookie-based sessions

### AI and Search

- Google GenAI
- Tavily Search

### Database

- Neon Postgres
- Drizzle ORM

### Deployment

- Render Blueprint
- Single service, single origin setup

## Why Single-Origin Deployment

The app is designed to run frontend and backend from the same public domain in production. This avoids the cross-site cookie problems that commonly break authentication on mobile devices and stricter browsers.

In production:

- the React app is built from `client/`
- the Express server in `server/` serves the built assets
- auth cookies remain first-party

## Project Structure

```text
.
├── client/                 React frontend
├── server/                 Express API, auth, DB, AI integration
├── render.yaml             Render Blueprint
├── DEPLOY_CHECKLIST.md     Deployment runbook
└── README.md               Project overview
```

## Core Features

### Chat Experience

- Real-time streaming responses
- Suggested follow-up questions
- Mobile-friendly layout with compact conversation controls
- Markdown answer rendering

### Auth and Accounts

- OAuth with Google and GitHub
- Local email/password signup and signin
- Session-based auth with persistent conversation history
- Logout and account deletion

### Anonymous Mode

- Anonymous users can start immediately
- Anonymous usage is limited to 5 prompts total
- After sign-in, local anonymous conversations are imported into the account

### Context Optimization

- Older turns are summarized when the conversation gets large
- Recent turns are preserved in detail
- Helps reduce context window pressure and token waste

## Local Development

### 1. Install Dependencies

Frontend:

```bash
cd client
npm install
```

Backend:

```bash
cd server
npm install
```

### 2. Configure Environment Variables

Use `server/.env.example` as the base.

Required backend variables:

```bash
TAVILY_API_KEY=
GOOGLE_API_KEY=
STREAM_DEBUG=0
DATABASE_URL=
DATABASE_URL_DIRECT=
SESSION_SECRET=
CLIENT_URL=http://localhost:5173
API_BASE_URL=http://localhost:8080
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
```

Optional frontend variable:

```bash
VITE_API_URL=http://localhost:8080
```

If `VITE_API_URL` is not set, the frontend already defaults to localhost in local development.

### 3. Run the App

Backend:

```bash
cd server
bun run dev
```

Frontend:

```bash
cd client
npm run dev
```

## Database Workflow

Generate migrations:

```bash
cd server
npm run db:generate
```

Apply migrations:

```bash
cd server
npm run db:migrate
```

Open Drizzle Studio:

```bash
cd server
npm run db:studio
```

## Deployment

The recommended production setup is Render using the included [render.yaml](./render.yaml).

### Render Build Strategy

The Render service:

- installs frontend dependencies
- builds the React app
- installs server dependencies
- starts Express from `server/index.ts`

### Required Production Environment Variables

Set these on the Render service:

- `DATABASE_URL`
- `DATABASE_URL_DIRECT`
- `SESSION_SECRET`
- `GOOGLE_API_KEY`
- `TAVILY_API_KEY`
- `CLIENT_URL`
- `API_BASE_URL`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`

For single-origin production, both of these should be the same public app URL:

```bash
CLIENT_URL=https://your-app.onrender.com
API_BASE_URL=https://your-app.onrender.com
```

### OAuth Callback URLs

Google:

```text
https://your-app.onrender.com/auth/google/callback
```

GitHub:

```text
https://your-app.onrender.com/auth/github/callback
```

### Deployment Checklist

See [DEPLOY_CHECKLIST.md](./DEPLOY_CHECKLIST.md) for the operational checklist.

## Scripts

### Client

```bash
npm run dev
npm run build
npm run preview
```

### Server

```bash
bun run dev
npm run env:check
npm run db:generate
npm run db:migrate
npm run db:studio
npm run smoke:deploy
```

## Common Troubleshooting

### Auth Works Locally But Fails on Mobile or Other Devices

Use the single-origin production deployment. Split frontend/backend domains often cause cookie and auth persistence issues.

### `DATABASE_URL is not set`

Make sure the active Render service has `DATABASE_URL` or `DATABASE_URL_DIRECT` configured in its Environment settings.

### Static Assets Return 500 or HTML Instead of JS/CSS

Ensure the frontend was built successfully and the backend is serving `client/dist` in production.

### Login Succeeds in DB But UI Still Shows Signed Out

Check that:

- cookies are being set
- `/auth/me` returns `authenticated: true`
- frontend and backend are running on the same production origin

## Current Product Direction

Ishenium is built as a practical AI product rather than a demo app. The system is designed around:

- durable conversations
- production-grade auth behavior
- deployment realism
- mobile usability
- context efficiency for long-running chats

## License

No license file is currently included in this repository.
