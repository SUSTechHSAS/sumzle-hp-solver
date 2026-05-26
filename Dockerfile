# ─── Stage 1: Build Rust Solver ──────────────────────────────────────────
FROM rust:1.82-bookworm AS rust-builder

WORKDIR /build
COPY mini-services/sumzle-solver/ ./
ENV RUST_MIN_STACK=16777216
RUN cargo build --release

# ─── Stage 2: Build Next.js Frontend ────────────────────────────────────
FROM oven/bun:1 AS frontend-builder

WORKDIR /build
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile

COPY . .
RUN bun run db:generate
RUN bun run build

# ─── Stage 3: Production Image ──────────────────────────────────────────
FROM debian:bookworm-slim AS production

# Install runtime dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy Rust solver
COPY --from=rust-builder /build/target/release/sumzle-solver /app/sumzle-solver

# Copy Next.js standalone build
COPY --from=frontend-builder /build/.next/standalone /app/
COPY --from=frontend-builder /build/.next/static /app/.next/static
COPY --from=frontend-builder /build/public /app/public

# Set environment
ENV RUST_MIN_STACK=16777216
ENV NODE_ENV=production
ENV SOLVER_PORT=3031
ENV PORT=3000

# Expose ports
EXPOSE 3000 3031

# Create startup script
RUN cat > /app/start.sh << 'EOF'
#!/bin/bash
set -e
echo "Starting Sumzle HP Solver..."

# Start Rust solver in background
echo "Starting Rust solver on port 3031..."
/app/sumzle-solver &
SOLVER_PID=$!

# Wait for solver to be ready
echo "Waiting for solver to start..."
for i in $(seq 1 30); do
  if curl -s http://127.0.0.1:3031/api/health > /dev/null 2>&1; then
    echo "Solver is ready!"
    break
  fi
  sleep 1
done

# Start Next.js frontend
echo "Starting Next.js frontend on port 3000..."
cd /app
node server.js &
FRONTEND_PID=$!

# Wait for any process to exit
wait -n $SOLVER_PID $FRONTEND_PID

# Kill remaining processes
kill $SOLVER_PID $FRONTEND_PID 2>/dev/null || true
EOF
RUN chmod +x /app/start.sh

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
  CMD curl -f http://127.0.0.1:3031/api/health && curl -f http://127.0.0.1:3000 || exit 1

CMD ["/app/start.sh"]
