'use client'

import React, { useState, useCallback, useEffect, useRef } from 'react'
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
  ChevronDown, ChevronUp, RefreshCw, MonitorSmartphone, Network
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
  correct: 'bg-emerald-500 text-white border-emerald-600 dark:bg-emerald-600 dark:border-emerald-700',
  present: 'bg-amber-400 text-amber-950 border-amber-500 dark:bg-amber-500 dark:text-amber-950 dark:border-amber-600',
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

  // Refs
  const resultsRef = useRef<HTMLDivElement>(null)

  // ─── Dark mode effect ──────────────────────────────────────────────────────

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode)
  }, [darkMode])

  // ─── Fetch health ──────────────────────────────────────────────────────────

  const fetchHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/health?XTransformPort=3031')
      if (res.ok) {
        const data = await res.json()
        setHealth(data.data || data)
      }
    } catch {
      // Health endpoint might not be available
    }
  }, [])

  useEffect(() => {
    fetchHealth()
    const interval = setInterval(fetchHealth, 30000)
    return () => clearInterval(interval)
  }, [fetchHealth])

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
        return { ...tile, char }
      })
    }))
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

  // ─── Solve ─────────────────────────────────────────────────────────────────

  const solve = useCallback(async () => {
    setSolving(true)
    setSolveError(null)
    setSolveResult(null)

    try {
      // Convert display chars to API chars and filter empty rows
      const apiRows = rows
        .filter(row => row.some(t => t.char !== ''))
        .map(row => row.map(tile => ({
          char: DISPLAY_TO_API[tile.char] || tile.char,
          state: tile.state,
        })))

      const body = {
        length: expressionLength,
        rows: apiRows,
        mode: 'parallel',
        num_threads: health?.parallel_threads || 4,
      }

      const res = await fetch('/api/solve/parallel?XTransformPort=3031', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      const data = await res.json()

      if (!res.ok || !data.success) {
        throw new Error(data.error || `Solver returned status ${res.status}`)
      }

      setSolveResult(data.data)
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
    } catch {
      setSolveError('Invalid JSON format for import')
    }
  }, [importText])

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

  const addWorker = useCallback(() => {
    if (!workerAddress.trim()) return
    const newWorker: WorkerNode = {
      id: Math.random().toString(36).substring(2, 8),
      address: workerAddress.trim(),
      status: 'idle',
      tasks_completed: 0,
      last_heartbeat: new Date().toISOString(),
    }
    setWorkers(prev => [...prev, newWorker])
    setWorkerAddress('')
  }, [workerAddress])

  const removeWorker = useCallback((id: string) => {
    setWorkers(prev => prev.filter(w => w.id !== id))
  }, [])

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen flex flex-col bg-zinc-50 dark:bg-zinc-950 transition-colors duration-300">
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
            {/* Engine status */}
            {health && (
              <Badge variant="secondary" className="hidden sm:flex items-center gap-1.5 text-xs">
                <Cpu className="w-3 h-3" />
                {health.cpu_cores} cores / {health.parallel_threads} threads
              </Badge>
            )}
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
                  <Button variant="outline" size="sm" onClick={addRow} disabled={rows.length >= MAX_ROWS}>
                    <Plus className="w-3.5 h-3.5 mr-1" /> Add Guess Row
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setShowImport(!showImport)}>
                    <Upload className="w-3.5 h-3.5 mr-1" /> Import
                  </Button>
                  <Button variant="outline" size="sm" onClick={copyState}>
                    {copied ? <Check className="w-3.5 h-3.5 mr-1" /> : <Copy className="w-3.5 h-3.5 mr-1" />}
                    {copied ? 'Copied!' : 'Export'}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setShowDistributed(!showDistributed)}>
                    <Network className="w-3.5 h-3.5 mr-1" /> Workers
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Import Panel */}
            {showImport && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Import Game State</CardTitle>
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

            {/* Distributed Computing Panel */}
            {showDistributed && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Server className="w-4 h-4 text-teal-500" />
                    Distributed Workers
                  </CardTitle>
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
                  Click tile to select & type, click again to cycle state. Right-click also cycles state.
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
                <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
                  {rows.map((row, rowIdx) => (
                    <div key={rowIdx} className="flex items-center gap-1.5">
                      <span className="text-xs text-zinc-400 w-4 text-right shrink-0">{rowIdx + 1}</span>
                      <div className="flex gap-1">
                        {row.map((tile, colIdx) => {
                          const isSelected = selectedCell?.row === rowIdx && selectedCell?.col === colIdx
                          return (
                            <button
                              key={colIdx}
                              className={`
                                w-10 h-10 sm:w-11 sm:h-11 rounded-lg border-2 font-mono font-bold text-lg
                                flex items-center justify-center transition-all duration-150 select-none
                                ${STATE_COLORS[tile.state]}
                                ${isSelected ? 'ring-2 ring-emerald-500 ring-offset-1 dark:ring-offset-zinc-900 scale-105' : ''}
                                hover:scale-105 active:scale-95
                              `}
                              onClick={(e) => handleTileClick(rowIdx, colIdx, e)}
                              onContextMenu={(e) => handleTileContextMenu(e, rowIdx, colIdx)}
                              aria-label={`Row ${rowIdx + 1} Column ${colIdx + 1}: ${tile.char || 'empty'}, ${tile.state}`}
                            >
                              {tile.char || ''}
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
                <div className="space-y-1.5">
                  {KEYBOARD_CHARS.map((line, lineIdx) => (
                    <div key={lineIdx} className="flex justify-center gap-1">
                      {line.map((key) => (
                        <Button
                          key={key}
                          variant="outline"
                          size="sm"
                          className="h-9 w-9 sm:h-10 sm:w-10 font-mono font-bold text-sm p-0"
                          onClick={() => handleKeyPress(key)}
                          disabled={!selectedCell}
                        >
                          {key}
                        </Button>
                      ))}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Solve Button */}
            <Button
              className="w-full h-12 text-base font-bold bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white shadow-lg shadow-emerald-500/20"
              onClick={solve}
              disabled={solving}
              size="lg"
            >
              {solving ? (
                <>
                  <RefreshCw className="w-5 h-5 mr-2 animate-spin" />
                  Solving...
                </>
              ) : (
                <>
                  <Play className="w-5 h-5 mr-2" />
                  Solve with Rust Engine
                </>
              )}
            </Button>

            {/* Solve Error */}
            {solveError && (
              <Card className="border-red-300 dark:border-red-800">
                <CardContent className="pt-5">
                  <p className="text-sm text-red-600 dark:text-red-400">{solveError}</p>
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
                        <div className="text-center p-2 rounded-lg bg-zinc-100 dark:bg-zinc-800">
                          <Cpu className="w-4 h-4 mx-auto mb-1 text-emerald-500" />
                          <div className="text-lg font-bold">{health.cpu_cores}</div>
                          <div className="text-xs text-zinc-500">CPU Cores</div>
                        </div>
                        <div className="text-center p-2 rounded-lg bg-zinc-100 dark:bg-zinc-800">
                          <Activity className="w-4 h-4 mx-auto mb-1 text-teal-500" />
                          <div className="text-lg font-bold">{health.parallel_threads}</div>
                          <div className="text-xs text-zinc-500">Threads</div>
                        </div>
                      </>
                    )}
                    {solveResult && (
                      <>
                        <div className="text-center p-2 rounded-lg bg-zinc-100 dark:bg-zinc-800">
                          <Timer className="w-4 h-4 mx-auto mb-1 text-amber-500" />
                          <div className="text-lg font-bold">{solveResult.elapsed_ms.toFixed(1)}</div>
                          <div className="text-xs text-zinc-500">ms Elapsed</div>
                        </div>
                        <div className="text-center p-2 rounded-lg bg-zinc-100 dark:bg-zinc-800">
                          <BarChart3 className="w-4 h-4 mx-auto mb-1 text-rose-500" />
                          <div className="text-lg font-bold">{formatNumber(solveResult.searched_count)}</div>
                          <div className="text-xs text-zinc-500">Searched</div>
                        </div>
                      </>
                    )}
                  </div>
                  {solveResult && (
                    <div className="mt-3 flex items-center justify-between p-2 rounded-lg bg-gradient-to-r from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/30">
                      <span className="text-sm font-medium">Solve Speed</span>
                      <span className="text-sm font-bold text-emerald-600 dark:text-emerald-400">
                        {formatSpeed(solveResult.speed_per_sec)}
                      </span>
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* Solving Progress */}
            {solving && (
              <Card>
                <CardContent className="pt-5 space-y-3">
                  <div className="flex items-center gap-2">
                    <RefreshCw className="w-4 h-4 animate-spin text-emerald-500" />
                    <span className="text-sm font-medium">Rust engine solving...</span>
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
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Trophy className="w-4 h-4 text-amber-500" />
                    Results
                    <Badge variant="secondary" className="ml-auto">
                      {solveResult.results.length} found
                    </Badge>
                  </CardTitle>
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
                        <div className="max-h-80 overflow-y-auto space-y-1 mt-2">
                          {solveResult.results.map((expr, idx) => (
                            <div
                              key={idx}
                              className="flex items-center gap-2 p-2 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
                            >
                              <span className="text-xs text-zinc-400 w-6 text-right">{idx + 1}</span>
                              <code className="font-mono font-bold text-sm flex-1">{expr}</code>
                            </div>
                          ))}
                        </div>
                      )}
                    </TabsContent>

                    <TabsContent value="probabilities">
                      {solveResult.char_probabilities.length === 0 ? (
                        <p className="text-sm text-zinc-500 dark:text-zinc-400 text-center py-6">
                          No probability data available.
                        </p>
                      ) : (
                        <div className="max-h-80 overflow-y-auto space-y-1.5 mt-2">
                          {solveResult.char_probabilities
                            .sort((a, b) => b.probability - a.probability)
                            .map((cp) => (
                              <div key={cp.char} className="flex items-center gap-2">
                                <code className="font-mono font-bold text-sm w-5 text-center">{cp.char}</code>
                                <div className="flex-1 h-5 bg-zinc-100 dark:bg-zinc-800 rounded-full overflow-hidden">
                                  <div
                                    className="h-full rounded-full bg-gradient-to-r from-emerald-400 to-teal-500 transition-all duration-500"
                                    style={{ width: `${cp.probability}%` }}
                                  />
                                </div>
                                <span className="text-xs text-zinc-500 w-12 text-right">
                                  {cp.probability.toFixed(1)}%
                                </span>
                              </div>
                            ))}
                        </div>
                      )}
                    </TabsContent>

                    <TabsContent value="recommended">
                      {solveResult.recommended ? (
                        <div className="text-center py-6 space-y-4">
                          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 shadow-lg shadow-amber-500/20">
                            <Trophy className="w-8 h-8 text-white" />
                          </div>
                          <div>
                            <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-2">Recommended Guess</p>
                            <code className="text-3xl font-mono font-black bg-gradient-to-r from-amber-500 to-orange-500 bg-clip-text text-transparent">
                              {solveResult.recommended}
                            </code>
                          </div>
                          <p className="text-xs text-zinc-400">
                            Based on character probability analysis across all valid solutions
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

            {/* Empty state */}
            {!solveResult && !solving && (
              <Card>
                <CardContent className="pt-6 text-center">
                  <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center">
                    <Zap className="w-8 h-8 text-zinc-300 dark:text-zinc-600" />
                  </div>
                  <h3 className="text-lg font-semibold mb-1">Ready to Solve</h3>
                  <p className="text-sm text-zinc-500 dark:text-zinc-400 max-w-sm mx-auto">
                    Enter your constraints on the board, then hit Solve to find all valid equations using the high-performance Rust engine.
                  </p>
                </CardContent>
              </Card>
            )}

            {/* How to Play */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">How to Play</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-zinc-600 dark:text-zinc-400 space-y-2">
                <p>Sumzle is a math-based Wordle where you guess valid equations.</p>
                <Separator />
                <div className="space-y-1">
                  <p><span className="inline-block w-4 h-4 rounded bg-emerald-500 align-text-bottom mr-1" /> <strong>Green</strong> — Correct character in the right position</p>
                  <p><span className="inline-block w-4 h-4 rounded bg-amber-400 align-text-bottom mr-1" /> <strong>Yellow</strong> — Character exists but in the wrong position</p>
                  <p><span className="inline-block w-4 h-4 rounded bg-zinc-400 align-text-bottom mr-1" /> <strong>Gray</strong> — Character is not in the equation</p>
                </div>
                <Separator />
                <p>Click a tile to select it, then press a keyboard key to enter a character. Click the same tile again (or right-click) to cycle its color state.</p>
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
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Engine v{health.version} • Uptime {Math.floor(health.uptime_secs / 60)}m
              </span>
            )}
            <span>Parallel Multi-Core Solver</span>
          </div>
        </div>
      </footer>
    </div>
  )
}
