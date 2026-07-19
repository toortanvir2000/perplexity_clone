import "dotenv/config";

const required = [
  "DATABASE_URL",
  "DATABASE_URL_DIRECT",
  "GOOGLE_API_KEY",
  "TAVILY_API_KEY",
  "SESSION_SECRET",
  "CLIENT_URL",
  "API_BASE_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
];

const missing = required.filter((key) => !process.env[key] || !process.env[key].trim());

if (missing.length > 0) {
  console.error("Missing required environment variables:");
  for (const key of missing) {
    console.error(`- ${key}`);
  }
  process.exit(1);
}

const warnings = [];

if ((process.env.SESSION_SECRET || "").includes("replace-with")) {
  warnings.push("SESSION_SECRET appears to be a placeholder.");
}

if (!(process.env.CLIENT_URL || "").startsWith("http")) {
  warnings.push("CLIENT_URL should be a full URL.");
}

if (!(process.env.API_BASE_URL || "").startsWith("http")) {
  warnings.push("API_BASE_URL should be a full URL.");
}

if (warnings.length > 0) {
  console.warn("Environment warnings:");
  for (const warning of warnings) {
    console.warn(`- ${warning}`);
  }
}

console.log("Environment check passed.");
