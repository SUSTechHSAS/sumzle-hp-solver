'use client'

import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Sun, Moon, Zap, Play, Plus, Trash2, Upload, Server, Cpu,
  Activity, Timer, Gauge, Trophy, BarChart3, Copy, Check,
  ChevronDown, ChevronUp, RefreshCw, MonitorSmartphone, Network,
  X, ArrowRight, Sparkles, Clock, Hash, Search, History, Info,
  Target, HelpCircle, AlertTriangle
} from 'lucide-react'

// ─── Types ───────────────────────────────────────────────────────────────────

type TileState = 'correct' | 'present' | 'absent' | 'empty'

interface Tile {
  char: string
  state: TileState
}

interface SolveResult {
  results: string[]
  searched_count: number
  elapsed_ms: number
  speed_per_sec: number
  char_probabilities: { char: string; probability: number }[]
  recommended: string
}

interface HealthInfo {
  status: string
  version: string
  cpu_cores: number
  parallel_threads: number
  uptime_secs: number
}

interface WorkerNode {
  id: string
  address: string
  status: 'idle' | 'busy' | 'offline'
  tasks_completed: number
  last_heartbeat: string
}

interface SolveHistoryEntry {
  id: string
  timestamp: number
  expressionLength: number
  constraintCount: number
  resultCount: number
  elapsedMs: number
  searchedCount: number
  recommended: string
  maxResultsApplied: boolean
}

// ─── Constants ───────────────────────────────────────────────────────────────

const KEYBOARD_CHARS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['+', '-', '×', '÷', '%', '^', '=', '>', '⌫'],
  ['(', ')', '!', '[', ']', 'A'],
]

const DISPLAY_TO_API: Record<string, string> = {
  '×': '*',
  '÷': '/',
}

const API_TO_DISPLAY: Record<string, string> = {
  '*': '×',
  '/': '÷',
}

const STATE_ORDER: TileState[] = ['empty', 'correct', 'present', 'absent']

const STATE_COLORS: Record<TileState, string> = {
  correct: 'bg-emerald-500 text-white border-emerald-600 dark:bg-emerald-600 dark:border-emerald-700 shadow-sm shadow-emerald-500/30',
  present: 'bg-amber-400 text-amber-950 border-amber-500 dark:bg-amber-500 dark:text-amber-950 dark:border-amber-600 shadow-sm shadow-amber-400/30',
  absent: 'bg-zinc-400 text-zinc-800 border-zinc-500 dark:bg-zinc-600 dark:text-zinc-200 dark:border-zinc-700',
  empty: 'bg-white text-zinc-800 border-zinc-300 dark:bg-zinc-800 dark:text-zinc-200 dark:border-zinc-600',
}

const STATE_LABELS: Record<TileState, string> = {
  correct: '🟩 Correct',
  present: '🟨 Present',
  absent: '⬛ Absent',
  empty: '⬜ Empty',
}

const MAX_ROWS = 10
const MIN_LENGTH = 3
const MAX_LENGTH = 15
const DEFAULT_LENGTH = 6
const MAX_RESULTS_DEFAULT = 500
const MAX_SOLVE_HISTORY = 10

// Valid characters for physical keyboard mapping
const VALID_CHARS_SET = new Set([
  '0','1','2','3','4','5','6','7','8','9',
  '+','-','*','/','%','^','=','>','(',')','!','[',']','A','a',
])

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createEmptyRow(length: number): Tile[] {
  return Array.from({ length }, () => ({ char: '', state: 'empty' as TileState }))
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
  return n.toString()
}

function formatSpeed(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M/s'
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K/s'
  return n.toFixed(0) + '/s'
}

function formatExpression(expr: string): string {
  return expr.replace(/\*/g, '×').replace(/\//g, '÷')
}

function formatUptime(secs: number): string {
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function Home() {
  // Core state
  const [darkMode, setDarkMode] = useState(true)
  const [expressionLength, setExpressionLength] = useState(DEFAULT_LENGTH)
  const [rows, setRows] = useState<Tile[][]>([createEmptyRow(DEFAULT_LENGTH)])
  const [selectedCell, setSelectedCell] = useState<{ row: number; col: number } | null>(null)

  // Solver state
  const [solving, setSolving] = useState(false)
  const [solveResult, setSolveResult] = useState<SolveResult | null>(null)
  const [solveError, setSolveError] = useState<string | null>(null)

  // Health state
  const [health, setHealth] = useState<HealthInfo | null>(null)

  // Distributed state
  const [workers, setWorkers] = useState<WorkerNode[]>([])
  const [workerAddress, setWorkerAddress] = useState('')
  const [showDistributed, setShowDistributed] = useState(false)

  // Import state
  const [importText, setImportText] = useState('')
  const [showImport, setShowImport] = useState(false)
  const [copied, setCopied] = useState(false)

  // Results tab
  const [resultTab, setResultTab] = useState('solutions')

  // Result filter/search
  const [resultFilter, setResultFilter] = useState('')

  // Solve history
  const [solveHistory, setSolveHistory] = useState<SolveHistoryEntry[]>([])
  const [showHistory, setShowHistory] = useState(false)

  // Tile pop animation tracking
  const [poppingTile, setPoppingTile] = useState<string | null>(null)

  // Solver status (derived from health checks)
  const [solverOnline, setSolverOnline] = useState<boolean | null>(null) // null = unknown/starting
  const [solverLastChecked, setSolverLastChecked] = useState<number>(0)

  // Solve progress timer
  const [solveTimerMs, setSolveTimerMs] = useState(0)

  // Result sort
  const [resultSort, setResultSort] = useState<'default' | 'az' | 'za' | 'shortest' | 'longest'>('default')

  // Keyboard shortcut help
  const [showShortcuts, setShowShortcuts] = useState(false)

  // Copy individual result
  const [copiedResult, setCopiedResult] = useState<string | null>(null)

  // Celebration effect
  const [celebrating, setCelebrating] = useState(false)

  // Refs
  const resultsRef = useRef<HTMLDivElement>(null)
  const boardRef = useRef<HTMLDivElement>(null)

  // ─── Dark mode effect ──────────────────────────────────────────────────────

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode)
  }, [darkMode])

  // ─── Solve progress timer ──────────────────────────────────────────────────

  useEffect(() => {
    if (!solving) {
      setSolveTimerMs(0)
      return
    }
    const start = Date.now()
    const interval = setInterval(() => {
      setSolveTimerMs(Date.now() - start)
    }, 100)
    return () => clearInterval(interval)
  }, [solving])

  // ─── Celebration effect ────────────────────────────────────────────────────

  useEffect(() => {
    if (solveResult && solveResult.results.length > 0) {
      setCelebrating(true)
      const timer = setTimeout(() => setCelebrating(false), 2000)
      return () => clearTimeout(timer)
    }
  }, [solveResult])

  // ─── Fetch health ──────────────────────────────────────────────────────────

  const solvingRef = useRef(false)
  solvingRef.current = solving

  const fetchHealth = useCallback(async () => {
    // Skip health check while solving to prevent concurrent requests
    if (solvingRef.current) return
    try {
      const res = await fetch('/api/health')
      if (res.ok) {
        const data = await res.json()
        setHealth(data.data || data)
        setSolverOnline(true)
      } else {
        // Keep last known health info but mark as offline
        setSolverOnline(false)
      }
    } catch {
      // Keep last known health info but mark as offline
      setSolverOnline(false)
    }
    setSolverLastChecked(Date.now())
  }, [])

  // Adaptive health check: 15s initially, 30s when online, 60s when offline
  useEffect(() => {
    fetchHealth() // Check immediately on mount
    const getInterval = () => {
      if (solverOnline === null) return 15000 // Starting: check every 15s
      if (solverOnline) return 30000 // Online: every 30s
      return 60000 // Offline: every 60s
    }
    const interval = setInterval(fetchHealth, getInterval())
    return () => clearInterval(interval)
  }, [fetchHealth, solverOnline])

  // ─── Update row lengths ────────────────────────────────────────────────────

  const updateRowLengths = useCallback((newLength: number) => {
    setRows(prev => prev.map(row => {
      if (row.length === newLength) return row
      const newRow = createEmptyRow(newLength)
      for (let i = 0; i < Math.min(row.length, newLength); i++) {
        newRow[i] = row[i]
      }
      return newRow
    }))
  }, [])

  const handleLengthChange = useCallback((val: string) => {
    const n = parseInt(val, 10)
    if (!isNaN(n) && n >= MIN_LENGTH && n <= MAX_LENGTH) {
      setExpressionLength(n)
      updateRowLengths(n)
    }
  }, [updateRowLengths])

  // ─── Row management ────────────────────────────────────────────────────────

  const addRow = useCallback(() => {
    setRows(prev => {
      if (prev.length >= MAX_ROWS) return prev
      return [...prev, createEmptyRow(expressionLength)]
    })
  }, [expressionLength])

  const removeRow = useCallback((index: number) => {
    setRows(prev => prev.length <= 1 ? prev : prev.filter((_, i) => i !== index))
  }, [])

  const clearRow = useCallback((index: number) => {
    setRows(prev => prev.map((row, i) => i === index ? createEmptyRow(expressionLength) : row))
  }, [expressionLength])

  // ─── Tile interactions ─────────────────────────────────────────────────────

  const cycleState = useCallback((rowIdx: number, colIdx: number) => {
    setRows(prev => prev.map((row, i) => {
      if (i !== rowIdx) return row
      return row.map((tile, j) => {
        if (j !== colIdx) return tile
        if (!tile.char && tile.state === 'empty') return tile // Can't cycle empty char
        const currentIdx = STATE_ORDER.indexOf(tile.state)
        const nextIdx = (currentIdx + 1) % STATE_ORDER.length
        return { ...tile, state: STATE_ORDER[nextIdx] }
      })
    }))
  }, [])

  const setChar = useCallback((rowIdx: number, colIdx: number, char: string) => {
    setRows(prev => prev.map((row, i) => {
      if (i !== rowIdx) return row
      return row.map((tile, j) => {
        if (j !== colIdx) return tile
        // When setting a char, if state is empty and char is non-empty, default to 'correct'
        const newState = char && tile.state === 'empty' ? 'correct' : tile.state
        return { ...tile, char, state: newState }
      })
    }))
    // Trigger pop animation
    const tileKey = `${rowIdx}-${colIdx}`
    setPoppingTile(tileKey)
    setTimeout(() => setPoppingTile(null), 200)
  }, [])

  const handleTileClick = useCallback((rowIdx: number, colIdx: number, e?: React.MouseEvent) => {
    if (e?.button === 2) {
      // Right-click cycles state
      e.preventDefault()
      cycleState(rowIdx, colIdx)
    } else {
      // Left-click: if already selected, cycle state; otherwise select
      if (selectedCell?.row === rowIdx && selectedCell?.col === colIdx) {
        cycleState(rowIdx, colIdx)
      } else {
        setSelectedCell({ row: rowIdx, col: colIdx })
      }
    }
  }, [selectedCell, cycleState])

  const handleTileContextMenu = useCallback((e: React.MouseEvent, rowIdx: number, colIdx: number) => {
    e.preventDefault()
    cycleState(rowIdx, colIdx)
  }, [cycleState])

  // ─── Keyboard handling ─────────────────────────────────────────────────────

  const handleKeyPress = useCallback((key: string) => {
    if (!selectedCell) return

    if (key === '⌫') {
      // Backspace: clear char and move back
      const { row, col } = selectedCell
      setChar(row, col, '')
      if (col > 0) {
        setSelectedCell({ row, col: col - 1 })
      }
      return
    }

    const { row, col } = selectedCell
    setChar(row, col, key)
    // Move to next cell
    if (col < expressionLength - 1) {
      setSelectedCell({ row, col: col + 1 })
    }
  }, [selectedCell, expressionLength, setChar])

  // ─── Physical keyboard support ────────────────────────────────────────────

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept if user is typing in an input/textarea
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return

      if (!selectedCell) return

      // Backspace
      if (e.key === 'Backspace') {
        e.preventDefault()
        handleKeyPress('⌫')
        return
      }

      // Delete key
      if (e.key === 'Delete') {
        e.preventDefault()
        const { row, col } = selectedCell
        setChar(row, col, '')
        return
      }

      // Arrow keys for navigation
      if (e.key === 'ArrowLeft' && selectedCell.col > 0) {
        e.preventDefault()
        setSelectedCell({ row: selectedCell.row, col: selectedCell.col - 1 })
        return
      }
      if (e.key === 'ArrowRight' && selectedCell.col < expressionLength - 1) {
        e.preventDefault()
        setSelectedCell({ row: selectedCell.row, col: selectedCell.col + 1 })
        return
      }
      if (e.key === 'ArrowUp' && selectedCell.row > 0) {
        e.preventDefault()
        setSelectedCell({ row: selectedCell.row - 1, col: selectedCell.col })
        return
      }
      if (e.key === 'ArrowDown' && selectedCell.row < rows.length - 1) {
        e.preventDefault()
        setSelectedCell({ row: selectedCell.row + 1, col: selectedCell.col })
        return
      }

      // Escape to deselect
      if (e.key === 'Escape') {
        setSelectedCell(null)
        return
      }

      // Character input
      let char = e.key
      // Map 'a' to 'A' for permutation
      if (char === 'a') char = 'A'
      // Map '*' to display as '×' (but API uses '*')
      if (char === '*') char = '×'
      // Map '/' to display as '÷' (but API uses '/')
      if (char === '/') char = '÷'

      if (VALID_CHARS_SET.has(e.key) || (char === '×') || (char === '÷') || (char === 'A')) {
        e.preventDefault()
        handleKeyPress(char)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedCell, expressionLength, rows.length, handleKeyPress, setChar])

  // ─── Solve ─────────────────────────────────────────────────────────────────

  const solve = useCallback(async () => {
    setSolving(true)
    setSolveError(null)
    setSolveResult(null)
    setResultFilter('')

    try {
      // Convert display chars to API chars and filter empty rows
      const apiRows = rows
        .filter(row => row.some(t => t.char !== ''))
        .map(row => row.map(tile => ({
          char: DISPLAY_TO_API[tile.char] || tile.char,
          state: tile.state,
        })))

      if (apiRows.length === 0) {
        // No constraints - solve all equations of this length
        // Still send an empty row to indicate we want to solve
      }

      const body = {
        length: expressionLength,
        rows: apiRows.length > 0 ? apiRows : [Array(expressionLength).fill(null).map(() => ({ char: '', state: 'empty' }))],
        mode: 'parallel',
        num_threads: health?.parallel_threads || undefined,
        max_results: MAX_RESULTS_DEFAULT,
      }

      // Try solving with up to 3 retries (solver may auto-restart between attempts)
      let data: any = null
      let res: Response | null = null
      const MAX_RETRIES = 3
      const RETRY_DELAY = 3000 // 3s wait for solver to restart

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          res = await fetch('/api/solve/parallel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
          data = await res.json()

          if (res.ok && data.success) break // Success!

          if (data.error?.includes('not available') || data.error?.includes('busy')) {
            // Solver might be restarting, wait and retry
            if (attempt < MAX_RETRIES - 1) {
              await new Promise(r => setTimeout(r, RETRY_DELAY))
              continue
            }
          }
          break // Other error, don't retry
        } catch {
          if (attempt < MAX_RETRIES - 1) {
            await new Promise(r => setTimeout(r, RETRY_DELAY))
            continue
          }
          throw new Error('Solver backend not available after retries')
        }
      }

      if (!res || !data) {
        throw new Error('Solver backend not available after retries')
      }

      if (!res.ok || !data.success) {
        throw new Error(data.error || `Solver returned status ${res.status}`)
      }

      const result: SolveResult = data.data
      setSolveResult(result)

      // Add to solve history
      const maxResultsApplied = result.results.length >= MAX_RESULTS_DEFAULT
      const historyEntry: SolveHistoryEntry = {
        id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
        timestamp: Date.now(),
        expressionLength,
        constraintCount: apiRows.filter(r => r.some(t => t.char !== '')).length,
        resultCount: result.results.length,
        elapsedMs: result.elapsed_ms,
        searchedCount: result.searched_count,
        recommended: result.recommended || '',
        maxResultsApplied,
      }
      setSolveHistory(prev => [historyEntry, ...prev].slice(0, MAX_SOLVE_HISTORY))

      // Scroll to results
      setTimeout(() => {
        resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 100)
    } catch (err) {
      setSolveError(err instanceof Error ? err.message : 'Solve failed')
    } finally {
      setSolving(false)
    }
  }, [rows, expressionLength, health])

  // ─── Import ────────────────────────────────────────────────────────────────

  const handleImport = useCallback(() => {
    try {
      const parsed = JSON.parse(importText)
      if (parsed.length && typeof parsed.length === 'number') {
        setExpressionLength(parsed.length)
        updateRowLengths(parsed.length)
      }
      if (parsed.rows && Array.isArray(parsed.rows)) {
        const importedRows = parsed.rows.map((row: { char: string; state: TileState }[]) =>
          row.map((tile: { char: string; state: TileState }) => ({
            char: API_TO_DISPLAY[tile.char] || tile.char,
            state: tile.state || 'empty',
          }))
        )
        setRows(importedRows)
      }
      setShowImport(false)
      setImportText('')
      setSolveError(null)
    } catch {
      setSolveError('Invalid JSON format for import')
    }
  }, [importText, updateRowLengths])

  // ─── Export game state ─────────────────────────────────────────────────────

  const exportState = useCallback(() => {
    const apiRows = rows.map(row =>
      row.map(tile => ({
        char: DISPLAY_TO_API[tile.char] || tile.char,
        state: tile.state,
      }))
    )
    return JSON.stringify({ length: expressionLength, rows: apiRows }, null, 2)
  }, [rows, expressionLength])

  const copyState = useCallback(async () => {
    await navigator.clipboard.writeText(exportState())
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [exportState])

  // ─── Distributed workers ───────────────────────────────────────────────────

  const addWorker = useCallback(async () => {
    if (!workerAddress.trim()) return
    try {
      const res = await fetch('/api/distributed/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: workerAddress.trim() }),
      })
      const data = await res.json()
      if (data.success) {
        const newWorker: WorkerNode = {
          id: data.data.worker_id,
          address: workerAddress.trim(),
          status: 'idle',
          tasks_completed: 0,
          last_heartbeat: new Date().toISOString(),
        }
        setWorkers(prev => [...prev, newWorker])
        setWorkerAddress('')
      }
    } catch {
      // Fallback: add locally
      const newWorker: WorkerNode = {
        id: Math.random().toString(36).substring(2, 8),
        address: workerAddress.trim(),
        status: 'idle',
        tasks_completed: 0,
        last_heartbeat: new Date().toISOString(),
      }
      setWorkers(prev => [...prev, newWorker])
      setWorkerAddress('')
    }
  }, [workerAddress])

  const removeWorker = useCallback((id: string) => {
    setWorkers(prev => prev.filter(w => w.id !== id))
  }, [])

  // ─── Clear all ─────────────────────────────────────────────────────────────

  const clearAll = useCallback(() => {
    setRows([createEmptyRow(expressionLength)])
    setSelectedCell(null)
    setSolveResult(null)
    setSolveError(null)
    setResultFilter('')
  }, [expressionLength])

  // ─── Filtered results ──────────────────────────────────────────────────────

  const filteredResults = useMemo(() => {
    if (!solveResult) return []
    let results = solveResult.results
    if (resultFilter.trim()) {
      const lowerFilter = resultFilter.toLowerCase().replace(/×/g, '*').replace(/÷/g, '/')
      results = results.filter(expr =>
        expr.toLowerCase().includes(lowerFilter) ||
        formatExpression(expr).toLowerCase().includes(resultFilter.toLowerCase())
      )
    }
    // Apply sort
    switch (resultSort) {
      case 'az':
        return [...results].sort((a, b) => a.localeCompare(b))
      case 'za':
        return [...results].sort((a, b) => b.localeCompare(a))
      case 'shortest':
        return [...results].sort((a, b) => a.length - b.length)
      case 'longest':
        return [...results].sort((a, b) => b.length - a.length)
      default:
        return results
    }
  }, [solveResult, resultFilter, resultSort])

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen flex flex-col bg-zinc-50 dark:bg-zinc-950 transition-colors duration-300 dark:[background-image:radial-gradient(circle_at_50%_0%,rgba(255,255,255,0.03),transparent_75%)]">
      <style>{`
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
      {/* ─── Header ──────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 bg-white/80 dark:bg-zinc-900/80 backdrop-blur-md border-b border-zinc-200 dark:border-zinc-800">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <Zap className="w-5 h-5 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold bg-gradient-to-r from-emerald-500 to-teal-600 bg-clip-text text-transparent">
                Sumzle HP Solver
              </h1>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">High-Performance Rust Engine</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Engine status indicator */}
            <Badge
              variant="secondary"
              className={`hidden sm:flex items-center gap-1.5 text-xs ${
                solverOnline === null
                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200 dark:border-amber-800'
                  : solverOnline
                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800'
                    : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-red-200 dark:border-red-800'
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${
                solverOnline === null
                  ? 'bg-amber-500 animate-pulse'
                  : solverOnline
                    ? 'bg-emerald-500'
                    : 'bg-red-500'
              }`} />
              {solverOnline === null
                ? 'Starting...'
                : solverOnline
                  ? `${health?.cpu_cores || '?'} cores · ${health?.parallel_threads || '?'} threads`
                  : `Offline${solverLastChecked ? ` · ${Math.round((Date.now() - solverLastChecked) / 1000)}s ago` : ''}`
              }
            </Badge>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setDarkMode(!darkMode)}
              className="rounded-full"
              aria-label="Toggle theme"
            >
              {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </Button>
          </div>
        </div>
      </header>

      {/* ─── Main Content ────────────────────────────────────────────────────── */}
      <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

          {/* ─── LEFT PANEL: Input ──────────────────────────────────────────── */}
          <div className="space-y-4">

            {/* Settings Card */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <MonitorSmartphone className="w-4 h-4 text-emerald-500" />
                  Puzzle Settings
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-4">
                  <label className="text-sm font-medium whitespace-nowrap">Expression Length</label>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleLengthChange(String(expressionLength - 1))}
                      disabled={expressionLength <= MIN_LENGTH}
                    >
                      −
                    </Button>
                    <Input
                      type="number"
                      min={MIN_LENGTH}
                      max={MAX_LENGTH}
                      value={expressionLength}
                      onChange={(e) => handleLengthChange(e.target.value)}
                      className="w-16 text-center h-8"
                    />
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleLengthChange(String(expressionLength + 1))}
                      disabled={expressionLength >= MAX_LENGTH}
                    >
                      +
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={addRow} disabled={rows.length >= MAX_ROWS || solving}>
                    <Plus className="w-3.5 h-3.5 mr-1" /> Add Row
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setShowImport(!showImport)} disabled={solving}>
                    <Upload className="w-3.5 h-3.5 mr-1" /> Import
                  </Button>
                  <Button variant="outline" size="sm" onClick={copyState}>
                    {copied ? <Check className="w-3.5 h-3.5 mr-1" /> : <Copy className="w-3.5 h-3.5 mr-1" />}
                    {copied ? 'Copied!' : 'Export'}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setShowDistributed(!showDistributed)}>
                    <Network className="w-3.5 h-3.5 mr-1" /> Workers
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setShowHistory(!showHistory)} className="relative">
                    <History className="w-3.5 h-3.5 mr-1" /> History
                    {solveHistory.length > 0 && (
                      <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-emerald-500 text-white text-[9px] flex items-center justify-center font-bold">
                        {solveHistory.length}
                      </span>
                    )}
                  </Button>
                  <Button variant="outline" size="sm" onClick={clearAll} disabled={solving} className="text-zinc-500">
                    <RefreshCw className="w-3.5 h-3.5 mr-1" /> Clear
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Presets */}
            <div className="flex flex-wrap gap-1.5">
              <span className="text-xs text-zinc-500 dark:text-zinc-400 self-center mr-1">Presets:</span>
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => {
                setExpressionLength(5)
                updateRowLengths(5)
                setRows([[{char:'1',state:'correct'},{char:'+',state:'correct'},{char:'1',state:'correct'},{char:'=',state:'correct'},{char:'2',state:'correct'}]])
                setSelectedCell(null)
                setSolveResult(null)
              }}>
                1+1=2
              </Button>
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => {
                setExpressionLength(6)
                updateRowLengths(6)
                setRows([[{char:'1',state:'correct'},{char:'+',state:'correct'},{char:'2',state:'present'},{char:'=',state:'correct'},{char:'3',state:'correct'},{char:'',state:'empty'}]])
                setSelectedCell(null)
                setSolveResult(null)
              }}>
                Starter Len 6
              </Button>
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => {
                setExpressionLength(8)
                updateRowLengths(8)
                setRows([
                  [{char:'1',state:'correct'},{char:'2',state:'present'},{char:'+',state:'correct'},{char:'3',state:'absent'},{char:'=',state:'correct'},{char:'5',state:'correct'},{char:'',state:'empty'},{char:'',state:'empty'}],
                  [{char:'2',state:'present'},{char:'\u00d7',state:'correct'},{char:'3',state:'correct'},{char:'=',state:'correct'},{char:'6',state:'correct'},{char:'',state:'empty'},{char:'',state:'empty'},{char:'',state:'empty'}],
                ])
                setSelectedCell(null)
                setSolveResult(null)
              }}>
                Hard Mode
              </Button>
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => {
                setExpressionLength(6)
                updateRowLengths(6)
                setRows([createEmptyRow(6)])
                setSelectedCell(null)
                setSolveResult(null)
                setSolveError(null)
                setResultFilter('')
              }}>
                Full Clear
              </Button>
            </div>

            {/* Import Panel */}
            {showImport && (
              <Card className="animate-in slide-in-from-top-2 duration-200">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">Import Game State</CardTitle>
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setShowImport(false)}>
                      <X className="w-3 h-3" />
                    </Button>
                  </div>
                  <CardDescription>Paste JSON game state below</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <Textarea
                    placeholder='{"length": 6, "rows": [[{"char":"1","state":"correct"},...]]}'
                    value={importText}
                    onChange={(e) => setImportText(e.target.value)}
                    className="font-mono text-xs min-h-24"
                  />
                  <Button size="sm" onClick={handleImport} disabled={!importText.trim()}>
                    <Upload className="w-3.5 h-3.5 mr-1" /> Import
                  </Button>
                </CardContent>
              </Card>
            )}

            {/* Solve History Panel */}
            {showHistory && (
              <Card className="animate-in slide-in-from-top-2 duration-200">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base flex items-center gap-2">
                      <History className="w-4 h-4 text-teal-500" />
                      Solve History
                    </CardTitle>
                    <div className="flex items-center gap-1">
                      {solveHistory.length > 0 && (
                        <Button variant="ghost" size="sm" className="h-6 text-xs text-zinc-400" onClick={() => setSolveHistory([])}>
                          Clear
                        </Button>
                      )}
                      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setShowHistory(false)}>
                        <X className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                  <CardDescription>Recent solve results for comparison</CardDescription>
                </CardHeader>
                <CardContent>
                  {solveHistory.length === 0 ? (
                    <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center py-3">
                      No solve history yet. Run a solve to see results here.
                    </p>
                  ) : (
                    <div className="space-y-2 max-h-64 overflow-y-auto">
                      {solveHistory.map((entry) => (
                        <div
                          key={entry.id}
                          className="p-2.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                        >
                          <div className="flex items-center justify-between mb-1">
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                                Len {entry.expressionLength}
                              </Badge>
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                                {entry.constraintCount} rows
                              </Badge>
                              {entry.maxResultsApplied && (
                                <Badge className="text-[10px] px-1.5 py-0 bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-0">
                                  Limited
                                </Badge>
                              )}
                            </div>
                            <span className="text-[10px] text-zinc-400">
                              {new Date(entry.timestamp).toLocaleTimeString()}
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3 text-xs">
                              <span className="font-mono font-bold text-emerald-600 dark:text-emerald-400">
                                {formatNumber(entry.resultCount)} results
                              </span>
                              <span className="text-zinc-500">
                                {entry.elapsedMs < 1000 ? `${entry.elapsedMs.toFixed(0)}ms` : `${(entry.elapsedMs / 1000).toFixed(2)}s`}
                              </span>
                            </div>
                            {entry.recommended && (
                              <code className="text-xs font-mono font-bold text-amber-600 dark:text-amber-400">
                                {formatExpression(entry.recommended)}
                              </code>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Distributed Computing Panel */}
            {showDistributed && (
              <Card className="animate-in slide-in-from-top-2 duration-200">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Server className="w-4 h-4 text-teal-500" />
                      Distributed Workers
                    </CardTitle>
                    <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setShowDistributed(false)}>
                      <X className="w-3 h-3" />
                    </Button>
                  </div>
                  <CardDescription>Register and manage compute nodes</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex gap-2">
                    <Input
                      placeholder="ws://worker-host:3032"
                      value={workerAddress}
                      onChange={(e) => setWorkerAddress(e.target.value)}
                      className="h-8 text-sm"
                    />
                    <Button size="sm" onClick={addWorker} disabled={!workerAddress.trim()}>
                      <Plus className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                  {workers.length === 0 ? (
                    <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center py-3">
                      No workers registered. Add a worker node to enable distributed solving.
                    </p>
                  ) : (
                    <div className="space-y-2 max-h-48 overflow-y-auto">
                      {workers.map((w) => (
                        <div key={w.id} className="flex items-center justify-between p-2 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-sm">
                          <div className="flex items-center gap-2">
                            <div className={`w-2 h-2 rounded-full ${
                              w.status === 'idle' ? 'bg-emerald-500' :
                              w.status === 'busy' ? 'bg-amber-500' : 'bg-zinc-400'
                            }`} />
                            <span className="font-mono text-xs">{w.address}</span>
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                              {w.status}
                            </Badge>
                          </div>
                          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => removeWorker(w.id)}>
                            <Trash2 className="w-3 h-3 text-zinc-400" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Constraint Board */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Activity className="w-4 h-4 text-emerald-500" />
                  Constraint Board
                </CardTitle>
                <CardDescription>
                  Click tile to select, click again to cycle state. Type with keyboard. Use arrow keys to navigate.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {/* Legend */}
                <div className="flex flex-wrap gap-2 text-xs mb-1">
                  {STATE_ORDER.map(s => (
                    <span
                      key={s}
                      className={`px-2 py-0.5 rounded border text-xs font-medium ${STATE_COLORS[s]}`}
                    >
                      {STATE_LABELS[s]}
                    </span>
                  ))}
                </div>

                {/* Rows */}
                <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1" ref={boardRef}>
                  {rows.map((row, rowIdx) => (
                    <div key={rowIdx} className="flex items-center gap-1.5">
                      <span className="text-xs text-zinc-400 w-4 text-right shrink-0">{rowIdx + 1}</span>
                      <div className="flex gap-0.5">
                        {row.map((tile, colIdx) => {
                          const isSelected = selectedCell?.row === rowIdx && selectedCell?.col === colIdx
                          const tileKey = `${rowIdx}-${colIdx}`
                          const isPopping = poppingTile === tileKey
                          return (
                            <button
                              key={colIdx}
                              className={`
                                w-10 h-10 sm:w-11 sm:h-11 rounded-lg border-2 font-mono font-bold text-lg
                                flex items-center justify-center transition-all duration-150 select-none
                                relative
                                ${STATE_COLORS[tile.state]}
                                ${isSelected ? 'ring-2 ring-emerald-500 ring-offset-1 dark:ring-offset-zinc-900 shadow-md animate-pulse' : ''}
                                ${isPopping ? 'scale-110' : ''}
                                hover:scale-105 active:scale-95
                              `}
                              onClick={(e) => handleTileClick(rowIdx, colIdx, e)}
                              onContextMenu={(e) => handleTileContextMenu(e, rowIdx, colIdx)}
                              title={`Position ${colIdx + 1}`}
                              aria-label={`Row ${rowIdx + 1} Column ${colIdx + 1}: ${tile.char || 'empty'}, ${tile.state}`}
                            >
                              {tile.char ? (API_TO_DISPLAY[tile.char] || tile.char) : ''}
                              {/* Subtle separator line between tiles */}
                              {colIdx < row.length - 1 && (
                                <span className="absolute -right-[3px] top-1/2 -translate-y-1/2 w-[1px] h-5 bg-zinc-200 dark:bg-zinc-700 opacity-50" />
                              )}
                            </button>
                          )
                        })}
                      </div>
                      <div className="flex gap-0.5 ml-1 shrink-0">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => clearRow(rowIdx)}
                          title="Clear row"
                        >
                          <RefreshCw className="w-3 h-3" />
                        </Button>
                        {rows.length > 1 && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-zinc-400 hover:text-red-500"
                            onClick={() => removeRow(rowIdx)}
                            title="Remove row"
                          >
                            <Trash2 className="w-3 h-3" />
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Keyboard */}
            <Card>
              <CardContent className="pt-5">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">On-Screen Keyboard</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => setShowShortcuts(!showShortcuts)}
                    title="Keyboard shortcuts"
                  >
                    <HelpCircle className="w-3.5 h-3.5 text-zinc-400" />
                  </Button>
                </div>
                {showShortcuts && (
                  <div className="mb-2 p-2 rounded-lg bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 text-xs text-zinc-600 dark:text-zinc-400 animate-in slide-in-from-top-1 duration-150">
                    ←→ Navigate &nbsp;|&nbsp; ↑↓ Row &nbsp;|&nbsp; ⌫ Delete &nbsp;|&nbsp; Esc Deselect &nbsp;|&nbsp; Click: Select/Cycle
                  </div>
                )}
                <div className="space-y-1.5">
                  {KEYBOARD_CHARS.map((line, lineIdx) => (
                    <div key={lineIdx} className="flex justify-center gap-1">
                      {line.map((key) => (
                        <Button
                          key={key}
                          variant="outline"
                          size="sm"
                          className={`
                            h-9 w-9 sm:h-10 sm:w-10 font-mono font-bold text-sm p-0 transition-all duration-100
                            ${key === '⌫' ? 'bg-zinc-100 dark:bg-zinc-800 col-span-1' : ''}
                            ${selectedCell
                              ? 'hover:bg-emerald-50 hover:border-emerald-300 dark:hover:bg-emerald-950 dark:hover:border-emerald-700 active:scale-90 active:bg-emerald-100 dark:active:bg-emerald-900'
                              : 'opacity-50'
                            }
                          `}
                          onClick={() => handleKeyPress(key)}
                          disabled={!selectedCell}
                        >
                          {key}
                        </Button>
                      ))}
                    </div>
                  ))}
                </div>
                {selectedCell && (
                  <p className="text-xs text-zinc-400 mt-2 text-center">
                    Selected: Row {selectedCell.row + 1}, Col {selectedCell.col + 1} — Type or use keyboard
                  </p>
                )}
                {!selectedCell && (
                  <p className="text-xs text-amber-500 dark:text-amber-400 mt-2 text-center">
                    Click a tile on the board to start typing
                  </p>
                )}
              </CardContent>
            </Card>

            {/* Constraint validation warnings */}
            {(() => {
              if (solving) return null
              const warnings: string[] = []
              const hasEqualsInAnyRow = rows.some(row => row.some(t => t.char === '='))
              const hasAnyConstraints = rows.some(row => row.some(t => t.char !== ''))
              if (hasAnyConstraints && !hasEqualsInAnyRow) {
                warnings.push('No "=" found in constraints. Results may be very large.')
              }
              if (!hasAnyConstraints && expressionLength < 5) {
                warnings.push('Short expression with no constraints will return many results.')
              }
              return warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800">
                  <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-700 dark:text-amber-400">{w}</p>
                </div>
              ))
            })()}

            {/* Solve Button - with gradient border effect */}
            <div className="relative group">
              <div className="absolute -inset-0.5 bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-500 rounded-xl opacity-60 group-hover:opacity-100 blur-sm transition-opacity duration-300 bg-[length:200%_100%] animate-[shimmer_3s_ease-in-out_infinite]" />
              <Button
                className="relative w-full h-12 text-base font-bold bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white shadow-lg shadow-emerald-500/20 transition-all duration-200 hover:shadow-xl hover:shadow-emerald-500/30 rounded-xl"
                onClick={solve}
                disabled={solving}
                size="lg"
              >
                {solving ? (
                  <>
                    <RefreshCw className="w-5 h-5 mr-2 animate-spin" />
                    Solving... {(solveTimerMs / 1000).toFixed(1)}s
                  </>
                ) : (
                  <>
                    <Play className="w-5 h-5 mr-2" />
                    Solve with Rust Engine
                  </>
                )}
              </Button>
            </div>

            {/* Solve Error */}
            {solveError && (
              <Card className="border-red-300 dark:border-red-800 animate-in slide-in-from-top-2 duration-200">
                <CardContent className="pt-5">
                  <div className="flex items-start gap-2">
                    <X className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                    <p className="text-sm text-red-600 dark:text-red-400">{solveError}</p>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>

          {/* ─── RIGHT PANEL: Results ──────────────────────────────────────── */}
          <div className="space-y-4" ref={resultsRef}>

            {/* Stats Card */}
            {(solveResult || health) && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Gauge className="w-4 h-4 text-emerald-500" />
                    Engine Stats
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {health && (
                      <>
                        <div className="text-center p-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800/80 transition-colors">
                          <Cpu className="w-4 h-4 mx-auto mb-1 text-emerald-500" />
                          <div className="text-lg font-bold">{health.cpu_cores}</div>
                          <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Cores</div>
                        </div>
                        <div className="text-center p-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800/80 transition-colors">
                          <Activity className="w-4 h-4 mx-auto mb-1 text-teal-500" />
                          <div className="text-lg font-bold">{health.parallel_threads}</div>
                          <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Threads</div>
                        </div>
                      </>
                    )}
                    {solveResult && (
                      <>
                        <div className="text-center p-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800/80 transition-colors">
                          <Timer className="w-4 h-4 mx-auto mb-1 text-amber-500" />
                          <div className="text-lg font-bold">{solveResult.elapsed_ms < 1000 ? solveResult.elapsed_ms.toFixed(0) : (solveResult.elapsed_ms / 1000).toFixed(2)}</div>
                          <div className="text-[10px] text-zinc-500 uppercase tracking-wider">{solveResult.elapsed_ms < 1000 ? 'ms' : 'sec'}</div>
                        </div>
                        <div className="text-center p-2.5 rounded-xl bg-zinc-100 dark:bg-zinc-800/80 transition-colors">
                          <BarChart3 className="w-4 h-4 mx-auto mb-1 text-rose-500" />
                          <div className="text-lg font-bold">{formatNumber(solveResult.searched_count)}</div>
                          <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Searched</div>
                        </div>
                      </>
                    )}
                  </div>
                  {solveResult && (
                    <div className="mt-3 flex items-center justify-between p-2.5 rounded-xl bg-gradient-to-r from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/30 border border-emerald-100 dark:border-emerald-900/50">
                      <span className="text-sm font-medium flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-emerald-500" />
                        Solve Speed
                      </span>
                      <span className="text-sm font-bold text-emerald-600 dark:text-emerald-400">
                        {formatSpeed(solveResult.speed_per_sec)}
                      </span>
                    </div>
                  )}
                  {health && (
                    <div className="mt-2 flex items-center justify-between p-2 rounded-lg bg-zinc-50 dark:bg-zinc-800/50 text-xs text-zinc-500">
                      <span className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                        Engine v{health.version}
                      </span>
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        Uptime {formatUptime(health.uptime_secs)}
                      </span>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Solving Progress */}
            {solving && (
              <Card className="animate-in slide-in-from-top-2 duration-200">
                <CardContent className="pt-5 space-y-3">
                  <div className="flex items-center gap-2">
                    <RefreshCw className="w-4 h-4 animate-spin text-emerald-500" />
                    <span className="text-sm font-medium">Rust engine solving... {(solveTimerMs / 1000).toFixed(1)}s</span>
                  </div>
                  <Progress value={undefined} className="h-2" />
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    Parallel search across {health?.parallel_threads || 4} threads
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Results */}
            {solveResult && (
              <Card className="animate-in slide-in-from-bottom-4 duration-500">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-2">
                    <Trophy className="w-4 h-4 text-amber-500" />
                    <CardTitle className="text-base">Results</CardTitle>
                    <Badge
                      variant="secondary"
                      className={`ml-auto relative ${celebrating ? 'animate-bounce' : ''}`}
                    >
                      {solveResult.results.length >= MAX_RESULTS_DEFAULT
                        ? `${MAX_RESULTS_DEFAULT.toLocaleString()}+ found`
                        : `${solveResult.results.length.toLocaleString()} found`
                      }
                      {celebrating && (
                        <span className="absolute -top-2 -right-2 text-sm">\u2728</span>
                      )}
                    </Badge>
                  </div>
                  {solveResult.results.length >= MAX_RESULTS_DEFAULT && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-1 flex items-center gap-1">
                      <Info className="w-3 h-3" />
                      Showing {MAX_RESULTS_DEFAULT.toLocaleString()} of ~{solveResult.results.length.toLocaleString()}+ results. Add more constraints to narrow results.
                    </p>
                  )}
                </CardHeader>
                <CardContent>
                  <Tabs value={resultTab} onValueChange={setResultTab}>
                    <TabsList className="w-full">
                      <TabsTrigger value="solutions" className="flex-1">Solutions</TabsTrigger>
                      <TabsTrigger value="probabilities" className="flex-1">Probabilities</TabsTrigger>
                      <TabsTrigger value="recommended" className="flex-1">Best</TabsTrigger>
                    </TabsList>

                    <TabsContent value="solutions">
                      {solveResult.results.length === 0 ? (
                        <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center py-6">
                          No solutions found. Try adjusting constraints.
                        </p>
                      ) : (
                        <div className="space-y-2 mt-2">
                          {/* Search/Filter + Sort */}
                          <div className="flex gap-2">
                            <div className="relative flex-1">
                              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400" />
                              <Input
                                placeholder="Filter solutions... (e.g. 1+2=3)"
                                value={resultFilter}
                                onChange={(e) => setResultFilter(e.target.value)}
                                className="h-8 text-sm pl-8 pr-8"
                              />
                              {resultFilter && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="absolute right-0.5 top-1/2 -translate-y-1/2 h-7 w-7"
                                  onClick={() => setResultFilter('')}
                                >
                                  <X className="w-3 h-3" />
                                </Button>
                              )}
                            </div>
                            <select
                              className="h-8 text-xs border border-zinc-200 dark:border-zinc-700 rounded-md bg-white dark:bg-zinc-800 px-2 text-zinc-600 dark:text-zinc-400"
                              value={resultSort}
                              onChange={(e) => setResultSort(e.target.value as typeof resultSort)}
                            >
                              <option value="default">Default</option>
                              <option value="az">A→Z</option>
                              <option value="za">Z→A</option>
                              <option value="shortest">Shortest</option>
                              <option value="longest">Longest</option>
                            </select>
                          </div>

                          {/* Result count info */}
                          {resultFilter && (
                            <p className="text-xs text-zinc-500">
                              {filteredResults.length.toLocaleString()} of {solveResult.results.length.toLocaleString()} solutions match filter
                            </p>
                          )}

                          {/* Results list */}
                          <div className="max-h-96 overflow-y-auto space-y-0.5 scrollbar-thin">
                            {filteredResults.slice(0, 500).map((expr, idx) => (
                              <div
                                key={idx}
                                className={`flex items-center gap-2 p-2 rounded-lg transition-colors group
                                  hover:bg-zinc-100 dark:hover:bg-zinc-800
                                  ${expr === solveResult.recommended
                                    ? 'bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800'
                                    : 'border border-transparent'
                                  }
                                `}
                              >
                                <span className="text-xs text-zinc-400 w-8 text-right font-mono group-hover:text-zinc-600 dark:group-hover:text-zinc-300">{idx + 1}</span>
                                <code className="font-mono font-bold text-sm flex-1 tracking-wider group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors">{formatExpression(expr)}</code>
                                {expr === solveResult.recommended && (
                                  <Trophy className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                                )}
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                                  onClick={async () => {
                                    await navigator.clipboard.writeText(formatExpression(expr))
                                    setCopiedResult(expr)
                                    setTimeout(() => setCopiedResult(null), 1500)
                                  }}
                                  title="Copy expression"
                                >
                                  {copiedResult === expr ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3 text-zinc-400" />}
                                </Button>
                              </div>
                            ))}
                            {filteredResults.length > 500 && (
                              <p className="text-xs text-zinc-400 text-center py-2">
                                Showing 500 of {filteredResults.length.toLocaleString()} filtered solutions
                              </p>
                            )}
                            {filteredResults.length === 0 && resultFilter && (
                              <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center py-6">
                                No solutions match &ldquo;{resultFilter}&rdquo;
                              </p>
                            )}
                          </div>
                        </div>
                      )}
                    </TabsContent>

                    <TabsContent value="probabilities">
                      {solveResult.char_probabilities.length === 0 ? (
                        <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center py-6">
                          No probability data available.
                        </p>
                      ) : (
                        <div className="max-h-96 overflow-y-auto space-y-2 mt-2 scrollbar-thin">
                          {solveResult.char_probabilities
                            .sort((a, b) => b.probability - a.probability)
                            .map((cp, idx) => {
                              const displayChar = API_TO_DISPLAY[cp.char] || cp.char
                              const barWidth = Math.min(cp.probability, 100)
                              // Color coding based on probability
                              const barColor = cp.probability >= 30
                                ? 'from-emerald-400 to-teal-500'
                                : cp.probability >= 15
                                  ? 'from-teal-400 to-cyan-500'
                                  : cp.probability >= 5
                                    ? 'from-cyan-400 to-sky-500'
                                    : 'from-zinc-300 to-zinc-400 dark:from-zinc-600 dark:to-zinc-500'
                              return (
                                <div key={cp.char} className="flex items-center gap-2 group">
                                  <span className="text-xs text-zinc-400 w-4 text-right font-mono">{idx + 1}</span>
                                  <div
                                    className={`w-8 h-8 rounded-lg border-2 flex items-center justify-center font-mono font-bold text-sm shrink-0
                                      ${cp.probability >= 15 ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-800' :
                                        cp.probability >= 5 ? 'bg-teal-50 text-teal-700 border-teal-200 dark:bg-teal-950/30 dark:text-teal-400 dark:border-teal-800' :
                                        'bg-zinc-50 text-zinc-600 border-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:border-zinc-700'}
                                    `}
                                  >
                                    {displayChar}
                                  </div>
                                  <div className="flex-1 h-6 bg-zinc-100 dark:bg-zinc-800 rounded-md overflow-hidden relative">
                                    <div
                                      className={`h-full rounded-md bg-gradient-to-r ${barColor} transition-all duration-700 ease-out relative`}
                                      style={{ width: `${barWidth}%` }}
                                    >
                                      {cp.probability >= 8 && (
                                        <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] font-bold text-white/90">
                                          {cp.probability.toFixed(1)}%
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                  {cp.probability < 8 && (
                                    <span className="text-xs text-zinc-500 w-14 text-right font-mono shrink-0">
                                      {cp.probability.toFixed(1)}%
                                    </span>
                                  )}
                                  {cp.probability >= 8 && (
                                    <span className="text-xs text-zinc-400 w-14 text-right font-mono shrink-0">
                                      {cp.probability.toFixed(1)}%
                                    </span>
                                  )}
                                </div>
                              )
                            })}
                        </div>
                      )}
                    </TabsContent>

                    <TabsContent value="recommended">
                      {solveResult.recommended ? (
                        <div className="text-center py-8 space-y-4">
                          <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 shadow-lg shadow-amber-500/20 animate-in zoom-in-50 duration-300">
                            <Trophy className="w-10 h-10 text-white" />
                          </div>
                          <div>
                            <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-3">Recommended Guess</p>
                            <code className="text-4xl font-mono font-black bg-gradient-to-r from-amber-500 to-orange-500 bg-clip-text text-transparent tracking-widest">
                              {formatExpression(solveResult.recommended)}
                            </code>
                          </div>
                          <p className="text-xs text-zinc-400 max-w-xs mx-auto">
                            Based on character probability analysis across {solveResult.results.length.toLocaleString()} valid solutions
                          </p>
                        </div>
                      ) : (
                        <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center py-6">
                          No recommendation available.
                        </p>
                      )}
                    </TabsContent>
                  </Tabs>
                </CardContent>
              </Card>
            )}

            {/* Empty state - Compact "Ready to Solve" placeholder */}
            {!solveResult && !solving && (
              <Card className="transition-all duration-500">
                <CardContent className="pt-5">
                  <div className="text-center mb-4">
                    <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-gradient-to-br from-emerald-100 to-teal-100 dark:from-emerald-900/30 dark:to-teal-900/30 flex items-center justify-center border border-emerald-200 dark:border-emerald-800">
                      <Zap className="w-6 h-6 text-emerald-500" />
                    </div>
                    <h3 className="text-base font-semibold mb-1">Ready to Solve</h3>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400">
                      Enter constraints on the board, then hit Solve
                    </p>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs mb-3">
                    <div className="flex items-start gap-2 p-2 rounded-lg bg-zinc-50 dark:bg-zinc-800/50">
                      <span className="w-5 h-5 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center shrink-0 text-[10px] font-bold text-emerald-600 dark:text-emerald-400">1</span>
                      <span className="text-zinc-600 dark:text-zinc-400">Set length &amp; enter chars</span>
                    </div>
                    <div className="flex items-start gap-2 p-2 rounded-lg bg-zinc-50 dark:bg-zinc-800/50">
                      <span className="w-5 h-5 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center shrink-0 text-[10px] font-bold text-emerald-600 dark:text-emerald-400">2</span>
                      <span className="text-zinc-600 dark:text-zinc-400">Cycle colors: 🟩→🟨→⬛</span>
                    </div>
                    <div className="flex items-start gap-2 p-2 rounded-lg bg-zinc-50 dark:bg-zinc-800/50">
                      <span className="w-5 h-5 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center shrink-0 text-[10px] font-bold text-emerald-600 dark:text-emerald-400">3</span>
                      <span className="text-zinc-600 dark:text-zinc-400">Hit Solve!</span>
                    </div>
                    <div className="flex items-start gap-2 p-2 rounded-lg bg-zinc-50 dark:bg-zinc-800/50">
                      <Target className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                      <span className="text-zinc-600 dark:text-zinc-400">Use <strong>Probabilities</strong> for best guess</span>
                    </div>
                  </div>

                  <Separator className="mb-3" />

                  {/* Example game state */}
                  <div className="text-center">
                    <p className="text-[10px] text-zinc-400 mb-1.5">Example: 1+2=3 with constraints</p>
                    <div className="flex justify-center gap-0.5">
                      <div className="w-8 h-8 rounded border-2 bg-emerald-500 text-white border-emerald-600 font-mono font-bold text-sm flex items-center justify-center">1</div>
                      <div className="w-8 h-8 rounded border-2 bg-emerald-500 text-white border-emerald-600 font-mono font-bold text-sm flex items-center justify-center">+</div>
                      <div className="w-8 h-8 rounded border-2 bg-amber-400 text-amber-950 border-amber-500 font-mono font-bold text-sm flex items-center justify-center">2</div>
                      <div className="w-8 h-8 rounded border-2 bg-emerald-500 text-white border-emerald-600 font-mono font-bold text-sm flex items-center justify-center">=</div>
                      <div className="w-8 h-8 rounded border-2 bg-zinc-400 text-zinc-800 border-zinc-500 font-mono font-bold text-sm flex items-center justify-center">3</div>
                    </div>
                    <p className="text-[10px] text-zinc-400 mt-1">🟩 Right spot · 🟨 Wrong spot · ⬛ Not in equation</p>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* How to Play */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Hash className="w-4 h-4 text-emerald-500" />
                  How to Play
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-zinc-600 dark:text-zinc-400 space-y-3">
                <p>Sumzle is a math-based Wordle where you guess valid equations like <code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded">1+2=3</code>.</p>
                <Separator />
                <div className="space-y-1.5">
                  <p className="flex items-center gap-2">
                    <span className="inline-block w-4 h-4 rounded bg-emerald-500 shrink-0" />
                    <strong>Green</strong> — Correct character in the right position
                  </p>
                  <p className="flex items-center gap-2">
                    <span className="inline-block w-4 h-4 rounded bg-amber-400 shrink-0" />
                    <strong>Yellow</strong> — Character exists but in the wrong position
                  </p>
                  <p className="flex items-center gap-2">
                    <span className="inline-block w-4 h-4 rounded bg-zinc-400 shrink-0" />
                    <strong>Gray</strong> — Character is not in the equation
                  </p>
                </div>
                <Separator />
                <div className="space-y-1 text-xs text-zinc-500 dark:text-zinc-500">
                  <p>&#8226; Click a tile to select, then type a character</p>
                  <p>&#8226; Click the same tile again (or right-click) to cycle its color</p>
                  <p>&#8226; Use arrow keys to navigate between tiles</p>
                  <p>&#8226; Supports: +−×÷%^=()![]A (permutation)</p>
                  <p>&#8226; <code className="bg-zinc-100 dark:bg-zinc-800 px-1 rounded">[x/y]</code> = floor division, <code className="bg-zinc-100 dark:bg-zinc-800 px-1 rounded">n!</code> = factorial, <code className="bg-zinc-100 dark:bg-zinc-800 px-1 rounded">mAn</code> = permutation</p>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>

      {/* ─── Footer ──────────────────────────────────────────────────────────── */}
      <footer className="mt-auto border-t border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900">
        <div className="max-w-7xl mx-auto px-4 py-4 flex flex-col sm:flex-row items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-400">
          <div className="flex items-center gap-2">
            <Zap className="w-3.5 h-3.5 text-emerald-500" />
            <span>Sumzle HP Solver — Powered by Rust</span>
          </div>
          <div className="flex items-center gap-4">
            {health && (
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Engine v{health.version} · {formatUptime(health.uptime_secs)}
              </span>
            )}
            <span>Parallel Multi-Core Solver</span>
          </div>
        </div>
      </footer>
    </div>
  )
}
