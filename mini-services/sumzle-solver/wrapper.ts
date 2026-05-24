import { spawn } from 'child_process';
import { resolve } from 'path';

const binaryPath = resolve(__dirname, 'target/release/sumzle-solver');

const proc = spawn(binaryPath, [], {
  stdio: 'inherit',
  env: {
    ...process.env,
    RUST_MIN_STACK: '4194304', // 4MB stack for recursive solver
  },
});

proc.on('error', (err) => {
  console.error('Failed to start solver:', err);
  process.exit(1);
});

proc.on('exit', (code) => {
  console.log(`Solver exited with code ${code}`);
  process.exit(code || 0);
});

process.on('SIGTERM', () => proc.kill('SIGTERM'));
process.on('SIGINT', () => proc.kill('SIGINT'));
