use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use rayon::prelude::*;

use crate::solver::{FloorContext, SumzleSolver, CharProbability};

/// Parallel solver using Rayon for multi-core search
pub struct ParallelSolver {
    pub solver: Arc<SumzleSolver>,
    pub num_threads: usize,
}

/// Result from a single search branch
#[derive(Debug)]
struct BranchResult {
    results: Vec<String>,
    searched_count: u64,
}

impl ParallelSolver {
    pub fn new(solver: SumzleSolver, num_threads: usize) -> Self {
        ParallelSolver {
            solver: Arc::new(solver),
            num_threads: if num_threads == 0 { num_cpus::get() } else { num_threads },
        }
    }

    /// Solve using parallel search - distribute top-level branches across threads
    pub fn solve(&self) -> (Vec<String>, u64) {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(self.num_threads)
            .build()
            .unwrap();

        let solver = self.solver.clone();
        let length = solver.length;
        let initial_expression: Vec<Option<char>> = vec![None; length];
        let initial_counts: HashMap<char, usize> = HashMap::new();
        let floor_context = FloorContext::default();

        let top_level_chars = solver.get_optimized_char_order(
            0, &initial_expression, None, floor_context,
        );

        // Distribute top-level character branches across threads
        let branch_results: Vec<BranchResult> = pool.install(|| {
            top_level_chars
                .par_iter()
                .map(|&ch| {
                    let mut current_expression = vec![None; length];
                    let mut current_counts = HashMap::new();
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

                        current_counts.entry(ch).and_modify(|c| *c -= 1);
                    }

                    BranchResult { results, searched_count }
                })
                .collect()
        });

        // Merge results
        let mut all_results = Vec::new();
        let mut total_searched: u64 = 0;

        for br in branch_results {
            all_results.extend(br.results);
            total_searched += br.searched_count;
        }

        (all_results, total_searched)
    }

    /// Solve with deeper parallelism - parallelize at both level 0 and level 1
    /// This provides more work items for better load balancing
    pub fn solve_deep_parallel(&self) -> (Vec<String>, u64) {
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(self.num_threads)
            .build()
            .unwrap();

        let solver = self.solver.clone();
        let length = solver.length;
        let initial_expression: Vec<Option<char>> = vec![None; length];
        let initial_counts: HashMap<char, usize> = HashMap::new();
        let floor_context = FloorContext::default();

        let top_level_chars = solver.get_optimized_char_order(
            0, &initial_expression, None, floor_context,
        );

        // Generate second-level work items for finer-grained parallelism
        let mut work_items: Vec<(char, char)> = Vec::new();
        let mut single_char_items: Vec<char> = Vec::new();

        for &ch in &top_level_chars {
            let next_floor_context = solver.get_next_floor_context(ch, floor_context);
            if solver.can_place_char(ch, 0, &initial_expression, None, &initial_counts, floor_context) {
                let mut expr = vec![None; length];
                expr[0] = Some(ch);
                let mut counts = HashMap::new();
                *counts.entry(ch).or_insert(0) += 1;
                let main_op = if SumzleSolver::is_main_operator(ch) { Some(ch) } else { None };

                let second_level_chars = solver.get_optimized_char_order(1, &expr, main_op, next_floor_context);

                if second_level_chars.len() <= 2 {
                    single_char_items.push(ch);
                } else {
                    for &ch2 in &second_level_chars {
                        work_items.push((ch, ch2));
                    }
                }

                counts.entry(ch).and_modify(|c| *c -= 1);
            }
        }

        // Process single-char items as-is (they don't have enough sub-branches)
        let single_results: Vec<BranchResult> = pool.install(|| {
            single_char_items
                .par_iter()
                .map(|&ch| {
                    let mut current_expression = vec![None; length];
                    let mut current_counts = HashMap::new();
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

                        current_counts.entry(ch).and_modify(|c| *c -= 1);
                    }

                    BranchResult { results, searched_count }
                })
                .collect()
        });

        // Process two-char work items with deeper parallelism
        let deep_results: Vec<BranchResult> = pool.install(|| {
            work_items
                .par_iter()
                .map(|&(ch1, ch2)| {
                    let mut current_expression = vec![None; length];
                    let mut current_counts = HashMap::new();
                    let mut results = Vec::new();
                    let mut searched_count: u64 = 0;

                    let floor_ctx1 = solver.get_next_floor_context(ch1, floor_context);

                    if solver.can_place_char(ch1, 0, &current_expression, None, &current_counts, floor_context) {
                        current_expression[0] = Some(ch1);
                        *current_counts.entry(ch1).or_insert(0) += 1;
                        let main_op1 = if SumzleSolver::is_main_operator(ch1) { Some(ch1) } else { None };

                        let floor_ctx2 = solver.get_next_floor_context(ch2, floor_ctx1);

                        if solver.can_place_char(ch2, 1, &current_expression, main_op1, &current_counts, floor_ctx1) {
                            current_expression[1] = Some(ch2);
                            *current_counts.entry(ch2).or_insert(0) += 1;
                            let main_op2 = if SumzleSolver::is_main_operator(ch2) { Some(ch2) } else { main_op1 };

                            solver.recursive_search(
                                2,
                                &mut current_expression,
                                main_op2,
                                &mut current_counts,
                                floor_ctx2,
                                &mut results,
                                &mut searched_count,
                            );

                            *current_counts.entry(ch2).or_insert(0) -= 1;
                        }

                        *current_counts.entry(ch1).or_insert(0) -= 1;
                    }

                    BranchResult { results, searched_count }
                })
                .collect()
        });

        // Merge results
        let mut all_results = Vec::new();
        let mut total_searched: u64 = 0;

        for br in single_results.into_iter().chain(deep_results) {
            all_results.extend(br.results);
            total_searched += br.searched_count;
        }

        (all_results, total_searched)
    }
}
