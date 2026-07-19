const backendUrl = process.env.BACKEND_URL;

if (!backendUrl) {
  console.error("Missing BACKEND_URL. Example: https://your-api.onrender.com");
  process.exit(1);
}

function normalizeBaseUrl(url) {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

const base = normalizeBaseUrl(backendUrl);

async function check(name, run) {
  try {
    await run();
    console.log(`[PASS] ${name}`);
  } catch (error) {
    console.error(`[FAIL] ${name}`);
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

await check("GET /auth/me responds", async () => {
  const response = await fetch(`${base}/auth/me`, {
    method: "GET",
  });

  if (response.status !== 200 && response.status !== 401) {
    throw new Error(`Unexpected status: ${response.status}`);
  }
});

await check("POST /conversation anonymous flow", async () => {
  const response = await fetch(`${base}/conversation`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message: "Smoke test ping" }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Status ${response.status}: ${body}`);
  }

  const body = await response.text();
  if (!body.includes("<SOURCES>")) {
    throw new Error("Response missing <SOURCES> marker");
  }
});

if (process.exitCode !== 1) {
  console.log("Deployment smoke test completed.");
}
