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

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const solverUrl = `http://127.0.0.1:${SOLVER_PORT}${url.pathname}${url.search}`;

    const res = await fetch(solverUrl, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5000),
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (error) {
    // If solver is not running, try to start it
    if (!solverStarting) {
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
            RUST_MIN_STACK: '4194304',
          },
        });
        proc.unref();
      } catch (e) {
        // Failed to start solver
      }
      // Wait for solver to come up
      const alive = await waitForSolver();
      solverStarting = false;

      if (alive) {
        // Retry the request
        try {
          const url = new URL(request.url);
          const solverUrl = `http://127.0.0.1:${SOLVER_PORT}${url.pathname}${url.search}`;
          const res = await fetch(solverUrl, {
            method: "GET",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(5000),
          });
          const data = await res.json();
          return NextResponse.json(data, { status: res.status });
        } catch {
          // Still failed after restart
        }
      }
    } else if (Date.now() - solverStartTime < SOLVER_STARTUP_TIMEOUT) {
      // Another request is already starting the solver, wait for it
      const alive = await waitForSolver(SOLVER_STARTUP_TIMEOUT - (Date.now() - solverStartTime));
      if (alive) {
        try {
          const url = new URL(request.url);
          const solverUrl = `http://127.0.0.1:${SOLVER_PORT}${url.pathname}${url.search}`;
          const res = await fetch(solverUrl, {
            method: "GET",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(5000),
          });
          const data = await res.json();
          return NextResponse.json(data, { status: res.status });
        } catch {
          // Failed
        }
      }
    }

    return NextResponse.json(
      {
        success: false,
        error: `Solver backend not available: ${error instanceof Error ? error.message : "Unknown error"}`,
        data: { solver_online: false }
      },
      { status: 502 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const url = new URL(request.url);
    const solverUrl = `http://127.0.0.1:${SOLVER_PORT}${url.pathname}${url.search}`;

    const body = await request.json();

    const res = await fetch(solverUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000), // 2 min timeout for solves
    });

    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (error) {
    // If solver is not running, try to start it
    if (!solverStarting) {
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
            RUST_MIN_STACK: '4194304',
          },
        });
        proc.unref();
      } catch (e) {
        // Failed to start solver
      }
      // Wait for solver to come up
      const alive = await waitForSolver();
      solverStarting = false;

      if (alive) {
        // Retry the request
        try {
          const url = new URL(request.url);
          const solverUrl = `http://127.0.0.1:${SOLVER_PORT}${url.pathname}${url.search}`;
          const res = await fetch(solverUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),  // Note: body was already parsed
            signal: AbortSignal.timeout(120000),
          });
          const data = await res.json();
          return NextResponse.json(data, { status: res.status });
        } catch {
          // Still failed after restart
        }
      }
    } else if (Date.now() - solverStartTime < SOLVER_STARTUP_TIMEOUT) {
      const alive = await waitForSolver(SOLVER_STARTUP_TIMEOUT - (Date.now() - solverStartTime));
      if (alive) {
        try {
          const url = new URL(request.url);
          const solverUrl = `http://127.0.0.1:${SOLVER_PORT}${url.pathname}${url.search}`;
          const res = await fetch(solverUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(120000),
          });
          const data = await res.json();
          return NextResponse.json(data, { status: res.status });
        } catch {
          // Failed
        }
      }
    }

    return NextResponse.json(
      {
        success: false,
        error: `Solver backend not available: ${error instanceof Error ? error.message : "Unknown error"}`,
        data: { solver_online: false }
      },
      { status: 502 }
    );
  }
}
