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

#[tokio::main(flavor = "multi_thread", worker_threads = 4)]
async fn main() {
    tracing_subscriber::fmt::init();

    // Set stack size for blocking threads (recursive solver needs large stack)
    std::env::set_var("RUST_MIN_STACK", "16777216"); // 16MB stack

    let num_threads = num_cpus::get();
    tracing::info!("Sumzle High-Performance Solver starting...");
    tracing::info!("  Port: {}", PORT);
    tracing::info!("  CPU cores: {}", num_threads);
    tracing::info!("  Parallel engine: Rayon");
    tracing::info!("  Distributed computing: Enabled (coordinator mode)");

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
}
