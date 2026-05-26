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
  Target, HelpCircle, AlertTriangle, Download, Lightbulb, TrendingUp,
  Undo2, Redo2, ArrowUp, GripVertical, Share2, ExternalLink, Eye
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
  speedPerSec: number
  recommended: string
  maxResultsApplied: boolean
}

interface SmartHint {
  char: string
  displayChar: string
  position: number
  probability: number
}

interface ConstraintConflict {
  type: 'hard' | 'soft'
  char: string
  message: string
}

// ─── Constants ───────────────────────────────────────────────────────────────

const KEYBOARD_CHARS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['+', '-', '\u00d7', '\u00f7', '%', '^', '=', '>', '\u232b'],
  ['(', ')', '!', '[', ']', 'A'],
]

const DISPLAY_TO_API: Record<string, string> = {
  '\u00d7': '*',
  '\u00f7': '/',
}

const API_TO_DISPLAY: Record<string, string> = {
  '*': '\u00d7',
  '/': '\u00f7',
}

const STATE_ORDER: TileState[] = ['empty', 'correct', 'present', 'absent']

const STATE_COLORS: Record<TileState, string> = {
  correct: 'bg-emerald-500 text-white border-emerald-600 dark:bg-emerald-600 dark:border-emerald-700 shadow-sm shadow-emerald-500/30',
  present: 'bg-amber-400 text-amber-950 border-amber-500 dark:bg-amber-500 dark:text-amber-950 dark:border-amber-600 shadow-sm shadow-amber-400/30',
  absent: 'bg-zinc-400 text-zinc-800 border-zinc-500 dark:bg-zinc-600 dark:text-zinc-200 dark:border-zinc-700',
  empty: 'bg-white text-zinc-800 border-zinc-300 dark:bg-zinc-800 dark:text-zinc-200 dark:border-zinc-600',
}

const STATE_LABELS: Record<TileState, string> = {
  correct: '\ud83d\udfe9 Correct',
  present: '\ud83d\udfe8 Present',
  absent: '\u2b1b Absent',
  empty: '\u2b1c Empty',
}

const MAX_ROWS = 10
const MIN_LENGTH = 3
const MAX_LENGTH = 15
const DEFAULT_LENGTH = 6
const MAX_RESULTS_DEFAULT = 0  // 0 = no limit, fetch ALL results from solver
const MAX_DISPLAY_RESULTS = 500  // Max results to render in the DOM for performance
const MAX_RESULTS_SAFE_CAP = 100000  // Safety cap to prevent browser OOM on initial solve
const MAX_SOLVE_HISTORY = 10
const MAX_UNDO_HISTORY = 50
const APP_VERSION = '2.1.0'

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
  return expr.replace(/\*/g, '\u00d7').replace(/\//g, '\u00f7')
}

function formatUptime(secs: number): string {
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
}

function getExpressionType(expr: string): 'equation' | 'comparison' {
  if (expr.includes('>')) return 'comparison'
  return 'equation'
}

function deepCloneRows(rows: Tile[][]): Tile[][] {
  return rows.map(row => row.map(tile => ({ ...tile })))
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

  // Tile flip animation tracking
  const [flippingTile, setFlippingTile] = useState<string | null>(null)

  // Solver status (derived from health checks)
  const [solverOnline, setSolverOnline] = useState<boolean | null>(null)
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

  // Smart hints
  const [showHints, setShowHints] = useState(true)

  // Download menu
  const [showDownloadMenu, setShowDownloadMenu] = useState(false)

  // Undo/Redo history
  const [historyStack, setHistoryStack] = useState<Tile[][][]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)

  // Scroll to top visibility
  const [showScrollTop, setShowScrollTop] = useState(false)

  // Result badge flash
  const [resultBadgeFlash, setResultBadgeFlash] = useState(false)

  // Load more results display limit
  const [displayLimit, setDisplayLimit] = useState(MAX_DISPLAY_RESULTS)

  // Download all (unlimited) progress
  const [downloadingAll, setDownloadingAll] = useState(false)
  const [downloadAllProgress, setDownloadAllProgress] = useState('')

  // Drag & Drop row reordering
  const [dragOverRow, setDragOverRow] = useState<number | null>(null)
  const [dragSourceRow, setDragSourceRow] = useState<number | null>(null)

  // Result expression visualizer
  const [selectedResultExpr, setSelectedResultExpr] = useState<string | null>(null)

  // Share puzzle state
  const [shareCopied, setShareCopied] = useState(false)

  // Mobile keyboard auto-open
  const mobileInputRef = useRef<HTMLInputElement>(null)

  // Refs
  const resultsRef = useRef<HTMLDivElement>(null)
  const boardRef = useRef<HTMLDivElement>(null)
  const downloadMenuRef = useRef<HTMLDivElement>(null)
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const expressionLengthRef = useRef(expressionLength)
  expressionLengthRef.current = expressionLength

  // ─── Undo/Redo ────────────────────────────────────────────────────────────

  const pushHistory = useCallback((newRows: Tile[][]) => {
    setHistoryStack(prev => {
      // Truncate any redo states beyond current index
      const truncated = prev.slice(0, historyIndex + 1)
      const updated = [...truncated, deepCloneRows(newRows)].slice(-MAX_UNDO_HISTORY)
      setHistoryIndex(updated.length - 1)
      return updated
    })
  }, [historyIndex])

  const canUndo = historyIndex > 0
  const canRedo = historyIndex < historyStack.length - 1

  const undo = useCallback(() => {
    if (historyIndex <= 0) return
    const newIndex = historyIndex - 1
    setHistoryIndex(newIndex)
    setRows(deepCloneRows(historyStack[newIndex]))
  }, [historyIndex, historyStack])

  const redo = useCallback(() => {
    if (historyIndex >= historyStack.length - 1) return
    const newIndex = historyIndex + 1
    setHistoryIndex(newIndex)
    setRows(deepCloneRows(historyStack[newIndex]))
  }, [historyIndex, historyStack])

  // ─── Load puzzle from URL ──────────────────────────────────────────────────

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const puzzleParam = params.get('p')
    if (puzzleParam) {
      try {
        const decoded = JSON.parse(atob(puzzleParam))
        if (decoded.length && typeof decoded.length === 'number') {
          setExpressionLength(decoded.length)
        }
        if (decoded.rows && Array.isArray(decoded.rows)) {
          const importedRows = (decoded.rows as { char: string; state: string }[][]).map((row) =>
            row.map((tile) => ({
              char: API_TO_DISPLAY[tile.char] || tile.char,
              state: ((tile.state === 'empty' && tile.char !== '') ? 'absent' :
                     (tile.state || 'empty')) as TileState,
            }))
          )
          setRows(importedRows)
          if (importedRows) pushHistory(importedRows)
          // Clean URL
          window.history.replaceState({}, '', window.location.pathname)
        }
      } catch {
        // Invalid puzzle param, ignore
      }
    }
  }, [])

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

  // ─── Mobile keyboard auto-open ────────────────────────────────────────────

  useEffect(() => {
    if (selectedCell && mobileInputRef.current) {
      mobileInputRef.current.focus({ preventScroll: true })
    }
  }, [selectedCell])

  // ─── Celebration effect ────────────────────────────────────────────────────

  useEffect(() => {
    if (solveResult && solveResult.results.length > 0) {
      setCelebrating(true)
      setResultBadgeFlash(true)
      const timer = setTimeout(() => setCelebrating(false), 2000)
      const flashTimer = setTimeout(() => setResultBadgeFlash(false), 1500)
      return () => { clearTimeout(timer); clearTimeout(flashTimer) }
    }
  }, [solveResult])

  // ─── Close download menu on outside click ──────────────────────────────────

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (downloadMenuRef.current && !downloadMenuRef.current.contains(e.target as Node)) {
        setShowDownloadMenu(false)
      }
    }
    if (showDownloadMenu) {
      document.addEventListener('mousedown', handleClick)
      return () => document.removeEventListener('mousedown', handleClick)
    }
  }, [showDownloadMenu])

  // ─── Scroll to top visibility ──────────────────────────────────────────────

  useEffect(() => {
    const handleScroll = () => {
      setShowScrollTop(window.scrollY > 400)
    }
    window.addEventListener('scroll', handleScroll, { passive: true })
    return () => window.removeEventListener('scroll', handleScroll)
  }, [])

  // ─── Fetch health ──────────────────────────────────────────────────────────

  const solvingRef = useRef(false)
  solvingRef.current = solving

  const fetchHealth = useCallback(async () => {
    if (solvingRef.current) return
    try {
      const res = await fetch('/api/health')
      if (res.ok) {
        const data = await res.json()
        setHealth(data.data || data)
        setSolverOnline(true)
      } else {
        setSolverOnline(false)
      }
    } catch {
      setSolverOnline(false)
    }
    setSolverLastChecked(Date.now())
  }, [])

  useEffect(() => {
    fetchHealth()
    const getInterval = () => {
      if (solverOnline === null) return 15000
      if (solverOnline) return 30000
      return 60000
    }
    const interval = setInterval(fetchHealth, getInterval())
    return () => clearInterval(interval)
  }, [fetchHealth, solverOnline])

  // ─── Update row lengths ────────────────────────────────────────────────────

  const updateRowLengths = useCallback((newLength: number) => {
    setRows(prev => {
      const updated = prev.map(row => {
        if (row.length === newLength) return row
        const newRow = createEmptyRow(newLength)
        for (let i = 0; i < Math.min(row.length, newLength); i++) {
          newRow[i] = row[i]
        }
        return newRow
      })
      pushHistory(updated)
      return updated
    })
  }, [pushHistory])

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
      const updated = [...prev, createEmptyRow(expressionLength)]
      pushHistory(updated)
      return updated
    })
  }, [expressionLength, pushHistory])

  const removeRow = useCallback((index: number) => {
    setRows(prev => {
      if (prev.length <= 1) return prev
      const updated = prev.filter((_, i) => i !== index)
      pushHistory(updated)
      return updated
    })
  }, [pushHistory])

  const clearRow = useCallback((index: number) => {
    setRows(prev => {
      const updated = prev.map((row, i) => i === index ? createEmptyRow(expressionLength) : row)
      pushHistory(updated)
      return updated
    })
  }, [expressionLength, pushHistory])

  // ─── Tile interactions ─────────────────────────────────────────────────────

  const cycleState = useCallback((rowIdx: number, colIdx: number) => {
    setRows(prev => {
      const updated = prev.map((row, i) => {
        if (i !== rowIdx) return row
        return row.map((tile, j) => {
          if (j !== colIdx) return tile
          if (!tile.char && tile.state === 'empty') return tile
          const currentIdx = STATE_ORDER.indexOf(tile.state)
          const nextIdx = (currentIdx + 1) % STATE_ORDER.length
          return { ...tile, state: STATE_ORDER[nextIdx] }
        })
      })
      pushHistory(updated)
      return updated
    })
    // Trigger flip animation
    const tileKey = `${rowIdx}-${colIdx}`
    setFlippingTile(tileKey)
    setTimeout(() => setFlippingTile(null), 300)
  }, [pushHistory])

  const setChar = useCallback((rowIdx: number, colIdx: number, char: string) => {
    setRows(prev => {
      const updated = prev.map((row, i) => {
        if (i !== rowIdx) return row
        return row.map((tile, j) => {
          if (j !== colIdx) return tile
          const newState = char && tile.state === 'empty' ? 'correct' : tile.state
          return { ...tile, char, state: newState }
        })
      })

      // Feature 5: Auto-advance row on complete
      if (char && rowIdx < updated.length) {
        const currentRow = updated[rowIdx]
        const allFilled = currentRow.every(t => t.char !== '')
        const hasNonEmptyState = currentRow.some(t => t.state !== 'empty')
        if (allFilled && hasNonEmptyState && updated.length < MAX_ROWS) {
          // Check if there's already an empty row below
          const hasEmptyRowBelow = updated.slice(rowIdx + 1).some(r => r.every(t => t.char === ''))
          if (!hasEmptyRowBelow) {
            updated.push(createEmptyRow(expressionLengthRef.current))
          }
        }
      }

      pushHistory(updated)
      return updated
    })
    const tileKey = `${rowIdx}-${colIdx}`
    setPoppingTile(tileKey)
    setTimeout(() => setPoppingTile(null), 200)
  }, [pushHistory])

  const handleTileClick = useCallback((rowIdx: number, colIdx: number, e?: React.MouseEvent) => {
    if (e?.button === 2) {
      e.preventDefault()
      cycleState(rowIdx, colIdx)
    } else {
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

    if (key === '\u232b') {
      const { row, col } = selectedCell
      setChar(row, col, '')
      if (col > 0) {
        setSelectedCell({ row, col: col - 1 })
      }
      return
    }

    const { row, col } = selectedCell
    setChar(row, col, key)
    if (col < expressionLength - 1) {
      setSelectedCell({ row, col: col + 1 })
    }
  }, [selectedCell, expressionLength, setChar])

  // ─── Solve ─────────────────────────────────────────────────────────────────

  const solve = useCallback(async () => {
    setSolving(true)
    setSolveError(null)
    setSolveResult(null)
    setResultFilter('')
    setDisplayLimit(MAX_DISPLAY_RESULTS)

    try {
      const apiRows = rows
        .filter(row => row.some(t => t.char !== ''))
        .map(row => row.map(tile => ({
          char: DISPLAY_TO_API[tile.char] || tile.char,
          state: tile.state === 'absent' ? 'empty' : tile.state,
        })))

      const body: Record<string, unknown> = {
        length: expressionLength,
        rows: apiRows.length > 0 ? apiRows : [Array(expressionLength).fill(null).map(() => ({ char: '', state: 'empty' }))],
        mode: 'parallel',
        num_threads: health?.parallel_threads || undefined,
        max_results: MAX_RESULTS_SAFE_CAP,
      }

      let data: Record<string, unknown> | null = null
      let res: Response | null = null
      const MAX_RETRIES = 3
      const RETRY_DELAYS = [2000, 5000, 8000]

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          res = await fetch('/api/solve/parallel', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })

          const text = await res.text()
          try {
            data = JSON.parse(text)
          } catch {
            if (attempt < MAX_RETRIES - 1) {
              await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]))
              continue
            }
            throw new Error('Solver is starting up, please try again in a few seconds')
          }

          // Handle busy state (409) - don't retry, show message immediately
          if (res.status === 409) {
            const errMsg = (data as Record<string, unknown>)?.error as string || ''
            throw new Error(errMsg || 'Solver is busy. Click "Reset" if it seems stuck.')
          }

          if (res.ok && (data as Record<string, unknown>).success) break

          const errorMsg = (data as Record<string, unknown>).error as string || ''
          // Don't retry on "busy" - it means the solver is processing
          if (errorMsg.includes('busy') || errorMsg.includes('solver_busy')) {
            throw new Error('Solver is currently busy. Click "Reset" if it seems stuck.')
          }
          if (errorMsg.includes('not available') || errorMsg.includes('starting') || errorMsg.includes('connection failed') || errorMsg.includes('restarting')) {
            if (attempt < MAX_RETRIES - 1) {
              await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]))
              continue
            }
          }
          if (errorMsg.includes('timed out') || errorMsg.includes('too large')) {
            throw new Error('Solve timed out — the search space is too large. Try adding more constraints or use a shorter expression length.')
          }
          break
        } catch (err) {
          // If this is already a user-friendly error we threw, re-throw it
          if (err instanceof Error && (
            err.message.includes('busy') ||
            err.message.includes('timed out') ||
            err.message.includes('search space') ||
            err.message.includes('stuck')
          )) {
            throw err
          }
          if (attempt < MAX_RETRIES - 1) {
            await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]))
            continue
          }
          const msg = err instanceof Error ? err.message : 'Unknown error'
          if (msg.includes('fetch')) {
            throw new Error('Could not reach solver. It may be starting up — please try again in a few seconds')
          }
          throw new Error(msg)
        }
      }

      if (!res || !data) {
        throw new Error('Solver is not responding. It may be restarting — please try again shortly')
      }

      if (!res.ok || !(data as Record<string, unknown>).success) {
        const errMsg = (data as Record<string, unknown>).error as string || `Solver returned status ${res.status}`
        if (errMsg.includes('busy')) {
          throw new Error('Solver is currently busy. Click "Reset" if it seems stuck.')
        }
        if (errMsg.includes('not available') || errMsg.includes('connection failed')) {
          throw new Error('Solver connection lost. It may be restarting — please try again shortly')
        }
        throw new Error(errMsg)
      }

      const result: SolveResult = (data as Record<string, unknown>).data as SolveResult
      setSolveResult(result)

      const maxResultsApplied = result.results.length >= MAX_RESULTS_SAFE_CAP
      const historyEntry: SolveHistoryEntry = {
        id: Date.now().toString(36) + Math.random().toString(36).substring(2, 6),
        timestamp: Date.now(),
        expressionLength,
        constraintCount: apiRows.filter(r => r.some(t => t.char !== '')).length,
        resultCount: result.results.length,
        elapsedMs: result.elapsed_ms,
        searchedCount: result.searched_count,
        speedPerSec: result.speed_per_sec,
        recommended: result.recommended || '',
        maxResultsApplied,
      }
      setSolveHistory(prev => [historyEntry, ...prev].slice(0, MAX_SOLVE_HISTORY))

      setTimeout(() => {
        resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      }, 100)
    } catch (err) {
      setSolveError(err instanceof Error ? err.message : 'Solve failed')
    } finally {
      setSolving(false)
    }
  }, [rows, expressionLength, health])

  // ─── Reset Solver ────────────────────────────────────────────────────────

  const resetSolver = useCallback(async () => {
    try {
      setSolveError(null)
      const res = await fetch('/api/solver/reset')
      const data = await res.json()
      if (data.success) {
        // Refresh health after reset
        setTimeout(() => fetchHealth(), 2000)
      } else {
        setSolveError('Failed to reset solver. Please try again.')
      }
    } catch {
      setSolveError('Could not reach solver for reset. It may need manual restart.')
    }
  }, [fetchHealth])

  // ─── Import ────────────────────────────────────────────────────────────────

  const handleImport = useCallback(() => {
    try {
      const parsed = JSON.parse(importText)
      let importedRows: Tile[][] | null = null
      if (parsed.length && typeof parsed.length === 'number') {
        setExpressionLength(parsed.length)
      }
      if (parsed.rows && Array.isArray(parsed.rows)) {
        importedRows = (parsed.rows as { char: string; state: string }[][]).map((row) =>
          row.map((tile) => ({
            char: API_TO_DISPLAY[tile.char] || tile.char,
            state: ((tile.state === 'empty' && tile.char !== '') ? 'absent' :
                   (tile.state || 'empty')) as TileState,
          }))
        )
        setRows(importedRows)
        if (importedRows) pushHistory(importedRows)
      }
      setShowImport(false)
      setImportText('')
      setSolveError(null)
    } catch {
      setSolveError('Invalid JSON format for import')
    }
  }, [importText, pushHistory])

  // ─── Export game state ─────────────────────────────────────────────────────

  const exportState = useCallback(() => {
    const apiRows = rows.map(row =>
      row.map(tile => ({
        char: DISPLAY_TO_API[tile.char] || tile.char,
        state: tile.state === 'absent' ? 'empty' : tile.state,
      }))
    )
    return JSON.stringify({ length: expressionLength, rows: apiRows }, null, 2)
  }, [rows, expressionLength])

  const copyState = useCallback(async () => {
    await navigator.clipboard.writeText(exportState())
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [exportState])

  // ─── Physical keyboard support + keyboard shortcuts ────────────────────────

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl/Cmd+Z to undo
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo()
        return
      }
      // Ctrl/Cmd+Y or Ctrl+Shift+Z to redo
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'Z' && e.shiftKey) || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault()
        redo()
        return
      }

      // Ctrl/Cmd+Enter to solve
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        if (!solvingRef.current) solve()
        return
      }

      // Ctrl/Cmd+E to export/copy game state
      if ((e.ctrlKey || e.metaKey) && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault()
        copyState()
        return
      }

      // Don't intercept if user is typing in an input/textarea
      const target = e.target as HTMLElement
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return

      if (!selectedCell) return

      // Backspace
      if (e.key === 'Backspace') {
        e.preventDefault()
        handleKeyPress('\u232b')
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
      if (char === 'a') char = 'A'
      if (char === '*') char = '\u00d7'
      if (char === '/') char = '\u00f7'

      if (VALID_CHARS_SET.has(e.key) || (char === '\u00d7') || (char === '\u00f7') || (char === 'A')) {
        e.preventDefault()
        handleKeyPress(char)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedCell, expressionLength, rows.length, handleKeyPress, setChar, solve, copyState, undo, redo])

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

  // ─── Drag & Drop row reordering ────────────────────────────────────────────

  const handleDragStart = useCallback((rowIdx: number) => {
    setDragSourceRow(rowIdx)
  }, [])

  const handleDragOver = useCallback((e: React.DragEvent, rowIdx: number) => {
    e.preventDefault()
    setDragOverRow(rowIdx)
  }, [])

  const handleDragEnd = useCallback(() => {
    if (dragSourceRow !== null && dragOverRow !== null && dragSourceRow !== dragOverRow) {
      setRows(prev => {
        const updated = [...prev]
        const [moved] = updated.splice(dragSourceRow, 1)
        updated.splice(dragOverRow, 0, moved)
        pushHistory(updated)
        return updated
      })
      // Update selected cell if it was in the moved row
      if (selectedCell) {
        if (selectedCell.row === dragSourceRow) {
          setSelectedCell({ row: dragOverRow, col: selectedCell.col })
        } else {
          // Adjust other rows' indices
          const newRowIndex = selectedCell.row
          if (dragSourceRow < selectedCell.row && dragOverRow >= selectedCell.row) {
            setSelectedCell({ row: newRowIndex - 1, col: selectedCell.col })
          } else if (dragSourceRow > selectedCell.row && dragOverRow <= selectedCell.row) {
            setSelectedCell({ row: newRowIndex + 1, col: selectedCell.col })
          }
        }
      }
    }
    setDragSourceRow(null)
    setDragOverRow(null)
  }, [dragSourceRow, dragOverRow, pushHistory, selectedCell])

  // ─── Share Puzzle via URL ──────────────────────────────────────────────────

  const sharePuzzle = useCallback(async () => {
    const apiRows = rows.map(row =>
      row.map(tile => ({
        char: DISPLAY_TO_API[tile.char] || tile.char,
        state: tile.state === 'absent' ? 'empty' : tile.state,
      }))
    )
    const puzzleState = { length: expressionLength, rows: apiRows }
    const encoded = btoa(JSON.stringify(puzzleState))
    const url = `${window.location.origin}${window.location.pathname}?p=${encoded}`
    await navigator.clipboard.writeText(url)
    setShareCopied(true)
    setTimeout(() => setShareCopied(false), 2000)
  }, [rows, expressionLength])

  // ─── Result Count Estimation ───────────────────────────────────────────────

  const estimatedResultCount = useMemo((): string | null => {
    if (solving) return null
    const hasAnyConstraints = rows.some(row => row.some(t => t.char !== ''))
    if (!hasAnyConstraints) return null

    const totalTiles = rows.reduce((acc, row) => acc + row.filter(t => t.char !== '').length, 0)
    const correctCount = rows.reduce((acc, row) => acc + row.filter(t => t.state === 'correct').length, 0)
    const presentCount = rows.reduce((acc, row) => acc + row.filter(t => t.state === 'present').length, 0)
    const density = (correctCount * 3 + presentCount * 1) / Math.max(totalTiles, 1)

    if (density >= 2) return '~1-10'
    if (density >= 1) return '~10-100'
    if (density >= 0.5) return '~100-1K'
    if (density >= 0.25) return '~1K-10K'
    if (density >= 0.1) return '~10K-100K'
    return '~100K+'
  }, [rows, solving])

  // ─── Result Expression Visualizer ──────────────────────────────────────────

  const visualizeExpression = useMemo(() => {
    if (!selectedResultExpr) return null

    const expr = selectedResultExpr
    // Find the separator (= or >)
    const eqIdx = expr.indexOf('=')
    const gtIdx = expr.indexOf('>')
    const sepIdx = eqIdx >= 0 ? eqIdx : gtIdx
    const separator = eqIdx >= 0 ? '=' : '>'

    if (sepIdx < 0) {
      // No separator, show as single group
      return { leftChars: expr.split(''), rightChars: [], separator: '' }
    }

    const left = expr.substring(0, sepIdx)
    const right = expr.substring(sepIdx + 1)

    return {
      leftChars: left.split(''),
      rightChars: right.split(''),
      separator,
    }
  }, [selectedResultExpr])

  // ─── Clear all ─────────────────────────────────────────────────────────────

  const clearAll = useCallback(() => {
    const newRows = [createEmptyRow(expressionLength)]
    setRows(newRows)
    setSelectedCell(null)
    setSolveResult(null)
    setSolveError(null)
    setResultFilter('')
    pushHistory(newRows)
  }, [expressionLength, pushHistory])

  // ─── Filtered results ──────────────────────────────────────────────────────

  const filteredResults = useMemo(() => {
    if (!solveResult) return []
    let results = solveResult.results
    if (resultFilter.trim()) {
      const lowerFilter = resultFilter.toLowerCase().replace(/\u00d7/g, '*').replace(/\u00f7/g, '/')
      results = results.filter(expr =>
        expr.toLowerCase().includes(lowerFilter) ||
        formatExpression(expr).toLowerCase().includes(resultFilter.toLowerCase())
      )
    }
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

  // ─── Constraint Summary ────────────────────────────────────────────────────

  const constraintSummary = useMemo(() => {
    const locked = new Map<string, number[]>()
    const excluded = new Set<string>()
    const hinted = new Map<string, number[]>()

    rows.forEach(row => {
      row.forEach((tile, colIdx) => {
        if (!tile.char) return
        const apiChar = DISPLAY_TO_API[tile.char] || tile.char
        if (tile.state === 'correct') {
          const positions = locked.get(apiChar) || []
          if (!positions.includes(colIdx)) positions.push(colIdx)
          locked.set(apiChar, positions)
        } else if (tile.state === 'absent') {
          excluded.add(apiChar)
        } else if (tile.state === 'present') {
          const positions = hinted.get(apiChar) || []
          if (!positions.includes(colIdx)) positions.push(colIdx)
          hinted.set(apiChar, positions)
        }
      })
    })

    locked.forEach((_, char) => hinted.delete(char))

    return { locked, excluded, hinted }
  }, [rows])

  // ─── Constraint Conflict Detection (Feature 3) ────────────────────────────

  const constraintConflicts = useMemo((): ConstraintConflict[] => {
    const conflicts: ConstraintConflict[] = []

    // Build a map: char -> { correctPositions: Set<number>, absentPositions: Set<number>, presentPositions: Set<number> }
    const charInfo = new Map<string, {
      correctPositions: Set<number>
      absentPositions: Set<number>
      presentPositions: Set<number>
      absentRows: Set<number>
      correctRows: Set<number>
      presentRows: Set<number>
    }>()

    rows.forEach((row, rowIdx) => {
      row.forEach((tile, colIdx) => {
        if (!tile.char) return
        const apiChar = DISPLAY_TO_API[tile.char] || tile.char
        if (!charInfo.has(apiChar)) {
          charInfo.set(apiChar, {
            correctPositions: new Set(),
            absentPositions: new Set(),
            presentPositions: new Set(),
            absentRows: new Set(),
            correctRows: new Set(),
            presentRows: new Set(),
          })
        }
        const info = charInfo.get(apiChar)!
        if (tile.state === 'correct') {
          info.correctPositions.add(colIdx)
          info.correctRows.add(rowIdx)
        } else if (tile.state === 'absent') {
          info.absentPositions.add(colIdx)
          info.absentRows.add(rowIdx)
        } else if (tile.state === 'present') {
          info.presentPositions.add(colIdx)
          info.presentRows.add(rowIdx)
        }
      })
    })

    charInfo.forEach((info, char) => {
      const displayChar = API_TO_DISPLAY[char] || char

      // Hard conflict: same char is both correct AND absent at the SAME position
      for (const pos of info.correctPositions) {
        if (info.absentPositions.has(pos)) {
          conflicts.push({
            type: 'hard',
            char: displayChar,
            message: `"${displayChar}" is both correct and absent at position ${pos + 1}`,
          })
        }
      }

      // Soft warning: char is absent in one row but correct in another at a different position
      // (and absent row doesn't have the char as correct/present elsewhere)
      if (info.absentRows.size > 0 && info.correctRows.size > 0) {
        // Check if absent row also has this char as correct/present
        for (const absentRowIdx of info.absentRows) {
          const row = rows[absentRowIdx]
          const hasCorrectOrPresentInRow = row.some(tile => {
            const apiChar2 = DISPLAY_TO_API[tile.char] || tile.char
            return apiChar2 === char && (tile.state === 'correct' || tile.state === 'present')
          })
          if (!hasCorrectOrPresentInRow) {
            conflicts.push({
              type: 'soft',
              char: displayChar,
              message: `"${displayChar}" is absent in row ${absentRowIdx + 1} but correct elsewhere \u2014 may eliminate valid solutions`,
            })
          }
        }
      }
    })

    return conflicts
  }, [rows])

  // ─── Keyboard Key State Indicator (Feature 2) ─────────────────────────────

  const keyboardKeyStates = useMemo((): Map<string, TileState> => {
    const keyStates = new Map<string, TileState>()

    rows.forEach(row => {
      row.forEach(tile => {
        if (!tile.char) return
        const key = tile.char
        const currentState = keyStates.get(key)

        // Priority: correct > present > absent > unknown
        if (tile.state === 'correct') {
          keyStates.set(key, 'correct')
        } else if (tile.state === 'present' && currentState !== 'correct') {
          keyStates.set(key, 'present')
        } else if (tile.state === 'absent' && currentState !== 'correct' && currentState !== 'present') {
          keyStates.set(key, 'absent')
        } else if (!currentState) {
          keyStates.set(key, 'empty')
        }
      })
    })

    return keyStates
  }, [rows])

  // ─── Smart Hints ───────────────────────────────────────────────────────────

  const smartHints = useMemo((): SmartHint[] => {
    if (!solveResult || solveResult.results.length <= 1 || !solveResult.char_probabilities.length) return []

    const correctPositions = new Set<number>()
    rows.forEach(row => {
      row.forEach((tile, colIdx) => {
        if (tile.state === 'correct' && tile.char) {
          correctPositions.add(colIdx)
        }
      })
    })

    const fullyConstrainedChars = new Set<string>()
    rows.forEach(row => {
      row.forEach(tile => {
        if (tile.state === 'correct' && tile.char) {
          fullyConstrainedChars.add(DISPLAY_TO_API[tile.char] || tile.char)
        }
      })
    })

    const hints: SmartHint[] = []
    for (const cp of solveResult.char_probabilities) {
      if (cp.probability < 5) continue
      const displayChar = API_TO_DISPLAY[cp.char] || cp.char
      const isFullyConstrained = fullyConstrainedChars.has(cp.char)

      if (!isFullyConstrained) {
        for (let pos = 0; pos < expressionLength; pos++) {
          if (correctPositions.has(pos)) continue
          const hasConstraintAtPos = rows.some(row =>
            row[pos]?.state === 'correct' && row[pos]?.char !== ''
          )
          if (hasConstraintAtPos) continue
          hints.push({
            char: cp.char,
            displayChar,
            position: pos,
            probability: cp.probability,
          })
          break
        }
      }

      if (hints.length >= 3) break
    }

    return hints.sort((a, b) => b.probability - a.probability).slice(0, 3)
  }, [solveResult, rows, expressionLength])

  // ─── Download handlers ─────────────────────────────────────────────────────

  const handleDownload = useCallback((format: 'json' | 'txt' | 'csv') => {
    if (!solveResult) return

    let content: string
    let filename: string
    let mimeType: string

    if (format === 'json') {
      content = JSON.stringify(solveResult, null, 2)
      filename = `sumzle-results-${Date.now()}.json`
      mimeType = 'application/json'
    } else if (format === 'csv') {
      const header = '#,Expression,Type,Length'
      const rows = solveResult.results.map((expr, idx) =>
        `${idx + 1},"${formatExpression(expr)}",${getExpressionType(expr)},${expr.length}`
      )
      content = [header, ...rows].join('\n')
      filename = `sumzle-results-${Date.now()}.csv`
      mimeType = 'text/csv'
    } else {
      content = solveResult.results.map(formatExpression).join('\n')
      filename = `sumzle-results-${Date.now()}.txt`
      mimeType = 'text/plain'
    }

    const blob = new Blob([content], { type: mimeType })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    setShowDownloadMenu(false)
  }, [solveResult])

  // ─── Download All (Unlimited) ─────────────────────────────────────────────────

  const handleDownloadAllUnlimited = useCallback(async (format: 'txt' | 'csv' | 'json') => {
    if (!solveResult) return
    setDownloadingAll(true)
    setDownloadAllProgress('Re-solving without limit...')

    try {
      const apiRows = rows
        .filter(row => row.some(t => t.char !== ''))
        .map(row => row.map(tile => ({
          char: DISPLAY_TO_API[tile.char] || tile.char,
          state: tile.state === 'absent' ? 'empty' : tile.state,
        })))

      const body = {
        length: expressionLength,
        rows: apiRows.length > 0 ? apiRows : [Array(expressionLength).fill(null).map(() => ({ char: '', state: 'empty' }))],
        mode: 'parallel',
        num_threads: health?.parallel_threads || undefined,
        // No max_results = unlimited
      }

      setDownloadAllProgress('Calculating all results (this may take a while)...')

      const res = await fetch('/api/solve/parallel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      const text = await res.text()
      let data: Record<string, unknown>
      try {
        data = JSON.parse(text)
      } catch {
        throw new Error('Failed to parse solver response')
      }

      if (!res.ok || !data.success) {
        throw new Error((data.error as string) || 'Solve failed')
      }

      const result: SolveResult = data.data as SolveResult
      setDownloadAllProgress(`Processing ${result.results.length.toLocaleString()} results for download...`)

      let content: string
      let filename: string
      let mimeType: string

      if (format === 'json') {
        content = JSON.stringify(result, null, 2)
        filename = `sumzle-all-results-${Date.now()}.json`
        mimeType = 'application/json'
      } else if (format === 'csv') {
        const header = '#,Expression,Type,Length'
        const csvRows = result.results.map((expr, idx) =>
          `${idx + 1},"${formatExpression(expr)}",${getExpressionType(expr)},${expr.length}`
        )
        content = [header, ...csvRows].join('\n')
        filename = `sumzle-all-results-${Date.now()}.csv`
        mimeType = 'text/csv'
      } else {
        content = result.results.map(formatExpression).join('\n')
        filename = `sumzle-all-results-${Date.now()}.txt`
        mimeType = 'text/plain'
      }

      const blob = new Blob([content], { type: mimeType })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      setDownloadAllProgress(`Downloaded ${result.results.length.toLocaleString()} results!`)

      // Update solveResult with full results if they're more than current
      if (result.results.length > solveResult.results.length) {
        setSolveResult(result)
      }
    } catch (err) {
      setSolveError(`Download all failed: ${err instanceof Error ? err.message : 'Unknown error'}`)
    } finally {
      setTimeout(() => {
        setDownloadingAll(false)
        setDownloadAllProgress('')
      }, 2000)
    }
  }, [solveResult, rows, expressionLength, health])

  // ─── Recent solve speeds for bar chart ─────────────────────────────────────

  const recentSpeeds = useMemo(() => {
    return solveHistory.slice(0, 5).map(h => ({
      id: h.id,
      speed: h.speedPerSec,
      elapsed: h.elapsedMs,
      label: h.elapsedMs < 1000 ? `${h.elapsedMs.toFixed(0)}ms` : `${(h.elapsedMs / 1000).toFixed(1)}s`,
    }))
  }, [solveHistory])

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen flex flex-col bg-zinc-50 dark:bg-zinc-950 transition-colors duration-300 dark:[background-image:radial-gradient(circle_at_50%_0%,rgba(255,255,255,0.03),transparent_75%)]">
      <style>{`
        @keyframes shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
        @keyframes tileFlip {
          0% { transform: rotateY(0deg); }
          50% { transform: rotateY(90deg); }
          100% { transform: rotateY(0deg); }
        }
        @keyframes tileGlow {
          0%, 100% { box-shadow: 0 0 4px 1px rgba(16,185,129,0.3); }
          50% { box-shadow: 0 0 12px 4px rgba(16,185,129,0.6); }
        }
        @keyframes pulseRing {
          0%, 100% { box-shadow: 0 0 0 0 rgba(16,185,129,0.5); }
          50% { box-shadow: 0 0 0 6px rgba(16,185,129,0); }
        }
        @keyframes badgeFlash {
          0%, 100% { transform: scale(1); }
          25% { transform: scale(1.25); }
          50% { transform: scale(1.1); }
          75% { transform: scale(1.2); }
        }
        .tile-flip {
          animation: tileFlip 0.3s ease-in-out;
        }
        .tile-glow {
          animation: tileGlow 1.5s ease-in-out;
        }
        .pulse-ring {
          animation: pulseRing 1.5s ease-in-out infinite;
        }
        .badge-flash {
          animation: badgeFlash 0.6s ease-in-out;
        }
        /* Absent tile diagonal stripe pattern */
        .tile-absent-stripes {
          background-image: repeating-linear-gradient(
            -45deg,
            transparent,
            transparent 4px,
            rgba(0,0,0,0.06) 4px,
            rgba(0,0,0,0.06) 5px
          );
        }
        .dark .tile-absent-stripes {
          background-image: repeating-linear-gradient(
            -45deg,
            transparent,
            transparent 4px,
            rgba(255,255,255,0.04) 4px,
            rgba(255,255,255,0.04) 5px
          );
        }
        /* Noise texture for dark mode */
        .dark-noise::before {
          content: '';
          position: absolute;
          inset: 0;
          opacity: 0.015;
          pointer-events: none;
          background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E");
          background-repeat: repeat;
        }
        /* Keyboard key state indicators */
        .key-correct {
          border-bottom: 3px solid rgb(16, 185, 129) !important;
        }
        .key-present {
          border-bottom: 3px solid rgb(245, 158, 11) !important;
        }
        .key-absent {
          opacity: 0.5;
        }
        /* Animated progress bar shimmer */
        @keyframes progressShimmer {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(100%); }
        }
        .progress-shimmer {
          position: relative;
          overflow: hidden;
        }
        .progress-shimmer::after {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: linear-gradient(
            90deg,
            transparent,
            rgba(255,255,255,0.3),
            transparent
          );
          animation: progressShimmer 1.5s ease-in-out infinite;
        }
        /* Drag and drop styles */
        .drag-over-top {
          border-top: 2px solid rgb(16, 185, 129) !important;
        }
        .drag-over-bottom {
          border-bottom: 2px solid rgb(16, 185, 129) !important;
        }
        .dragging {
          opacity: 0.5;
        }
        /* Tile press effect */
        .tile-press:active {
          transform: scale(0.92);
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
              size="sm"
              onClick={resetSolver}
              className="h-7 px-2 text-xs text-zinc-500 hover:text-rose-500 focus-visible:ring-2 focus-visible:ring-rose-500"
              title="Reset solver (kills stuck process and restarts)"
            >
              <RefreshCw className="w-3 h-3 mr-1" /> Reset
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => setDarkMode(!darkMode)}
              className="rounded-full focus-visible:ring-2 focus-visible:ring-emerald-500"
              aria-label="Toggle dark/light theme"
              title="Toggle theme"
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
            <Card className="shadow-md shadow-zinc-200/50 dark:shadow-zinc-900/50 dark:bg-gradient-to-br dark:from-zinc-900 dark:to-zinc-950/80">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <MonitorSmartphone className="w-4 h-4 text-emerald-500" />
                  Puzzle Settings
                  {/* Undo/Redo buttons */}
                  <div className="ml-auto flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 focus-visible:ring-2 focus-visible:ring-emerald-500"
                      onClick={undo}
                      disabled={!canUndo}
                      title="Undo (Ctrl+Z)"
                    >
                      <Undo2 className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 focus-visible:ring-2 focus-visible:ring-emerald-500"
                      onClick={redo}
                      disabled={!canRedo}
                      title="Redo (Ctrl+Y)"
                    >
                      <Redo2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center gap-4">
                  <label className="text-sm font-medium whitespace-nowrap">Expression Length</label>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8 focus-visible:ring-2 focus-visible:ring-emerald-500"
                      onClick={() => handleLengthChange(String(expressionLength - 1))}
                      disabled={expressionLength <= MIN_LENGTH}
                    >
                      &minus;
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
                      className="h-8 w-8 focus-visible:ring-2 focus-visible:ring-emerald-500"
                      onClick={() => handleLengthChange(String(expressionLength + 1))}
                      disabled={expressionLength >= MAX_LENGTH}
                    >
                      +
                    </Button>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={addRow} disabled={rows.length >= MAX_ROWS || solving} className="focus-visible:ring-2 focus-visible:ring-emerald-500" title="Add a new constraint row">
                    <Plus className="w-3.5 h-3.5 mr-1" /> Add Row
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setShowImport(!showImport)} disabled={solving} className="focus-visible:ring-2 focus-visible:ring-emerald-500" title="Import puzzle from JSON">
                    <Upload className="w-3.5 h-3.5 mr-1" /> Import
                  </Button>
                  <Button variant="outline" size="sm" onClick={copyState} className="focus-visible:ring-2 focus-visible:ring-emerald-500" title="Copy game state as JSON to clipboard">
                    {copied ? <Check className="w-3.5 h-3.5 mr-1" /> : <Copy className="w-3.5 h-3.5 mr-1" />}
                    {copied ? 'Copied!' : 'Export'}
                  </Button>
                  <Button variant="outline" size="sm" onClick={sharePuzzle} className="focus-visible:ring-2 focus-visible:ring-emerald-500" title="Share puzzle via URL link">
                    {shareCopied ? <Check className="w-3.5 h-3.5 mr-1" /> : <Share2 className="w-3.5 h-3.5 mr-1" />}
                    {shareCopied ? 'Link Copied!' : 'Share'}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setShowDistributed(!showDistributed)} className="focus-visible:ring-2 focus-visible:ring-emerald-500" title="Manage distributed worker nodes">
                    <Network className="w-3.5 h-3.5 mr-1" /> Workers
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setShowHistory(!showHistory)} className="relative focus-visible:ring-2 focus-visible:ring-emerald-500" title="View recent solve history">
                    <History className="w-3.5 h-3.5 mr-1" /> History
                    {solveHistory.length > 0 && (
                      <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-emerald-500 text-white text-[9px] flex items-center justify-center font-bold">
                        {solveHistory.length}
                      </span>
                    )}
                  </Button>
                  <Button variant="outline" size="sm" onClick={clearAll} disabled={solving} className="text-zinc-500 focus-visible:ring-2 focus-visible:ring-emerald-500" title="Clear all constraints and reset">
                    <RefreshCw className="w-3.5 h-3.5 mr-1" /> Clear
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Presets */}
            <div className="flex flex-wrap gap-1.5">
              <span className="text-xs text-zinc-500 dark:text-zinc-400 self-center mr-1">Presets:</span>
              <Button variant="outline" size="sm" className="h-7 text-xs focus-visible:ring-2 focus-visible:ring-emerald-500" onClick={() => {
                const newRows: Tile[][] = [[{char:'1',state:'correct'},{char:'+',state:'correct'},{char:'1',state:'correct'},{char:'=',state:'correct'},{char:'2',state:'correct'}]]
                setExpressionLength(5)
                updateRowLengths(5)
                setRows(newRows)
                pushHistory(newRows)
                setSelectedCell(null)
                setSolveResult(null)
              }}>
                1+1=2
              </Button>
              <Button variant="outline" size="sm" className="h-7 text-xs focus-visible:ring-2 focus-visible:ring-emerald-500" onClick={() => {
                const newRows: Tile[][] = [[{char:'1',state:'correct'},{char:'+',state:'correct'},{char:'1',state:'correct'},{char:'=',state:'correct'},{char:'2',state:'correct'}]]
                setExpressionLength(6)
                updateRowLengths(6)
                setRows(newRows)
                pushHistory(newRows)
                setSelectedCell(null)
                setSolveResult(null)
              }}>
                Starter Len 6
              </Button>
              <Button variant="outline" size="sm" className="h-7 text-xs focus-visible:ring-2 focus-visible:ring-emerald-500" onClick={() => {
                const newRows: Tile[][] = [
                  [{char:'1',state:'correct'},{char:'2',state:'present'},{char:'+',state:'correct'},{char:'3',state:'absent'},{char:'=',state:'correct'},{char:'5',state:'correct'},{char:'',state:'empty'},{char:'',state:'empty'}],
                  [{char:'2',state:'present'},{char:'\u00d7',state:'correct'},{char:'3',state:'correct'},{char:'=',state:'correct'},{char:'6',state:'correct'},{char:'',state:'empty'},{char:'',state:'empty'},{char:'',state:'empty'}],
                ]
                setExpressionLength(8)
                updateRowLengths(8)
                setRows(newRows)
                pushHistory(newRows)
                setSelectedCell(null)
                setSolveResult(null)
              }}>
                Hard Mode
              </Button>
              <Button variant="outline" size="sm" className="h-7 text-xs focus-visible:ring-2 focus-visible:ring-emerald-500" onClick={() => {
                const clearedRows: Tile[][] = [createEmptyRow(6)]
                setExpressionLength(6)
                updateRowLengths(6)
                setRows(clearedRows)
                pushHistory(clearedRows)
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
              <Card className="animate-in slide-in-from-top-2 duration-200 shadow-md shadow-zinc-200/50 dark:shadow-zinc-900/50">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">Import Game State</CardTitle>
                    <Button variant="ghost" size="icon" className="h-6 w-6 focus-visible:ring-2 focus-visible:ring-emerald-500" onClick={() => setShowImport(false)}>
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
                  <Button size="sm" onClick={handleImport} disabled={!importText.trim()} className="focus-visible:ring-2 focus-visible:ring-emerald-500">
                    <Upload className="w-3.5 h-3.5 mr-1" /> Import
                  </Button>
                </CardContent>
              </Card>
            )}

            {/* Solve History Panel */}
            {showHistory && (
              <Card className="animate-in slide-in-from-top-2 duration-200 shadow-md shadow-zinc-200/50 dark:shadow-zinc-900/50">
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
                      <Button variant="ghost" size="icon" className="h-6 w-6 focus-visible:ring-2 focus-visible:ring-emerald-500" onClick={() => setShowHistory(false)}>
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
                              {entry.speedPerSec > 0 && (
                                <span className="text-zinc-400">
                                  {formatSpeed(entry.speedPerSec)}
                                </span>
                              )}
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
              <Card className="animate-in slide-in-from-top-2 duration-200 shadow-md shadow-zinc-200/50 dark:shadow-zinc-900/50">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Server className="w-4 h-4 text-teal-500" />
                      Distributed Workers
                    </CardTitle>
                    <Button variant="ghost" size="icon" className="h-6 w-6 focus-visible:ring-2 focus-visible:ring-emerald-500" onClick={() => setShowDistributed(false)}>
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
                    <Button size="sm" onClick={addWorker} disabled={!workerAddress.trim()} className="focus-visible:ring-2 focus-visible:ring-emerald-500">
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
                          <Button variant="ghost" size="icon" className="h-6 w-6 focus-visible:ring-2 focus-visible:ring-emerald-500" onClick={() => removeWorker(w.id)}>
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
            <Card className="shadow-md shadow-zinc-200/50 dark:shadow-zinc-900/50 dark:bg-gradient-to-br dark:from-zinc-900 dark:to-zinc-950/80">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Activity className="w-4 h-4 text-emerald-500" />
                    Constraint Board
                  </CardTitle>
                  {/* Conflict warning badges */}
                  {constraintConflicts.length > 0 && (
                    <Badge className="bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400 border-red-200 dark:border-red-800 text-[10px] px-1.5 py-0">
                      <AlertTriangle className="w-3 h-3 mr-1" />
                      {constraintConflicts.filter(c => c.type === 'hard').length} conflict{constraintConflicts.filter(c => c.type === 'hard').length !== 1 ? 's' : ''}
                    </Badge>
                  )}
                </div>
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
                      className={`px-2 py-0.5 rounded-lg border text-xs font-medium ${STATE_COLORS[s]} ${s === 'absent' ? 'tile-absent-stripes' : ''}`}
                    >
                      {STATE_LABELS[s]}
                    </span>
                  ))}
                </div>

                {/* Rows */}
                <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1" ref={boardRef}>
                  {rows.map((row, rowIdx) => (
                    <div
                      key={rowIdx}
                      className={`flex items-center gap-1.5 transition-all duration-150 ${
                        dragSourceRow === rowIdx ? 'dragging' : ''
                      } ${
                        dragOverRow !== null && dragOverRow !== dragSourceRow
                          ? dragOverRow === rowIdx && dragSourceRow !== null && dragSourceRow < rowIdx ? 'drag-over-bottom'
                            : dragOverRow === rowIdx && dragSourceRow !== null && dragSourceRow > rowIdx ? 'drag-over-top'
                            : ''
                          : ''
                      }`}
                      draggable
                      onDragStart={() => handleDragStart(rowIdx)}
                      onDragOver={(e) => handleDragOver(e, rowIdx)}
                      onDragEnd={handleDragEnd}
                    >
                      {/* Drag handle */}
                      <button
                        className="cursor-grab active:cursor-grabbing p-0.5 text-zinc-300 hover:text-zinc-500 dark:text-zinc-600 dark:hover:text-zinc-400 shrink-0 focus-visible:ring-2 focus-visible:ring-emerald-500"
                        title="Drag to reorder row"
                        aria-label="Drag handle for row ${rowIdx + 1}"
                      >
                        <GripVertical className="w-3.5 h-3.5" />
                      </button>
                      <span className="text-xs text-zinc-400 w-4 text-right shrink-0 font-medium">{rowIdx + 1}</span>
                      <div className="flex gap-0.5">
                        {row.map((tile, colIdx) => {
                          const isSelected = selectedCell?.row === rowIdx && selectedCell?.col === colIdx
                          const tileKey = `${rowIdx}-${colIdx}`
                          const isPopping = poppingTile === tileKey
                          const isFlipping = flippingTile === tileKey
                          const isRecommended = solveResult?.recommended &&
                            tile.state === 'correct' &&
                            colIdx < solveResult.recommended.length &&
                            (DISPLAY_TO_API[tile.char] || tile.char) === solveResult.recommended[colIdx]
                          const isAbsent = tile.state === 'absent'

                          return (
                            <button
                              key={colIdx}
                              className={`
                                w-10 h-10 sm:w-11 sm:h-11 rounded-lg border-2 font-mono font-bold text-lg
                                flex items-center justify-center transition-all duration-150 select-none
                                relative overflow-hidden
                                ${STATE_COLORS[tile.state]}
                                ${isAbsent ? 'tile-absent-stripes opacity-90' : ''}
                                ${isSelected ? 'ring-2 ring-emerald-500 ring-offset-1 dark:ring-offset-zinc-900 shadow-md pulse-ring' : ''}
                                ${isPopping ? 'scale-110' : ''}
                                ${isFlipping ? 'tile-flip' : ''}
                                ${isRecommended ? 'tile-glow' : ''}
                                hover:scale-105 active:scale-95 tile-press
                              `}
                              style={{ perspective: '400px', transformStyle: 'preserve-3d' }}
                              onClick={(e) => handleTileClick(rowIdx, colIdx, e)}
                              onContextMenu={(e) => handleTileContextMenu(e, rowIdx, colIdx)}
                              title={`Position ${colIdx + 1}`}
                              aria-label={`Row ${rowIdx + 1} Column ${colIdx + 1}: ${tile.char || 'empty'}, ${tile.state}`}
                            >
                              {tile.char ? (API_TO_DISPLAY[tile.char] || tile.char) : ''}
                              {/* Absent tile watermark */}
                              {isAbsent && (
                                <span className="absolute inset-0 flex items-center justify-center text-2xl font-bold opacity-[0.08] pointer-events-none select-none" aria-hidden="true">
                                  {'\u2715'}
                                </span>
                              )}
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
                          className="h-7 w-7 focus-visible:ring-2 focus-visible:ring-emerald-500"
                          onClick={() => clearRow(rowIdx)}
                          title="Clear row"
                        >
                          <RefreshCw className="w-3 h-3" />
                        </Button>
                        {rows.length > 1 && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-zinc-400 hover:text-red-500 focus-visible:ring-2 focus-visible:ring-emerald-500"
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

            {/* Constraint Conflict Warnings (Feature 3) */}
            {constraintConflicts.length > 0 && (
              <div className="space-y-1.5">
                {constraintConflicts.map((conflict, i) => (
                  <div
                    key={i}
                    className={`flex items-start gap-2 p-2.5 rounded-lg border ${
                      conflict.type === 'hard'
                        ? 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800'
                        : 'bg-amber-50 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800'
                    }`}
                  >
                    <AlertTriangle className={`w-4 h-4 shrink-0 mt-0.5 ${
                      conflict.type === 'hard' ? 'text-red-500' : 'text-amber-500'
                    }`} />
                    <p className={`text-xs ${
                      conflict.type === 'hard' ? 'text-red-700 dark:text-red-400' : 'text-amber-700 dark:text-amber-400'
                    }`}>
                      {conflict.message}
                    </p>
                  </div>
                ))}
              </div>
            )}

            {/* Constraint Summary Bar */}
            {(() => {
              const { locked, excluded, hinted } = constraintSummary
              const hasAnyConstraints = locked.size > 0 || excluded.size > 0 || hinted.size > 0
              if (!hasAnyConstraints) return null

              return (
                <div className="p-3 rounded-xl bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 shadow-md shadow-zinc-200/50 dark:shadow-zinc-900/50">
                  <div className="flex items-center gap-2 mb-2">
                    <Target className="w-3.5 h-3.5 text-emerald-500" />
                    <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Constraints</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {Array.from(locked.entries()).map(([char, positions]) => (
                      <span
                        key={`lock-${char}`}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-mono font-bold bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800"
                      >
                        {'\ud83d\udfe9'} {API_TO_DISPLAY[char] || char}<sub className="text-[9px] font-normal">{positions.map(p => p + 1).join(',')}</sub>
                      </span>
                    ))}
                    {Array.from(hinted.entries()).map(([char, positions]) => (
                      <span
                        key={`hint-${char}`}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-mono font-bold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400 border border-amber-200 dark:border-amber-800"
                      >
                        {'\ud83d\udfe8'} {API_TO_DISPLAY[char] || char}<sub className="text-[9px] font-normal">{'\u2260'}{positions.map(p => p + 1).join(',')}</sub>
                      </span>
                    ))}
                    {Array.from(excluded).map((char) => (
                      <span
                        key={`excl-${char}`}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-mono font-bold bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400 border border-zinc-200 dark:border-zinc-700"
                      >
                        {'\u2b1b'} {API_TO_DISPLAY[char] || char}
                      </span>
                    ))}
                  </div>
                </div>
              )
            })()}

            {/* Keyboard */}
            <Card className="shadow-md shadow-zinc-200/50 dark:shadow-zinc-900/50 dark:bg-gradient-to-br dark:from-zinc-900 dark:to-zinc-950/80">
              <CardContent className="pt-5">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs text-zinc-500 dark:text-zinc-400">On-Screen Keyboard</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 focus-visible:ring-2 focus-visible:ring-emerald-500"
                    onClick={() => setShowShortcuts(!showShortcuts)}
                    title="Keyboard shortcuts"
                  >
                    <HelpCircle className="w-3.5 h-3.5 text-zinc-400" />
                  </Button>
                </div>
                {showShortcuts && (
                  <div className="mb-2 p-2 rounded-lg bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 text-xs text-zinc-600 dark:text-zinc-400 animate-in slide-in-from-top-1 duration-150 space-y-1">
                    <div>{'\u2190\u2192'} Navigate | {'\u2191\u2193'} Row | {'\u232b'} Delete | Esc Deselect | Click: Select/Cycle</div>
                    <div className="text-emerald-600 dark:text-emerald-400 font-medium">{'\u2318\u21b5'} / Ctrl+Enter: Solve | {'\u2318'}E / Ctrl+E: Export | Ctrl+Z/Y: Undo/Redo</div>
                  </div>
                )}
                <div className="space-y-1.5">
                  {KEYBOARD_CHARS.map((line, lineIdx) => (
                    <div key={lineIdx} className="flex justify-center gap-1 p-1.5 rounded-lg bg-zinc-50/50 dark:bg-zinc-800/30 border border-zinc-100 dark:border-zinc-800/50">
                      {line.map((key) => {
                        const keyState = keyboardKeyStates.get(key)
                        const stateClass = keyState === 'correct'
                          ? 'key-correct'
                          : keyState === 'present'
                            ? 'key-present'
                            : keyState === 'absent'
                              ? 'key-absent'
                              : ''

                        return (
                          <Button
                            key={key}
                            variant="outline"
                            size="sm"
                            className={`
                              h-9 w-9 sm:h-10 sm:w-10 font-mono font-bold text-sm p-0 transition-all duration-100 focus-visible:ring-2 focus-visible:ring-emerald-500
                              ${key === '\u232b' ? 'bg-zinc-100 dark:bg-zinc-800 col-span-1' : ''}
                              ${stateClass}
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
                        )
                      })}
                    </div>
                  ))}
                </div>
                {selectedCell && (
                  <p className="text-xs text-zinc-400 mt-2 text-center">
                    Selected: Row {selectedCell.row + 1}, Col {selectedCell.col + 1} {'\u2014'} Type or use keyboard
                  </p>
                )}
                {!selectedCell && (
                  <p className="text-xs text-amber-500 dark:text-amber-400 mt-2 text-center">
                    Click a tile on the board to start typing
                  </p>
                )}
                {/* Hidden input for mobile keyboard auto-open */}
                <input
                  ref={mobileInputRef}
                  type="text"
                  inputMode="none"
                  className="absolute w-0 h-0 opacity-0 overflow-hidden"
                  aria-hidden="true"
                  tabIndex={-1}
                  onKeyDown={(e) => {
                    // Forward mobile keyboard input to the handler
                    const target = e.target as HTMLElement
                    if (target === mobileInputRef.current && selectedCell) {
                      // Let the global keydown handler take care of it
                      e.preventDefault()
                      e.stopPropagation()
                    }
                  }}
                />
              </CardContent>
            </Card>

            {/* Constraint validation warnings */}
            {(() => {
              if (solving) return null
              const warnings: string[] = []
              const hasEqualsInAnyRow = rows.some(row => row.some(t => t.char === '='))
              const hasAnyConstraints = rows.some(row => row.some(t => t.char !== ''))
              const constraintCount = rows.reduce((acc, row) => acc + row.filter(t => t.char !== '').length, 0)
              if (hasAnyConstraints && !hasEqualsInAnyRow) {
                warnings.push('No "=" found in constraints. Results may be very large.')
              }
              if (!hasAnyConstraints && expressionLength < 5) {
                warnings.push('Short expression with no constraints will return many results.')
              }
              // Complexity warnings for long expressions
              if (expressionLength >= 8 && constraintCount < 3) {
                warnings.push(`Length ${expressionLength} with few constraints may take a very long time (60+ seconds). Add more constraints to speed up the search.`)
              } else if (expressionLength >= 7 && !hasAnyConstraints) {
                warnings.push(`Length ${expressionLength} with no constraints will take a long time. Consider adding at least one row of constraints.`)
              }
              if (expressionLength >= 9) {
                warnings.push('Expressions of length 9+ have an enormous search space. The solver may time out or run out of memory.')
              }
              return warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800">
                  <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-700 dark:text-amber-400">{w}</p>
                </div>
              ))
            })()}

            {/* Gradient divider before solve button */}
            <div className="h-px bg-gradient-to-r from-transparent via-emerald-500/40 to-transparent" />

            {/* Result Count Estimation */}
            {estimatedResultCount && !solving && (
              <div className="flex items-center justify-center gap-1.5 -mb-2">
                <Hash className="w-3 h-3 text-zinc-400" />
                <span className="text-xs text-zinc-400">{estimatedResultCount} expected</span>
              </div>
            )}

            {/* Solve Button - with gradient border effect + shortcut badge */}
            <div className="relative group lg:static sticky bottom-4 z-40">
              <div className="absolute -inset-0.5 bg-gradient-to-r from-emerald-400 via-teal-400 to-cyan-400 rounded-xl opacity-60 group-hover:opacity-100 blur-sm transition-opacity duration-300 bg-[length:200%_100%] animate-[shimmer_3s_ease-in-out_infinite]" />
              <Button
                className="relative w-full h-12 text-base font-bold bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-600 hover:from-emerald-600 hover:via-teal-600 hover:to-emerald-700 text-white shadow-lg shadow-emerald-500/20 transition-all duration-200 hover:shadow-xl hover:shadow-emerald-500/30 rounded-xl focus-visible:ring-2 focus-visible:ring-emerald-500"
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
                    <span className="ml-2 text-xs opacity-70 font-normal hidden sm:inline">{'\u2318\u21b5'}</span>
                  </>
                )}
              </Button>
            </div>

            {/* Solve Error */}
            {solveError && (
              <Card className="border-red-300 dark:border-red-800 animate-in slide-in-from-top-2 duration-200 shadow-md shadow-red-200/50 dark:shadow-red-900/30">
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
              <Card className="shadow-md shadow-zinc-200/50 dark:shadow-zinc-900/50 dark:bg-gradient-to-br dark:from-zinc-900 dark:to-zinc-950/80">
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
                    <>
                      {/* Speed gauge */}
                      <div className="mt-3 space-y-2">
                        <div className="flex items-center justify-between p-2.5 rounded-xl bg-gradient-to-r from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/30 border border-emerald-100 dark:border-emerald-900/50">
                          <span className="text-sm font-medium flex items-center gap-1.5">
                            <Sparkles className="w-3.5 h-3.5 text-emerald-500" />
                            Solve Speed
                          </span>
                          <span className="text-sm font-bold text-emerald-600 dark:text-emerald-400">
                            {formatSpeed(solveResult.speed_per_sec)}
                          </span>
                        </div>
                        {/* Speed gauge visual */}
                        <div className="px-1">
                          <div className="h-3 rounded-full bg-zinc-100 dark:bg-zinc-800 overflow-hidden">
                            <div
                              className="h-full rounded-full bg-gradient-to-r from-emerald-400 via-teal-500 to-cyan-500 transition-all duration-1000 ease-out"
                              style={{ width: `${Math.min(100, (solveResult.speed_per_sec / 2000000) * 100)}%` }}
                            />
                          </div>
                          <div className="flex justify-between text-[9px] text-zinc-400 mt-0.5">
                            <span>0</span>
                            <span>1M/s</span>
                            <span>2M/s</span>
                          </div>
                        </div>
                        {/* Expressions/ms */}
                        <div className="flex items-center justify-between text-xs text-zinc-500 dark:text-zinc-400 px-1">
                          <span className="flex items-center gap-1">
                            <TrendingUp className="w-3 h-3" />
                            Throughput
                          </span>
                          <span className="font-mono font-bold text-teal-600 dark:text-teal-400">
                            {(solveResult.speed_per_sec / 1000).toFixed(1)}K expr/ms
                          </span>
                        </div>
                      </div>
                      {/* Recent solve speeds bar chart */}
                      {recentSpeeds.length > 1 && (
                        <div className="mt-3 p-2.5 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-100 dark:border-zinc-800">
                          <div className="flex items-center justify-between mb-2">
                            <span className="text-[10px] text-zinc-500 uppercase tracking-wider flex items-center gap-1">
                              <BarChart3 className="w-3 h-3" /> Recent Solves
                            </span>
                          </div>
                          <div className="flex items-end gap-1.5 h-12">
                            {[...recentSpeeds].reverse().map((s) => {
                              const maxSpeed = Math.max(...recentSpeeds.map(r => r.speed), 1)
                              const height = Math.max(8, (s.speed / maxSpeed) * 100)
                              return (
                                <div key={s.id} className="flex-1 flex flex-col items-center gap-0.5">
                                  <span className="text-[8px] text-zinc-400 font-mono">{s.label}</span>
                                  <div
                                    className="w-full rounded-sm bg-gradient-to-t from-emerald-500 to-teal-400 dark:from-emerald-600 dark:to-teal-500 transition-all duration-500"
                                    style={{ height: `${height}%` }}
                                    title={`${formatSpeed(s.speed)}`}
                                  />
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )}
                    </>
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
              <Card className="animate-in slide-in-from-top-2 duration-200 shadow-md shadow-emerald-200/30 dark:shadow-emerald-900/30">
                <CardContent className="pt-5 space-y-3">
                  <div className="flex items-center gap-2">
                    <RefreshCw className="w-4 h-4 animate-spin text-emerald-500" />
                    <span className="text-sm font-medium">Rust engine solving... {(solveTimerMs / 1000).toFixed(1)}s</span>
                  </div>
                  {/* Animated shimmer progress bar */}
                  <div className="h-3 rounded-full bg-gradient-to-r from-emerald-200 via-teal-200 to-cyan-200 dark:from-emerald-900 dark:via-teal-900 dark:to-cyan-900 progress-shimmer">
                    <div className="h-full rounded-full bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500 transition-all duration-300" style={{ width: '100%' }} />
                  </div>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400">
                    Parallel search across {health?.parallel_threads || 4} threads
                  </p>
                </CardContent>
              </Card>
            )}

            {/* Results */}
            {solveResult && (
              <Card className="animate-in slide-in-from-bottom-4 duration-500 shadow-md shadow-zinc-200/50 dark:shadow-zinc-900/50 dark:bg-gradient-to-br dark:from-zinc-900 dark:to-zinc-950/80">
                <CardHeader className="pb-3">
                  <div className="flex items-center gap-2">
                    <Trophy className="w-4 h-4 text-amber-500" />
                    <CardTitle className="text-base">Results</CardTitle>
                    <Badge
                      variant="secondary"
                      className={`ml-auto relative ${celebrating ? 'animate-bounce' : ''} ${resultBadgeFlash ? 'badge-flash' : ''}`}
                    >
                      {`${solveResult.results.length.toLocaleString()} found`}
                      {celebrating && (
                        <span className="absolute -top-2 -right-2 text-sm">{'\u2728'}</span>
                      )}
                    </Badge>
                  </div>
                  {solveResult.results.length > MAX_DISPLAY_RESULTS && (
                    <div className="space-y-2 mt-1">
                      <div className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center justify-between">
                        <span className="flex items-center gap-1">
                          <Download className="w-3 h-3" />
                          {solveResult.results.length.toLocaleString()} solutions available for download
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 text-[10px] px-2 text-emerald-600 dark:text-emerald-400 border-emerald-300 dark:border-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950/20 focus-visible:ring-2 focus-visible:ring-emerald-500"
                          onClick={() => handleDownload('txt')}
                        >
                          <Download className="w-2.5 h-2.5 mr-1" /> Download current
                        </Button>
                      </div>
                      {solveResult.results.length >= MAX_RESULTS_SAFE_CAP && (
                        <div className="flex items-center gap-2 p-2 rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800">
                          <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                          <div className="flex-1 text-xs text-amber-700 dark:text-amber-400">
                            <span className="font-semibold">Results capped at {MAX_RESULTS_SAFE_CAP.toLocaleString()}</span> — more may exist. Use &ldquo;Download All&rdquo; to get every result (may take longer).
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 text-[10px] px-2 text-amber-700 dark:text-amber-400 border-amber-300 dark:border-amber-700 hover:bg-amber-100 dark:hover:bg-amber-950/30 shrink-0 focus-visible:ring-2 focus-visible:ring-amber-500"
                            onClick={() => handleDownloadAllUnlimited('txt')}
                            disabled={downloadingAll}
                          >
                            {downloadingAll ? <RefreshCw className="w-2.5 h-2.5 mr-1 animate-spin" /> : <Download className="w-2.5 h-2.5 mr-1" />}
                            Download All (unlimited)
                          </Button>
                        </div>
                      )}
                      {downloadingAll && downloadAllProgress && (
                        <div className="flex items-center gap-2 p-2 rounded-lg bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200 dark:border-emerald-800">
                          <RefreshCw className="w-3.5 h-3.5 text-emerald-500 animate-spin shrink-0" />
                          <span className="text-xs text-emerald-700 dark:text-emerald-400">{downloadAllProgress}</span>
                        </div>
                      )}
                    </div>
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
                      {/* Unique solution banner */}
                      {solveResult.results.length === 1 && (
                        <div className="mb-3 p-3 rounded-xl bg-gradient-to-r from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/30 border border-emerald-200 dark:border-emerald-800 text-center animate-in zoom-in-50 duration-300">
                          <span className="text-2xl mb-1 block">{'\ud83c\udf89'}</span>
                          <p className="text-sm font-bold text-emerald-700 dark:text-emerald-400">Unique Solution Found!</p>
                          <code className="text-lg font-mono font-black text-emerald-600 dark:text-emerald-300 tracking-widest">
                            {formatExpression(solveResult.results[0])}
                          </code>
                        </div>
                      )}

                      {/* No results helpful message */}
                      {solveResult.results.length === 0 && (
                        <div className="mb-3 p-4 rounded-xl bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700 text-center">
                          <span className="text-2xl mb-2 block">{'\ud83d\udd0d'}</span>
                          <p className="text-sm font-semibold text-zinc-700 dark:text-zinc-300 mb-2">No solutions found</p>
                          <div className="space-y-1 text-xs text-zinc-500 dark:text-zinc-400">
                            <p>Try these to find results:</p>
                            <p className="flex items-center justify-center gap-1">
                              <ArrowRight className="w-3 h-3" /> Remove or change an absent constraint
                            </p>
                            <p className="flex items-center justify-center gap-1">
                              <ArrowRight className="w-3 h-3" /> Check if the &ldquo;=&rdquo; position is correct
                            </p>
                            <p className="flex items-center justify-center gap-1">
                              <ArrowRight className="w-3 h-3" /> Try changing a &ldquo;present&rdquo; to &ldquo;absent&rdquo;
                            </p>
                          </div>
                        </div>
                      )}

                      {solveResult.results.length > 1 && (
                        <div className="space-y-2 mt-2">
                          {/* Search/Filter + Sort + Download */}
                          <div className="flex gap-2">
                            <div className="relative flex-1">
                              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-zinc-400" />
                              <Input
                                placeholder="Filter solutions... (e.g. 1+2=3)"
                                value={resultFilter}
                                onChange={(e) => setResultFilter(e.target.value)}
                                className="h-8 text-sm pl-8 pr-8 focus-visible:ring-2 focus-visible:ring-emerald-500"
                              />
                              {resultFilter && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="absolute right-0.5 top-1/2 -translate-y-1/2 h-7 w-7 focus-visible:ring-2 focus-visible:ring-emerald-500"
                                  onClick={() => setResultFilter('')}
                                >
                                  <X className="w-3 h-3" />
                                </Button>
                              )}
                            </div>
                            <select
                              className="h-8 text-xs border border-zinc-200 dark:border-zinc-700 rounded-md bg-white dark:bg-zinc-800 px-2 text-zinc-600 dark:text-zinc-400 focus-visible:ring-2 focus-visible:ring-emerald-500"
                              value={resultSort}
                              onChange={(e) => setResultSort(e.target.value as typeof resultSort)}
                            >
                              <option value="default">Default</option>
                              <option value="az">A{'\u2192'}Z</option>
                              <option value="za">Z{'\u2192'}A</option>
                              <option value="shortest">Shortest</option>
                              <option value="longest">Longest</option>
                            </select>
                            {/* Download button */}
                            <div className="relative" ref={downloadMenuRef}>
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 px-2 focus-visible:ring-2 focus-visible:ring-emerald-500"
                                onClick={() => setShowDownloadMenu(!showDownloadMenu)}
                                title={`Download ${solveResult.results.length.toLocaleString()} results`}
                              >
                                <Download className="w-3.5 h-3.5" />
                              </Button>
                              {showDownloadMenu && (
                                <div className="absolute right-0 top-full mt-1 w-52 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg z-50 animate-in slide-in-from-top-1 duration-150">
                                  <div className="px-3 py-1.5 text-[10px] text-zinc-400 border-b border-zinc-100 dark:border-zinc-700 font-medium">
                                    Download {solveResult.results.length.toLocaleString()} results
                                  </div>
                                  <button
                                    className="w-full text-left px-3 py-2 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors focus-visible:ring-2 focus-visible:ring-emerald-500"
                                    onClick={() => handleDownload('json')}
                                  >
                                    {'\ud83d\udcc4'} JSON (full data)
                                  </button>
                                  <button
                                    className="w-full text-left px-3 py-2 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors focus-visible:ring-2 focus-visible:ring-emerald-500"
                                    onClick={() => handleDownload('csv')}
                                  >
                                    {'\ud83d\udcca'} CSV (spreadsheet)
                                  </button>
                                  <button
                                    className="w-full text-left px-3 py-2 text-xs hover:bg-zinc-100 dark:hover:bg-zinc-700 transition-colors focus-visible:ring-2 focus-visible:ring-emerald-500"
                                    onClick={() => handleDownload('txt')}
                                  >
                                    {'\ud83d\udcdd'} Plain text (list)
                                  </button>
                                  {solveResult.results.length >= MAX_RESULTS_SAFE_CAP && (
                                    <>
                                      <div className="border-t border-zinc-100 dark:border-zinc-700 my-0.5" />
                                      <div className="px-3 py-1 text-[9px] text-amber-500 font-medium uppercase tracking-wider">
                                        Unlimited (re-solve)
                                      </div>
                                      <button
                                        className="w-full text-left px-3 py-2 text-xs hover:bg-amber-50 dark:hover:bg-amber-950/20 text-amber-700 dark:text-amber-400 rounded-b-lg transition-colors focus-visible:ring-2 focus-visible:ring-amber-500"
                                        onClick={() => { handleDownloadAllUnlimited('txt'); setShowDownloadMenu(false) }}
                                        disabled={downloadingAll}
                                      >
                                        {'\u26a1'} All results (TXT, unlimited)
                                      </button>
                                    </>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Result count info */}
                          {resultFilter && (
                            <p className="text-xs text-zinc-500">
                              {filteredResults.length.toLocaleString()} of {solveResult.results.length.toLocaleString()} solutions match filter
                            </p>
                          )}

                          {/* Results list with zebra striping */}
                          <div className="max-h-96 overflow-y-auto space-y-0 scrollbar-thin rounded-lg border border-zinc-100 dark:border-zinc-800">
                            {filteredResults.slice(0, displayLimit).map((expr, idx) => {
                              const isRecommended = expr === solveResult.recommended
                              const exprType = getExpressionType(expr)
                              return (
                                <div
                                  key={idx}
                                  className={`flex items-center gap-2 p-2 transition-colors group
                                    ${idx % 2 === 0 ? 'bg-white dark:bg-zinc-900' : 'bg-zinc-50 dark:bg-zinc-800/30'}
                                    hover:bg-emerald-50 dark:hover:bg-emerald-950/20
                                    ${isRecommended
                                      ? '!bg-amber-50 dark:!bg-amber-950/20 border-l-2 border-l-amber-400 dark:border-l-amber-600'
                                      : ''
                                    }
                                  `}
                                >
                                  <span className="text-xs text-zinc-400 w-8 text-right font-mono group-hover:text-zinc-600 dark:group-hover:text-zinc-300">{idx + 1}</span>
                                  <code
                                    className="font-mono font-bold text-sm flex-1 tracking-wider group-hover:text-emerald-600 dark:group-hover:text-emerald-400 transition-colors cursor-pointer"
                                    onClick={() => setSelectedResultExpr(selectedResultExpr === expr ? null : expr)}
                                    title="Click to visualize expression"
                                  >{formatExpression(expr)}</code>
                                  {/* Expression type tag */}
                                  {exprType === 'comparison' && (
                                    <Badge variant="outline" className="text-[9px] px-1 py-0 h-4 border-teal-300 text-teal-600 dark:border-teal-700 dark:text-teal-400 shrink-0">
                                      cmp
                                    </Badge>
                                  )}
                                  {isRecommended && (
                                    <Trophy className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                                  )}
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity shrink-0 focus-visible:ring-2 focus-visible:ring-emerald-500"
                                    onClick={async () => {
                                      await navigator.clipboard.writeText(formatExpression(expr))
                                      setCopiedResult(expr)
                                      setTimeout(() => setCopiedResult(null), 1500)
                                    }}
                                    title="Copy expression to clipboard"
                                  >
                                    {copiedResult === expr ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3 text-zinc-400" />}
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className={`h-6 w-6 shrink-0 focus-visible:ring-2 focus-visible:ring-emerald-500 ${
                                      selectedResultExpr === expr
                                        ? 'opacity-100 text-emerald-500'
                                        : 'opacity-0 group-hover:opacity-100 text-zinc-400'
                                    } transition-opacity`}
                                    onClick={() => setSelectedResultExpr(selectedResultExpr === expr ? null : expr)}
                                    title="Visualize expression breakdown"
                                  >
                                    <Eye className="w-3 h-3" />
                                  </Button>
                                </div>
                              )
                            })}
                            {filteredResults.length > displayLimit && (
                              <div className="text-center py-3 space-y-2">
                                <p className="text-xs text-zinc-400">
                                  Showing {displayLimit.toLocaleString()} of {filteredResults.length.toLocaleString()} solutions
                                </p>
                                <div className="flex items-center justify-center gap-2">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7 text-xs focus-visible:ring-2 focus-visible:ring-emerald-500"
                                    onClick={() => setDisplayLimit(prev => Math.min(prev + MAX_DISPLAY_RESULTS, filteredResults.length))}
                                  >
                                    Load {Math.min(MAX_DISPLAY_RESULTS, filteredResults.length - displayLimit).toLocaleString()} more
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7 text-xs text-emerald-600 dark:text-emerald-400 border-emerald-300 dark:border-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-950/20 focus-visible:ring-2 focus-visible:ring-emerald-500"
                                    onClick={() => handleDownload('txt')}
                                  >
                                    <Download className="w-3 h-3 mr-1" /> Download all {filteredResults.length.toLocaleString()}
                                  </Button>
                                </div>
                              </div>
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
                                  <span className={`text-xs w-14 text-right font-mono shrink-0 ${cp.probability >= 8 ? 'text-zinc-400' : 'text-zinc-500'}`}>
                                    {cp.probability.toFixed(1)}%
                                  </span>
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

            {/* Result Expression Visualizer */}
            {selectedResultExpr && visualizeExpression && (
              <Card className="animate-in slide-in-from-bottom-2 duration-200 shadow-md shadow-zinc-200/50 dark:shadow-zinc-900/50">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Eye className="w-4 h-4 text-teal-500" />
                      Expression Visualizer
                    </CardTitle>
                    <Button variant="ghost" size="icon" className="h-6 w-6 focus-visible:ring-2 focus-visible:ring-emerald-500" onClick={() => setSelectedResultExpr(null)}>
                      <X className="w-3 h-3" />
                    </Button>
                  </div>
                  <CardDescription>Visual breakdown of the expression</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-center gap-2 flex-wrap p-4 rounded-xl bg-zinc-50 dark:bg-zinc-800/50">
                    {/* Left side of expression */}
                    <div className="flex gap-0.5">
                      {visualizeExpression.leftChars.map((ch, i) => {
                        const displayCh = API_TO_DISPLAY[ch] || ch
                        const isDigit = /\d/.test(ch)
                        const isOp = ['+', '-', '*', '/', '%', '^', '!', 'A'].includes(ch)
                        return (
                          <span
                            key={`l-${i}`}
                            className={`w-9 h-9 rounded-lg border-2 flex items-center justify-center font-mono font-bold text-sm transition-all
                              ${isDigit
                                ? 'bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-900/40 dark:text-emerald-400 dark:border-emerald-700'
                                : isOp
                                  ? 'bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-900/40 dark:text-amber-400 dark:border-amber-700'
                                  : 'bg-zinc-100 text-zinc-700 border-zinc-300 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-600'
                              }`}
                          >
                            {displayCh}
                          </span>
                        )
                      })}
                    </div>
                    {/* Separator (= or >) */}
                    {visualizeExpression.separator && (
                      <span className="text-2xl font-black text-emerald-600 dark:text-emerald-400 px-2">
                        {visualizeExpression.separator}
                      </span>
                    )}
                    {/* Right side of expression */}
                    {visualizeExpression.rightChars.length > 0 && (
                      <div className="flex gap-0.5">
                        {visualizeExpression.rightChars.map((ch, i) => {
                          const displayCh = API_TO_DISPLAY[ch] || ch
                          const isDigit = /\d/.test(ch)
                          const isOp = ['+', '-', '*', '/', '%', '^', '!', 'A'].includes(ch)
                          return (
                            <span
                              key={`r-${i}`}
                              className={`w-9 h-9 rounded-lg border-2 flex items-center justify-center font-mono font-bold text-sm transition-all
                                ${isDigit
                                  ? 'bg-emerald-100 text-emerald-700 border-emerald-300 dark:bg-emerald-900/40 dark:text-emerald-400 dark:border-emerald-700'
                                  : isOp
                                    ? 'bg-amber-100 text-amber-700 border-amber-300 dark:bg-amber-900/40 dark:text-amber-400 dark:border-amber-700'
                                    : 'bg-zinc-100 text-zinc-700 border-zinc-300 dark:bg-zinc-800 dark:text-zinc-300 dark:border-zinc-600'
                                }`}
                            >
                              {displayCh}
                            </span>
                          )
                        })}
                      </div>
                    )}
                  </div>
                  {/* Legend */}
                  <div className="flex items-center justify-center gap-4 mt-3 text-xs text-zinc-500">
                    <span className="flex items-center gap-1">
                      <span className="w-4 h-4 rounded bg-emerald-100 dark:bg-emerald-900/40 border border-emerald-300 dark:border-emerald-700" />
                      Digits
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="w-4 h-4 rounded bg-amber-100 dark:bg-amber-900/40 border border-amber-300 dark:border-amber-700" />
                      Operators
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="w-4 h-4 rounded bg-zinc-100 dark:bg-zinc-800 border border-zinc-300 dark:border-zinc-600" />
                      Symbols
                    </span>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Smart Hints Card - continued */}
            {solveResult && solveResult.results.length > 1 && smartHints.length > 0 && (
              <Card className="shadow-md shadow-zinc-200/50 dark:shadow-zinc-900/50">
                <CardHeader className="pb-2">
                  <div
                    className="flex items-center justify-between cursor-pointer"
                    onClick={() => setShowHints(!showHints)}
                    role="button"
                    tabIndex={0}
                    aria-expanded={showHints}
                  >
                    <CardTitle className="text-base flex items-center gap-2">
                      <Lightbulb className="w-4 h-4 text-amber-500" />
                      Smart Hints
                    </CardTitle>
                    {showHints ? <ChevronUp className="w-4 h-4 text-zinc-400" /> : <ChevronDown className="w-4 h-4 text-zinc-400" />}
                  </div>
                  <CardDescription>Suggestions to narrow down results</CardDescription>
                </CardHeader>
                {showHints && (
                  <CardContent className="pt-0 space-y-2">
                    {smartHints.map((hint, idx) => (
                      <div
                        key={idx}
                        className="flex items-center gap-3 p-2.5 rounded-lg bg-gradient-to-r from-amber-50 to-teal-50 dark:from-amber-950/20 dark:to-teal-950/20 border border-amber-100 dark:border-amber-900/30"
                      >
                        <span className="text-lg">{'\ud83d\udca1'}</span>
                        <div className="flex-1">
                          <p className="text-xs text-zinc-700 dark:text-zinc-300">
                            Try constraining <strong className="font-mono text-amber-600 dark:text-amber-400">{hint.displayChar}</strong> at position <strong>{hint.position + 1}</strong>
                          </p>
                          <p className="text-[10px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                            Appears in {hint.probability.toFixed(0)}% of remaining solutions
                          </p>
                        </div>
                        <div className="w-12 h-12 rounded-lg bg-amber-100 dark:bg-amber-900/30 border-2 border-amber-300 dark:border-amber-700 flex items-center justify-center font-mono font-bold text-lg text-amber-700 dark:text-amber-400 shrink-0">
                          {hint.displayChar}
                        </div>
                      </div>
                    ))}
                    <p className="text-[10px] text-zinc-400 text-center pt-1">
                      Based on character probability analysis of {solveResult.results.length.toLocaleString()} solutions
                    </p>
                  </CardContent>
                )}
              </Card>
            )}

            {/* Empty state - Compact "Ready to Solve" placeholder */}
            {!solveResult && !solving && (
              <Card className="transition-all duration-500 shadow-md shadow-zinc-200/50 dark:shadow-zinc-900/50">
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
                      <span className="text-zinc-600 dark:text-zinc-400">Cycle colors: {'\ud83d\udfe9'}{'\u2192'}{'\ud83d\udfe8'}{'\u2192'}{'\u2b1b'}</span>
                    </div>
                    <div className="flex items-start gap-2 p-2 rounded-lg bg-zinc-50 dark:bg-zinc-800/50">
                      <span className="w-5 h-5 rounded-full bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center shrink-0 text-[10px] font-bold text-emerald-600 dark:text-emerald-400">3</span>
                      <span className="text-zinc-600 dark:text-zinc-400">Hit Solve! ({'\u2318\u21b5'})</span>
                    </div>
                    <div className="flex items-start gap-2 p-2 rounded-lg bg-zinc-50 dark:bg-zinc-800/50">
                      <Target className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                      <span className="text-zinc-600 dark:text-zinc-400">Use <strong>Probabilities</strong> for best guess</span>
                    </div>
                  </div>

                  <div className="h-px bg-gradient-to-r from-transparent via-emerald-500/40 to-transparent mb-3" />

                  {/* Example game state */}
                  <div className="text-center">
                    <p className="text-[10px] text-zinc-400 mb-1.5">Example: 1+2=3 with constraints</p>
                    <div className="flex justify-center gap-0.5">
                      <div className="w-8 h-8 rounded-lg border-2 bg-emerald-500 text-white border-emerald-600 font-mono font-bold text-sm flex items-center justify-center shadow-inner">1</div>
                      <div className="w-8 h-8 rounded-lg border-2 bg-emerald-500 text-white border-emerald-600 font-mono font-bold text-sm flex items-center justify-center shadow-inner">+</div>
                      <div className="w-8 h-8 rounded-lg border-2 bg-amber-400 text-amber-950 border-amber-500 font-mono font-bold text-sm flex items-center justify-center shadow-inner">2</div>
                      <div className="w-8 h-8 rounded-lg border-2 bg-emerald-500 text-white border-emerald-600 font-mono font-bold text-sm flex items-center justify-center shadow-inner">=</div>
                      <div className="w-8 h-8 rounded-lg border-2 bg-zinc-400 text-zinc-800 border-zinc-500 font-mono font-bold text-sm flex items-center justify-center shadow-inner tile-absent-stripes">3</div>
                    </div>
                    <p className="text-[10px] text-zinc-400 mt-1">{'\ud83d\udfe9'} Right spot {'\u00b7'} {'\ud83d\udfe8'} Wrong spot {'\u00b7'} {'\u2b1b'} Not in equation</p>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Gradient divider */}
            <div className="h-px bg-gradient-to-r from-transparent via-teal-500/40 to-transparent" />

            {/* How to Play */}
            <Card className="shadow-md shadow-zinc-200/50 dark:shadow-zinc-900/50">
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Hash className="w-4 h-4 text-emerald-500" />
                  How to Play
                </CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-zinc-600 dark:text-zinc-400 space-y-3">
                <p>Sumzle is a math-based Wordle where you guess valid equations like <code className="text-xs bg-zinc-100 dark:bg-zinc-800 px-1.5 py-0.5 rounded">1+2=3</code>.</p>
                <div className="h-px bg-gradient-to-r from-transparent via-zinc-300 dark:via-zinc-600 to-transparent" />
                <div className="space-y-1.5">
                  <p className="flex items-center gap-2">
                    <span className="inline-block w-4 h-4 rounded bg-emerald-500 shrink-0" />
                    <strong>Green</strong> {'\u2014'} Correct character in the right position
                  </p>
                  <p className="flex items-center gap-2">
                    <span className="inline-block w-4 h-4 rounded bg-amber-400 shrink-0" />
                    <strong>Yellow</strong> {'\u2014'} Character exists but in the wrong position
                  </p>
                  <p className="flex items-center gap-2">
                    <span className="inline-block w-4 h-4 rounded bg-zinc-400 shrink-0" />
                    <strong>Gray</strong> {'\u2014'} Character is not in the equation
                  </p>
                </div>
                <div className="h-px bg-gradient-to-r from-transparent via-zinc-300 dark:via-zinc-600 to-transparent" />
                <div className="space-y-1 text-xs text-zinc-500 dark:text-zinc-500">
                  <p>&#8226; Click a tile to select, then type a character</p>
                  <p>&#8226; Click the same tile again (or right-click) to cycle its color</p>
                  <p>&#8226; Use arrow keys to navigate between tiles</p>
                  <p>&#8226; Supports: +{'\u2212'}{'\u00d7'}{'\u00f7'}%^=()![]A (permutation)</p>
                  <p>&#8226; <code className="bg-zinc-100 dark:bg-zinc-800 px-1 rounded">[x/y]</code> = floor division, <code className="bg-zinc-100 dark:bg-zinc-800 px-1 rounded">n!</code> = factorial, <code className="bg-zinc-100 dark:bg-zinc-800 px-1 rounded">mAn</code> = permutation</p>
                  <p>&#8226; <strong className="text-emerald-600 dark:text-emerald-400">Keyboard shortcuts:</strong> {'\u2318\u21b5'} Solve, {'\u2318'}E Export, Ctrl+Z/Y Undo/Redo</p>
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
            <span>Sumzle HP Solver v{APP_VERSION} {'\u2014'} Powered by Rust {'\ud83e\udd80'}</span>
            <a
              href="https://github.com/SUSTechHSAS/sumzle-hp-solver"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 hover:underline focus-visible:ring-2 focus-visible:ring-emerald-500 rounded"
              title="View on GitHub"
            >
              <ExternalLink className="w-3 h-3" />
              GitHub
            </a>
          </div>
          <div className="flex items-center gap-4 flex-wrap justify-center">
            {health && (
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Engine v{health.version} {'\u00b7'} {formatUptime(health.uptime_secs)}
              </span>
            )}
            <span className="flex items-center gap-1.5">
              <Cpu className="w-3 h-3" />
              {health?.cpu_cores || '?'} cores {'\u00b7'} {health?.parallel_threads || '?'} threads
            </span>
            <span>Parallel Multi-Core Solver</span>
          </div>
        </div>
      </footer>

      {/* ─── Scroll to Top Button ──────────────────────────────────────────── */}
      {showScrollTop && (
        <button
          className="fixed bottom-20 right-4 z-50 w-10 h-10 rounded-full bg-emerald-500 text-white shadow-lg shadow-emerald-500/30 flex items-center justify-center hover:bg-emerald-600 transition-all duration-200 hover:scale-110 focus-visible:ring-2 focus-visible:ring-emerald-500"
          onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
          aria-label="Scroll to top"
        >
          <ArrowUp className="w-5 h-5" />
        </button>
      )}
    </div>
  )
}
