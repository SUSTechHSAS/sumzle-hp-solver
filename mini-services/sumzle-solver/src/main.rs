mod solver;
mod parallel;
mod distributed;
mod api;

use api::AppState;
use distributed::DistributedCoordinator;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Instant;

const PORT: u16 = 3031;

fn main() {
    // Set stack size BEFORE creating tokio runtime
    // This affects spawn_blocking threads
    std::env::set_var("RUST_MIN_STACK", "8388608"); // 8MB

    let num_threads = num_cpus::get();
    tracing_subscriber::fmt::init();

    tracing::info!("Sumzle High-Performance Solver starting...");
    tracing::info!("  Port: {}", PORT);
    tracing::info!("  CPU cores: {}", num_threads);
    tracing::info!("  Parallel engine: Rayon");
    tracing::info!("  Distributed computing: Enabled (coordinator mode)");

    // Build tokio runtime - RUST_MIN_STACK controls spawn_blocking thread stack size
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .max_blocking_threads(4)
        .enable_all()
        .build()
        .expect("Failed to create tokio runtime");

    runtime.block_on(async move {
        let coordinator = Arc::new(DistributedCoordinator::new(num_threads));
        let state = AppState {
            coordinator: coordinator.clone(),
            start_time: Instant::now(),
            busy: AtomicBool::new(false),
        };

        let app = api::create_router(state);

        let addr = format!("0.0.0.0:{}", PORT);
        tracing::info!("Server listening on {}", addr);

        let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
        axum::serve(listener, app).await.unwrap();
    });
}
