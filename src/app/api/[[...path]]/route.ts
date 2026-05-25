import { NextRequest, NextResponse } from "next/server";
import { execSync } from "child_process";

const SOLVER_PORT = 3031;
const SOLVER_STARTUP_TIMEOUT = 10000; // 10s to wait for solver to start
const SOLVER_CHECK_INTERVAL = 500; // Check every 500ms
const SOLVER_REQUEST_TIMEOUT = 180000; // 3 minutes max for solve requests

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
 * Check if solver is busy by querying its status endpoint.
 */
async function isSolverBusy(): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${SOLVER_PORT}/api/solve/status`, {
      signal: AbortSignal.timeout(2000),
    });
    if (res.ok) {
      const data = await res.json();
      return data?.data?.busy === true;
    }
  } catch {
    // If we can't reach the solver, it's not "busy" — it's down
  }
  return false;
}

/**
 * Kill the solver process and restart it fresh.
 * This is used when the busy flag gets stuck.
 */
async function resetSolver(): Promise<boolean> {
  try {
    // Kill existing solver processes
    execSync('pkill -9 -f sumzle-solver 2>/dev/null || true', { timeout: 3000 });
    await new Promise(r => setTimeout(r, 1000));

    // Start fresh
    const started = await tryStartSolver();
    return started;
  } catch {
    return false;
  }
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
    return { data: null, parseError: `Invalid JSON from solver: ${msg}`, rawText: "" };
  }
}

/**
 * Normalize tile states in request body for Rust solver compatibility.
 * The Rust solver's TileState enum has: correct, present, absent, empty
 * Map "absent" → "empty" for backward compatibility with older binaries
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
 * Estimate solve complexity based on expression length and constraints.
 * Returns 'fast', 'moderate', 'slow', or 'very_slow'
 */
function estimateComplexity(body: unknown): 'fast' | 'moderate' | 'slow' | 'very_slow' {
  if (!body || typeof body !== 'object') return 'fast';
  const b = body as Record<string, unknown>;
  const length = (b.length as number) || 6;
  const rows = b.rows as Array<Array<{ char: string; state: string }>> | undefined;

  // Count constraints
  let constraintCount = 0;
  if (rows) {
    for (const row of rows) {
      for (const tile of row) {
        if (tile.char && tile.state !== 'empty') constraintCount++;
      }
    }
  }

  if (length <= 5) return 'fast';
  if (length === 6) return constraintCount >= 3 ? 'fast' : 'moderate';
  if (length === 7) return constraintCount >= 5 ? 'moderate' : 'slow';
  if (length === 8) return constraintCount >= 5 ? 'slow' : 'very_slow';
  return 'very_slow'; // length >= 9
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

  // Use longer timeout for solve requests
  const timeout = method === 'POST' && pathname.includes('/solve') ? SOLVER_REQUEST_TIMEOUT : 5000;

  const fetchOptions: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(timeout),
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
      let detail = rawText.substring(0, 200);
      if (detail.includes("unknown_variant")) {
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
  const url = new URL(request.url);
  const pathname = url.pathname;

  // Handle /api/solver/reset - kill and restart stuck solver
  if (pathname === '/api/solver/reset') {
    const success = await resetSolver();
    return NextResponse.json({
      success,
      message: success ? 'Solver reset successfully' : 'Failed to reset solver',
    });
  }

  // Handle /api/solve/status - check if solver is busy
  if (pathname === '/api/solve/status') {
    try {
      return await fetchSolver(pathname, url.search, "GET");
    } catch {
      return NextResponse.json({
        success: true,
        data: { busy: false },
        error: null,
      });
    }
  }

  try {
    return await fetchSolver(pathname, url.search, "GET");
  } catch (error) {
    // If solver is not running, try to start it
    const alive = await tryStartSolver();
    if (alive) {
      try {
        return await fetchSolver(pathname, url.search, "GET");
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

  const url = new URL(request.url);
  const pathname = url.pathname;

  // Only check busy state for solve endpoints
  if (pathname.includes('/solve')) {
    // Check if solver is already busy
    const busy = await isSolverBusy();
    if (busy) {
      return NextResponse.json(
        {
          success: false,
          error: "Solver is currently busy processing another request. Please wait a moment and try again, or click 'Reset Solver' if it seems stuck.",
          data: { solver_busy: true },
        },
        { status: 409 } // 409 Conflict
      );
    }

    // Estimate complexity and warn if very slow
    const complexity = estimateComplexity(body);
    if (complexity === 'very_slow') {
      // For very slow solves, add a hint in the response headers
      // but still proceed with the request
    }
  }

  try {
    return await fetchSolver(pathname, url.search, "POST", body);
  } catch (error) {
    // If solver is not running, try to start it
    const alive = await tryStartSolver();
    if (alive) {
      try {
        return await fetchSolver(pathname, url.search, "POST", body);
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
    } else if (errorMsg.includes("abort") || errorMsg.includes("timeout") || errorMsg.includes("Timeout")) {
      friendlyMsg = "Solver request timed out. The puzzle search space is too large — try adding more constraints to narrow results, or use a shorter expression length.";
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
