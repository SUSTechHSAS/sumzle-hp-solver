import { spawn, ChildProcess } from 'child_process';
import { resolve } from 'path';
import { existsSync } from 'fs';

const binaryPath = resolve(__dirname, 'target/release/sumzle-solver');

if (!existsSync(binaryPath)) {
  console.error('Solver binary not found at:', binaryPath);
  process.exit(1);
}

let proc: ChildProcess | null = null;
let restartCount = 0;
const MAX_RESTARTS = 50; // Max restarts per session
let lastRestartTime = 0;

function startSolver() {
  if (restartCount >= MAX_RESTARTS) {
    console.error(`Max restarts (${MAX_RESTARTS}) reached. Exiting.`);
    process.exit(1);
  }

  const now = Date.now();
  if (now - lastRestartTime < 2000) {
    // If restarting too quickly, wait a bit
    console.log('Restarting too quickly, waiting 2s...');
    setTimeout(startSolver, 2000);
    return;
  }

  lastRestartTime = now;
  restartCount++;
  console.log(`Starting solver (restart #${restartCount})...`);

  proc = spawn(binaryPath, [], {
    stdio: 'inherit',
    env: {
      ...process.env,
      RUST_MIN_STACK: '16777216', // 16MB stack for deep recursive solver
    },
  });

  proc.on('error', (err) => {
    console.error('Solver error:', err);
    proc = null;
    setTimeout(startSolver, 3000);
  });

  proc.on('exit', (code, signal) => {
    console.log(`Solver exited with code ${code}, signal ${signal}`);
    proc = null;
    // Auto-restart after a delay
    setTimeout(startSolver, 2000);
  });
}

// Start the solver
startSolver();

// Handle shutdown signals
process.on('SIGTERM', () => {
  console.log('Watchdog received SIGTERM, shutting down...');
  if (proc) proc.kill('SIGTERM');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Watchdog received SIGINT, shutting down...');
  if (proc) proc.kill('SIGINT');
  process.exit(0);
});
