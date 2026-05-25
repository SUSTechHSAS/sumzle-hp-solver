import { NextRequest, NextResponse } from "next/server";

const SOLVER_PORT = 3031;
const SOLVER_STARTUP_TIMEOUT = 10000; // 10s to wait for solver to start
const SOLVER_CHECK_INTERVAL = 500; // Check every 500ms

// Track solver startup state
let solverStarting = false;
let solverStartTime = 0;

async function isSolverAlive(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${SOLVER_PORT}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForSolver(maxWaitMs: number = SOLVER_STARTUP_TIMEOUT): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (await isSolverAlive()) return true;
    await new Promise(r => setTimeout(r, SOLVER_CHECK_INTERVAL));
  }
  return false;
}

/**
 * Safely parse JSON from a response, returning null if the body is not valid JSON.
 */
async function safeParseJson(res: Response): Promise<{ data: unknown; parseError: string | null; rawText: string }> {
  try {
    const text = await res.text();
    if (!text || text.trim().length === 0) {
      return { data: null, parseError: "Empty response body from solver", rawText: text };
    }
    const parsed = JSON.parse(text);
    return { data: parsed, parseError: null, rawText: text };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown JSON parse error";
    const text = await res.text?.() ?? "";
    return { data: null, parseError: `Invalid JSON from solver: ${msg}`, rawText: text };
  }
}

/**
 * Normalize tile states in request body for Rust solver compatibility.
 * The Rust solver's TileState enum has: correct, present, empty
 * The frontend may send: correct, present, absent, empty
 * Map "absent" → "empty" (Rust treats "empty with char" as absent/grey in constraint processing)
 */
function normalizeTileStates(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const b = body as Record<string, unknown>;

  // Normalize rows array
  if (Array.isArray(b.rows)) {
    b.rows = b.rows.map((row: unknown) => {
      if (!Array.isArray(row)) return row;
      return row.map((tile: unknown) => {
        if (!tile || typeof tile !== 'object') return tile;
        const t = tile as Record<string, unknown>;
        if (t.state === 'absent') {
          return { ...t, state: 'empty' };
        }
        return tile;
      });
    });
  }

  return b;
}

/**
 * Try to start the solver binary and wait for it to come up.
 */
async function tryStartSolver(): Promise<boolean> {
  if (solverStarting && Date.now() - solverStartTime < SOLVER_STARTUP_TIMEOUT) {
    // Another request is already starting the solver, wait for it
    return waitForSolver(SOLVER_STARTUP_TIMEOUT - (Date.now() - solverStartTime));
  }

  solverStarting = true;
  solverStartTime = Date.now();
  try {
    const { spawn } = await import('child_process');
    const { resolve } = await import('path');
    const binaryPath = resolve(process.cwd(), 'mini-services/sumzle-solver/target/release/sumzle-solver');
    const proc = spawn(binaryPath, [], {
      stdio: 'ignore',
      detached: true,
      env: {
        ...process.env,
        RUST_MIN_STACK: '16777216',
      },
    });
    proc.unref();
  } catch {
    // Failed to start solver
  }
  // Wait for solver to come up
  const alive = await waitForSolver();
  solverStarting = false;
  return alive;
}

/**
 * Make a request to the Rust solver, with automatic retry on failure.
 */
async function fetchSolver(pathname: string, search: string, method: string, body?: unknown): Promise<NextResponse> {
  const solverUrl = `http://127.0.0.1:${SOLVER_PORT}${pathname}${search}`;

  const fetchOptions: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(method === 'POST' ? 120000 : 5000),
  };
  if (body !== undefined) {
    fetchOptions.body = JSON.stringify(body);
  }

  const res = await fetch(solverUrl, fetchOptions);

  // Try to parse the response as JSON
  const { data, parseError, rawText } = await safeParseJson(res);

  if (parseError) {
    // Handle specific HTTP status codes with better messages
    if (res.status === 422) {
      // Unprocessable Entity - usually a deserialization error
      // Extract useful info from the raw text (Axum error messages)
      let detail = rawText.substring(0, 200);
      if (detail.includes("unknown variant")) {
        // e.g., "unknown variant `absent`, expected one of `correct`, `present`, `empty`"
        const match = detail.match(/unknown variant `(\w+)`/);
        const variant = match ? match[1] : 'unknown';
        detail = `Unsupported tile state: "${variant}". The solver may need to be updated.`;
      }
      return NextResponse.json(
        {
          success: false,
          error: `Invalid request data: ${detail}`,
          data: null,
        },
        { status: 400 }
      );
    }

    // The solver returned non-JSON (might be HTML error page, empty body, etc.)
    return NextResponse.json(
      {
        success: false,
        error: `Solver returned invalid response (HTTP ${res.status}): ${parseError}`,
        data: { solver_online: false },
      },
      { status: res.status >= 400 ? res.status : 502 }
    );
  }

  return NextResponse.json(data, { status: res.status });
}

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    return await fetchSolver(url.pathname, url.search, "GET");
  } catch (error) {
    // If solver is not running, try to start it
    const alive = await tryStartSolver();
    if (alive) {
      try {
        const url = new URL(request.url);
        return await fetchSolver(url.pathname, url.search, "GET");
      } catch {
        // Still failed after restart
      }
    }

    return NextResponse.json(
      {
        success: false,
        error: `Solver backend not available: ${error instanceof Error ? error.message : "Unknown error"}`,
        data: { solver_online: false },
      },
      { status: 502 }
    );
  }
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid JSON in request body",
        data: null,
      },
      { status: 400 }
    );
  }

  // Normalize tile states for Rust solver compatibility (absent → empty)
  body = normalizeTileStates(body);

  try {
    const url = new URL(request.url);
    return await fetchSolver(url.pathname, url.search, "POST", body);
  } catch (error) {
    // If solver is not running, try to start it
    const alive = await tryStartSolver();
    if (alive) {
      try {
        const url = new URL(request.url);
        return await fetchSolver(url.pathname, url.search, "POST", body);
      } catch {
        // Still failed after restart
      }
    }

    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    // Provide a user-friendly error message
    let friendlyMsg = "Solver backend not available";
    if (errorMsg.includes("ECONNREFUSED")) {
      friendlyMsg = "Solver is starting up, please try again in a few seconds";
    } else if (errorMsg.includes("fetch failed")) {
      friendlyMsg = "Solver connection failed. It may be restarting";
    } else if (errorMsg.includes("abort")) {
      friendlyMsg = "Solver request timed out. The puzzle may be too complex";
    }

    return NextResponse.json(
      {
        success: false,
        error: friendlyMsg,
        data: { solver_online: false },
      },
      { status: 502 }
    );
  }
}
