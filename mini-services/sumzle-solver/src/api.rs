use axum::{
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex;
use tower_http::cors::CorsLayer;

use crate::solver::{CharProbability, SolveRequest, SolveResult, SumzleSolver, TileData};
use crate::parallel::ParallelSolver;
use crate::distributed::{
    DistributedCoordinator, JobId, JobStatus, WorkItem, WorkResult, WorkerNode,
};

/// Application state shared across handlers
pub struct AppState {
    pub coordinator: Arc<DistributedCoordinator>,
}

/// API response wrapper
#[derive(Serialize)]
pub struct ApiResponse<T: Serialize> {
    pub success: bool,
    pub data: Option<T>,
    pub error: Option<String>,
}

impl<T: Serialize> ApiResponse<T> {
    pub fn ok(data: T) -> Self {
        ApiResponse { success: true, data: Some(data), error: None }
    }
    pub fn err(msg: impl Into<String>) -> ApiResponse<T> {
        ApiResponse { success: false, data: None, error: Some(msg.into()) }
    }
}

/// Solve request with mode selection
#[derive(Debug, Deserialize)]
pub struct ApiSolveRequest {
    pub length: usize,
    pub rows: Vec<Vec<TileData>>,
    #[serde(default = "default_mode")]
    pub mode: String, // "local", "parallel", "distributed"
    #[serde(default)]
    pub num_threads: Option<usize>,
    #[serde(default)]
    pub max_results: Option<usize>,
}

fn default_mode() -> String { "parallel".to_string() }

/// Distributed job creation response
#[derive(Serialize)]
pub struct JobCreatedResponse {
    pub job_id: JobId,
}

/// Worker registration request
#[derive(Debug, Deserialize)]
pub struct RegisterWorkerRequest {
    pub url: String,
}

/// Worker registration response
#[derive(Serialize)]
pub struct RegisterWorkerResponse {
    pub worker_id: String,
}

/// Worker get work response
#[derive(Serialize)]
pub struct GetWorkResponse {
    pub work_item: Option<WorkItem>,
}

/// Worker status info
#[derive(Serialize)]
pub struct WorkerInfo {
    pub workers: Vec<WorkerNode>,
    pub total_workers: usize,
    pub active_workers: usize,
}

/// Job list info
#[derive(Serialize)]
pub struct JobInfo {
    pub jobs: Vec<JobSummary>,
}

#[derive(Serialize)]
pub struct JobSummary {
    pub id: JobId,
    pub status: JobStatus,
}

/// Health check response
#[derive(Serialize)]
pub struct HealthResponse {
    pub status: String,
    pub version: String,
    pub num_cpus: usize,
}

pub fn create_router(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/solve", post(solve))
        .route("/api/solve/local", post(solve_local))
        .route("/api/solve/parallel", post(solve_parallel))
        .route("/api/distributed/job", post(create_distributed_job))
        .route("/api/distributed/job/:job_id", get(get_job_status))
        .route("/api/distributed/job/:job_id/result", get(get_job_result))
        .route("/api/distributed/job/:job_id/cancel", post(cancel_job))
        .route("/api/distributed/work", get(get_work))
        .route("/api/distributed/result", post(submit_result))
        .route("/api/distributed/workers", get(list_workers))
        .route("/api/distributed/register", post(register_worker))
        .route("/api/distributed/heartbeat/:worker_id", post(heartbeat))
        .route("/api/distributed/jobs", get(list_jobs))
        .layer(CorsLayer::permissive())
        .with_state(Arc::new(state))
}

async fn health() -> Json<ApiResponse<HealthResponse>> {
    Json(ApiResponse::ok(HealthResponse {
        status: "ok".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        num_cpus: num_cpus::get(),
    }))
}

async fn solve(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ApiSolveRequest>,
) -> Result<Json<ApiResponse<SolveResult>>, StatusCode> {
    let mode = req.mode.clone();
    match mode.as_str() {
        "local" => solve_local_handler(req).await,
        "parallel" => solve_parallel_handler(req).await,
        "distributed" => {
            solve_distributed_handler(state, req).await
        }
        _ => Ok(Json(ApiResponse::err(format!("Unknown mode: {}", mode)))),
    }
}

async fn solve_local(
    Json(req): Json<ApiSolveRequest>,
) -> Result<Json<ApiResponse<SolveResult>>, StatusCode> {
    solve_local_handler(req).await
}

async fn solve_parallel(
    Json(req): Json<ApiSolveRequest>,
) -> Result<Json<ApiResponse<SolveResult>>, StatusCode> {
    solve_parallel_handler(req).await
}

async fn solve_local_handler(req: ApiSolveRequest) -> Result<Json<ApiResponse<SolveResult>>, StatusCode> {
    let start = Instant::now();

    let mut solver = SumzleSolver::new(req.length, req.rows);
    if let Err(e) = solver.preprocess_constraints() {
        return Ok(Json(ApiResponse::err(e)));
    }

    let (results, searched_count) = solver.search_sequential();
    let elapsed_ms = start.elapsed().as_millis() as u64;
    let speed = if elapsed_ms > 0 { searched_count as f64 / (elapsed_ms as f64 / 1000.0) } else { 0.0 };

    let probs = SumzleSolver::calculate_probabilities(&results);
    let recommended = SumzleSolver::get_recommended(&results, &probs);

    let max_results = req.max_results.unwrap_or(usize::MAX);
    let results = if results.len() > max_results {
        results[..max_results].to_vec()
    } else {
        results
    };

    Ok(Json(ApiResponse::ok(SolveResult {
        results,
        searched_count,
        elapsed_ms,
        speed_per_sec: speed,
        char_probabilities: probs,
        recommended,
    })))
}

async fn solve_parallel_handler(req: ApiSolveRequest) -> Result<Json<ApiResponse<SolveResult>>, StatusCode> {
    let start = Instant::now();
    let num_threads = req.num_threads.unwrap_or(num_cpus::get());

    let mut solver = SumzleSolver::new(req.length, req.rows);
    if let Err(e) = solver.preprocess_constraints() {
        return Ok(Json(ApiResponse::err(e)));
    }

    let parallel_solver = ParallelSolver::new(solver, num_threads);
    let (results, searched_count) = parallel_solver.solve();
    let elapsed_ms = start.elapsed().as_millis() as u64;
    let speed = if elapsed_ms > 0 { searched_count as f64 / (elapsed_ms as f64 / 1000.0) } else { 0.0 };

    let probs = SumzleSolver::calculate_probabilities(&results);
    let recommended = SumzleSolver::get_recommended(&results, &probs);

    let max_results = req.max_results.unwrap_or(usize::MAX);
    let results = if results.len() > max_results {
        results[..max_results].to_vec()
    } else {
        results
    };

    Ok(Json(ApiResponse::ok(SolveResult {
        results,
        searched_count,
        elapsed_ms,
        speed_per_sec: speed,
        char_probabilities: probs,
        recommended,
    })))
}

async fn solve_distributed_handler(
    state: Arc<AppState>,
    req: ApiSolveRequest,
) -> Result<Json<ApiResponse<SolveResult>>, StatusCode> {
    let coordinator = &state.coordinator;

    match coordinator.start_job(req.length, req.rows) {
        Ok(job_id) => {
            // Execute locally for now (in production, distribute to workers)
            let num_threads = req.num_threads.unwrap_or(num_cpus::get());
            
            // Get work items and execute them locally
            loop {
                let work = coordinator.get_work("local");
                match work {
                    Some(wi) => {
                        let result = coordinator.execute_work_locally(&wi, num_threads);
                        coordinator.submit_result("local", result);
                    }
                    None => break,
                }
            }

            match coordinator.get_job_result(&job_id) {
                Some(result) => Ok(Json(ApiResponse::ok(result))),
                None => Ok(Json(ApiResponse::err("Job completed but no result available"))),
            }
        }
        Err(e) => Ok(Json(ApiResponse::err(e))),
    }
}

async fn create_distributed_job(
    State(state): State<Arc<AppState>>,
    Json(req): Json<ApiSolveRequest>,
) -> Result<Json<ApiResponse<JobCreatedResponse>>, StatusCode> {
    let coordinator = &state.coordinator;
    match coordinator.start_job(req.length, req.rows) {
        Ok(job_id) => Ok(Json(ApiResponse::ok(JobCreatedResponse { job_id }))),
        Err(e) => Ok(Json(ApiResponse::err(e))),
    }
}

async fn get_job_status(
    State(state): State<Arc<AppState>>,
    Path(job_id): Path<String>,
) -> Result<Json<ApiResponse<JobStatus>>, StatusCode> {
    let coordinator = &state.coordinator;
    match coordinator.get_job_status(&job_id) {
        Some(status) => Ok(Json(ApiResponse::ok(status))),
        None => Ok(Json(ApiResponse::err("Job not found"))),
    }
}

async fn get_job_result(
    State(state): State<Arc<AppState>>,
    Path(job_id): Path<String>,
) -> Result<Json<ApiResponse<SolveResult>>, StatusCode> {
    let coordinator = &state.coordinator;
    match coordinator.get_job_result(&job_id) {
        Some(result) => Ok(Json(ApiResponse::ok(result))),
        None => Ok(Json(ApiResponse::err("Job result not available"))),
    }
}

async fn cancel_job(
    State(state): State<Arc<AppState>>,
    Path(job_id): Path<String>,
) -> Result<Json<ApiResponse<bool>>, StatusCode> {
    let coordinator = &state.coordinator;
    let cancelled = coordinator.cancel_job(&job_id);
    Ok(Json(ApiResponse::ok(cancelled)))
}

async fn get_work(
    State(state): State<Arc<AppState>>,
) -> Result<Json<ApiResponse<GetWorkResponse>>, StatusCode> {
    let coordinator = &state.coordinator;
    let work = coordinator.get_work("api_caller");
    Ok(Json(ApiResponse::ok(GetWorkResponse { work_item: work })))
}

async fn submit_result(
    State(state): State<Arc<AppState>>,
    Json(result): Json<WorkResult>,
) -> Result<Json<ApiResponse<bool>>, StatusCode> {
    let coordinator = &state.coordinator;
    coordinator.submit_result("api_caller", result);
    Ok(Json(ApiResponse::ok(true)))
}

async fn register_worker(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RegisterWorkerRequest>,
) -> Result<Json<ApiResponse<RegisterWorkerResponse>>, StatusCode> {
    let coordinator = &state.coordinator;
    let worker_id = coordinator.register_worker(req.url);
    Ok(Json(ApiResponse::ok(RegisterWorkerResponse { worker_id })))
}

async fn heartbeat(
    State(state): State<Arc<AppState>>,
    Path(worker_id): Path<String>,
) -> Result<Json<ApiResponse<bool>>, StatusCode> {
    let coordinator = &state.coordinator;
    let ok = coordinator.heartbeat(&worker_id);
    Ok(Json(ApiResponse::ok(ok)))
}

async fn list_workers(
    State(state): State<Arc<AppState>>,
) -> Result<Json<ApiResponse<WorkerInfo>>, StatusCode> {
    let coordinator = &state.coordinator;
    let workers = coordinator.list_workers();
    let total = workers.len();
    let active = workers.iter().filter(|w| w.status != crate::distributed::WorkerStatus::Offline).count();
    Ok(Json(ApiResponse::ok(WorkerInfo {
        workers,
        total_workers: total,
        active_workers: active,
    })))
}

async fn list_jobs(
    State(state): State<Arc<AppState>>,
) -> Result<Json<ApiResponse<JobInfo>>, StatusCode> {
    let coordinator = &state.coordinator;
    let jobs = coordinator.list_jobs();
    let summaries: Vec<JobSummary> = jobs.into_iter()
        .map(|(id, status)| JobSummary { id, status })
        .collect();
    Ok(Json(ApiResponse::ok(JobInfo { jobs: summaries })))
}
