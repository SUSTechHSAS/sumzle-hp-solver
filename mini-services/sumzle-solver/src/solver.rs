use std::collections::{HashMap, HashSet};
use serde::{Deserialize, Serialize};
use rayon::prelude::*;

/// Valid characters for Sumzle expressions
pub const VALID_CHARS: &[char] = &[
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
    '+', '-', '*', '/', '%', '^', '=', '(', ')', '!', '[', '>', 'A',
];

/// Maximum operand value for pruning
pub const MAX_OPERAND_VALUE: i64 = 30;

/// Tile state from the game (matches JS: correct/present/absent/empty)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TileState {
    Correct,
    Present,
    Absent,
    Empty,
}

/// A single tile in a guess row
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TileData {
    pub char: String,
    pub state: TileState,
}

/// Global knowledge extracted from all guess rows
#[derive(Debug, Clone)]
pub struct GlobalKnowledge {
    pub fixed_chars: Vec<Option<char>>,
    pub cannot_be_at: Vec<HashSet<char>>,
    pub must_appear_min_count: HashMap<char, usize>,
    pub must_appear_exact_count: HashMap<char, usize>,
    pub globally_forbidden: HashSet<char>,
}

/// Floor context tracking for bracket expressions
#[derive(Debug, Clone, Copy)]
pub struct FloorContext {
    pub in_floor: bool,
    pub has_slash_in_current_floor: bool,
}

impl Default for FloorContext {
    fn default() -> Self {
        FloorContext {
            in_floor: false,
            has_slash_in_current_floor: false,
        }
    }
}

/// Solve request from the API
#[derive(Debug, Clone, Deserialize)]
pub struct SolveRequest {
    pub length: usize,
    pub rows: Vec<Vec<TileData>>,
    pub max_results: Option<usize>,
    pub parallelism: Option<usize>,
}

/// Solve result for the API
#[derive(Debug, Clone, Serialize)]
pub struct SolveResult {
    pub results: Vec<String>,
    pub searched_count: u64,
    pub elapsed_ms: u64,
    pub speed_per_sec: f64,
    pub char_probabilities: Vec<CharProbability>,
    pub recommended: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct CharProbability {
    pub char: String,
    pub probability: f64,
}

/// The core Sumzle solver - matches JS OptimizedSumzleSolver behavior exactly
pub struct SumzleSolver {
    pub length: usize,
    pub guess_rows_data: Vec<Vec<TileData>>,
    pub global_knowledge: GlobalKnowledge,
}

impl SumzleSolver {
    pub fn new(length: usize, guess_rows_data: Vec<Vec<TileData>>) -> Self {
        let gk = GlobalKnowledge {
            fixed_chars: vec![None; length],
            cannot_be_at: vec![HashSet::new(); length],
            must_appear_min_count: HashMap::new(),
            must_appear_exact_count: HashMap::new(),
            globally_forbidden: HashSet::new(),
        };
        SumzleSolver {
            length,
            guess_rows_data,
            global_knowledge: gk,
        }
    }

    // ========== Character classification (matching JS exactly) ==========

    pub fn is_digit(c: char) -> bool {
        c >= '0' && c <= '9'
    }

    pub fn is_binary_operator(c: char) -> bool {
        matches!(c, '+' | '-' | '*' | '/' | '%' | '^' | 'A')
    }

    pub fn is_unary_post_operator(c: char) -> bool {
        c == '!'
    }

    pub fn is_operator(c: char) -> bool {
        Self::is_binary_operator(c) || Self::is_unary_post_operator(c)
    }

    pub fn is_open_bracket(c: char) -> bool {
        c == '(' || c == '['
    }

    pub fn is_close_bracket(c: char) -> bool {
        c == ')' || c == ']'
    }

    pub fn is_main_operator(c: char) -> bool {
        c == '=' || c == '>'
    }

    pub fn get_matching_bracket(open: char) -> Option<char> {
        match open {
            '(' => Some(')'),
            '[' => Some(']'),
            _ => None,
        }
    }

    // ========== Constraint preprocessing (matching JS exactly) ==========

    pub fn preprocess_constraints(&mut self) -> Result<(), String> {
        self.global_knowledge = GlobalKnowledge {
            fixed_chars: vec![None; self.length],
            cannot_be_at: vec![HashSet::new(); self.length],
            must_appear_min_count: HashMap::new(),
            must_appear_exact_count: HashMap::new(),
            globally_forbidden: HashSet::new(),
        };
        let gk = &mut self.global_knowledge;

        // First pass: extract fixed chars and cannot-be-at
        for row in &self.guess_rows_data {
            for (c, tile) in row.iter().enumerate() {
                if c >= self.length { continue; }
                if tile.char.is_empty() { continue; }
                let ch = tile.char.chars().next().unwrap();

                match tile.state {
                    TileState::Correct => {
                        if let Some(fixed) = gk.fixed_chars[c] {
                            if fixed != ch {
                                return Err(format!(
                                    "冲突: 位置 {} 同时固定为 {} 和 {}.",
                                    c + 1, fixed, ch
                                ));
                            }
                        }
                        gk.fixed_chars[c] = Some(ch);
                        for &vc in VALID_CHARS.iter() {
                            if vc != ch {
                                gk.cannot_be_at[c].insert(vc);
                            }
                        }
                    }
                    TileState::Present => {
                        gk.cannot_be_at[c].insert(ch);
                    }
                    TileState::Absent => {
                        gk.cannot_be_at[c].insert(ch);
                    }
                    TileState::Empty => {
                        // Empty state with a char should not normally happen,
                        // but treat same as absent for backward compatibility
                        gk.cannot_be_at[c].insert(ch);
                    }
                }
            }
        }

        // Collect all chars in guesses
        let mut all_chars_in_guesses: HashSet<char> = HashSet::new();
        for row in &self.guess_rows_data {
            for tile in row {
                if !tile.char.is_empty() {
                    if let Some(ch) = tile.char.chars().next() {
                        all_chars_in_guesses.insert(ch);
                    }
                }
            }
        }

        // Derive min/exact counts
        for &ch in &all_chars_in_guesses {
            let mut min_required_overall: usize = 0;
            let mut derived_exact_count: Option<usize> = None;

            for row in &self.guess_rows_data {
                let row_has_char = row.iter().any(|t| t.char.chars().next() == Some(ch));
                if !row_has_char { continue; }

                let mut green_in_row: usize = 0;
                let mut yellow_in_row: usize = 0;
                for tile in row {
                    if tile.char.chars().next() == Some(ch) {
                        match tile.state {
                            TileState::Correct => green_in_row += 1,
                            TileState::Present => yellow_in_row += 1,
                            TileState::Absent | TileState::Empty => {}
                        }
                    }
                }

                let min_required_this_row = green_in_row + yellow_in_row;
                min_required_overall = min_required_overall.max(min_required_this_row);

                let has_absent_state = row.iter().any(|t| {
                    t.char.chars().next() == Some(ch) && (t.state == TileState::Absent || t.state == TileState::Empty)
                });
                if has_absent_state {
                    let exact_count_this_row = green_in_row + yellow_in_row;
                    match derived_exact_count {
                        None => derived_exact_count = Some(exact_count_this_row),
                        Some(prev) => {
                            if prev != exact_count_this_row {
                                return Err(format!(
                                    "冲突: 字符 '{}' 在不同猜测行中推断出不同的精确数量 ({} vs {}).",
                                    ch, prev, exact_count_this_row
                                ));
                            }
                        }
                    }
                }
            }

            gk.must_appear_min_count.insert(ch, min_required_overall);

            if let Some(exact) = derived_exact_count {
                if exact < min_required_overall {
                    return Err(format!(
                        "冲突: 字符 '{}' 的精确数量 ({}) 小于其最小需求数量 ({}).",
                        ch, exact, min_required_overall
                    ));
                }
                gk.must_appear_exact_count.insert(ch, exact);
                if exact == 0 && min_required_overall == 0 {
                    gk.globally_forbidden.insert(ch);
                }
            }
        }

        // Validate fixed chars against forbidden/cannot-be-at
        for i in 0..self.length {
            if let Some(fixed) = gk.fixed_chars[i] {
                if gk.globally_forbidden.contains(&fixed) {
                    return Err(format!(
                        "冲突: 字符 '{}' 在位置 {} 固定但同时被全局禁用.",
                        fixed, i + 1
                    ));
                }
                if gk.cannot_be_at[i].contains(&fixed) {
                    return Err(format!(
                        "冲突: 字符 '{}' 在位置 {} 固定但又标记为不能在该位置.",
                        fixed, i + 1
                    ));
                }
                let current_min = *gk.must_appear_min_count.get(&fixed).unwrap_or(&0);
                gk.must_appear_min_count.insert(fixed, current_min.max(1));
                if let Some(&exact) = gk.must_appear_exact_count.get(&fixed) {
                    let min = *gk.must_appear_min_count.get(&fixed).unwrap_or(&0);
                    if exact < min {
                        return Err(format!(
                            "冲突: 字符 '{}' 的精确数量 {} 小于其最小固定要求.",
                            fixed, exact
                        ));
                    }
                }
            }
        }

        // Validate exact vs min counts
        for (&ch, &exact) in &gk.must_appear_exact_count {
            let min = *gk.must_appear_min_count.get(&ch).unwrap_or(&0);
            if exact < min {
                return Err(format!(
                    "冲突: 字符 '{}' 的精确数量 ({}) 小于其最小需求 ({}).",
                    ch, exact, min
                ));
            }
        }

        // Validate globally forbidden against must-appear
        for &ch in &gk.globally_forbidden {
            let min = *gk.must_appear_min_count.get(&ch).unwrap_or(&0);
            if min > 0 {
                return Err(format!(
                    "冲突: 字符 '{}' 被全局禁用但又要求至少出现.",
                    ch
                ));
            }
            if let Some(&exact) = gk.must_appear_exact_count.get(&ch) {
                if exact > 0 {
                    return Err(format!(
                        "冲突: 字符 '{}' 被全局禁用但又要求精确出现.",
                        ch
                    ));
                }
            }
        }

        Ok(())
    }

    // ========== canPlaceChar (matching JS exactly) ==========

    pub fn can_place_char(
        &self,
        ch: char,
        index: usize,
        current_expression: &[Option<char>],
        main_op_so_far: Option<char>,
        current_counts: &HashMap<char, usize>,
        floor_context: FloorContext,
    ) -> bool {
        let gk = &self.global_knowledge;

        if gk.globally_forbidden.contains(&ch) { return false; }
        if let Some(fixed) = gk.fixed_chars[index] {
            if fixed != ch { return false; }
        }
        if gk.cannot_be_at[index].contains(&ch) { return false; }

        let current_count = *current_counts.get(&ch).unwrap_or(&0);
        if let Some(&exact) = gk.must_appear_exact_count.get(&ch) {
            if current_count >= exact { return false; }
        }

        // Floor context rules
        if floor_context.in_floor {
            if ch == '[' { return false; }
            if Self::is_operator(ch) && ch != '/' { return false; }
            if Self::is_main_operator(ch) { return false; }
            if ch == '(' { return false; }
            if ch == 'A' || ch == '!' { return false; }

            if ch == '/' {
                if floor_context.has_slash_in_current_floor { return false; }
                let prev = if index > 0 { current_expression[index - 1] } else { None };
                if !prev.map_or(false, Self::is_digit) || index == 0 { return false; }
            } else if ch == ']' {
                let prev = if index > 0 { current_expression[index - 1] } else { None };
                if !prev.map_or(false, Self::is_digit) { return false; }
                if !floor_context.has_slash_in_current_floor { return false; }
            } else if !Self::is_digit(ch) {
                return false;
            }
        }

        if ch == '[' && floor_context.in_floor { return false; }
        if ch == ']' && !floor_context.in_floor { return false; }
        if ch == '[' && index >= self.length - 3 { return false; }

        // Leading zero and max operand check
        if Self::is_digit(ch) && main_op_so_far != Some('=') {
            let mut temp_num_str = String::new();
            temp_num_str.push(ch);
            let mut k = index as i32 - 1;
            while k >= 0 {
                if let Some(prev_ch) = current_expression[k as usize] {
                    if Self::is_digit(prev_ch) {
                        temp_num_str = format!("{}{}", prev_ch, temp_num_str);
                        k -= 1;
                    } else {
                        break;
                    }
                } else {
                    break;
                }
            }

            if temp_num_str.len() > 1 && temp_num_str.starts_with('0') {
                return false;
            }

            let char_before_number = if k >= 0 {
                current_expression[k as usize]
            } else {
                None
            };

            if char_before_number.is_none()
                || char_before_number.map_or(false, |c| Self::is_operator(c))
                || char_before_number.map_or(false, Self::is_open_bracket)
                || char_before_number.map_or(false, Self::is_main_operator)
            {
                if let Ok(val) = temp_num_str.parse::<i64>() {
                    if val > MAX_OPERAND_VALUE {
                        return false;
                    }
                }
            }
        }

        let prev_char = if index > 0 { current_expression[index - 1] } else { None };

        // Position 0 rules
        if index == 0 {
            if Self::is_binary_operator(ch) || Self::is_close_bracket(ch)
                || Self::is_main_operator(ch) || Self::is_unary_post_operator(ch)
            {
                return false;
            }
        }

        // Rules based on previous character
        if let Some(prev) = prev_char {
            if Self::is_digit(prev) {
                if Self::is_open_bracket(ch) && ch != '[' { return false; }
                if ch == '[' && floor_context.in_floor { return false; }
            } else if Self::is_operator(prev) {
                if Self::is_binary_operator(ch)
                    && !(prev == 'A' && (Self::is_open_bracket(ch) || Self::is_digit(ch)))
                    && !Self::is_unary_post_operator(prev)
                {
                    return false;
                }
                if Self::is_close_bracket(ch) { return false; }
                if Self::is_main_operator(ch) && !Self::is_unary_post_operator(prev) { return false; }
                if Self::is_unary_post_operator(prev) && (Self::is_digit(ch) || Self::is_open_bracket(ch)) {
                    return false;
                }
            } else if Self::is_open_bracket(prev) {
                if prev == '[' && ch == '(' { return false; }
                if Self::is_binary_operator(ch) { return false; }
                if Self::is_close_bracket(ch) {
                    if Some(ch) != Self::get_matching_bracket(prev) { return false; }
                }
                if Self::is_main_operator(ch) { return false; }
                if Self::is_unary_post_operator(ch) { return false; }
            } else if Self::is_close_bracket(prev) {
                if Self::is_digit(ch) { return false; }
                if Self::is_open_bracket(ch) { return false; }
            } else if Self::is_main_operator(prev) {
                if prev == '=' {
                    if !Self::is_digit(ch) && ch != '-' { return false; }
                } else {
                    if Self::is_main_operator(ch) { return false; }
                    if Self::is_close_bracket(ch) { return false; }
                }
            }
        }

        // After = rules
        if main_op_so_far == Some('=') {
            if !Self::is_digit(ch) && ch != '-' { return false; }
            if ch == '-' {
                if prev_char != Some('=') || index >= self.length - 1 {
                    // Allow '-' only right after '='
                    if prev_char != Some('=') {
                        // standard operator rules apply
                    } else if index >= self.length - 1 {
                        return false;
                    }
                }
            }
        }

        // Last position rules
        if index == self.length - 1 {
            if Self::is_binary_operator(ch) || Self::is_open_bracket(ch) || Self::is_main_operator(ch) {
                return false;
            }
        }

        // Bracket balance check
        let mut open_paren_depth: i32 = 0;
        let mut open_square_depth: i32 = 0;
        let mut open_brackets_stack: Vec<char> = Vec::new();

        for i in 0..=index {
            let c = if i < index {
                current_expression[i]
            } else {
                Some(ch)
            };
            if let Some(c) = c {
                if c == '(' {
                    open_paren_depth += 1;
                    open_brackets_stack.push(c);
                } else if c == '[' {
                    open_square_depth += 1;
                    open_brackets_stack.push(c);
                } else if c == ')' {
                    open_paren_depth -= 1;
                    if open_paren_depth < 0 { return false; }
                    if open_brackets_stack.pop() != Some('(') { return false; }
                } else if c == ']' {
                    open_square_depth -= 1;
                    if open_square_depth < 0 { return false; }
                    if open_brackets_stack.pop() != Some('[') { return false; }
                }
            }
        }

        if index == self.length - 1 && (open_paren_depth != 0 || open_square_depth != 0) {
            return false;
        }

        // Main operator rules
        if Self::is_main_operator(ch) {
            if let Some(mop) = main_op_so_far {
                if mop != ch && !(mop == '>' && ch == '=') { return false; }
                if mop == ch && ch == '=' { return false; }
            }
            if index == 0 || index >= self.length - 1 { return false; }
        }

        // Permutation 'A' rules
        if ch == 'A' {
            if prev_char.is_none() || (!prev_char.map_or(false, Self::is_digit) && !prev_char.map_or(false, Self::is_close_bracket)) {
                return false;
            }
        }
        if prev_char == Some('A') {
            if !Self::is_digit(ch) && !Self::is_open_bracket(ch) { return false; }
        }

        // Factorial '!' rules
        if ch == '!' {
            if prev_char.is_none() { return false; }
            if let Some(prev) = prev_char {
                if Self::is_digit(prev) {
                    if prev == '0' {
                        // 0! = 1, which is valid. JS checks evaluateExpression("0!") === null
                        // but 0! = 1 which is not null, so it's allowed
                    }
                } else if Self::is_close_bracket(prev) {
                    if prev == ']' { return false; }
                } else {
                    return false;
                }
            }
        }

        true
    }

    // ========== getOptimizedCharOrder (matching JS exactly) ==========

    pub fn get_optimized_char_order(
        &self,
        index: usize,
        current_expression: &[Option<char>],
        main_op_so_far: Option<char>,
        floor_context: FloorContext,
    ) -> Vec<char> {
        let gk = &self.global_knowledge;
        if let Some(fixed) = gk.fixed_chars[index] {
            return vec![fixed];
        }

        let prev_char = if index > 0 { current_expression[index - 1] } else { None };

        let mut ordered_chars: Vec<char> = Vec::new();

        if floor_context.in_floor {
            if floor_context.has_slash_in_current_floor {
                ordered_chars = vec!['0','1','2','3','4','5','6','7','8','9', ']'];
            } else {
                ordered_chars = vec!['0','1','2','3','4','5','6','7','8','9', '/'];
            }
        } else if main_op_so_far == Some('=') {
            if prev_char == Some('=') {
                ordered_chars = vec!['-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
            } else {
                ordered_chars = vec!['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
            }
        } else if index == 0 {
            ordered_chars = vec!['1', '2', '3', '4', '5', '6', '7', '8', '9', '(', '['];
        } else if prev_char.map_or(false, Self::is_digit) {
            ordered_chars = vec![
                '0','1','2','3','4','5','6','7','8','9',
                '+', '-', '*', '/', '%', '^', 'A', '!',
                ')', ']', '[',
                '=', '>',
            ];
        } else if prev_char.map_or(false, Self::is_binary_operator)
            || prev_char == Some('A')
            || (prev_char.map_or(false, Self::is_main_operator) && prev_char != Some('='))
        {
            ordered_chars = vec!['1','2','3','4','5','6','7','8','9','0', '(', '['];
        } else if prev_char.map_or(false, Self::is_open_bracket) {
            ordered_chars = vec!['1','2','3','4','5','6','7','8','9','0', '(', '['];
        } else if prev_char.map_or(false, Self::is_close_bracket) || prev_char.map_or(false, Self::is_unary_post_operator) {
            ordered_chars = vec![
                '+', '-', '*', '/', '%', '^', 'A', '!',
                ')', ']', '[',
                '=', '>',
            ];
        } else {
            ordered_chars = vec![
                '1','2','3','4','5','6','7','8','9','0',
                '+','-','*','/', '=',
                '(', '[', ')', ']',
                '%','^','!','A','>',
            ];
        }

        // Last position filtering
        if index == self.length - 1 && !floor_context.in_floor {
            let end_chars: HashSet<char> = ['0','1','2','3','4','5','6','7','8','9', ')', ']', '!'].into_iter().collect();
            ordered_chars.retain(|c| end_chars.contains(c));
            if ordered_chars.is_empty() && prev_char.is_some() {
                ordered_chars = end_chars.into_iter().collect();
            } else if ordered_chars.is_empty() && index == 0 && self.length == 1 {
                ordered_chars = vec!['0','1','2','3','4','5','6','7','8','9'];
            }
        }

        // Deduplicate and filter by constraints
        let mut seen = HashSet::new();
        ordered_chars.retain(|c| {
            seen.insert(*c)
                && !gk.globally_forbidden.contains(c)
                && !gk.cannot_be_at[index].contains(c)
        });

        ordered_chars
    }

    // ========== Expression evaluation (matching JS exactly) ==========

    pub fn check_brackets(expr: &str) -> bool {
        let mut stack: Vec<char> = Vec::new();
        for ch in expr.chars() {
            if Self::is_open_bracket(ch) {
                stack.push(ch);
            } else if Self::is_close_bracket(ch) {
                if stack.is_empty() { return false; }
                let last_open = stack.pop().unwrap();
                if Some(ch) != Self::get_matching_bracket(last_open) { return false; }
            }
        }
        stack.is_empty()
    }

    /// Evaluate floor bracket expressions: [x/y] = floor(x/y)
    fn process_floor_brackets(&self, expr: &str) -> Option<String> {
        let mut processed = expr.to_string();
        let mut iterations = 0;
        const MAX_ITERATIONS: usize = 10;

        while iterations < MAX_ITERATIONS {
            // Find innermost [...] 
            let open_idx = processed.rfind('[');
            let close_idx = processed.find(']');
            
            match (open_idx, close_idx) {
                (Some(o), Some(c)) if o < c => {
                    let inner = &processed[o + 1..c];
                    if inner.is_empty() { return None; }
                    
                    // Validate: only digits and / allowed inside floor brackets
                    if !inner.chars().all(|c| c.is_ascii_digit() || c == '/') { 
                        return None; 
                    }
                    
                    let val = self.evaluate_simple_expression(inner)?;
                    let floored = val.floor();
                    if !floored.is_finite() || floored.is_nan() { return None; }
                    
                    processed = format!("{}{}{}", &processed[..o], floored as i64, &processed[c + 1..]);
                    iterations += 1;
                }
                _ => break,
            }
        }

        if iterations >= MAX_ITERATIONS && processed.contains('[') {
            return None;
        }

        Some(processed)
    }

    /// Process factorial: n!
    pub fn process_factorials(expr: &str) -> Option<String> {
        let mut result = expr.to_string();
        
        // Repeatedly find and replace factorial patterns
        loop {
            let bang_idx = result.find('!');
            if bang_idx.is_none() { break; }
            let bang_idx = bang_idx.unwrap();
            
            // Find the number before !
            let before = &result[..bang_idx];
            let mut num_end = before.len();
            let mut num_start = before.len();
            
            for (i, c) in before.char_indices().rev() {
                if c.is_ascii_digit() {
                    num_start = i;
                } else {
                    break;
                }
            }
            
            if num_start == num_end { return None; }
            
            let num_str = &before[num_start..num_end];
            let n: i64 = num_str.parse().ok()?;
            
            if n > 12 || n < 0 { return None; }
            
            let factorial = if n == 0 { 1i64 } else {
                let mut f = 1i64;
                for i in 2..=n { f *= i; }
                f
            };
            
            result = format!("{}{}{}", &result[..num_start], factorial, &result[bang_idx + 1..]);
        }
        
        Some(result)
    }

    /// Process permutation: mAn = m!/(m-n)!
    pub fn process_permutation(expr: &str) -> Option<String> {
        let mut result = expr.to_string();
        
        loop {
            // Find pattern: digits A digits
            let a_idx = result.find('A');
            if a_idx.is_none() { break; }
            let a_idx = a_idx.unwrap();
            
            let before = &result[..a_idx];
            let after = &result[a_idx + 1..];
            
            // Find number before A
            let mut m_end = before.len();
            let mut m_start = before.len();
            for (i, c) in before.char_indices().rev() {
                if c.is_ascii_digit() { m_start = i; } else { break; }
            }
            if m_start == m_end { return None; }
            
            // Find number after A
            let mut n_start = 0usize;
            let mut n_end = 0usize;
            for (i, c) in after.char_indices() {
                if c.is_ascii_digit() {
                    if n_start == n_end { n_start = i; }
                    n_end = i + 1;
                } else {
                    break;
                }
            }
            if n_start == n_end { return None; }
            
            let m_str = &before[m_start..m_end];
            let n_str = &after[n_start..n_end];
            
            let m_val: i64 = m_str.parse().ok()?;
            let n_val: i64 = n_str.parse().ok()?;
            
            if m_val > 10 || n_val > 10 || n_val > m_val || m_val < 0 || n_val < 0 {
                return None;
            }
            
            let mut perm = 1i64;
            for i in 0..n_val { perm *= (m_val - i); }
            
            let full_start = a_idx - m_str.len();
            let full_end = a_idx + 1 + n_str.len();
            result = format!("{}{}{}", &result[..full_start], perm, &result[full_end..]);
        }
        
        Some(result)
    }

    /// Evaluate a simple arithmetic expression (no floor, factorial, permutation, or ^)
    fn evaluate_simple_expression(&self, expr: &str) -> Option<f64> {
        if expr.is_empty() { return None; }

        // Check for leading zeros in multi-digit numbers (except negative sign)
        let check_expr = if expr.starts_with('-') { &expr[1..] } else { expr };
        for part in check_expr.split(&['+','-','*','/','%','(',')'][..]) {
            if part.is_empty() { continue; }
            let trimmed = part.trim();
            if trimmed.len() > 1 && trimmed.starts_with('0') {
                return None;
            }
        }

        // Validate only allowed characters
        for c in expr.chars() {
            if !c.is_ascii_digit() && !"+-*/%() .".contains(c) {
                return None;
            }
        }

        // Evaluate using recursive descent parser
        self.parse_expression(expr)
    }

    /// Recursive descent parser for arithmetic expressions
    fn parse_expression(&self, expr: &str) -> Option<f64> {
        let chars: Vec<char> = expr.chars().collect();
        let mut pos = 0usize;
        let result = self.parse_add_sub(&chars, &mut pos)?;
        // Should consume all characters
        while pos < chars.len() && chars[pos] == ' ' { pos += 1; }
        if pos != chars.len() { return None; }
        Some(result)
    }

    fn parse_add_sub(&self, chars: &[char], pos: &mut usize) -> Option<f64> {
        let mut left = self.parse_mul_div(chars, pos)?;
        
        loop {
            self.skip_whitespace(chars, pos);
            if *pos >= chars.len() { break; }
            
            let op = chars[*pos];
            if op == '+' || op == '-' {
                *pos += 1;
                let right = self.parse_mul_div(chars, pos)?;
                left = if op == '+' { left + right } else { left - right };
            } else {
                break;
            }
        }
        
        Some(left)
    }

    fn parse_mul_div(&self, chars: &[char], pos: &mut usize) -> Option<f64> {
        let mut left = self.parse_unary(chars, pos)?;
        
        loop {
            self.skip_whitespace(chars, pos);
            if *pos >= chars.len() { break; }
            
            let op = chars[*pos];
            if op == '*' || op == '/' || op == '%' {
                *pos += 1;
                let right = self.parse_unary(chars, pos)?;
                left = match op {
                    '*' => left * right,
                    '/' => {
                        if right == 0.0 { return None; }
                        left / right
                    }
                    '%' => {
                        if right == 0.0 { return None; }
                        left % right
                    }
                    _ => unreachable!(),
                };
            } else {
                break;
            }
        }
        
        Some(left)
    }

    fn parse_unary(&self, chars: &[char], pos: &mut usize) -> Option<f64> {
        self.skip_whitespace(chars, pos);
        if *pos < chars.len() && chars[*pos] == '-' {
            *pos += 1;
            let val = self.parse_primary(chars, pos)?;
            Some(-val)
        } else {
            self.parse_primary(chars, pos)
        }
    }

    fn parse_primary(&self, chars: &[char], pos: &mut usize) -> Option<f64> {
        self.skip_whitespace(chars, pos);
        
        if *pos >= chars.len() { return None; }
        
        if chars[*pos] == '(' {
            *pos += 1;
            let val = self.parse_add_sub(chars, pos)?;
            self.skip_whitespace(chars, pos);
            if *pos >= chars.len() || chars[*pos] != ')' { return None; }
            *pos += 1;
            return Some(val);
        }
        
        // Parse number
        let start = *pos;
        while *pos < chars.len() && (chars[*pos].is_ascii_digit() || chars[*pos] == '.') {
            *pos += 1;
        }
        
        if start == *pos { return None; }
        
        let num_str: String = chars[start..*pos].iter().collect();
        num_str.parse::<f64>().ok()
    }

    fn skip_whitespace(&self, chars: &[char], pos: &mut usize) {
        while *pos < chars.len() && chars[*pos] == ' ' {
            *pos += 1;
        }
    }

    /// Full expression evaluation (matching JS evaluateExpression)
    pub fn evaluate_expression(&self, expr: &str) -> Option<f64> {
        if expr.is_empty() { return None; }

        // Step 1: Process floor brackets
        let processed = self.process_floor_brackets(expr)?;

        // Step 2: Process factorial
        let processed = Self::process_factorials(&processed)?;

        // Step 3: Process permutation
        let processed = Self::process_permutation(&processed)?;

        // Step 4: Replace ^ with ** (handled via power in parser)
        // We need to handle power operator. Let's add it to our parser.
        let processed = processed.replace('^', "**");

        // Step 5: Evaluate the resulting simple expression
        self.evaluate_simple_expression(&processed)
    }

    /// Check if expression is a simple number or negative number (matches JS isSimpleNumberOrNegativeNumber)
    pub fn is_simple_number_or_negative_number(expr: &str) -> bool {
        let trimmed = expr.trim();
        trimmed.parse::<i64>().is_ok() || (trimmed.starts_with('-') && trimmed[1..].parse::<i64>().is_ok())
    }

    /// Check if a value is a valid integer (matches JS isInteger)
    pub fn is_integer(value: f64) -> bool {
        value.is_finite() && !value.is_nan() && value == value.floor() && value.abs() < i64::MAX as f64
    }

    /// Validate whether the expression is a valid equation (matches JS isValidEquation)
    pub fn is_valid_equation(&self, expression: &str) -> bool {
        if !Self::check_brackets(expression) { return false; }

        // Find the main operator(s) at depth 0
        let mut main_op: Option<String> = None;
        let mut main_op_index: isize = -1;
        let mut depth: i32 = 0;

        for (i, ch) in expression.char_indices() {
            if Self::is_open_bracket(ch) { depth += 1; }
            else if Self::is_close_bracket(ch) { depth -= 1; }
            else if depth == 0 && Self::is_main_operator(ch) {
                let op_str = ch.to_string();
                match &main_op {
                    None => {
                        main_op = Some(op_str);
                        main_op_index = i as isize;
                    }
                    Some(prev) => {
                        if prev != &op_str && !(prev == ">" && ch == '=') { return false; }
                        if prev == &op_str && ch == '=' { return false; }
                        if prev == ">" && ch == '=' {
                            main_op = Some(">=".to_string());
                        }
                    }
                }
            }
        }

        let main_op = match main_op {
            Some(op) => op,
            None => return false,
        };

        if main_op_index <= 0 || main_op_index as usize >= expression.len() - 1 { return false; }

        // Split at main operator
        let (left_side, right_side) = if main_op == ">=" {
            let left = &expression[..main_op_index as usize];
            let right = &expression[main_op_index as usize + 2..];
            (left, right)
        } else {
            let left = &expression[..main_op_index as usize];
            let right = &expression[main_op_index as usize + 1..];
            (left, right)
        };

        if left_side.is_empty() || right_side.is_empty() { return false; }

        // Check for negative on RHS after =
        if main_op == "=" && right_side.starts_with('-') && right_side.len() == 1 {
            return false;
        }

        let left_value = self.evaluate_expression(left_side);
        let right_value = self.evaluate_expression(right_side);

        let left_value = match left_value {
            Some(v) => v,
            None => return false,
        };
        let right_value = match right_value {
            Some(v) => v,
            None => return false,
        };

        if !Self::is_integer(left_value) || !Self::is_integer(right_value) {
            return false;
        }

        // RHS of = must be a simple number or negative number
        if main_op == "=" && !Self::is_simple_number_or_negative_number(right_side) {
            return false;
        }

        match main_op.as_str() {
            "=" => left_value == right_value,
            ">" => left_value > right_value,
            ">=" => left_value >= right_value,
            _ => false,
        }
    }

    /// Sequential recursive search (matching JS _optimizedRecursiveSearch)
    pub fn search_sequential(&self) -> (Vec<String>, u64) {
        let mut results: Vec<String> = Vec::new();
        let mut searched_count: u64 = 0;
        let mut current_expression: Vec<Option<char>> = vec![None; self.length];
        let current_counts: HashMap<char, usize> = HashMap::new();
        let floor_context = FloorContext::default();

        let top_level_chars = self.get_optimized_char_order(
            0, &current_expression, None, floor_context,
        );

        for &ch in &top_level_chars {
            let next_floor_context = self.get_next_floor_context(ch, floor_context);

            if self.can_place_char(ch, 0, &current_expression, None, &current_counts, floor_context) {
                current_expression[0] = Some(ch);
                let mut counts = current_counts.clone();
                *counts.entry(ch).or_insert(0) += 1;
                let new_main_op = if Self::is_main_operator(ch) { Some(ch) } else { None };

                self.recursive_search(
                    1,
                    &mut current_expression,
                    new_main_op,
                    &mut counts,
                    next_floor_context,
                    &mut results,
                    &mut searched_count,
                );

                counts.entry(ch).and_modify(|c| *c -= 1);
                if counts.get(&ch) == Some(&0) { counts.remove(&ch); }
            }
        }

        current_expression[0] = None;
        (results, searched_count)
    }

    /// Parallel search using Rayon's global thread pool
    /// Distributes top-level character branches across available threads
    pub fn search_parallel(&self, _num_threads: usize) -> (Vec<String>, u64) {
        let mut current_expression: Vec<Option<char>> = vec![None; self.length];
        let current_counts: HashMap<char, usize> = HashMap::new();
        let floor_context = FloorContext::default();

        let top_level_chars = self.get_optimized_char_order(
            0, &current_expression, None, floor_context,
        );

        // Collect the work items (top-level chars that can be placed)
        let work_items: Vec<char> = top_level_chars.into_iter()
            .filter(|&ch| self.can_place_char(ch, 0, &current_expression, None, &current_counts, floor_context))
            .collect();

        // Distribute across threads using Rayon's par_iter
        let branch_results: Vec<(Vec<String>, u64)> = work_items.par_iter()
            .map(|&ch| {
                let mut expr = vec![None; self.length];
                let mut counts = HashMap::new();
                let mut results = Vec::new();
                let mut searched_count: u64 = 0;

                let next_floor_context = self.get_next_floor_context(ch, floor_context);
                expr[0] = Some(ch);
                *counts.entry(ch).or_insert(0) += 1;
                let new_main_op = if Self::is_main_operator(ch) { Some(ch) } else { None };

                self.recursive_search(
                    1,
                    &mut expr,
                    new_main_op,
                    &mut counts,
                    next_floor_context,
                    &mut results,
                    &mut searched_count,
                );

                (results, searched_count)
            })
            .collect();

        // Merge results
        let mut all_results = Vec::new();
        let mut total_searched: u64 = 0;
        for (results, searched) in branch_results {
            all_results.extend(results);
            total_searched += searched;
        }

        (all_results, total_searched)
    }

    pub fn recursive_search(
        &self,
        index: usize,
        current_expression: &mut Vec<Option<char>>,
        main_op_so_far: Option<char>,
        current_counts: &mut HashMap<char, usize>,
        floor_context: FloorContext,
        results: &mut Vec<String>,
        searched_count: &mut u64,
    ) {
        if index == self.length {
            *searched_count += 1;

            if main_op_so_far.is_none() { return; }

            let expr_str: String = current_expression.iter()
                .filter_map(|&c| c)
                .collect();

            if !Self::check_brackets(&expr_str) { return; }

            // Check exact and min counts
            let gk = &self.global_knowledge;
            for (&ch, &exact) in &gk.must_appear_exact_count {
                if *current_counts.get(&ch).unwrap_or(&0) != exact { return; }
            }
            for (&ch, &min) in &gk.must_appear_min_count {
                if !gk.must_appear_exact_count.contains_key(&ch) {
                    if *current_counts.get(&ch).unwrap_or(&0) < min { return; }
                }
            }

            if self.is_valid_equation(&expr_str) {
                results.push(expr_str);
            }
            return;
        }

        let fixed = self.global_knowledge.fixed_chars[index];

        if let Some(fixed_ch) = fixed {
            let next_floor_context = self.get_next_floor_context(fixed_ch, floor_context);
            if self.can_place_char(fixed_ch, index, current_expression, main_op_so_far, current_counts, floor_context) {
                current_expression[index] = Some(fixed_ch);
                *current_counts.entry(fixed_ch).or_insert(0) += 1;
                let new_main_op = if Self::is_main_operator(fixed_ch) { Some(fixed_ch) } else { main_op_so_far };

                self.recursive_search(
                    index + 1, current_expression, new_main_op, current_counts,
                    next_floor_context, results, searched_count,
                );

                *current_counts.entry(fixed_ch).or_insert(0) -= 1;
                if current_counts.get(&fixed_ch) == Some(&0) { current_counts.remove(&fixed_ch); }
            }
        } else {
            let chars_to_try = self.get_optimized_char_order(index, current_expression, main_op_so_far, floor_context);
            for ch in chars_to_try {
                let next_floor_context = self.get_next_floor_context(ch, floor_context);
                if self.can_place_char(ch, index, current_expression, main_op_so_far, current_counts, floor_context) {
                    current_expression[index] = Some(ch);
                    *current_counts.entry(ch).or_insert(0) += 1;
                    let new_main_op = if Self::is_main_operator(ch) { Some(ch) } else { main_op_so_far };

                    self.recursive_search(
                        index + 1, current_expression, new_main_op, current_counts,
                        next_floor_context, results, searched_count,
                    );

                    *current_counts.entry(ch).or_insert(0) -= 1;
                    if current_counts.get(&ch) == Some(&0) { current_counts.remove(&ch); }
                }
            }
        }

        current_expression[index] = None;
    }

    pub fn get_next_floor_context(&self, ch: char, ctx: FloorContext) -> FloorContext {
        if ch == '[' {
            FloorContext { in_floor: true, has_slash_in_current_floor: false }
        } else if ch == ']' && ctx.in_floor {
            FloorContext { in_floor: false, has_slash_in_current_floor: false }
        } else if ch == '/' && ctx.in_floor {
            FloorContext { in_floor: true, has_slash_in_current_floor: true }
        } else {
            ctx
        }
    }

    /// Calculate character probabilities from results
    pub fn calculate_probabilities(results: &[String]) -> Vec<CharProbability> {
        if results.is_empty() { return Vec::new(); }

        let mut char_counts: HashMap<char, usize> = HashMap::new();
        for solution in results {
            let unique: HashSet<char> = solution.chars().collect();
            for &ch in &unique {
                *char_counts.entry(ch).or_insert(0) += 1;
            }
        }

        let total = results.len() as f64;
        let mut probs: Vec<CharProbability> = char_counts
            .into_iter()
            .map(|(ch, count)| CharProbability {
                char: ch.to_string(),
                probability: (count as f64 / total) * 100.0,
            })
            .collect();

        probs.sort_by(|a, b| {
            b.probability.partial_cmp(&a.probability).unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.char.cmp(&b.char))
        });

        probs
    }

    /// Get recommended solution based on probabilities
    pub fn get_recommended(results: &[String], probs: &[CharProbability]) -> Option<String> {
        if results.is_empty() || probs.is_empty() { return None; }

        let top_chars: HashSet<char> = probs.iter()
            .take(5)
            .filter_map(|p| p.char.chars().next())
            .collect();

        let mut best_solution: Option<String> = None;
        let mut best_score: f64 = -1.0;

        for solution in results {
            let unique: HashSet<char> = solution.chars().collect();
            let mut score: f64 = 0.0;

            for &ch in &unique {
                if let Some(prob_item) = probs.iter().find(|p| p.char.chars().next() == Some(ch)) {
                    score += prob_item.probability;
                }
            }

            let bonus: f64 = top_chars.iter()
                .filter(|&&tc| unique.contains(&tc))
                .count() as f64 * 50.0;
            score += bonus;

            if score > best_score {
                best_score = score;
                best_solution = Some(solution.clone());
            }
        }

        best_solution
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_digit() {
        assert!(SumzleSolver::is_digit('0'));
        assert!(SumzleSolver::is_digit('9'));
        assert!(!SumzleSolver::is_digit('a'));
    }

    #[test]
    fn test_check_brackets() {
        assert!(SumzleSolver::check_brackets("(1+2)"));
        assert!(!SumzleSolver::check_brackets("(1+2"));
        assert!(SumzleSolver::check_brackets("[3/4]"));
    }

    #[test]
    fn test_evaluate_expression() {
        let solver = SumzleSolver::new(6, vec![]);
        assert_eq!(solver.evaluate_expression("1+2"), Some(3.0));
        assert_eq!(solver.evaluate_expression("3*4"), Some(12.0));
        assert_eq!(solver.evaluate_expression("10/2"), Some(5.0));
        assert_eq!(solver.evaluate_expression("5%3"), Some(2.0));
    }

    #[test]
    fn test_is_valid_equation() {
        let solver = SumzleSolver::new(6, vec![]);
        assert!(solver.is_valid_equation("1+2=3"));
        assert!(solver.is_valid_equation("2*3=6"));
        assert!(!solver.is_valid_equation("1+2=4"));
    }
}
