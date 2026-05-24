use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::solver::{FloorContext, SumzleSolver, CharProbability, TileData, SolveResult};
use crate::parallel::ParallelSolver;

/// Unique identifier for a solve job
pub type JobId = String;

/// Status of a distributed solve job
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum JobStatus {
    Pending,
    Running { progress: f64, branches_complete: usize, branches_total: usize },
    Completed,
    Failed(String),
    Cancelled,
}

/// A work item that can be distributed to a worker node
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkItem {
    pub job_id: JobId,
    pub branch_index: usize,
    pub first_char: char,
    pub length: usize,
    pub rows: Vec<Vec<TileData>>,
}

/// Result from a worker node
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkResult {
    pub job_id: JobId,
    pub branch_index: usize,
    pub results: Vec<String>,
    pub searched_count: u64,
    pub elapsed_ms: u64,
    pub error: Option<String>,
}

/// Worker node registration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkerNode {
    pub id: String,
    pub url: String,
    pub status: WorkerStatus,
    pub last_heartbeat: u64,
    pub jobs_completed: u64,
    pub avg_speed: f64, // results per second
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum WorkerStatus {
    Idle,
    Busy { job_id: JobId, branch_index: usize },
    Offline,
}

/// Distributed coordinator that manages job distribution across nodes
pub struct DistributedCoordinator {
    pub workers: Arc<Mutex<HashMap<String, WorkerNode>>>,
    pub jobs: Arc<Mutex<HashMap<JobId, DistributedJob>>>,
    pub local_solver_config: Arc<Mutex<LocalSolverConfig>>,
}

#[derive(Debug, Clone)]
pub struct LocalSolverConfig {
    pub num_threads: usize,
}

pub struct DistributedJob {
    pub id: JobId,
    pub status: JobStatus,
    pub total_branches: usize,
    pub completed_branches: usize,
    pub results: Vec<String>,
    pub searched_count: u64,
    pub start_time: Instant,
    pub work_items: Vec<WorkItem>,
    pub pending_work: Vec<usize>, // indices into work_items
    pub worker_assignments: HashMap<String, usize>, // worker_id -> branch_index
}

impl DistributedCoordinator {
    pub fn new(num_threads: usize) -> Self {
        DistributedCoordinator {
            workers: Arc::new(Mutex::new(HashMap::new())),
            jobs: Arc::new(Mutex::new(HashMap::new())),
            local_solver_config: Arc::new(Mutex::new(LocalSolverConfig { num_threads })),
        }
    }

    /// Register a new worker node
    pub fn register_worker(&self, url: String) -> String {
        let id = Uuid::new_v4().to_string();
        let worker = WorkerNode {
            id: id.clone(),
            url,
            status: WorkerStatus::Idle,
            last_heartbeat: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs(),
            jobs_completed: 0,
            avg_speed: 0.0,
        };
        self.workers.lock().unwrap().insert(id.clone(), worker);
        id
    }

    /// Unregister a worker node
    pub fn unregister_worker(&self, worker_id: &str) {
        self.workers.lock().unwrap().remove(worker_id);
    }

    /// Update worker heartbeat
    pub fn heartbeat(&self, worker_id: &str) -> bool {
        let mut workers = self.workers.lock().unwrap();
        if let Some(worker) = workers.get_mut(worker_id) {
            worker.last_heartbeat = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            true
        } else {
            false
        }
    }

    /// Start a new distributed solve job
    pub fn start_job(&self, length: usize, rows: Vec<Vec<TileData>>) -> Result<JobId, String> {
        // Create the solver to preprocess constraints and generate work items
        let mut solver = SumzleSolver::new(length, rows.clone());
        solver.preprocess_constraints()?;

        let initial_expression: Vec<Option<char>> = vec![None; length];
        let initial_counts: HashMap<char, usize> = HashMap::new();
        let floor_context = FloorContext::default();

        let top_level_chars = solver.get_optimized_char_order(
            0, &initial_expression, None, floor_context,
        );

        // Generate work items - one per top-level character
        let work_items: Vec<WorkItem> = top_level_chars.iter()
            .enumerate()
            .map(|(i, &ch)| WorkItem {
                job_id: String::new(), // Will be set later
                branch_index: i,
                first_char: ch,
                length,
                rows: rows.clone(),
            })
            .collect();

        let job_id = Uuid::new_v4().to_string();
        let total_branches = work_items.len();

        // Set job_id on work items
        let work_items: Vec<WorkItem> = work_items.into_iter()
            .map(|mut wi| { wi.job_id = job_id.clone(); wi })
            .collect();

        let pending_work: Vec<usize> = (0..work_items.len()).collect();

        let job = DistributedJob {
            id: job_id.clone(),
            status: JobStatus::Running {
                progress: 0.0,
                branches_complete: 0,
                branches_total: total_branches,
            },
            total_branches,
            completed_branches: 0,
            results: Vec::new(),
            searched_count: 0,
            start_time: Instant::now(),
            work_items,
            pending_work,
            worker_assignments: HashMap::new(),
        };

        self.jobs.lock().unwrap().insert(job_id.clone(), job);
        Ok(job_id)
    }

    /// Get the next work item for a worker
    pub fn get_work(&self, worker_id: &str) -> Option<WorkItem> {
        let mut jobs = self.jobs.lock().unwrap();
        let mut workers = self.workers.lock().unwrap();

        // Find a job with pending work
        for (_, job) in jobs.iter_mut() {
            if let JobStatus::Running { .. } = job.status {
                if let Some(branch_idx) = job.pending_work.pop() {
                    let work_item = job.work_items[branch_idx].clone();
                    job.worker_assignments.insert(worker_id.to_string(), branch_idx);
                    
                    if let Some(worker) = workers.get_mut(worker_id) {
                        worker.status = WorkerStatus::Busy {
                            job_id: job.id.clone(),
                            branch_index: branch_idx,
                        };
                    }
                    
                    return Some(work_item);
                }
            }
        }
        None
    }

    /// Submit work results from a worker
    pub fn submit_result(&self, worker_id: &str, result: WorkResult) {
        let mut jobs = self.jobs.lock().unwrap();
        let mut workers = self.workers.lock().unwrap();

        // Update worker status
        if let Some(worker) = workers.get_mut(worker_id) {
            worker.status = WorkerStatus::Idle;
            worker.jobs_completed += 1;
            if result.elapsed_ms > 0 {
                let speed = result.searched_count as f64 / (result.elapsed_ms as f64 / 1000.0);
                worker.avg_speed = if worker.avg_speed == 0.0 { speed } else { (worker.avg_speed + speed) / 2.0 };
            }
        }

        if let Some(job) = jobs.get_mut(&result.job_id) {
            if let Some(error) = result.error {
                // Put the work item back in pending queue
                job.pending_work.push(result.branch_index);
            } else {
                job.results.extend(result.results);
                job.searched_count += result.searched_count;
                job.completed_branches += 1;
                job.worker_assignments.remove(worker_id);

                let progress = if job.total_branches > 0 {
                    (job.completed_branches as f64 / job.total_branches as f64) * 100.0
                } else {
                    100.0
                };

                if job.completed_branches >= job.total_branches {
                    job.status = JobStatus::Completed;
                } else {
                    job.status = JobStatus::Running {
                        progress,
                        branches_complete: job.completed_branches,
                        branches_total: job.total_branches,
                    };
                }
            }
        }
    }

    /// Get job status
    pub fn get_job_status(&self, job_id: &str) -> Option<JobStatus> {
        let jobs = self.jobs.lock().unwrap();
        jobs.get(job_id).map(|j| j.status.clone())
    }

    /// Get job results
    pub fn get_job_result(&self, job_id: &str) -> Option<SolveResult> {
        let jobs = self.jobs.lock().unwrap();
        jobs.get(job_id).and_then(|job| {
            match &job.status {
                JobStatus::Completed | JobStatus::Running { .. } => {
                    let elapsed = job.start_time.elapsed().as_millis() as u64;
                    let speed = if elapsed > 0 { job.searched_count as f64 / (elapsed as f64 / 1000.0) } else { 0.0 };
                    let probs = SumzleSolver::calculate_probabilities(&job.results);
                    let recommended = SumzleSolver::get_recommended(&job.results, &probs);

                    Some(SolveResult {
                        results: job.results.clone(),
                        searched_count: job.searched_count,
                        elapsed_ms: elapsed,
                        speed_per_sec: speed,
                        char_probabilities: probs,
                        recommended,
                    })
                }
                _ => None,
            }
        })
    }

    /// Cancel a job
    pub fn cancel_job(&self, job_id: &str) -> bool {
        let mut jobs = self.jobs.lock().unwrap();
        if let Some(job) = jobs.get_mut(job_id) {
            job.status = JobStatus::Cancelled;
            true
        } else {
            false
        }
    }

    /// Execute a work item locally (for the local worker)
    pub fn execute_work_locally(&self, work_item: &WorkItem, num_threads: usize) -> WorkResult {
        let start = Instant::now();
        
        let mut solver = SumzleSolver::new(work_item.length, work_item.rows.clone());
        
        if let Err(e) = solver.preprocess_constraints() {
            return WorkResult {
                job_id: work_item.job_id.clone(),
                branch_index: work_item.branch_index,
                results: Vec::new(),
                searched_count: 0,
                elapsed_ms: start.elapsed().as_millis() as u64,
                error: Some(e),
            };
        }

        let length = solver.length;
        let mut current_expression: Vec<Option<char>> = vec![None; length];
        let mut current_counts: HashMap<char, usize> = HashMap::new();
        let floor_context = FloorContext::default();
        let ch = work_item.first_char;

        let mut results = Vec::new();
        let mut searched_count: u64 = 0;

        let next_floor_context = solver.get_next_floor_context(ch, floor_context);

        if solver.can_place_char(ch, 0, &current_expression, None, &current_counts, floor_context) {
            current_expression[0] = Some(ch);
            *current_counts.entry(ch).or_insert(0) += 1;
            let new_main_op = if SumzleSolver::is_main_operator(ch) { Some(ch) } else { None };

            solver.recursive_search(
                1,
                &mut current_expression,
                new_main_op,
                &mut current_counts,
                next_floor_context,
                &mut results,
                &mut searched_count,
            );
        }

        WorkResult {
            job_id: work_item.job_id.clone(),
            branch_index: work_item.branch_index,
            results,
            searched_count,
            elapsed_ms: start.elapsed().as_millis() as u64,
            error: None,
        }
    }

    /// List all workers
    pub fn list_workers(&self) -> Vec<WorkerNode> {
        self.workers.lock().unwrap().values().cloned().collect()
    }

    /// List all jobs
    pub fn list_jobs(&self) -> Vec<(JobId, JobStatus)> {
        self.jobs.lock().unwrap().iter()
            .map(|(id, job)| (id.clone(), job.status.clone()))
            .collect()
    }
}
