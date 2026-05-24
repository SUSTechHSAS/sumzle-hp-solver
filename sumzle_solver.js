
        class OptimizedSumzleSolver {
            constructor() {
                this.length = 6;
                this.guessRowsData = [];
                this.isRunning = false;
                this.shouldStop = false;
                this.results = [];
                this.searchedCount = 0;
                this.startTime = 0;
                this.selectedTile = null; 
                this.globalKnowledge = {};
                this.charProbabilitiesData = [];
                this.lastUIUpdate = 0;
                
                this.validChars = "0123456789+-*/%^=()![]>A";
                this.displayCharsMap = { '*': '×', '/': '÷' };
                this.actualCharsMap = { '×': '*', '÷': '/' };
                this.resumeState = null; // 用于恢复搜索
                this.exportableState = null;
                
                this.maxOperandValue = 30; 
                this.searchPruningEnabled = true; 

                this.tileContextMenu = document.getElementById('tileContextMenu');
                this.activeContextMenuTile = null;
                
                this.initializeUI();
                this.updateConstraintBoard();
                this.autoAdvanceFocus = true;
            }

            initializeUI() {
                const themeToggle = document.getElementById('themeToggle');
                themeToggle.addEventListener('click', () => this.toggleTheme());

                const lengthInput = document.getElementById('lengthInput');
                lengthInput.addEventListener('change', (e) => {
                    this.hideContextMenu();
                    const newLength = Math.max(3, Math.min(15, parseInt(e.target.value) || this.length));
                    e.target.value = newLength;
                    
                    if (this.selectedTile) { 
                        if (this.selectedTile.colIndex >= newLength) {
                             if (this.selectedTile.element) this.selectedTile.element.style.outline = '';
                             this.selectedTile = null;
                        }
                    }
                    
                    if (newLength === this.length) return;
                    this.length = newLength;

                    this.guessRowsData.forEach((row, rowIndex) => {
                        const newRowArray = Array(this.length).fill(null).map((_, colIndex) => {
                            if (colIndex < row.length && row[colIndex]) {
                                return { ...row[colIndex] };
                            }
                            return { char: '', state: 'empty' };
                        });
                        this.guessRowsData[rowIndex] = newRowArray;
                    });
                    
                    this.updateConstraintBoard(); 
                });

                document.getElementById('solveBtn').addEventListener('click', () => this.solve());
                document.getElementById('clearBtn').addEventListener('click', () => this.clear());
                document.getElementById('stopBtn').addEventListener('click', () => this.stop());
                document.getElementById('addGuessRowBtn').addEventListener('click', () => {
                    this.hideContextMenu();
                    this.addGuessRow();
                });
                 document.getElementById('importGameStateBtn').addEventListener('click', () => this.importGameState());
                document.getElementById('exportSearchStateBtn').addEventListener('click', () => this.exportSearchState());
                // This button now triggers the hidden file input
                document.getElementById('importSearchStateBtn').addEventListener('click', () => {
                    document.getElementById('searchStateFileInput').click();
                });
                // The file input itself handles the import logic when a file is selected
                document.getElementById('searchStateFileInput').addEventListener('change', (event) => this.handleFileImport(event));

                this.createKeyboard();

                this.tileContextMenu.querySelectorAll('.context-menu-btn').forEach(btn => {
                    btn.addEventListener('click', (event) => {
                        event.stopPropagation();
                        const action = btn.dataset.action;
                        const state = btn.dataset.state;
                        this.handleContextMenuAction(action, state);
                    });
                });

                document.addEventListener('click', (event) => {
                    if (this.tileContextMenu.style.display === 'none' && !this.tileContextMenu.classList.contains('visible')) return;

                    const clickedOnSelectedTile = this.selectedTile && event.target.closest('.constraint-tile') === this.selectedTile.element;
                    const clickedOnMenu = event.target.closest('.tile-context-menu');

                    if (!clickedOnSelectedTile && !clickedOnMenu) {
                        this.hideContextMenu();
                    }
                }, true);

                document.addEventListener('keydown', (event) => {
                    if (event.key === 'Escape' && (this.tileContextMenu.style.display !== 'none' || this.tileContextMenu.classList.contains('visible'))) {
                        this.hideContextMenu();
                    }
                });
            }

            showContextMenu(tileElement, rowIndex, colIndex) {
                const tileData = this.guessRowsData[rowIndex][colIndex];
                const hasChar = !!tileData.char;

                this.tileContextMenu.querySelector('[data-state="correct"]').disabled = !hasChar;
                this.tileContextMenu.querySelector('[data-state="present"]').disabled = !hasChar;
                this.tileContextMenu.querySelector('[data-state="empty"]').disabled = !hasChar;
                this.tileContextMenu.querySelector('[data-action="delete"]').disabled = !hasChar;

                const tileRect = tileElement.getBoundingClientRect();
                const menuHeight = this.tileContextMenu.offsetHeight || 50; 
                const menuWidth = this.tileContextMenu.offsetWidth || 180; 

                let top = tileRect.bottom + window.scrollY + 8;
                let left = tileRect.left + window.scrollX + (tileRect.width / 2) - (menuWidth / 2);

                if (top + menuHeight > window.innerHeight + window.scrollY - 10) {
                    top = tileRect.top + window.scrollY - menuHeight - 8;
                }
                if (top < window.scrollY + 5) {
                    top = window.scrollY + 5;
                }
                if (left + menuWidth > window.innerWidth + window.scrollX - 5) {
                    left = window.innerWidth + window.scrollX - menuWidth - 5;
                }
                if (left < window.scrollX + 5) {
                    left = window.scrollX + 5;
                }
                
                this.tileContextMenu.style.top = `${top}px`;
                this.tileContextMenu.style.left = `${left}px`;
                this.tileContextMenu.style.display = 'flex'; 
                requestAnimationFrame(() => {
                    this.tileContextMenu.classList.add('visible');
                });
                this.activeContextMenuTile = { element: tileElement, rowIndex, colIndex };
            }

            hideContextMenu() {
                 this.tileContextMenu.classList.remove('visible');
                 setTimeout(() => {
                    if (!this.tileContextMenu.classList.contains('visible')) {
                         this.tileContextMenu.style.display = 'none';
                    }
                 }, 200); 
                this.activeContextMenuTile = null;
            }

            handleContextMenuAction(action, stateValue) {
                if (!this.activeContextMenuTile) return;

                const { element, rowIndex, colIndex } = this.activeContextMenuTile;
                const tileData = this.guessRowsData[rowIndex][colIndex];

                if (action === 'delete') {
                    tileData.char = '';
                    tileData.state = 'empty';
                } else if (stateValue) {
                    tileData.state = stateValue;
                }

                this.updateTileAppearance(element, tileData);
                this.hideContextMenu();
            }


            addGuessRow() {
                this.hideContextMenu();
                if (this.guessRowsData.length >= 10) { 
                    this.showError("最多只能添加10行猜测。");
                    return;
                }
                this.guessRowsData.push(this.createEmptyRow());
                this.updateConstraintBoard();
            }
            
            createEmptyRow() {
                return Array(this.length).fill().map(() => ({ char: '', state: 'empty' }));
            }

            createKeyboard() {
                const keyboard = document.getElementById('keyboard');
                keyboard.innerHTML = '';
                const chars = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '+', '-', '×', '÷', '%', '^', '=', '>', '!', 'A', '(', ')', '[', ']', '⌫'];
                
                chars.forEach(char => {
                    const key = document.createElement('div');
                    key.className = 'key';
                    key.textContent = char;
                    const actualChar = this.actualCharsMap[char] || char;
                    key.dataset.char = actualChar;
                    key.addEventListener('click', () => this.handleKeyPress(char, actualChar));
                    keyboard.appendChild(key);
                });
            }

            handleKeyPress(displayChar, actualChar) {
                if (!this.selectedTile || !this.selectedTile.element) return;
                this.hideContextMenu();
                const { rowIndex, colIndex } = this.selectedTile;
                const tileData = this.guessRowsData[rowIndex][colIndex];
                const originalTileElement = this.selectedTile.element;

                if (displayChar === '⌫') {
                    const charExisted = !!tileData.char;
                    tileData.char = '';
                    if (charExisted) {
                        tileData.state = 'empty';
                    }
                } else {
                    tileData.char = actualChar;
                     if (this.autoAdvanceFocus && colIndex < this.length - 1) {
                        this.selectNextTile(rowIndex, colIndex);
                    }
                }
                this.updateTileAppearance(originalTileElement, tileData);
            }

            selectNextTile(currentRowIndex, currentColIndex) {
                const nextColIndex = currentColIndex + 1;
                if (nextColIndex < this.length) {
                    const boardElement = document.getElementById('constraintBoard');
                    const nextTileElement = boardElement.querySelector(`.constraint-tile[data-row-index="${currentRowIndex}"][data-col-index="${nextColIndex}"]`);
                    if (nextTileElement) {
                        if (this.selectedTile && this.selectedTile.element) {
                            this.selectedTile.element.style.outline = '';
                        }
                        this.selectedTile = { element: nextTileElement, rowIndex: currentRowIndex, colIndex: nextColIndex };
                        nextTileElement.style.outline = '3px solid var(--fluent-blue)';
                         if (this.tileContextMenu.style.display !== 'none' || this.tileContextMenu.classList.contains('visible')) {
                            this.hideContextMenu();
                        }
                    }
                }
            }
            
            updateTileAppearance(tileElement, tileData) {
                tileElement.textContent = tileData.char ? (this.displayCharsMap[tileData.char] || tileData.char) : '';
                tileElement.className = 'constraint-tile'; 
                if (tileData.state !== 'empty' && tileData.char) {
                    tileElement.classList.add(tileData.state);
                } else if (tileData.state === 'empty' && tileData.char) {
                     tileElement.classList.add('empty'); 
                } else { 
                    tileElement.classList.add('empty');
                }
            }


            updateConstraintBoard() {
                const boardElement = document.getElementById('constraintBoard');
                boardElement.innerHTML = '';

                if (this.guessRowsData.length === 0) {
                    this.guessRowsData.push(this.createEmptyRow());
                }
                
                this.guessRowsData.forEach((rowData, rIndex) => {
                    const rowDiv = document.createElement('div');
                    rowDiv.className = 'constraint-row';
                    rowDiv.style.gridTemplateColumns = `repeat(${this.length}, 1fr)`;

                    rowData.forEach((tileData, cIndex) => {
                        const tileElement = document.createElement('div');
                        tileElement.dataset.rowIndex = rIndex;
                        tileElement.dataset.colIndex = cIndex;
                        this.updateTileAppearance(tileElement, tileData);
                        
                        tileElement.addEventListener('click', (event) => {
                            event.stopPropagation();
                            const clickedRIndex = parseInt(tileElement.dataset.rowIndex);
                            const clickedCIndex = parseInt(tileElement.dataset.colIndex);

                            if (this.selectedTile && 
                                this.selectedTile.rowIndex === clickedRIndex && 
                                this.selectedTile.colIndex === clickedCIndex) {
                                if ((this.tileContextMenu.style.display !== 'none' || this.tileContextMenu.classList.contains('visible')) && 
                                    this.activeContextMenuTile && 
                                    this.activeContextMenuTile.element === tileElement) {
                                    this.hideContextMenu();
                                } else {
                                    this.showContextMenu(tileElement, clickedRIndex, clickedCIndex);
                                }
                            } else {
                                this.hideContextMenu();
                                if (this.selectedTile && this.selectedTile.element) {
                                    this.selectedTile.element.style.outline = '';
                                }
                                this.selectedTile = { element: tileElement, rowIndex: clickedRIndex, colIndex: clickedCIndex };
                                tileElement.style.outline = '3px solid var(--fluent-blue)';
                            }
                        });
                        
                        rowDiv.appendChild(tileElement);
                    });
                    boardElement.appendChild(rowDiv);
                });

                if (this.selectedTile && this.selectedTile.element) {
                    const {rowIndex, colIndex} = this.selectedTile;
                    if(rowIndex < this.guessRowsData.length && colIndex < this.length) {
                         const currentSelectedElem = boardElement.children[rowIndex]?.children[colIndex];
                         if(currentSelectedElem) {
                            currentSelectedElem.style.outline = '3px solid var(--fluent-blue)';
                            this.selectedTile.element = currentSelectedElem; 
                         } else {
                            this.selectedTile = null;
                         }
                    } else {
                        this.selectedTile = null;
                    }
                }
            }

            preprocessConstraints() {
                this.globalKnowledge = {
                    fixedChars: Array(this.length).fill(null),
                    cannotBeAt: Array(this.length).fill(null).map(() => new Set()),
                    mustAppearMinCount: new Map(),
                    mustAppearExactCount: new Map(),
                    globallyForbidden: new Set()
                };
                const gk = this.globalKnowledge;

                for (let r = 0; r < this.guessRowsData.length; r++) {
                    const row = this.guessRowsData[r];
                    for (let c = 0; c < this.length; c++) {
                        if (c >= row.length) continue;
                        const tile = row[c];
                        if (!tile.char) continue;

                        if (tile.state === 'correct') {
                            if (gk.fixedChars[c] && gk.fixedChars[c] !== tile.char) {
                                this.showError(`冲突: 位置 ${c + 1} 同时固定为 ${gk.fixedChars[c]} 和 ${tile.char}.`); return false;
                            }
                            gk.fixedChars[c] = tile.char;
                            this.validChars.split('').forEach(vc => {
                                if (vc !== tile.char) gk.cannotBeAt[c].add(vc);
                            });
                        } else if (tile.state === 'present') {
                            gk.cannotBeAt[c].add(tile.char);
                        } else if (tile.state === 'empty' && tile.char) {
                            gk.cannotBeAt[c].add(tile.char);
                        }
                    }
                }

                const allCharsInGuesses = new Set();
                this.guessRowsData.forEach(row => row.forEach(tile => { if(tile.char) allCharsInGuesses.add(tile.char)}));

                for (const char of allCharsInGuesses) {
                    let minRequiredOverall = 0;
                    let derivedExactCount = undefined;

                    for (const row of this.guessRowsData) {
                        if (!row.some(tile => tile.char === char)) continue;

                        let greenInRow = 0;
                        let yellowInRow = 0;
                        row.forEach((tile) => {
                            if (tile.char === char) {
                                if (tile.state === 'correct') greenInRow++;
                                else if (tile.state === 'present') yellowInRow++;
                            }
                        });
                        
                        const minRequiredThisRow = greenInRow + yellowInRow;
                        minRequiredOverall = Math.max(minRequiredOverall, minRequiredThisRow);

                        if (row.some(tile => tile.char === char && tile.state === 'empty')) {
                            const exactCountThisRow = greenInRow + yellowInRow;
                            if (derivedExactCount === undefined) {
                                derivedExactCount = exactCountThisRow;
                            } else if (derivedExactCount !== exactCountThisRow) {
                                this.showError(`冲突: 字符 '${char}' 在不同猜测行中推断出不同的精确数量 (${derivedExactCount} vs ${exactCountThisRow}).`);
                                return false;
                            }
                        }
                    }

                    gk.mustAppearMinCount.set(char, minRequiredOverall);

                    if (derivedExactCount !== undefined) {
                        if (derivedExactCount < minRequiredOverall) {
                            this.showError(`冲突: 字符 '${char}' 的精确数量 (${derivedExactCount}) 小于其最小需求数量 (${minRequiredOverall}).`);
                            return false;
                        }
                        gk.mustAppearExactCount.set(char, derivedExactCount);
                        if (derivedExactCount === 0 && minRequiredOverall === 0) {
                            gk.globallyForbidden.add(char);
                        }
                    }
                }

                for (let i = 0; i < this.length; i++) {
                    const fixed = gk.fixedChars[i];
                    if (fixed) {
                        if (gk.globallyForbidden.has(fixed)) {
                            this.showError(`冲突: 字符 '${fixed}' 在位置 ${i + 1} 固定但同时被全局禁用.`); return false;
                        }
                        if (gk.cannotBeAt[i].has(fixed)) {
                           this.showError(`冲突: 字符 '${fixed}' 在位置 ${i + 1} 固定但又标记为不能在该位置.`); return false;
                        }
                        gk.mustAppearMinCount.set(fixed, Math.max(gk.mustAppearMinCount.get(fixed) || 0, 1));
                        if (gk.mustAppearExactCount.has(fixed)) {
                             if (gk.mustAppearExactCount.get(fixed) < (gk.mustAppearMinCount.get(fixed) || 0) ) {
                                 this.showError(`冲突: 字符 '${fixed}' 的精确数量 ${gk.mustAppearExactCount.get(fixed)} 小于其最小固定要求.`); return false;
                             }
                        }
                    }
                }
                for(const [char, exact] of gk.mustAppearExactCount) {
                    const min = gk.mustAppearMinCount.get(char) || 0;
                    if (exact < min) {
                         this.showError(`冲突: 字符 '${char}' 的精确数量 (${exact}) 小于其最小需求 (${min}).`); return false;
                    }
                }
                for (const char of gk.globallyForbidden) {
                    if ((gk.mustAppearMinCount.get(char) || 0) > 0) {
                         this.showError(`冲突: 字符 '${char}' 被全局禁用但又要求至少出现.`); return false;
                    }
                    if (gk.mustAppearExactCount.has(char) && gk.mustAppearExactCount.get(char) > 0) {
                         this.showError(`冲突: 字符 '${char}' 被全局禁用但又要求精确出现.`); return false;
                    }
                }
                return true;
            }


            async solve() {
                this.hideContextMenu();
                if (this.isRunning) return;
                
                    if (!this.preprocessConstraints()) {
                        return;
                    }
                

                this.isRunning = true;
                this.shouldStop = false;
                this.exportableState = null; // 清除任何先前的可导出状态

                // 如果不是恢复，则重置统计信息。如果恢复，则统计信息已加载。
                if (!this.resumeState) {
                    this.results = [];
                    this.searchedCount = 0;
                    this.startTime = Date.now();
                    this.charProbabilitiesData = [];
                } else {
                    // 恢复时，还原开始时间以正确计算总耗时。
                    this.startTime = Date.now() - (this.resumeState.stats.elapsedTime * 1000);
                }
                
                this.lastUIUpdate = Date.now();
                
                document.getElementById('solveBtn').classList.add('loading');
                document.getElementById('solveBtn').disabled = true;
                document.getElementById('clearBtn').classList.add('loading');
                document.getElementById('clearBtn').disabled = true;
                document.getElementById('addGuessRowBtn').classList.add('loading');
                document.getElementById('addGuessRowBtn').disabled = true;
                document.getElementById('exportSearchStateBtn').style.display = 'none';


                document.getElementById('solveBtn').style.display = 'none';
                document.getElementById('stopBtn').style.display = 'block';
                document.getElementById('progressContainer').style.display = 'block';
                document.getElementById('errorMessage').style.display = 'none';
                
                this.updateResults(); 
                this.updateCharProbabilitiesDisplay(); 
                 document.getElementById('recommendedResultContainer').innerHTML = 
                    '<div style="text-align: center; color: var(--color-text-secondary); padding: 20px;">求解中...</div>';

                
                try {
                    // 传入恢复状态，然后清除它，以免被意外再次使用
                    const stateToResume = this.resumeState;
                    this.resumeState = null;
                    await this.optimizedBruteForceSearch(stateToResume);
                } catch (error) {
                    this.showError('求解过程中出现错误: ' + error.message);
                } finally {
                    this.isRunning = false;
                    document.getElementById('solveBtn').classList.remove('loading');
                    document.getElementById('solveBtn').disabled = false;
                    document.getElementById('clearBtn').classList.remove('loading');
                    document.getElementById('clearBtn').disabled = false;
                    document.getElementById('addGuessRowBtn').classList.remove('loading');
                    document.getElementById('addGuessRowBtn').disabled = false;


                    document.getElementById('stopBtn').style.display = 'none';
                    
                    // 如果是用户停止了进程，则显示导出按钮
                    if (this.shouldStop && this.exportableState) {
                        document.getElementById('exportSearchStateBtn').style.display = 'block';
                    } else {
                        document.getElementById('solveBtn').style.display = 'block';
                    }
                    
                    this.updateStats();
                    this.calculateAndDisplayProbabilities(); 
                    this.updateResultsWithRecommendation(); 
                    if (this.shouldStop) {
                         document.getElementById('progressText').textContent = `已停止 - 搜索: ${this.searchedCount.toLocaleString()} - 找到: ${this.results.length}`;
                    } else {
                         document.getElementById('progressText').textContent = `完成 - 搜索: ${this.searchedCount.toLocaleString()} - 找到: ${this.results.length}`;
                         document.getElementById('progressFill').style.width = '100%';
                    }
                     if (this.results.length === 0 && !this.shouldStop) {
                        document.getElementById('progressContainer').style.display = 'none';
                    }
                }
            }

            stop() {
                this.shouldStop = true;
            }
            
            isDigit(c) { return c && c >= '0' && c <= '9'; }
            isBinaryOperator(c) { return c && ['+', '-', '*', '/', '%', '^', 'A'].includes(c); }
            isUnaryPostOperator(c) { return c === '!'; }
            isOperator(c) { return this.isBinaryOperator(c) || this.isUnaryPostOperator(c); }
            isOpenBracket(c) { return c && (c === '(' || c === '['); }
            isCloseBracket(c) { return c && (c === ')' || c === ']'); }
            isMainOperator(c) { return c && (c === '=' || c === '>'); }
            getMatchingBracket(openBracket) { return openBracket === '(' ? ')' : (openBracket === '[' ? ']' : null); }

            canPlaceChar(char, index, currentExpressionArray, mainOpSoFar, currentExpressionCounts, floorContext) {
                const gk = this.globalKnowledge;

                if (gk.globallyForbidden.has(char)) return false;
                if (gk.fixedChars[index] && gk.fixedChars[index] !== char) return false;
                if (gk.cannotBeAt[index].has(char)) return false;

                const currentCountOfChar = currentExpressionCounts.get(char) || 0;
                const exactCountForChar = gk.mustAppearExactCount.get(char);
                if (exactCountForChar !== undefined && currentCountOfChar >= exactCountForChar) {
                    return false; 
                }

                if (floorContext.inFloor) {
                    if (char === '[') return false;
                    if (this.isOperator(char) && char !== '/') return false;
                    if (this.isMainOperator(char)) return false;
                    if (char === '(') return false;
                    if (char === 'A' || char === '!') return false;

                    if (char === '/') {
                        if (floorContext.hasSlashInCurrentFloor) return false;
                        const prevActualChar = index > 0 ? currentExpressionArray[index-1] : null;
                        if (!this.isDigit(prevActualChar) || index === 0) return false;
                    } else if (char === ']') {
                        const prevActualChar = index > 0 ? currentExpressionArray[index-1] : null;
                        if (!this.isDigit(prevActualChar)) return false;
                        if (!floorContext.hasSlashInCurrentFloor) return false; 
                    } else if (!this.isDigit(char)) {
                        return false;
                    }
                }

                if (char === '[' && floorContext.inFloor) return false; 
                if (char === ']' && !floorContext.inFloor) return false; 
                if (char === '[') {
                     if (index >= this.length - 3) return false;
                }


                if (this.isDigit(char) && mainOpSoFar !== '=') { 
                    let tempNumStr = char;
                    let k = index - 1;
                    while (k >= 0 && this.isDigit(currentExpressionArray[k])) {
                        tempNumStr = currentExpressionArray[k] + tempNumStr;
                        k--;
                    }

                    if (tempNumStr.length > 1 && tempNumStr.startsWith('0')) {
                        return false; 
                    }
                    
                    const charBeforeNumberSequence = (k >= 0) ? currentExpressionArray[k] : null;
                    if (charBeforeNumberSequence === null || 
                        this.isOperator(charBeforeNumberSequence) || 
                        this.isOpenBracket(charBeforeNumberSequence) ||
                        this.isMainOperator(charBeforeNumberSequence)) {
                            if (parseInt(tempNumStr, 10) > this.maxOperandValue) {
                                return false; 
                            }
                    }
                }

                const prevChar = index > 0 ? currentExpressionArray[index - 1] : null;

                if (index === 0) { 
                    if (this.isBinaryOperator(char) || this.isCloseBracket(char) || this.isMainOperator(char) || this.isUnaryPostOperator(char)) return false;
                }

                if (prevChar) {
                    if (this.isDigit(prevChar)) {
                        if (this.isOpenBracket(char) && char !== '[') return false; 
                        if (char === '[' && floorContext.inFloor) return false;
                    } else if (this.isOperator(prevChar)) { 
                        if (this.isBinaryOperator(char) && !(prevChar === 'A' && (this.isOpenBracket(char) || this.isDigit(char))) && !this.isUnaryPostOperator(prevChar)) return false; 
                        if (this.isCloseBracket(char)) return false; 
                        if (this.isMainOperator(char) && !this.isUnaryPostOperator(prevChar)) return false; 
                        if (this.isUnaryPostOperator(prevChar) && (this.isDigit(char) || this.isOpenBracket(char))) return false; 
                    } else if (this.isOpenBracket(prevChar)) {
                        if (prevChar === '[' && char === '(') return false; 
                        if (this.isBinaryOperator(char)) return false; 
                        if (this.isCloseBracket(char) && char !== this.getMatchingBracket(prevChar)) return false; 
                        if (this.isMainOperator(char)) return false; 
                        if (this.isUnaryPostOperator(char)) return false; 
                    } else if (this.isCloseBracket(prevChar)) {
                        if (this.isDigit(char)) return false; 
                        if (this.isOpenBracket(char)) return false; 
                    } else if (this.isMainOperator(prevChar)) { 
                         if (prevChar === '=') { 
                             if (!this.isDigit(char) && char !== '-') return false; 
                         } else { 
                             if (this.isMainOperator(char)) return false; 
                             if (this.isCloseBracket(char)) return false; 
                         }
                    }
                }

                if (mainOpSoFar === '=') { 
                    if (!this.isDigit(char) && char !== '-') return false;
                    if (char === '-' && (prevChar !== '=' || index >= this.length -1 || !this.isDigit(currentExpressionArray[index+1]))) {
                        // Allow '-' only right after '=', and if not at the very end, and followed by a digit
                        // This is a simplification. True parsing of negative numbers is complex.
                        // For this check, if char is '-', it implies potential negative number.
                        // If prevChar is not '=', then '-' is an operator, not a sign.
                        if (prevChar !== '=') { /* do nothing, standard operator rules apply */ }
                        else if (index >= this.length -1) return false; // - at the very end like ...=-
                        // The char after '-' must be a digit for a negative number. This needs lookahead or different parsing.
                        // For now, this rule is a bit loose.
                    }
                }


                if (index === this.length - 1) { 
                    if (this.isBinaryOperator(char) || this.isOpenBracket(char) || this.isMainOperator(char)) return false;
                }
                
                let tempExpressionForBracketCheck = currentExpressionArray.slice(0, index);
                tempExpressionForBracketCheck.push(char);
                let openParenDepth = 0;
                let openSquareDepth = 0;
                const openBracketsStack = [];

                for (let i = 0; i < tempExpressionForBracketCheck.length; i++) {
                    const c = tempExpressionForBracketCheck[i];
                    if (!c) continue;
                    if (c === '(') { openParenDepth++; openBracketsStack.push(c); }
                    else if (c === '[') { openSquareDepth++; openBracketsStack.push(c); }
                    else if (c === ')') {
                        openParenDepth--;
                        if (openParenDepth < 0 || openBracketsStack.pop() !== '(') return false;
                    } else if (c === ']') {
                        openSquareDepth--;
                         if (openSquareDepth < 0 || openBracketsStack.pop() !== '[') return false;
                    }
                }
                if (index === this.length - 1 && (openParenDepth !== 0 || openSquareDepth !== 0)) return false;

                if (this.isMainOperator(char)) {
                    if (mainOpSoFar && mainOpSoFar !== char && !(mainOpSoFar === '>' && char === '=')) return false; 
                    if (mainOpSoFar === char && char === '=') return false; 
                    if (index === 0 || index >= this.length - 1) return false; 
                }
                
                if (char === 'A') {
                    if (!prevChar || (!this.isDigit(prevChar) && !this.isCloseBracket(prevChar))) return false; 
                }
                if (prevChar === 'A') {
                    if (!this.isDigit(char) && !this.isOpenBracket(char)) return false; 
                }

                if (char === '!') {
                    if (!prevChar) return false; 
                    if (this.isDigit(prevChar)) {
                        if (prevChar === '0' && this.evaluateExpression("0!") === null) return false; 
                    } else if (this.isCloseBracket(prevChar)) {
                        if (prevChar === ']') return false; 
                    } else {
                        return false; 
                    }
                }
                
                return true;
            }

            async _optimizedRecursiveSearch(index, currentExpression, mainOpSoFar, currentExpressionCounts, floorContext) {
                if (this.shouldStop) return;
                const gk = this.globalKnowledge;

                if (index === this.length) {
                    this.searchedCount++;
                    if (!mainOpSoFar) return; 
                    if (!this.checkBrackets(currentExpression.join(''))) return;

                    for (const [char, exactCount] of gk.mustAppearExactCount) {
                        if ((currentExpressionCounts.get(char) || 0) !== exactCount) return;
                    }
                    for (const [char, minCount] of gk.mustAppearMinCount) {
                         if (!gk.mustAppearExactCount.has(char)) {
                            if ((currentExpressionCounts.get(char) || 0) < minCount) return;
                        }
                    }
                    
                    if (this.isValidSolution(currentExpression.join(''))) {
                        this.results.push(currentExpression.join(''));
                        if (this.results.length <= 500) {
                             this.updateResultsWithRecommendation();
                        }
                    }
                    if (this.searchedCount % 20000 === 0 || (Date.now() - this.lastUIUpdate > 100)) {
                        this.updateStats();
                        this.updateProgressWithSearchedCount();
                        if (this.results.length > 500 && this.results.length % 100 === 0) {
                            this.updateResultsWithRecommendation();
                        }
                        this.lastUIUpdate = Date.now();
                        await new Promise(resolve => setTimeout(resolve, 0));
                    }
                    return;
                }
                
                const fixedCharForThisPosition = gk.fixedChars[index];

                if (fixedCharForThisPosition) {
                    let nextFloorContext = { ...floorContext };
                    if (fixedCharForThisPosition === '[') nextFloorContext = { inFloor: true, hasSlashInCurrentFloor: false };
                    else if (fixedCharForThisPosition === ']' && floorContext.inFloor) nextFloorContext = { inFloor: false, hasSlashInCurrentFloor: false };
                    else if (fixedCharForThisPosition === '/' && floorContext.inFloor) nextFloorContext = { ...floorContext, hasSlashInCurrentFloor: true };
                    
                    if (this.canPlaceChar(fixedCharForThisPosition, index, currentExpression, mainOpSoFar, currentExpressionCounts, floorContext)) {
                        currentExpression[index] = fixedCharForThisPosition;
                        currentExpressionCounts.set(fixedCharForThisPosition, (currentExpressionCounts.get(fixedCharForThisPosition) || 0) + 1);
                        const newMainOp = this.isMainOperator(fixedCharForThisPosition) ? fixedCharForThisPosition : mainOpSoFar;
                        
                        await this._optimizedRecursiveSearch(index + 1, currentExpression, newMainOp, currentExpressionCounts, nextFloorContext);
                        
                        currentExpressionCounts.set(fixedCharForThisPosition, currentExpressionCounts.get(fixedCharForThisPosition) - 1);
                        if(currentExpressionCounts.get(fixedCharForThisPosition) === 0) currentExpressionCounts.delete(fixedCharForThisPosition);

                    }
                } else {
                    const optimizedCharOrder = this.getOptimizedCharOrder(index, currentExpression, mainOpSoFar, floorContext);
                    for (const charToTry of optimizedCharOrder) {
                        if (this.shouldStop) return;
                        
                        let nextFloorContext = { ...floorContext };
                        if (charToTry === '[') nextFloorContext = { inFloor: true, hasSlashInCurrentFloor: false };
                        else if (charToTry === ']' && floorContext.inFloor) nextFloorContext = { inFloor: false, hasSlashInCurrentFloor: false };
                        else if (charToTry === '/' && floorContext.inFloor) nextFloorContext = { ...floorContext, hasSlashInCurrentFloor: true };

                        if (this.canPlaceChar(charToTry, index, currentExpression, mainOpSoFar, currentExpressionCounts, floorContext)) {
                            currentExpression[index] = charToTry;
                            currentExpressionCounts.set(charToTry, (currentExpressionCounts.get(charToTry) || 0) + 1);
                            const newMainOp = this.isMainOperator(charToTry) ? charToTry : mainOpSoFar;

                            await this._optimizedRecursiveSearch(index + 1, currentExpression, newMainOp, currentExpressionCounts, nextFloorContext);
                            
                            currentExpressionCounts.set(charToTry, currentExpressionCounts.get(charToTry) - 1);
                            if(currentExpressionCounts.get(charToTry) === 0) currentExpressionCounts.delete(charToTry);
                        }
                    }
                }
                currentExpression[index] = ''; 
            }

            getOptimizedCharOrder(index, currentExpression, mainOpSoFar, floorContext) {
                const gk = this.globalKnowledge;
                if (gk.fixedChars[index]) {
                    return [gk.fixedChars[index]];
                }

                let orderedChars = [];
                const prevChar = index > 0 ? currentExpression[index - 1] : null;

                if (floorContext.inFloor) {
                    if (floorContext.hasSlashInCurrentFloor) {
                        orderedChars = ['0','1','2','3','4','5','6','7','8','9', ']'];
                    } else {
                        orderedChars = ['0','1','2','3','4','5','6','7','8','9', '/'];
                    }
                } else if (mainOpSoFar === '=') {
                     if (prevChar === '=') {
                        orderedChars = ['-', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
                    } else {
                        orderedChars = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
                    }
                } else if (index === 0) {
                    orderedChars = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '(', '[']; 
                } else if (this.isDigit(prevChar)) {
                    orderedChars = ['0','1','2','3','4','5','6','7','8','9', 
                                    '+', '-', '*', '/', '%', '^', 'A', '!', 
                                    ')', ']', '[', 
                                    '=', '>'];
                } else if (this.isBinaryOperator(prevChar) || prevChar === 'A' || (this.isMainOperator(prevChar) && prevChar !== '=')) {
                    orderedChars = ['1','2','3','4','5','6','7','8','9','0', '(', '['];
                } else if (this.isOpenBracket(prevChar)) {
                    orderedChars = ['1','2','3','4','5','6','7','8','9','0', '(', '['];
                } else if (this.isCloseBracket(prevChar) || this.isUnaryPostOperator(prevChar)) {
                    orderedChars = ['+', '-', '*', '/', '%', '^', 'A', '!', 
                                    ')', ']', '[',
                                    '=', '>'];
                } else { 
                    orderedChars = ['1','2','3','4','5','6','7','8','9','0',
                                    '+','-','*','/', '=', 
                                    '(','[', ')',']',
                                    '%','^','!','A','>'];
                }

                if (index === this.length - 1 && !floorContext.inFloor) {
                    const endChars = ['0','1','2','3','4','5','6','7','8','9', ')', ']', '!'];
                    orderedChars = orderedChars.filter(c => endChars.includes(c));
                     if (orderedChars.length === 0 && prevChar) { 
                         orderedChars = endChars;
                     } else if (orderedChars.length === 0 && index === 0 && this.length === 1) { 
                         orderedChars = ['0','1','2','3','4','5','6','7','8','9'];
                     }
                }
                
                return [...new Set(orderedChars)].filter(c => 
                    !gk.globallyForbidden.has(c) && 
                    !gk.cannotBeAt[index].has(c)
                );
            }
            prepareExportState(topLevelChars, currentIndex) {
                const elapsedTime = (Date.now() - this.startTime) / 1000;
                this.exportableState = {
                    version: "1.0",
                    length: this.length,
                    rows: this.guessRowsData,
                    results: this.results,
                    stats: {
                        searchedCount: this.searchedCount,
                        elapsedTime: elapsedTime
                    },
                    progress: {
                        topLevelChars: topLevelChars,
                        resumeIndex: currentIndex // 从这个索引恢复
                    }
                };
            }

            exportSearchState() {
                if (!this.exportableState) {
                    this.showError("没有可导出的暂停状态。请先运行并停止一个搜索。");
                    return;
                }
                
                try {
                    this.showError("正在生成状态文件...");
                    const stateString = JSON.stringify(this.exportableState);
                    const blob = new Blob([stateString], { type: 'application/json' });
                    
                    const a = document.createElement('a');
                    const url = URL.createObjectURL(blob);
                    a.href = url;
                    
                    const timestamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
                    a.download = `sumzle_solver_state_${timestamp}.json`;
                    
                    document.body.appendChild(a);
                    a.click();
                    
                    setTimeout(() => {
                        document.body.removeChild(a);
                        URL.revokeObjectURL(url);
                        this.showError("状态文件已导出。");
                    }, 0);

                } catch (err) {
                    this.showError("导出失败: " + err.message);
                }
            }
handleFileImport(event) {
                const fileInput = event.target;
                const file = fileInput.files[0];
                if (!file) {
                    return; // No file selected
                }

                this.showError("正在读取状态文件...");
                const reader = new FileReader();

                reader.onload = (e) => {
                    try {
                        const stateString = e.target.result;
                        const state = JSON.parse(stateString);
                        
                        if (state.version !== "1.0" || !state.progress || !state.rows) {
                            throw new Error("状态文件无效或版本不兼容。");
                        }
                        
                        this.clear();

                        setTimeout(() => {
                            // Restore state from file
                            this.length = state.length;
                            this.guessRowsData = state.rows;
                            this.results = state.results;
                            this.searchedCount = state.stats.searchedCount;
                            this.resumeState = state; // Store full state for the solve method

                            // Update UI
                            document.getElementById('lengthInput').value = this.length;
                            this.updateConstraintBoard();
                            this.updateResultsWithRecommendation();
                            
                            const elapsed = state.stats.elapsedTime;
                            const speed = elapsed > 0 ? Math.round(this.searchedCount / elapsed) : 0;
                            document.getElementById('foundCount').textContent = this.results.length.toLocaleString();
                            document.getElementById('searchedCount').textContent = this.searchedCount.toLocaleString();
                            document.getElementById('timeElapsed').textContent = elapsed.toFixed(1) + 's';
                            document.getElementById('searchSpeed').textContent = speed.toLocaleString();
                            this.calculateAndDisplayProbabilities();

                            this.showError("状态导入成功！点击 '开始求解' 以继续。");
                            document.getElementById('exportSearchStateBtn').style.display = 'none';
                        }, 100);

                    } catch (err) {
                        this.showError("导入失败: " + err.message);
                        this.resumeState = null;
                    } finally {
                        // Reset file input to allow importing the same file again
                        fileInput.value = null;
                    }
                };

                reader.onerror = () => {
                    this.showError("读取文件时出错。");
                    fileInput.value = null;
                };

                reader.readAsText(file);
            }

            importSearchState() {
                const textarea = document.getElementById('searchStateInput');
                const stateString = textarea.value.trim();
                if (!stateString) {
                    this.showError("请粘贴要导入的搜索状态。");
                    return;
                }
                try {
                    const state = JSON.parse(stateString);
                    if (state.version !== "1.0" || !state.progress || !state.rows) {
                        throw new Error("状态码无效或版本不兼容。");
                    }
                    
                    this.clear();

                    setTimeout(() => {
                        // 恢复状态
                        this.length = state.length;
                        this.guessRowsData = state.rows;
                        this.results = state.results;
                        this.searchedCount = state.stats.searchedCount;
                        this.resumeState = state; // 为 solve 方法存储完整状态

                        // 更新UI
                        document.getElementById('lengthInput').value = this.length;
                        this.updateConstraintBoard();
                        this.updateResultsWithRecommendation();
                        
                        const elapsed = state.stats.elapsedTime;
                        const speed = elapsed > 0 ? Math.round(this.searchedCount / elapsed) : 0;
                        document.getElementById('foundCount').textContent = this.results.length.toLocaleString();
                        document.getElementById('searchedCount').textContent = this.searchedCount.toLocaleString();
                        document.getElementById('timeElapsed').textContent = elapsed.toFixed(1) + 's';
                        document.getElementById('searchSpeed').textContent = speed.toLocaleString();
                        this.calculateAndDisplayProbabilities();

                        this.showError("状态导入成功！点击 '开始求解' 以继续。");
                        document.getElementById('exportSearchStateBtn').style.display = 'none';
                    }, 100);

                } catch (e) {
                    this.showError("导入失败: " + e.message);
                    this.resumeState = null;
                }
            }

            async optimizedBruteForceSearch(resumeState = null) {
                this.lastUIUpdate = Date.now();
                const initialExpression = Array(this.length).fill('');
                const initialCounts = new Map();
                const initialFloorContext = { inFloor: false, hasSlashInCurrentFloor: false };
                
                // 确定第一个位置（索引0）的字符集
                const topLevelChars = resumeState ? resumeState.progress.topLevelChars : this.getOptimizedCharOrder(0, initialExpression, null, initialFloorContext);
                const totalTopLevelBranches = topLevelChars.length;
                
                // 确定起点
                let startBranchIndex = resumeState ? resumeState.progress.resumeIndex : 0;

                for (let i = startBranchIndex; i < totalTopLevelBranches; i++) {
                    const charToTry = topLevelChars[i];
                    
                    // 检查是否需要停止
                    if (this.shouldStop) {
                        this.prepareExportState(topLevelChars, i);
                        return; // 退出搜索
                    }
                    
                    // 根据顶层循环更新进度
                    const progressPercentage = ((i + 1) / totalTopLevelBranches) * 100;
                    this.updateProgress(progressPercentage);
                    
                    let nextFloorContext = { ...initialFloorContext };
                    if (charToTry === '[') nextFloorContext = { inFloor: true, hasSlashInCurrentFloor: false };
                    else if (charToTry === ']' && initialFloorContext.inFloor) nextFloorContext = { inFloor: false, hasSlashInCurrentFloor: false };
                    else if (charToTry === '/' && initialFloorContext.inFloor) nextFloorContext = { ...initialFloorContext, hasSlashInCurrentFloor: true };

                    if (this.canPlaceChar(charToTry, 0, initialExpression, null, initialCounts, initialFloorContext)) {
                        initialExpression[0] = charToTry;
                        initialCounts.set(charToTry, (initialCounts.get(charToTry) || 0) + 1);
                        const newMainOp = this.isMainOperator(charToTry) ? charToTry : null;

                        // 从第二个位置（索引1）开始递归
                        await this._optimizedRecursiveSearch(1, initialExpression, newMainOp, initialCounts, nextFloorContext);
                        
                        // 为下一个顶层字符进行回溯
                        initialCounts.set(charToTry, initialCounts.get(charToTry) - 1);
                        if(initialCounts.get(charToTry) === 0) initialCounts.delete(charToTry);
                    }
                }
                // 对表达式数组的最终回溯
                initialExpression[0] = '';
            }
            
            updateProgress(percentage) {
                const fill = document.getElementById('progressFill');
                const text = document.getElementById('progressText');
                
                const cappedPercentage = Math.min(100, percentage);
                fill.style.width = `${cappedPercentage}%`;
                text.textContent = `进度: ${cappedPercentage.toFixed(1)}% - 已搜索: ${this.searchedCount.toLocaleString()} - 找到: ${this.results.length}`;
            }

            isValidSolution(expression) {
                return this.isValidEquation(expression);
            }
        isInteger(value) {
            return typeof value === 'number' && !isNaN(value) && isFinite(value) && Number.isInteger(value);
        }

        isValidEquation(expression) {
            try {
                if (!this.checkBrackets(expression)) return false;
                
                let mainOp = null;
                let mainOpIndex = -1;
                let depth = 0;
                let hasMinusOnRHSStart = false;
                
                for (let i = 0; i < expression.length; i++) {
                    const char = expression[i];
                    if (this.isOpenBracket(char)) depth++;
                    else if (this.isCloseBracket(char)) depth--;
                    else if (depth === 0 && this.isMainOperator(char)) {
                        if (mainOp !== null && mainOp !== char) { 
                            if (!(mainOp === '>' && char === '=')) return false; 
                        }
                        if (mainOp === null) {
                            mainOp = char;
                            mainOpIndex = i;
                        } else if (char === '=' && mainOp === '>') { 
                             mainOp = '>='; 
                        } else if (mainOp === '=' && char === '=') { 
                            return false; 
                        }
                    }
                }
                
                if (!mainOp || mainOpIndex === 0 || mainOpIndex === expression.length - 1) return false;
                
                let leftSideString = expression.substring(0, mainOpIndex - (mainOp === '>=' ? 1:0) );
                let rightSideString = expression.substring(mainOpIndex + 1);

                if (mainOp === '=' && rightSideString.startsWith('-')) {
                    hasMinusOnRHSStart = true;
                }


                 if (leftSideString.length === 0 || rightSideString.length === 0) return false;
                 if (hasMinusOnRHSStart && rightSideString.length === 1) return false; // Just "=" or "=-"
                
                const leftValue = this.evaluateExpression(leftSideString);
                const rightValue = this.evaluateExpression(rightSideString);
                
                if (leftValue === null || rightValue === null) return false;
                
                if (!this.isInteger(leftValue) || !this.isInteger(rightValue)) {
                    return false;
                }
                
                if (mainOp === '=' && !this.isSimpleNumberOrNegativeNumber(rightSideString)) {
                    return false;
                }
                
                if (mainOp === '=') return leftValue === rightValue; 
                if (mainOp === '>' || mainOp === '>=') return leftValue > rightValue; 
                
            } catch (error) { return false; }
            return false;
        }

            isSimpleNumberOrNegativeNumber(expr) {
                return /^-?\d+$/.test(expr.trim());
            }
           
            checkBrackets(expression) {
                const stack = [];
                for (const char of expression) {
                    if (this.isOpenBracket(char)) stack.push(char);
                    else if (this.isCloseBracket(char)) {
                        if (stack.length === 0) return false;
                        const lastOpen = stack.pop();
                        if (char !== this.getMatchingBracket(lastOpen)) return false;
                    }
                }
                return stack.length === 0;
            }

            evaluateExpression(expr) {
                try {
                    if (expr.length === 0) return null;
                    let processedExpr = expr;

                    let bracketIterations = 0;
                    const maxBracketIterations = 10; 
                    while (/\[[^\[\]]+\]/.test(processedExpr) && bracketIterations < maxBracketIterations) {
                        processedExpr = processedExpr.replace(/\[([^\[\]]+)\]/g, (match, innerExpr) => {
                            if (!/^\d+\/\d+$/.test(innerExpr) && !/^\d+$/.test(innerExpr) ) { 
                                if( /^\d+$/.test(innerExpr) ) {
                                   const val = this.evaluateExpression(innerExpr);
                                   return (val !== null && typeof val === 'number' && !isNaN(val)) ? Math.floor(val).toString() : 'NaN';
                                }
                                return 'NaN'; 
                            }
                            if (innerExpr.trim() === '') return 'NaN'; 
                            const val = this.evaluateExpression(innerExpr);
                            return (val !== null && typeof val === 'number' && !isNaN(val)) ? Math.floor(val).toString() : 'NaN';
                        });
                        bracketIterations++;
                    }
                    if (bracketIterations >= maxBracketIterations && /\[[^\[\]]+\]/.test(processedExpr)) return null;

                    if (processedExpr.includes('NaN')) return null;

                    processedExpr = processedExpr.replace(/(\d+)!/g, (match, numStr) => {
                        const n = parseInt(numStr);
                        if (n === 0) return '1'; 
                        if (n > 12 || n < 0) return 'NaN'; 
                        let factorial = 1;
                        for (let i = 2; i <= n; i++) factorial *= i;
                        return factorial.toString();
                    });
                    if (processedExpr.includes('NaN')) return null;

                    processedExpr = processedExpr.replace(/(\d+)A(\d+)/g, (match, mStr, nStr) => {
                        const mVal = parseInt(mStr);
                        const nVal = parseInt(nStr);
                        if (mVal > 10 || nVal > 10 || nVal > mVal || mVal < 0 || nVal < 0) return 'NaN'; 
                        let result = 1;
                        for (let i = 0; i < nVal; i++) result *= (mVal - i);
                        return result.toString();
                    });
                    if (processedExpr.includes('NaN')) return null;

                    processedExpr = processedExpr.replace(/\^/g, '**'); 
                    
                    return this.evaluateSimpleExpression(processedExpr);
                } catch (error) { 
                    return null; 
                }
            }

            evaluateSimpleExpression(expr) {
                try {
                    if (expr.includes('NaN')) return null;
                    if (/\b0[0-9]+\b/.test(expr) && !expr.startsWith("0.")) return null;

                    const invalidPatterns = [
                        /[\+\-\*\/%]{2,}(?!\*)/, 
                        /(^[\*\/%])|([\+\-\*\/%]$)(?<!\d-)/, 
                        /\(\)/, /\[\]/, 
                        /\(\s*\)/, /\[\s*\]/, 
                        /\d+\s+\d+/, 
                        /\)\(/,       
                        /\d\(/,       
                        /\)\d/,       
                    ];
                    for (const pattern of invalidPatterns) {
                         if (pattern.test(expr.replace(/\*\*/g,"").replace(/(\d)-/g, '$1_minus_'))) return null; 
                    }

                    const allowedCharsPattern = /^[0-9.+\-*/%()\s]+$/; 
                    if (!allowedCharsPattern.test(expr.replace(/\*\*/g, ""))) return null;
                    
                    const result = Function('"use strict"; return (' + expr + ')')();
                    if (typeof result === 'number' && !isNaN(result) && isFinite(result)) {
                        return result;
                    }
                    return null;
                } catch (error) { return null; }
            }

        

        updateProgressWithSearchedCount() {
            const text = document.getElementById('progressText');
            text.textContent = `已搜索: ${this.searchedCount.toLocaleString()} - 找到: ${this.results.length}`;
            const fill = document.getElementById('progressFill');
            if(this.results.length > 0 && fill.style.width === "0%") { 
                fill.style.width = "5%"; 
            }
        }

        updateStats() {
            const elapsed = (Date.now() - this.startTime) / 1000;
            const speed = elapsed > 0 ? Math.round(this.searchedCount / elapsed) : 0;
            
            document.getElementById('foundCount').textContent = this.results.length.toLocaleString();
            document.getElementById('searchedCount').textContent = this.searchedCount.toLocaleString();
            document.getElementById('timeElapsed').textContent = elapsed.toFixed(1) + 's';
            document.getElementById('searchSpeed').textContent = speed.toLocaleString();
        }

        updateResults(highlightedRecommendedSolution = null) {
            const container = document.getElementById('resultsContainer');
            
            if (this.results.length === 0 && !this.isRunning) {
                container.innerHTML = '<div style="text-align: center; color: var(--color-text-secondary); padding: 40px;">暂无找到符合条件的解</div>';
                return;
            }
             if (this.results.length === 0 && this.isRunning) {
                container.innerHTML = '<div style="text-align: center; color: var(--color-text-secondary); padding: 40px;">正在搜索...</div>';
                return;
            }
            
            let html = `<div class="result-count">找到 ${this.results.length} 个解${this.results.length > 500 ? " (仅显示前500)" : ""}:</div>`;
            this.results.slice(0, 500).forEach((result, index) => {
                let displayResult = result;
                let tempResult = result;
                for (const [actual, display] of Object.entries(this.displayCharsMap)) {
                    const regex = new RegExp(actual.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
                    tempResult = tempResult.replace(regex, display);
                }
                displayResult = tempResult;

                const isRecommended = result === highlightedRecommendedSolution;
                const itemClass = isRecommended ? "result-item recommended" : "result-item";
                html += `<div class="${itemClass}">${index + 1}. ${displayResult} ${isRecommended ? " (⭐推荐)" : ""}</div>`;
            });
            
            container.innerHTML = html;
        }

        updateResultsWithRecommendation() {
            const recommendedContainer = document.getElementById('recommendedResultContainer');

            if (this.results.length === 0) {
                this.updateResults();
                recommendedContainer.innerHTML = '<div style="text-align: center; color: var(--color-text-secondary); padding: 20px;">无解则无推荐</div>';
                return;
            }
            if (this.charProbabilitiesData.length === 0 && this.results.length > 0) {
                 this.calculateAndDisplayProbabilities();
            }


            let bestSolution = null;
            let bestScore = -1;

            const topChars = this.charProbabilitiesData.slice(0, Math.min(5, this.charProbabilitiesData.length)).map(p => p.char);

            this.results.forEach(solution => {
                let score = 0;
                const uniqueCharsInSolution = new Set(solution.split(''));
                
                uniqueCharsInSolution.forEach(char => {
                    const probItem = this.charProbabilitiesData.find(p => p.char === char);
                    if (probItem) {
                        score += probItem.probability; 
                    }
                });
                
                let bonusForTopChars = 0;
                topChars.forEach(topChar => {
                    if(uniqueCharsInSolution.has(topChar)) bonusForTopChars += 50; 
                });
                score += bonusForTopChars;

                if (score > bestScore) {
                    bestScore = score;
                    bestSolution = solution;
                }
            });
            
            if (bestSolution) {
                let displayRecResult = bestSolution;
                 let tempRecResult = bestSolution;
                for (const [actual, display] of Object.entries(this.displayCharsMap)) {
                    const regex = new RegExp(actual.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
                    tempRecResult = tempRecResult.replace(regex, display);
                }
                displayRecResult = tempRecResult;
                recommendedContainer.innerHTML = `<div class="recommended-result-item">${displayRecResult}</div>`;
            } else {
                recommendedContainer.innerHTML = '<div style="text-align: center; color: var(--color-text-secondary); padding: 20px;">无可用推荐</div>';
            }
            
            this.updateResults(bestSolution);
        }
        
        calculateAndDisplayProbabilities() {
            const charCounts = {};
            if (this.results.length === 0) {
                this.charProbabilitiesData = []; 
                this.updateCharProbabilitiesDisplay();
                return;
            }

            this.results.forEach(solution => {
                const uniqueCharsInSolution = new Set(solution.split(''));
                uniqueCharsInSolution.forEach(char => {
                    charCounts[char] = (charCounts[char] || 0) + 1;
                });
            });

            this.charProbabilitiesData = Object.entries(charCounts).map(([char, count]) => ({
                char,
                probability: (count / this.results.length) * 100
            })).sort((a, b) => b.probability - a.probability || a.char.localeCompare(b.char));
            
            this.updateCharProbabilitiesDisplay();
        }

        updateCharProbabilitiesDisplay() {
            const container = document.getElementById('charProbContainer');
            if (this.charProbabilitiesData.length === 0) {
                container.innerHTML = '<div style="text-align: center; color: var(--color-text-secondary); padding: 20px;">无数据或未找到解</div>';
                return;
            }

            let html = '';
            const maxProb = Math.max(...this.charProbabilitiesData.map(p => p.probability), 0);

            this.charProbabilitiesData.forEach(item => {
                const displayChar = this.displayCharsMap[item.char] || item.char;
                const barWidth = maxProb > 0 ? (item.probability / maxProb) * 100 : 0;
                html += `
                    <div class="prob-item">
                        <div class="prob-char-display">${displayChar}</div>
                        <div class="prob-bar-container">
                            <div class="prob-bar" style="width: ${barWidth}%;"></div>
                        </div>
                        <div class="prob-value">${item.probability.toFixed(1)}%</div>
                    </div>
                `;
            });
            container.innerHTML = html;
        }

        clear() {
            this.hideContextMenu();
            this.isRunning = false;
            this.shouldStop = true; 
            
            setTimeout(() => { 
                this.results = [];
                this.searchedCount = 0;
                this.globalKnowledge = {}; 
                this.charProbabilitiesData = [];
                
                this.guessRowsData = []; 
                document.getElementById('lengthInput').value = 6;
                this.length = 6;
                this.updateConstraintBoard(); 

                this.updateResults();
                this.updateStats();
                this.updateCharProbabilitiesDisplay();
                 document.getElementById('recommendedResultContainer').innerHTML = 
                    '<div style="text-align: center; color: var(--color-text-secondary); padding: 20px;">等待求解开始...</div>';


                document.getElementById('errorMessage').style.display = 'none';
                document.getElementById('progressContainer').style.display = 'none';
                document.getElementById('progressFill').style.width = '0%';
                document.getElementById('progressText').textContent = '准备中...';
                
                const solveBtn = document.getElementById('solveBtn');
                const clearBtn = document.getElementById('clearBtn');
                const addGuessRowBtn = document.getElementById('addGuessRowBtn');

                solveBtn.style.display = 'block';
                solveBtn.classList.remove('loading');
                solveBtn.disabled = false;
                clearBtn.classList.remove('loading');
                clearBtn.disabled = false;
                addGuessRowBtn.classList.remove('loading');
                addGuessRowBtn.disabled = false;
                document.getElementById('stopBtn').style.display = 'none';

                if (this.selectedTile && this.selectedTile.element) {
                    this.selectedTile.element.style.outline = '';
                }
                this.selectedTile = null;
                 document.getElementById('importGameStateInput').value = '';
            }, 50); 
        }

        showError(message) {
            const errorDiv = document.getElementById('errorMessage');
            errorDiv.textContent = message;
            errorDiv.style.display = 'block';
        }

        toggleTheme() {
            document.body.classList.toggle('dark-theme');
            const toggle = document.getElementById('themeToggle');
            toggle.textContent = document.body.classList.contains('dark-theme') ? '🌙' : '☀️';
        }

         importGameState() {
            const importInput = document.getElementById('importGameStateInput');
            const gameStateString = importInput.value.trim();
            if (!gameStateString) {
                this.showError("请输入要导入的局面码。");
                return;
            }
            try {
                const gameState = JSON.parse(gameStateString);
                if (!gameState || typeof gameState.length !== 'number' || !Array.isArray(gameState.rows) ) {
                    throw new Error("局面码格式无效或版本不兼容。");
                }

                this.clear(); 

                setTimeout(() => { 
                    this.length = gameState.length;
                    document.getElementById('lengthInput').value = this.length;
                   
                    this.guessRowsData = gameState.rows.map(row => 
                        row.map(tile => ({
                            char: tile.char || '',
                            state: tile.state || 'empty'
                        }))
                    );

                    this.updateConstraintBoard();
                    importInput.value = ''; 
                    
                    this.showError("局面导入成功！"); 
                    setTimeout(()=> {
                        const errorDiv = document.getElementById('errorMessage');
                        if (errorDiv.textContent === "局面导入成功！") {
                           errorDiv.style.display = 'none';
                        }
                    }, 2000);
                }, 100); 
            } catch (error) {
                this.showError("导入局面失败：" + error.message);
            }
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        new OptimizedSumzleSolver();
        if (!document.getElementById('foundCount').textContent || document.getElementById('foundCount').textContent === '0') {
            const stats = {foundCount: '0', searchedCount: '0', timeElapsed: '0.0s', searchSpeed: '0'};
            for(const id in stats) document.getElementById(id).textContent = stats[id];
            document.getElementById('charProbContainer').innerHTML = '<div style="text-align: center; color: var(--color-text-secondary); padding: 20px;">求解后显示概率</div>';
             document.getElementById('recommendedResultContainer').innerHTML = 
                    '<div style="text-align: center; color: var(--color-text-secondary); padding: 20px;">求解后显示推荐</div>';
            document.getElementById('resultsContainer').innerHTML = '<div style="text-align: center; color: var(--color-text-secondary); padding: 40px;">等待求解开始...</div>';
        }
    });
