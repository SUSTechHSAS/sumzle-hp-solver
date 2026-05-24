import { NextRequest, NextResponse } from "next/server";

const SOLVER_PORT = 3031;

export async function GET(request: NextRequest) {
  try {
    const url = new URL(request.url);
    // Forward the full path to solver (Rust solver also uses /api/ prefix)
    const solverUrl = `http://localhost:${SOLVER_PORT}${url.pathname}${url.search}`;
    
    const res = await fetch(solverUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });
    
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: `Solver backend not available: ${error instanceof Error ? error.message : "Unknown error"}` },
      { status: 502 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const url = new URL(request.url);
    // Forward the full path to solver (Rust solver also uses /api/ prefix)
    const solverUrl = `http://localhost:${SOLVER_PORT}${url.pathname}${url.search}`;
    
    const body = await request.json();
    
    const res = await fetch(solverUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    
    const data = await res.json();
    return NextResponse.json(data, { status: res.status });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: `Solver backend not available: ${error instanceof Error ? error.message : "Unknown error"}` },
      { status: 502 }
    );
  }
}
