/* ========================================
   ピアノ音当てゲーム - メインアプリケーション
   ======================================== */

/**
 * 第2段階: 音声システム本実装
 * - AudioContext + GainNode 完全構成
 * - BGMループ・フェード・二重再生防止
 * - 複数音同期再生
 * - Web Audio API 代替ピアノ音
 * - ミュート保持機能
 * - 全相対パス（B:ドライブ非依存）
 */

const App = (() => {
  'use strict';

  const DEFAULT_SETTINGS = {
    questionCount: 5, theme: 'cream', difficulty: 'normal',
    noteLabel: 'solfege', effectStrength: 'normal',
    masterVolume: 0.5, pianoVolume: 0.5, bgmVolume: 0.5,
    sfxVolume: 0.5, applauseVolume: 0.5, sfxEnabled: true, muted: false,
    heatmapMode: 'subtle', autoNext: true, screenShake: false, reducedBlinking: false,
    // Stage 9 lifecycle default.  This is intentionally not a history field.
    resultDisplayTime: 2000,
    midiEnabled: false,
    selectedMidiInputId: null,
    midiConfirmationMode: 'singleImmediate',
    midiAutoConfirmDelayMs: 500,
    midiOctaveOffset: 0,
    midiScreenKeyboardEnabled: true,
    midiSustainAffectsAnswer: false
    ,intervalPlaybackType: 'harmonic', intervalAnswerType: 'name'
    ,enabledChordTypes: [], enabledInversions: [], chordOctaveJudgement: 'exact'
  };

  const DEFAULT_PROFILE = {
    id: 'default', name: 'デフォルト', icon: '🎹',
    settings: { ...DEFAULT_SETTINGS }, createdAt: null, updatedAt: null
  };

  const state = {
    initialized: false, audioReady: false,
    currentScreen: 'home', previousScreen: null, navigationRevision: 0, selectedSessionId: null,
    settings: { ...DEFAULT_SETTINGS },
    currentProfileId: null, profiles: {},
    currentSession: null, currentQuestion: null,
    selectedNotes: [],
    midiConnected: false,
    midiInputs: [],
    midiAccessRequested: false,
    midiAccessGranted: false,
    midiAccessFailed: false,
    midiNoApi: false,
    midiSelectedInputId: null,
    midiActiveNotes: new Map(),
    midiSustainedNotes: new Set(),
    midiAnswerNotes: new Set(),
    midiAutoConfirmTimer: null,
    midiLastVelocity: 0,
    midiSustainPedal: false,
    midiLogEntries: [],
    bgmPlaying: false, effectsPlaying: false,
    pianoSourceState: 'idle', pianoSourceDiagnostics: [],
    comboCount: 0, db: null,
    DB_NAME: 'PianoEarGameDB', DB_VERSION: 5 // Stage 8: MIDI data fields
  };

  // ========================================
  // DOMユーティリティ
  // ========================================

  const $ = (id) => document.getElementById(id);

  // ========================================
  // 演出ライフサイクル（第9段階：土台のみ）
  // ========================================
  // 演出そのものはここに追加する。回答・履歴・進行のデータは持たず、
  // 表示時間と次問題への遷移だけを一元管理する。
  const EffectsManager = {
    _token: 0,
    _active: null,
    _timers: new Set(),
    _animationFrames: new Set(),
    _temporaryNodes: new Set(),
    _activeAnimations: new Set(),
    _effectBag: [],
    _lastEffectName: null,
    _protectedKeys: new Set(['Enter', 'Escape', 'Backspace']),
    _keyHandler: null,

    _displayTime() {
      const configured = Number(state.settings?.resultDisplayTime);
      return Number.isFinite(configured) && configured >= 400 && configured <= 10000
        ? configured
        : 2000;
    },

    _effectStrength() {
      const strength = state.settings?.effectStrength;
      return ['none', 'subtle', 'normal', 'flashy'].includes(strength) ? strength : 'normal';
    },

    _prefersReducedMotion() {
      return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    },

    _effectConfig() {
      const strength = this._effectStrength();
      const reduced = this._hasReducedMotion();
      // Base config by strength level
      let cfg;
      if (strength === 'subtle') {
        cfg = { dur: 0.55, dist: 0.5, particles: 0.4, opacity: 0.7 };
      } else if (strength === 'flashy') {
        cfg = { dur: 1.0, dist: 1.3, particles: 1.5, opacity: 1.0 };
      } else {
        cfg = { dur: 1.0, dist: 1.0, particles: 1.0, opacity: 1.0 };
      }
      // Apply reduced-motion multiplier (accessibility overrides flashy)
      if (reduced) {
        cfg.dur *= 0.5;
        cfg.dist *= 0.4;
        cfg.particles *= 0.3;
        cfg.opacity *= 0.6;
      }
      return cfg;
    },

    _hasReducedMotion() {
      if (this._prefersReducedMotion()) return true;
      if (state.settings?.reducedBlinking === true) return true;
      return false;
    },

    _matches(active) {
      const session = state.currentSession;
      const question = state.currentQuestion;
      return state.currentScreen === 'session' &&
        this._active === active && this._token === active.effectToken &&
        session?.sessionId === active.sessionId &&
        session?.currentTurn === active.currentTurn &&
        question?.questionId === active.questionId && question?.answered === true;
    },

    _setTimer(callback, delay) {
      const timer = setTimeout(() => {
        this._timers.delete(timer);
        callback();
      }, delay);
      this._timers.add(timer);
      return timer;
    },

    requestFrame(callback) {
      const frame = requestAnimationFrame((timestamp) => {
        this._animationFrames.delete(frame);
        callback(timestamp);
      });
      this._animationFrames.add(frame);
      return frame;
    },

    createTemporaryElement(className = '') {
      const host = $('effects-host');
      if (!host) return null;
      const node = document.createElement('div');
      node.className = className;
      node.dataset.effectTemporary = 'true';
      host.appendChild(node);
      this._temporaryNodes.add(node);
      return node;
    },

    _installKeyProtection() {
      if (this._keyHandler) return;
      this._keyHandler = (event) => {
        if (!this.isActive() || !this._protectedKeys.has(event.key)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.key === 'Escape') this.skip();
      };
      document.addEventListener('keydown', this._keyHandler, true);
    },

    _removeKeyProtection() {
      if (!this._keyHandler) return;
      document.removeEventListener('keydown', this._keyHandler, true);
      this._keyHandler = null;
    },

    _render(active) {
      const host = $('effects-host');
      const skip = $('effects-skip-btn');
      if (host) {
        host.hidden = false;
        host.dataset.effectToken = String(active.effectToken);
        host.dataset.effectKind = active.kind;
        host.dataset.effectStrength = this._effectStrength();
      }
      if (skip) skip.hidden = false;
      if (active.kind === 'correct') this._presentCorrect(active);
      if (active.kind === 'incorrect') this._presentIncorrect(active);
    },

    _presentCorrect(active) {
      const question = state.currentQuestion;
      const session = state.currentSession;
      if (!question || !session || this._effectStrength() === 'none') return;

      const correctNotes = questionNotes(question, 'correct');
      const combo = Number(session.streakCount) || 0;
      const isPerfect = session.currentTurn + 1 === session.questionCount &&
        session.correctCount === session.questionCount;
      const card = this.createTemporaryElement('correct-effect-card');
      if (card) {
        const comboText = combo >= 2 ? `<span class="correct-effect-combo">${combo}連続正解</span>` : '';
        const perfectText = isPerfect ? '<span class="correct-effect-perfect">Perfect Session!</span>' : '';
        card.innerHTML = `<span class="correct-effect-mark" aria-hidden="true">✓</span><span class="correct-effect-copy"><strong>正解</strong>${comboText}${perfectText}</span>`;
      }

      correctNotes.forEach((note) => PianoKeyboard.setEffectKeyState(note, 'effect-correct'));

      AudioSystem.playCorrectChime({ combo, perfect: isPerfect, strength: this._effectStrength() });
    },

    _presentIncorrect(active) {
      const question = state.currentQuestion;
      if (!question || this._effectStrength() === 'none') return;

      const correctNotes = questionNotes(question, 'correct');
      const answerNotes = questionNotes(question, 'answer');
      const mode = question.mode || state.currentSession?.mode || 'single';
      const isChordNameMode = mode === 'chordName' || mode === 'chord-name';
      const isInversionMode = mode === 'chordInversion' || mode === 'inversion';
      const isIntervalMode = mode === 'interval';

      const noteName = (midi) => midiToNoteName(midi, state.settings.noteLabel || 'solfege');

      // --- Build card content ---
      let infoHtml = '';

      if (isIntervalMode) {
        const correctName = question.intervalName || '';
        const answerName = (question.selectedIntervalId && INTERVAL_DEFINITIONS.find(d => d.id === question.selectedIntervalId)?.name) || '';
        const diff = question.semitoneDistance;
        infoHtml = '<div class="incorrect-compare">';
        if (correctName) infoHtml += '<span class="incorrect-correct-label">正解: <strong>' + correctName + '</strong></span>';
        if (answerName) infoHtml += '<span class="incorrect-answer-label">回答: <strong>' + answerName + '</strong></span>';
        if (Number.isFinite(diff)) infoHtml += '<span class="incorrect-diff">差: ' + (diff > 0 ? '+' : '') + diff + '半音</span>';
        infoHtml += '</div>';
      } else if (isChordNameMode || isInversionMode) {
        const rootLabel = question.rootLabel || (correctNotes.length > 0 ? midiToNoteName(correctNotes[0], 'english').replace(/\d+/g, '') : '');
        const chordLabel = question.chordShortLabel || question.chordLabel || '';
        const invLabel = question.inversionLabel || '';
        const parts = [];
        if (question.componentsCorrect === true) parts.push('<span class="incorrect-part-ok">構成音✓</span>');
        else if (question.componentsCorrect === false) parts.push('<span class="incorrect-part-ng">構成音✗</span>');
        if (question.rootCorrect === true) parts.push('<span class="incorrect-part-ok">ルート✓</span>');
        else if (question.rootCorrect === false) parts.push('<span class="incorrect-part-ng">ルート✗</span>');
        if (question.chordTypeCorrect === true) parts.push('<span class="incorrect-part-ok">種類✓</span>');
        else if (question.chordTypeCorrect === false) parts.push('<span class="incorrect-part-ng">種類✗</span>');
        if (question.inversionCorrect === true) parts.push('<span class="incorrect-part-ok">転回✓</span>');
        else if (question.inversionCorrect === false) parts.push('<span class="incorrect-part-ng">転回✗</span>');
        infoHtml = '<div class="incorrect-compare"><span class="incorrect-correct-label">正解: <strong>' + rootLabel + chordLabel + ' ' + invLabel + '</strong></span>';
        if (parts.length) infoHtml += '<div class="incorrect-part-judgment">' + parts.join(' ') + '</div>';
        infoHtml += '</div>';
      } else {
        // Single, pair, triple, chord components: show note-by-note comparison
        const exactMatches = correctNotes.filter(function(n) { return answerNotes.indexOf(n) >= 0; });
        const missingNotes = correctNotes.filter(function(n) { return answerNotes.indexOf(n) < 0; });
        const extraNotes = answerNotes.filter(function(n) { return correctNotes.indexOf(n) < 0; });

        // For single note: show direction
        if (correctNotes.length === 1 && answerNotes.length === 1) {
          const cNote = correctNotes[0];
          const aNote = answerNotes[0];
          const diff = aNote - cNote;
          const absDiff = Math.abs(diff);
          const octDiff = Math.floor(absDiff / 12);
          const semiDiff = absDiff % 12;
          const direction = diff > 0 ? '高い' : (diff < 0 ? '低い' : '');
          infoHtml = '<div class="incorrect-compare">';
          infoHtml += '<span class="incorrect-correct-label">正解: <strong>' + noteName(cNote) + '</strong></span>';
          infoHtml += '<span class="incorrect-answer-label">回答: <strong>' + noteName(aNote) + '</strong></span>';
          if (diff !== 0) {
            const octText = octDiff > 0 ? octDiff + 'オクターブ ' : '';
            const semiText = semiDiff > 0 ? semiDiff + '半音' : '';
            infoHtml += '<span class="incorrect-diff">' + octText + semiText + (direction ? ' (' + direction + ')' : '') + '</span>';
          }
          infoHtml += '</div>';
        } else {
          // Multi-note comparison
          infoHtml = '<div class="incorrect-compare">';
          if (exactMatches.length > 0) {
            infoHtml += '<span class="incorrect-match-label">一致: <strong>' + exactMatches.map(noteName).join(' ') + '</strong></span>';
          }
          if (missingNotes.length > 0) {
            infoHtml += '<span class="incorrect-missing-label">不足: <strong>' + missingNotes.map(noteName).join(' ') + '</strong></span>';
          }
          if (extraNotes.length > 0) {
            infoHtml += '<span class="incorrect-extra-label">余分: <strong>' + extraNotes.map(noteName).join(' ') + '</strong></span>';
          }
          infoHtml += '</div>';
        }
      }

      const card = this.createTemporaryElement('incorrect-effect-card');
      if (card) {
        card.innerHTML = '<span class="incorrect-effect-mark" aria-hidden="true">✗</span><span class="incorrect-effect-copy"><strong>不正解</strong></span>' + infoHtml;
      }

      // Keyboard: mark correct notes green, wrong/answer notes red (non-overlapping)
      const wrongKeys = answerNotes.filter(function(n) { return correctNotes.indexOf(n) < 0; });
      correctNotes.forEach((note) => { PianoKeyboard.setEffectKeyState(note, 'effect-correct'); });
      wrongKeys.forEach((note) => { PianoKeyboard.setEffectKeyState(note, 'effect-wrong'); });
      AudioSystem.playSfxTone('incorrect');

      // Keyboard states persist until _clearPresentation() removes them at next question
      this._startKeyboardDisappearance();
    },

    // ---- Keyboard disappearance effects ----

    _getNonProtectedKeys() {
      const keys = [];
      PianoKeyboard._keys.forEach((el, midi) => {
        if (!el.classList.contains('effect-correct') && !el.classList.contains('effect-wrong')) {
          keys.push({ midi, element: el, isBlack: el.classList.contains('black-key') });
        }
      });
      return keys;
    },

    _effectDominoLeft(keys) {
      const cfg = this._effectConfig();
      keys.sort((a,b) => a.midi - b.midi);
      keys.forEach((key, i) => {
        const el = key.element;
        const dur = Math.round(500 * cfg.dur);
        const delay = Math.round(70 * cfg.dur);
        const anim = el.animate([
          { transform: 'perspective(600px) rotateX(0deg)', opacity: 1 },
          { transform: 'perspective(600px) rotateX(85deg)', opacity: 0.8 * cfg.opacity, offset: 0.6 },
          { transform: 'perspective(600px) rotateX(90deg)', opacity: 0 }
        ], { duration: dur, delay: delay, fill: 'forwards', easing: 'ease-in' });
        this._activeAnimations.add(anim);
      });
    },

    _effectDominoRight(keys) {
      const cfg = this._effectConfig();
      keys.sort((a,b) => b.midi - a.midi);
      keys.forEach((key, i) => {
        const el = key.element;
        const dur = Math.round(500 * cfg.dur);
        const delay = Math.round(70 * cfg.dur);
        const anim = el.animate([
          { transform: 'perspective(600px) rotateX(0deg)', opacity: 1 },
          { transform: 'perspective(600px) rotateX(85deg)', opacity: 0.8 * cfg.opacity, offset: 0.6 },
          { transform: 'perspective(600px) rotateX(90deg)', opacity: 0 }
        ], { duration: dur, delay: delay, fill: 'forwards', easing: 'ease-in' });
        this._activeAnimations.add(anim);
      });
    },

    _effectDrop(keys) {
      const cfg = this._effectConfig();
      const sorted = [...keys].sort((a,b) => a.midi - b.midi);
      sorted.forEach((key, i) => {
        const el = key.element;
        const rot = (Math.random() - 0.5) * 24 * cfg.dist;
        const dist1 = Math.round(100 * cfg.dist);
        const dist2 = Math.round(300 * cfg.dist);
        const dur = Math.round(650 * cfg.dur);
        const delay = Math.round(50 * cfg.dur);
        const anim = el.animate([
          { transform: 'translateY(0) rotate(0deg)', opacity: 1 },
          { transform: 'translateY(' + dist1 + 'px) rotate(' + rot + 'deg)', opacity: 0.6 * cfg.opacity, offset: 0.5 },
          { transform: 'translateY(' + dist2 + 'px) rotate(' + (rot * 1.5) + 'deg)', opacity: 0 }
        ], { duration: dur, delay: delay, fill: 'forwards', easing: 'cubic-bezier(0.22, 0.61, 0.36, 1)' });
        this._activeAnimations.add(anim);
      });
    },

    _effectFade(keys) {
      const cfg = this._effectConfig();
      keys.forEach((key, i) => {
        const el = key.element;
        const dur = Math.round(500 * cfg.dur);
        const delay = Math.round(20 * cfg.dur);
        const anim = el.animate([
          { opacity: 1 },
          { opacity: 0 }
        ], { duration: dur, delay: delay, fill: 'forwards', easing: 'ease-out' });
        this._activeAnimations.add(anim);
      });
    },

    _effectLaser(keys) {
      const cfg = this._effectConfig();
      const host = document.getElementById('piano-keyboard');
      if (!host) return;
      const sorted = [...keys].sort((a,b) => a.midi - b.midi);
      // Create laser beam element (skip temp DOM in subtle)
      if (cfg.dist > 0.5 || cfg.particles > 0.5) {
        const laser = document.createElement('div');
        laser.className = 'effect-laser-beam';
        const reducedLaser = this._hasReducedMotion();
        const laserColor = reducedLaser ? '#ff9999' : '#ff4444';
        const laserGlow = reducedLaser ? '#ffbbbb' : '#ff8888';
        const laserShadow = reducedLaser ? '0 0 6px 2px rgba(255,150,150,0.3)' : '0 0 12px 4px rgba(255,68,68,0.6)';
        laser.style.cssText = 'position:absolute;top:0;left:-6px;width:6px;height:100%;background:linear-gradient(to right, transparent 0%, ' + laserColor + ' 30%, ' + laserGlow + ' 50%, ' + laserColor + ' 70%, transparent 100%);box-shadow:' + laserShadow + ';z-index:20;pointer-events:none;';
        host.appendChild(laser);
        this._temporaryNodes.add(laser);
        const laserAnim = laser.animate([
          { left: '-6px' },
          { left: (host.offsetWidth + 6) + 'px' }
        ], { duration: Math.round(800 * cfg.dur), fill: 'forwards', easing: 'linear' });
        this._activeAnimations.add(laserAnim);
      }
      // Animate keys: compress then split as laser passes
      const totalDuration = Math.round(800 * cfg.dur);
      const perKeyDelay = totalDuration / sorted.length;
      sorted.forEach((key, i) => {
        const el = key.element;
        const splitDir = (i % 2 === 0) ? 1 : -1;
        const delay = i * perKeyDelay;
        const splitDist = Math.round(60 * cfg.dist);
        const splitDist2 = Math.round(120 * cfg.dist);
        const keyDur = Math.round(500 * cfg.dur);
        const anim = el.animate([
          { transform: 'scaleY(1) translateY(0)', opacity: 1, offset: 0 },
          { transform: 'scaleY(0.3) translateY(0)', opacity: 0.8 * cfg.opacity, offset: 0.15 },
          { transform: 'scaleY(0.1) translateY(' + (splitDir * splitDist) + 'px)', opacity: 0, offset: 0.5 },
          { transform: 'scaleY(0.05) translateY(' + (splitDir * splitDist2) + 'px)', opacity: 0 }
        ], { duration: keyDur, delay: Math.round(delay + totalDuration * 0.2), fill: 'forwards', easing: 'ease-out' });
        this._activeAnimations.add(anim);
      });
    },

    _effectExplosion(keys) {
      const cfg = this._effectConfig();
      const reducedBlink = this._hasReducedMotion();
      const host = document.getElementById('piano-keyboard');
      if (!host) return;
      keys.forEach((key) => {
        const el = key.element;
        const rect = el.getBoundingClientRect();
        const hostRect = host.getBoundingClientRect();
        const cx = rect.left - hostRect.left + rect.width / 2;
        const cy = rect.top - hostRect.top + rect.height / 2;
        // Animate key: scale up then shatter
        const keyAnim = el.animate([
          { transform: 'scale(1)', opacity: 1 },
          { transform: 'scale(' + (1 + 0.15 * cfg.dist) + ')', opacity: 0.9 * cfg.opacity, offset: 0.15 },
          { transform: 'scale(0.5)', opacity: 0.3 * cfg.opacity, offset: 0.5 },
          { transform: 'scale(0.1)', opacity: 0 }
        ], { duration: Math.round(600 * cfg.dur), fill: 'forwards', easing: 'ease-out' });
        this._activeAnimations.add(keyAnim);
        // Create particles per key (scaled by cfg.particles)
        const particleCount = Math.max(2, Math.round(8 * cfg.particles));
        for (let p = 0; p < particleCount; p++) {
          const particle = document.createElement('div');
          const angle = (p / particleCount) * 360 + Math.random() * 30;
          const dist = (40 + Math.random() * 80) * cfg.dist;
          const size = Math.max(2, Math.round((4 + Math.random() * 6) * Math.min(1, cfg.particles)));
          const color = reducedBlink ? (key.isBlack ? '#777' : '#ddd') : (key.isBlack ? '#555' : '#ccc');
          particle.style.cssText = 'position:absolute;width:' + size + 'px;height:' + size + 'px;background:' + color + ';border-radius:50%;left:' + (cx - size/2) + 'px;top:' + (cy - size/2) + 'px;z-index:15;pointer-events:none;';
          host.appendChild(particle);
          this._temporaryNodes.add(particle);
          const rad = angle * Math.PI / 180;
          const tx = Math.cos(rad) * dist;
          const ty = Math.sin(rad) * dist;
          const particleAnim = particle.animate([
            { transform: 'translate(0,0) scale(1)', opacity: 1 },
            { transform: 'translate(' + tx + 'px,' + ty + 'px) scale(0.5)', opacity: 0.7 * cfg.opacity, offset: 0.4 },
            { transform: 'translate(' + (tx * 1.8) + 'px,' + (ty * 1.8) + 'px) scale(0)', opacity: 0 }
          ], { duration: Math.round((550 + Math.random() * 150) * cfg.dur), fill: 'forwards', easing: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)' });
          this._activeAnimations.add(particleAnim);
        }
      });
    },

    _effectTornado(keys) {
      const cfg = this._effectConfig();
      const host = document.getElementById('piano-keyboard');
      if (!host) return;
      const hostRect = host.getBoundingClientRect();
      const centerX = hostRect.width / 2;
      const maxHeight = hostRect.height;
      // Create tornado visual element (skip in subtle)
      if (cfg.dist > 0.5) {
        const vortex = document.createElement('div');
        vortex.style.cssText = 'position:absolute;left:50%;top:50%;width:0;height:0;border-radius:50%;z-index:10;pointer-events:none;box-shadow:0 0 60px 20px rgba(180,180,200,0.15);transform:translate(-50%,-50%);';
        host.appendChild(vortex);
        this._temporaryNodes.add(vortex);
        const vortexAnim = vortex.animate([
          { boxShadow: '0 0 40px 10px rgba(180,180,200,0.1)', width: '0px', height: '0px' },
          { boxShadow: '0 0 100px 30px rgba(180,180,200,0.2)', width: Math.round(120 * cfg.dist) + 'px', height: Math.round(120 * cfg.dist) + 'px', offset: 0.5 },
          { boxShadow: '0 0 140px 40px rgba(180,180,200,0.05)', width: Math.round(200 * cfg.dist) + 'px', height: Math.round(200 * cfg.dist) + 'px' }
        ], { duration: Math.round(1000 * cfg.dur), fill: 'forwards', easing: 'ease-out' });
        this._activeAnimations.add(vortexAnim);
      }

      keys.forEach((key, i) => {
        const el = key.element;
        const rect = el.getBoundingClientRect();
        const kx = rect.left - hostRect.left + rect.width / 2;
        const ky = rect.top - hostRect.top + rect.height / 2;
        const dirX = centerX - kx;
        const dirY = -ky - maxHeight * 0.4;
        const stagger = Math.round(i * 50 * cfg.dur);
        // Spiral: multiple orbits while rising
        const orbits = 2 + Math.random();
        const spiralAngle = orbits * 360;
        const anim = el.animate([
          { transform: 'translate(0,0) rotate(0deg) scale(1)', opacity: 1 },
          { transform: 'translate(' + (dirX * 0.3 * cfg.dist) + 'px,' + (dirY * 0.2 * cfg.dist) + 'px) rotate(' + (spiralAngle * 0.3) + 'deg) scale(0.9)', opacity: 0.8 * cfg.opacity, offset: 0.3 },
          { transform: 'translate(' + (dirX * 0.6 * cfg.dist) + 'px,' + (dirY * 0.55 * cfg.dist) + 'px) rotate(' + (spiralAngle * 0.6) + 'deg) scale(0.6)', opacity: 0.5 * cfg.opacity, offset: 0.55 },
          { transform: 'translate(' + (dirX * 0.85 * cfg.dist) + 'px,' + (dirY * 0.85 * cfg.dist) + 'px) rotate(' + (spiralAngle * 0.85) + 'deg) scale(0.25)', opacity: 0.2 * cfg.opacity, offset: 0.8 },
          { transform: 'translate(' + (dirX * cfg.dist) + 'px,' + (dirY * cfg.dist) + 'px) rotate(' + spiralAngle + 'deg) scale(0.05)', opacity: 0 }
        ], { duration: Math.round(900 * cfg.dur), delay: stagger, fill: 'forwards', easing: 'cubic-bezier(0.4, 0, 0.2, 1)' });
        this._activeAnimations.add(anim);
      });
    },

    _effectLightParticles(keys) {
      const cfg = this._effectConfig();
      const reducedBlink = this._hasReducedMotion();
      const host = document.getElementById('piano-keyboard');
      if (!host) return;
      const hostRect = host.getBoundingClientRect();
      keys.forEach((key, i) => {
        const el = key.element;
        const rect = el.getBoundingClientRect();
        const cx = rect.left - hostRect.left + rect.width / 2;
        const cy = rect.top - hostRect.top + rect.height / 2;
        // Key fades out
        const keyAnim = el.animate([
          { opacity: 1, transform: 'scale(1)' },
          { opacity: 0.8, transform: 'scale(0.95)', offset: 0.2 },
          { opacity: 0.3, transform: 'scale(0.85)', offset: 0.5 },
          { opacity: 0, transform: 'scale(0.7)' }
        ], { duration: Math.round(700 * cfg.dur), delay: Math.round(i * 30 * cfg.dur), fill: 'forwards', easing: 'ease-out' });
        this._activeAnimations.add(keyAnim);
        // Create soft light particles per key (scaled by cfg.particles)
        const particleCount = Math.max(2, Math.round(6 * cfg.particles));
        for (let p = 0; p < particleCount; p++) {
          const particle = document.createElement('div');
          const angle = (p / particleCount) * 360 + Math.random() * 20;
          const dist = (30 + Math.random() * 60) * cfg.dist;
          const size = Math.max(2, Math.round((3 + Math.random() * 5) * Math.min(1, cfg.particles)));
          const driftX = (Math.random() - 0.5) * 40 * cfg.dist;
          const softBg = reducedBlink
            ? 'background:radial-gradient(circle,rgba(240,240,230,0.5),rgba(220,200,180,0.15));box-shadow:0 0 3px 1px rgba(220,200,180,0.2);'
            : 'background:radial-gradient(circle,rgba(255,255,220,0.9),rgba(255,200,100,0.3));box-shadow:0 0 6px 2px rgba(255,220,150,0.5);';
          particle.style.cssText = 'position:absolute;width:' + size + 'px;height:' + size + 'px;border-radius:50%;left:' + (cx - size/2) + 'px;top:' + (cy - size/2) + 'px;z-index:15;pointer-events:none;' + softBg;
          host.appendChild(particle);
          this._temporaryNodes.add(particle);
          const rad = angle * Math.PI / 180;
          const tx = Math.cos(rad) * dist + driftX;
          const ty = Math.sin(rad) * dist - 40 * cfg.dist - Math.random() * 60 * cfg.dist;
          const particleAnim = particle.animate([
            { transform: 'translate(0,0) scale(1)', opacity: 0.9 },
            { transform: 'translate(' + (tx * 0.4) + 'px,' + (ty * 0.4) + 'px) scale(1.2)', opacity: 0.7 * cfg.opacity, offset: 0.3 },
            { transform: 'translate(' + tx + 'px,' + ty + 'px) scale(0.3)', opacity: 0 }
          ], { duration: Math.round((800 + Math.random() * 200) * cfg.dur), delay: Math.round(i * 30 * cfg.dur), fill: 'forwards', easing: 'ease-out' });
          this._activeAnimations.add(particleAnim);
        }
      });
    },

    _effectSuckDepth(keys) {
      const cfg = this._effectConfig();
      const host = document.getElementById('piano-keyboard');
      if (!host) return;
      const hostRect = host.getBoundingClientRect();
      const centerX = hostRect.width / 2;
      const centerY = hostRect.height / 2;
      keys.forEach((key, i) => {
        const el = key.element;
        const rect = el.getBoundingClientRect();
        const kx = rect.left - hostRect.left + rect.width / 2;
        const ky = rect.top - hostRect.top + rect.height / 2;
        const dx = (centerX - kx) * cfg.dist;
        const dy = (centerY - ky) * cfg.dist;
        const stagger = Math.round(i * 40 * cfg.dur);
        const zEnd = Math.round(-400 * cfg.dist);
        const anim = el.animate([
          { transform: 'perspective(500px) translateZ(0) translate(0,0) scale(1)', opacity: 1 },
          { transform: 'perspective(500px) translateZ(' + Math.round(30 * cfg.dist) + 'px) translate(' + (dx * 0.15) + 'px,' + (dy * 0.15) + 'px) scale(0.85)', opacity: 0.8 * cfg.opacity, offset: 0.2 },
          { transform: 'perspective(500px) translateZ(' + Math.round(-80 * cfg.dist) + 'px) translate(' + (dx * 0.45) + 'px,' + (dy * 0.45) + 'px) scale(0.4)', opacity: 0.4 * cfg.opacity, offset: 0.5 },
          { transform: 'perspective(500px) translateZ(' + Math.round(-200 * cfg.dist) + 'px) translate(' + (dx * 0.7) + 'px,' + (dy * 0.7) + 'px) scale(0.1)', opacity: 0.1 * cfg.opacity, offset: 0.75 },
          { transform: 'perspective(500px) translateZ(' + zEnd + 'px) translate(' + dx + 'px,' + dy + 'px) scale(0.02)', opacity: 0 }
        ], { duration: Math.round(900 * cfg.dur), delay: stagger, fill: 'forwards', easing: 'cubic-bezier(0.6, 0.04, 0.98, 0.335)' });
        this._activeAnimations.add(anim);
      });
    },

    _effectSequentialDark(keys) {
      const cfg = this._effectConfig();
      const sorted = [...keys].sort((a,b) => a.midi - b.midi);
      sorted.forEach((key, i) => {
        const el = key.element;
        const isBlack = key.isBlack;
        const darkColor = isBlack ? 'rgba(0,0,0,0.97)' : 'rgba(40,35,30,0.95)';
        const anim = el.animate([
          { backgroundColor: '#ffffff', filter: 'brightness(1)', opacity: 1 },
          { backgroundColor: darkColor, filter: 'brightness(0.6)', opacity: 0.85 * cfg.opacity, offset: 0.3 },
          { backgroundColor: 'rgba(0,0,0,0.98)', filter: 'brightness(0.2)', opacity: 0.6 * cfg.opacity, offset: 0.6 },
          { backgroundColor: 'rgba(0,0,0,1)', filter: 'brightness(0)', opacity: 0 }
        ], { duration: Math.round(600 * cfg.dur), delay: Math.round(i * 60 * cfg.dur), fill: 'forwards', easing: 'ease-in-out' });
        this._activeAnimations.add(anim);
      });
    },

    _shuffleEffectBag() {
      const names = ['dominoLeft', 'dominoRight', 'drop', 'fade', 'laser', 'explosion', 'tornado', 'lightParticles', 'suckDepth', 'sequentialDark'];
      // Fisher-Yates shuffle
      for (let i = names.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [names[i], names[j]] = [names[j], names[i]];
      }
      // Ensure first item differs from last item of previous cycle
      if (this._lastEffectName && names[0] === this._lastEffectName && names.length > 1) {
        // Swap with next different name
        for (let k = 1; k < names.length; k++) {
          if (names[k] !== this._lastEffectName) {
            [names[0], names[k]] = [names[k], names[0]];
            break;
          }
        }
      }
      this._effectBag = names;
    },

    _startKeyboardDisappearance() {
      if (this._effectStrength() === 'none') return;
      const keys = this._getNonProtectedKeys();
      if (keys.length === 0) return;
      // Refill bag if empty
      if (this._effectBag.length === 0) {
        this._shuffleEffectBag();
      }
      const name = this._effectBag.shift();
      this._lastEffectName = name;
      const methodName = '_effect' + name.charAt(0).toUpperCase() + name.slice(1);
      const method = this[methodName];
      if (method) method.call(this, keys);
    },

    _clearPresentation({ preserveKeyStates = false } = {}) {
      this._timers.forEach(clearTimeout);
      this._timers.clear();
      this._animationFrames.forEach(cancelAnimationFrame);
      this._animationFrames.clear();
      this._activeAnimations.forEach(anim => { try { anim.cancel(); } catch(e) {} });
      this._activeAnimations.clear();
      this._temporaryNodes.forEach((node) => node.remove());
      this._temporaryNodes.clear();
      this._removeKeyProtection();
      const host = $('effects-host');
      const skip = $('effects-skip-btn');
      if (host) {
        host.hidden = true;
        delete host.dataset.effectToken;
        delete host.dataset.effectKind;
        delete host.dataset.effectStrength;
      }
      if (skip) skip.hidden = true;
      if (!preserveKeyStates) PianoKeyboard.clearEffectStates();
      state.effectsPlaying = false;
    },

    startCorrect(context) { return this._start('correct', context); },
    startIncorrect(context) { return this._start('incorrect', context); },

    _start(kind, context = {}) {
      this.cancel('superseded');
      const active = {
        kind,
        sessionId: context.sessionId,
        currentTurn: context.currentTurn,
        questionId: context.questionId,
        onComplete: context.onComplete,
        effectToken: ++this._token,
        completed: false
      };
      this._active = active;
      if (!this._matches(active)) {
        this.cancel('stale-start');
        return null;
      }
      state.effectsPlaying = true;
      this._render(active);
      this._installKeyProtection();
      this._setTimer(() => this._complete(active), this._displayTime());
      return active.effectToken;
    },

    _complete(active, { deferOnComplete = true } = {}) {
      if (!this._matches(active) || active.completed) return false;
      active.completed = true;
      this._active = null;
      this._clearPresentation({ preserveKeyStates: true });
      const complete = () => active.onComplete?.(active.effectToken);
      if (deferOnComplete) this._setTimer(complete, 800);
      else complete();
      return true;
    },

    skip() {
      const active = this._active;
      return active ? this._complete(active, { deferOnComplete: true }) : false;
    },

    cancel(_reason = 'cancelled') {
      const active = this._active;
      this._active = null;
      ++this._token;
      this._clearPresentation();
      return Boolean(active);
    },

    isActive() { return Boolean(this._active); },
    getSnapshot() {
      const active = this._active;
      return {
        active: Boolean(active),
        kind: active?.kind || null,
        effectToken: active?.effectToken || null,
        timerCount: this._timers.size,
        animationFrameCount: this._animationFrames.size,
        temporaryNodeCount: this._temporaryNodes.size
      };
    }
  };

  const showError = (message) => {
    const el = $('error-notification'), msgEl = $('error-message');
    if (el && msgEl) { msgEl.textContent = message; el.hidden = false; setTimeout(() => { el.hidden = true; }, 8000); }
    console.warn('[App]', message);
  };

  const confirmDialog = (message) => new Promise((resolve) => {
    const d = $('confirm-dialog'), m = $('confirm-message'), ok = $('confirm-ok'), cancel = $('confirm-cancel');
    if (!d || !m || !ok || !cancel) { resolve(false); return; }
    m.textContent = message; d.hidden = false;
    const cleanup = () => { d.hidden = true; ok.removeEventListener('click', onOk); cancel.removeEventListener('click', onCancel); };
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    ok.addEventListener('click', onOk); cancel.addEventListener('click', onCancel);
  });

  const midiToNoteName = (midiNote, format = 'english') => {
    const notes = ['C','Cs','D','Ds','E','F','Fs','G','Gs','A','As','B'];
    const oct = Math.floor(midiNote / 12) - 1;
    const ni = midiNote % 12, nn = notes[ni];
    if (format === 'none') return '';
    const sol = {C:'ド',Cs:'ド#',D:'レ',Ds:'レ#',E:'ミ',F:'ファ',Fs:'ファ#',G:'ソ',Gs:'ソ#',A:'ラ',As:'ラ#',B:'シ'};
    const en = nn.replace('s','#');
    if (format === 'solfege') return `${sol[nn]||nn}${oct}`;
    if (format === 'english') return `${en}${oct}`;
    if (format === 'both') return `${sol[nn]}(${en}${oct})`;
    return `${en}${oct}`;
  };

  // ========================================
  // localStorage キャッシュ
  // ========================================

  const LocalCache = {
    save(k, v) { try { localStorage.setItem(`pe_${k}`, JSON.stringify(v)); } catch(e) {} },
    load(k, d = null) { try { const v = localStorage.getItem(`pe_${k}`); return v ? JSON.parse(v) : d; } catch(e) { return d; } },
    remove(k) { try { localStorage.removeItem(`pe_${k}`); } catch(e) {} }
  };

  // ========================================
  // IndexedDB
  // ========================================

  const Storage = {
    failureInjection: new URLSearchParams(location.search).get('debugStorage') || '',
    setFailureInjection(target = '') { this.failureInjection = target; },
    async open() {
      return new Promise((resolve) => {
        const req = indexedDB.open(state.DB_NAME, state.DB_VERSION);
        req.onupgradeneeded = (event) => {
          const db = event.target.result, ov = event.oldVersion;
          // v1: 初回ストア作成
          if (ov < 1) {
            if (!db.objectStoreNames.contains('profiles'))
              db.createObjectStore('profiles', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('sessions')) {
              const ss = db.createObjectStore('sessions', { keyPath: 'sessionId' });
              ss.createIndex('profileId', 'profileId', { unique: false });
              ss.createIndex('date', 'startedAt', { unique: false });
            }
            if (!db.objectStoreNames.contains('checkins')) {
              const cs = db.createObjectStore('checkins', { keyPath: 'id' });
              cs.createIndex('profileId', 'profileId', { unique: false });
              cs.createIndex('date', 'date', { unique: false });
            }
            if (!db.objectStoreNames.contains('problemPools'))
              db.createObjectStore('problemPools', { keyPath: 'poolSignature' });
            if (!db.objectStoreNames.contains('heatmapData')) {
              const hs = db.createObjectStore('heatmapData', { keyPath: 'id' });
              hs.createIndex('profileId', 'profileId', { unique: false });
            }
            if (!db.objectStoreNames.contains('reviewData')) {
              const rs = db.createObjectStore('reviewData', { keyPath: 'id' });
              rs.createIndex('profileId', 'profileId', { unique: false });
            }
          }
          // v2: 今後の移行処理をここに追加（現状スキーマ変更なし）
          if (ov < 2) {
            // 現バージョン2ではストア構造の変更なし
            // 将来の移行はここに記述
          }
          // v3: questionPools ストア作成
          if (ov < 3) {
            if (!db.objectStoreNames.contains('questionPools'))
              db.createObjectStore('questionPools', { keyPath: 'id' });
          }
          // v4: Stage 7 uses the existing sessions store as the authoritative
          // question-history container.  Records themselves are migrated lazily
          // so a database upgrade never discards older Stage 1–6 sessions.
          if (ov < 4) {
            const ss = event.target.transaction.objectStore('sessions');
            if (!ss.indexNames.contains('profileCompleted'))
              ss.createIndex('profileCompleted', ['profileId', 'completedAt'], { unique: false });
          
          // v5: No schema changes for Stage 8 MIDI fields (handled by normalizeSessionRecord lazily)
          if (ov < 5) {
            // MIDI data fields are nullable and handled safely by normalizeSessionRecord
          }
}
        };
        req.onsuccess = (e) => { state.db = e.target.result; resolve(state.db); };
        req.onerror = () => { console.warn('[DB] open failed'); resolve(null); };
      });
    },
    async put(store, data) { if (!state.db) return false;
      try { await new Promise((res, rej) => { const tx = state.db.transaction(store, 'readwrite'); tx.objectStore(store).put(data); tx.oncomplete = () => res(); tx.onerror = (e) => rej(e.target.error); }); return true; } catch(e) { return false; } },
    async get(store, key) { if (!state.db) return null;
      try { return await new Promise((res, rej) => { const tx = state.db.transaction(store, 'readonly'); const r = tx.objectStore(store).get(key); r.onsuccess = () => res(r.result); r.onerror = (e) => rej(e.target.error); }); } catch(e) { return null; } },
    async getAll(store) { if (!state.db) return [];
      try { return await new Promise((res, rej) => { const tx = state.db.transaction(store, 'readonly'); const r = tx.objectStore(store).getAll(); r.onsuccess = () => res(r.result); r.onerror = (e) => rej(e.target.error); }); } catch(e) { return []; } },
    async delete(store, key) { if (!state.db) return false;
      try { await new Promise((res, rej) => { const tx = state.db.transaction(store, 'readwrite'); tx.objectStore(store).delete(key); tx.oncomplete = () => res(); tx.onerror = (e) => rej(e.target.error); }); return true; } catch(e) { return false; } },
    async clear(store) { if (!state.db) return false;
      try { await new Promise((res, rej) => { const tx = state.db.transaction(store, 'readwrite'); tx.objectStore(store).clear(); tx.oncomplete = () => res(); tx.onerror = (e) => rej(e.target.error); }); return true; } catch(e) { return false; } },
    async startSessionAtomic({ poolId, candidates, sessionDraft, makePool }) {
      if (!state.db) throw new Error('データベースを利用できません');
      return new Promise((resolve, reject) => {
        const tx = state.db.transaction(['questionPools', 'sessions'], 'readwrite');
        const pools = tx.objectStore('questionPools'), sessions = tx.objectStore('sessions'); let result;
        const fail = error => { try { tx.abort(); } catch (_) {} reject(error || new Error('原子的保存に失敗しました')); };
        const request = pools.get(poolId);
        request.onerror = () => fail(request.error);
        request.onsuccess = () => { try {
          const prepared = makePool(request.result, candidates);
          result = { pool: prepared.pool, ids: prepared.ids, session: { ...sessionDraft, questions: prepared.questions } };
          if (this.failureInjection === 'questionPools') throw new DOMException('questionPoolsへの保存失敗（開発用）', 'InjectedError');
          pools.put(result.pool).onerror = e => fail(e.target.error);
          if (this.failureInjection === 'sessions') throw new DOMException('sessionsへの保存失敗（開発用）', 'InjectedError');
          sessions.put(result.session).onerror = e => fail(e.target.error);
        } catch (e) { fail(e); } };
        tx.oncomplete = () => resolve(result);
        tx.onabort = tx.onerror = () => reject(tx.error || new Error('原子的保存に失敗しました'));
      });
    }
  };

  const AtomicStorageDebugRunner = {
    enabled: new URLSearchParams(location.search).get('debugAtomicTest') === '1',
    async run() {
      const output = $('atomic-test-result');
      const runButton = $('atomic-test-run');
      if (!this.enabled || !output || !state.db) return;
      runButton.disabled = true; output.textContent = '実行中…';
      const stamp = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const poolId = `__atomic_test_pool__${stamp}`;
      const sessionId = `__atomic_test_session__${stamp}`;
      const cacheBefore = localStorage.getItem('pe_incompleteSession');
      const currentBefore = state.currentSession;
      const candidates = [60, 61, 62, 63, 64, 65, 66];
      const draft = { sessionId, profileId:`__atomic_test_profile__${stamp}`, mode:'single', difficulty:'beginner',
        questionCount:5, currentTurn:0, correctCount:0, completed:false, questions:[], startedAt:new Date().toISOString() };
      const makePool = (existing, list) => {
        const pool = existing ? { ...existing, remainingQuestionIds:[...existing.remainingQuestionIds] } : {
          id:poolId, profileId:draft.profileId, poolSignature:'atomic-debug', cycle:1,
          remainingQuestionIds:list.map(m=>`single_midi_${m}`), recentQuestionIds:[]
        };
        const ids = pool.remainingQuestionIds.splice(0, 5);
        return { pool, ids, questions:ids.map(id=>({ id, midi:Number(id.replace('single_midi_','')) })) };
      };
      const args = { poolId, candidates, sessionDraft:draft, makePool };
      const inspect = async () => {
        const pool = await Storage.get('questionPools', poolId);
        const sessions = (await Storage.getAll('sessions')).filter(s=>s.sessionId===sessionId);
        return { poolExists:!!pool, remaining:pool?.remainingQuestionIds?.length ?? null,
          cycle:pool?.cycle ?? null, sessionCount:sessions.length };
      };
      const rows = [];
      try {
        for (const target of ['questionPools', 'sessions']) {
          Storage.setFailureInjection(target);
          let rejected=false; try { await Storage.startSessionAtomic(args); } catch (_) { rejected=true; }
          rows.push({ test:`${target} 障害`, rejected, ...(await inspect()) });
        }
        Storage.setFailureInjection('sessions');
        let firstRejected=false; try { await Storage.startSessionAtomic(args); } catch (_) { firstRejected=true; }
        Storage.setFailureInjection('');
        const retried = await Storage.startSessionAtomic(args);
        state.currentSession = retried.session;
        LocalCache.save('incompleteSession', retried.session);
        const successState = { cacheUpdated:!!LocalCache.load('incompleteSession', null), currentSessionUpdated:state.currentSession?.sessionId===sessionId };
        rows.push({ test:'同一sessionId再試行', firstRejected, sameSessionId:retried.session.sessionId===sessionId,
          expectedConsumed:5, ...successState, ...(await inspect()) });
        const cacheAfter = localStorage.getItem('pe_incompleteSession');
        const currentAfter = state.currentSession;
        output.textContent = rows.map(r =>
          `${r.test}: ${JSON.stringify(r)}`
        ).join('\n') + `\n成功後キャッシュ更新: ${cacheBefore!==cacheAfter}\n成功後currentSession更新: ${currentBefore!==currentAfter}`;
      } catch (error) {
        output.textContent = `テスト実行エラー: ${error.name || 'Error'}: ${error.message || error}`;
      } finally {
        Storage.setFailureInjection(new URLSearchParams(location.search).get('debugStorage') || '');
        await Storage.delete('questionPools', poolId);
        await Storage.delete('sessions', sessionId);
        if (cacheBefore === null) LocalCache.remove('incompleteSession'); else localStorage.setItem('pe_incompleteSession', cacheBefore);
        state.currentSession = currentBefore;
        runButton.disabled = false;
      }
    },
    mount() {
      if (!this.enabled) return;
      const panel=$('atomic-test-panel'); if (!panel) return;
      panel.hidden=false;
      $('atomic-test-run')?.addEventListener('click', () => this.run());
      // 自動操作のクリック可否に依存せず、実ブラウザ上で同じ試験を開始する。
      setTimeout(() => this.run(), 0);
    }
  };

  // ========================================
  // プロフィール管理
  // ========================================

  const ProfileManager = {
    async loadAll() { const profiles = await Storage.getAll('profiles'); state.profiles = {}; profiles.forEach(p => { state.profiles[p.id] = p; }); return profiles; },
    async save(profile) { profile.updatedAt = new Date().toISOString(); if (!profile.createdAt) profile.createdAt = profile.updatedAt; state.profiles[profile.id] = profile; return await Storage.put('profiles', profile); },
    async delete(pid) { if (pid === 'default') return false; delete state.profiles[pid]; return await Storage.delete('profiles', pid); },
    async switchTo(pid) {
      const p = state.profiles[pid]; if (!p) return false;
      state.currentProfileId = pid;
      state.settings = { ...DEFAULT_SETTINGS, ...(p.settings || {}) };
      // MIDI状態リセット（プロフィール切替時）
      state.midiActiveNotes = new Map();
      state.midiSustainedNotes = new Set();
      state.midiAnswerNotes = new Set();
      state.midiSustainPedal = false;
      state.midiLogEntries = [];
      state.midiLastVelocity = 0;
      if (!state.settings.midiEnabled) {
        MIDIManager.stop();
      } else if (MIDIManager._access) {
        const selectedId = state.settings.selectedMidiInputId;
        if (selectedId) MIDIManager.selectInput(selectedId);
      }
      LocalCache.save('currentProfileId', pid);
      this.applyTheme(); this.updateUI();
      if (state.currentScreen === 'calendar') CalendarController.show();
      AudioSystem.applyVolumes();
      return true;
    },
    async saveCurrentSettings() {
      const p = state.profiles[state.currentProfileId]; if (!p) return false;
      p.settings = { ...state.settings }; return await this.save(p);
    },
    applyTheme() {
      document.documentElement.setAttribute('data-theme', state.settings.theme);
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.content = state.settings.theme === 'dark' ? '#1a1a2e' : '#f5e6c8';
      LocalCache.save('theme', state.settings.theme);
    },
    updateUI() {
      const badge = $('home-profile-name'), label = $('settings-current-profile');
      const p = state.profiles[state.currentProfileId];
      if (badge) badge.textContent = p ? p.name : 'プロフィール';
      if (label) label.textContent = p ? p.name : 'デフォルト';
    }
  };

  // ========================================
  // 音声システム（第2段階 本実装）
  // ========================================
  //
  // AudioContext
  // └─ masterGain (masterVolume × muted)
  //     ├─ pianoGain (pianoVolume)
  //     ├─ bgmGain (bgmVolume) → BGM
  //     ├─ sfxGain (sfxVolume) → 効果音
  //     └─ applauseGain (applauseVolume) → 拍手
  //
  // ミュート時は masterGain のみ 0 に。各カテゴリ値は保持。
  // BGMは画面切替時に短いフェード（0.3秒）で切り替え

  const AudioSystem = {
    ctx: null, masterGain: null, pianoGain: null, bgmGain: null, sfxGain: null, applauseGain: null,
    bgmSource: null, bgmElement: null, bgmElementSource: null, bgmUrl: null, cachedBuffers: {},
    initialized: false, _mutedBefore: false, _bgmFadeTimer: null, bgmOutputScale: 0.5,
    pianoState: 'idle', pianoDiagnostics: [], pianoLoadPromise: null, pianoLoadStartedAt: 0, pianoReadyAt: 0,
    pianoManifest: [], activePianoSources: new Map(), pianoStats: {
      samplePlaybackCalls: 0, audioBufferSources: 0, pianoSynthCalls: 0,
      fallbackCalls: 0, sfxCalls: 0, failedFiles: 0
    },
    sessionBgm: { active: false, wasPlaying: false, url: null, currentTime: 0 },
    pendingBgmResume: null, suppressNextScreenBgm: false,
    sampleAnchors: [36, 39, 42, 45, 48, 51, 54, 57, 60, 63, 66, 69, 72, 75, 78, 81, 84],

    init() {
      if (this.initialized) return true;
      try {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.masterGain = this.ctx.createGain(); this.masterGain.connect(this.ctx.destination);
        this.pianoGain = this.ctx.createGain(); this.pianoGain.connect(this.masterGain);
        this.bgmGain = this.ctx.createGain(); this.bgmGain.connect(this.masterGain);
        this.sfxGain = this.ctx.createGain(); this.sfxGain.connect(this.masterGain);
        this.applauseGain = this.ctx.createGain(); this.applauseGain.connect(this.masterGain);
        this.pianoManifest = this.sampleAnchors.flatMap(note => [5, 12].map(velocity => ({ note, velocity,
          name: `piano_${this.noteFileName(note)}_v${velocity}.flac`,
          url: `./assets/audio/piano/piano_${this.noteFileName(note)}_v${velocity}.flac` })));
        this.applyVolumes(); this.initialized = true; return true;
      } catch (e) { console.warn('[Audio] init failed:', e); return false; }
    },

    noteFileName(note) {
      const names = ['C','Cs','D','Ds','E','F','Fs','G','Gs','A','As','B'];
      return `${names[note % 12]}${Math.floor(note / 12) - 1}`;
    },

    applyVolumes() {
      if (!this.ctx) return;
      this.masterGain.gain.value = state.settings.muted ? 0 : state.settings.masterVolume;
      this.pianoGain.gain.value = state.settings.pianoVolume;
      this.bgmGain.gain.value = state.settings.bgmVolume * this.bgmOutputScale;
      this.sfxGain.gain.value = state.settings.sfxVolume;
      this.applauseGain.gain.value = state.settings.applauseVolume;
    },

    resume() {
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(e => console.warn('[Audio] resume error:', e));
    },

    async loadAudio(url) {
      if (this.cachedBuffers[url]) return this.cachedBuffers[url];
      if (!this.ctx) return null;
      try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        const ab = await this.ctx.decodeAudioData(await resp.arrayBuffer());
        this.cachedBuffers[url] = ab; return ab;
      } catch (e) { return null; }
    },

    async preparePianoSamples({ force = false } = {}) {
      if (!this.initialized && !this.init()) return false;
      if (this.pianoLoadPromise && this.pianoState === 'loading') return this.pianoLoadPromise;
      if (this.pianoState === 'ready' && !force) return true;
      this.pianoState = 'loading'; this.pianoLoadStartedAt = performance.now(); this.pianoReadyAt = 0; state.pianoSourceState = 'loading'; this.pianoDiagnostics = [];
      this.pianoLoadPromise = (async () => {
        const results = await Promise.all(this.pianoManifest.map(async item => {
          const diagnostic = { ...item, httpStatus: null, contentType: '', bytes: 0, decoded: false, decodeError: '' };
          try {
            const response = await fetch(item.url, { cache: force ? 'reload' : 'default' });
            diagnostic.httpStatus = response.status;
            diagnostic.contentType = response.headers.get('content-type') || '';
            if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
            const bytes = await response.arrayBuffer(); diagnostic.bytes = bytes.byteLength;
            const buffer = await this.ctx.decodeAudioData(bytes);
            this.cachedBuffers[item.url] = buffer; diagnostic.decoded = true;
          } catch (error) { diagnostic.decodeError = String(error?.message || error); }
          return diagnostic;
        }));
        this.pianoDiagnostics = results;
        state.pianoSourceDiagnostics = results.map(item => ({ ...item }));
        const failures = results.filter(item => !item.decoded);
        this.pianoStats.failedFiles = failures.length;
        if (failures.length) {
          this.pianoState = 'error'; state.pianoSourceState = 'error';
          this.stopAllPianoSources();
          return false;
        }
        this.pianoReadyAt = performance.now(); this.pianoState = 'ready'; state.pianoSourceState = 'ready'; return true;
      })().finally(() => { this.pianoLoadPromise = null; this.updatePianoStatusUI(); });
      this.updatePianoStatusUI(); return this.pianoLoadPromise;
    },

    updatePianoStatusUI() {
      const stateTexts = document.querySelectorAll('[data-piano-source-status]');
      const retry = $('piano-source-retry');
      const ready = this.pianoDiagnostics.filter(item => item.decoded).length;
      const total = this.pianoManifest.length;
      stateTexts.forEach(stateText => {
        stateText.dataset.state = this.pianoState;
        if (this.pianoState === 'loading') stateText.textContent = `ピアノ音源を準備しています（${ready}/${total}）`;
        else if (this.pianoState === 'ready') stateText.textContent = '';
        else if (this.pianoState === 'error') {
          const failed = this.pianoDiagnostics.filter(item => !item.decoded);
          stateText.textContent = `ピアノ音源を読み込めませんでした（失敗 ${failed.length}件） ${failed.map(item => `${item.name}: HTTP ${item.httpStatus ?? 'なし'} / ${item.decodeError}`).join('；')}`;
        } else stateText.textContent = 'ピアノ音源は未準備です';
      });
      document.querySelectorAll('.audio-source-card').forEach(card => {
        card.hidden = this.pianoState === 'ready';
      });
      if (retry) { retry.hidden = !['loading','error'].includes(this.pianoState); retry.disabled = this.pianoState === 'loading'; }
      document.querySelectorAll('.mode-card, [data-screen="mode-select"][data-action="start-game"]').forEach(card => {
        const disabled = this.pianoState !== 'ready'; card.classList.toggle('is-disabled', disabled); card.setAttribute('aria-disabled', String(disabled));
      });
    },

    beginSessionAudio() {
      if (this.sessionBgm.active) return;
      this.sessionBgm = { active: true, wasPlaying: Boolean(state.bgmPlaying && this.bgmElement && !this.bgmElement.paused), url: this.bgmUrl, currentTime: this.bgmElement?.currentTime || 0 };
      this.pauseBGMForSession();
    },

    endSessionAudio() {
      if (!this.sessionBgm.active) return;
      const previous = this.sessionBgm; this.sessionBgm = { active: false, wasPlaying: false, url: null, currentTime: 0 };
      this.pendingBgmResume = previous.wasPlaying && previous.url && !state.settings.muted && state.settings.bgmVolume > 0
        ? { url: previous.url, currentTime: previous.currentTime } : null;
      this.suppressNextScreenBgm = true;
    },

    async playBGM(url, currentTime = 0) {
      if (this.sessionBgm.active || state.settings.muted || state.settings.bgmVolume === 0 || !url) return;
      if (!this.initialized && !this.init()) {
        this._showBGMPanel('BGMの音声出力を初期化できませんでした', () => this.playBGM(url), () => this._pickBGMFile(), () => {});
        return false;
      }
      const resolvedUrl = new URL(url, document.baseURI).href;
      if (resolvedUrl === this.bgmUrl && this.bgmElement && state.bgmPlaying) return true;
      this.stopBGM();
      let audio = null;
      try {
        audio = new Audio(); audio.src = resolvedUrl; audio.loop = true; audio.preload = 'auto'; audio.volume = 1;
        this.bgmElementSource = this.ctx.createMediaElementSource(audio); this.bgmElementSource.connect(this.bgmGain);
        this.bgmGain.gain.cancelScheduledValues(this.ctx.currentTime);
        this.bgmGain.gain.setValueAtTime(state.settings.bgmVolume * this.bgmOutputScale, this.ctx.currentTime);
        this.bgmElement = audio; this.bgmUrl = resolvedUrl; if (currentTime > 0) audio.currentTime = currentTime;
        await audio.play();
        if (this.bgmElement !== audio) return;
        state.bgmPlaying = true;
        $('bgm-status')?.setAttribute('hidden', '');
        return true;
      } catch (e) {
        if (this.bgmElement !== audio) return false;
        if (e?.name === 'NotAllowedError') {
          this.stopBGM();
          this._showBGMPanel('BGMの再生には画面操作が必要です。「ホームBGMを選択」を押すと開始します。', () => this.playBGM(url), () => this._pickBGMFile(), () => {});
          return false;
        }
        const reason = e?.message ? ` (${e.message})` : '';
        this.stopBGM();
        this._showBGMPanel(`BGMファイルを読み込めませんでした\n${resolvedUrl}${reason}`, () => this.playBGM(url), () => this._pickBGMFile(), () => {});
        return false;
      }
    },

    pauseBGMForSession() {
      if (this.bgmElement) { try { this.bgmElement.pause(); } catch (_) {} }
      state.bgmPlaying = false;
      if (this.bgmGain && this.ctx) this.bgmGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.03);
    },

    _fadeOutCurrentBGM() {
      if (this._bgmFadeTimer) { clearTimeout(this._bgmFadeTimer); this._bgmFadeTimer = null; }
      if (this.bgmElement) { try { this.bgmElement.pause(); } catch (_) {} }
      if (this.bgmSource) { try { this.bgmSource.stop(); } catch (_) {} this.bgmSource = null; }
      state.bgmPlaying = false;
      if (this.bgmGain && this.ctx) this.bgmGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.03);
    },

    stopBGM() {
      this._fadeOutCurrentBGM();
      if (this.bgmElement) { this.bgmElement.removeAttribute('src'); this.bgmElement.load(); this.bgmElement = null; }
      if (this.bgmElementSource) { try { this.bgmElementSource.disconnect(); } catch (_) {} this.bgmElementSource = null; }
      this.bgmUrl = null; this.sessionBgm = { active: false, wasPlaying: false, url: null, currentTime: 0 };
      this.pendingBgmResume = null; this.suppressNextScreenBgm = false;
    },

    switchBGMForScreen(screenName) {
      const bgmMap = { home: './assets/audio/bgm/home_loop.mp3', 'mode-select': './assets/audio/bgm/home_loop.mp3', calendar: './assets/audio/bgm/calendar_loop.mp3' };
      if (this.sessionBgm.active || screenName === 'session') { this.pauseBGMForSession(); return; }
      if (this.suppressNextScreenBgm) {
        const pending = this.pendingBgmResume;
        this.suppressNextScreenBgm = false; this.pendingBgmResume = null;
        if (pending && screenName !== 'session') this.playBGM(pending.url, pending.currentTime);
        else this._fadeOutCurrentBGM();
        return;
      }
      const url = bgmMap[screenName]; if (url) this.playBGM(url); else this.stopBGM();
    },

    _showBGMPanel(msg, onReload, onReselect, onDisable) {
      const panel = $('bgm-status'), text = $('bgm-status-text');
      if (!panel || !text) { showError(msg); return; }
      text.textContent = msg; panel.hidden = false;
      const reloadBtn = $('bgm-reload-btn'), reselectBtn = $('bgm-reselect-btn'), disableBtn = $('bgm-disable-btn');
      if (reloadBtn) reloadBtn.onclick = onReload; if (reselectBtn) reselectBtn.onclick = onReselect; if (disableBtn) disableBtn.onclick = () => { panel.hidden = true; onDisable(); };
    },

    _pickBGMFile() {
      const input = document.createElement('input'); input.type = 'file'; input.accept = 'audio/mpeg,audio/mp3,audio/ogg,audio/wav';
      input.onchange = async e => { const file = e.target.files[0]; if (!file) return; const url = URL.createObjectURL(file); try { await this.playBGM(url); } catch (_) { showError('ファイルの読み込みに失敗しました'); } }; input.click();
    },

    _selectPianoBuffer(midiNote, velocity = 96) {
      const midi = Math.max(36, Math.min(84, Number(midiNote) || 60));
      const anchor = this.sampleAnchors.reduce((best, note) => Math.abs(note - midi) < Math.abs(best - midi) ? note : best, this.sampleAnchors[0]);
      const layer = Number(velocity) >= 80 ? 12 : 5;
      const item = this.pianoManifest.find(entry => entry.note === anchor && entry.velocity === layer);
      return item ? { item, midi, anchor, playbackRate: Math.pow(2, (midi - anchor) / 12) } : null;
    },

    playPianoSample(midiNote, { duration = 0.9, velocity = 96, startTime = null } = {}) {
      if (this.pianoState !== 'ready' || !this.ctx || state.settings.muted) return false;
      const selected = this._selectPianoBuffer(midiNote, velocity); const buffer = selected && this.cachedBuffers[selected.item.url];
      if (!selected || !buffer) return false;
      try {
        const source = this.ctx.createBufferSource(); const envelope = this.ctx.createGain();
        source.buffer = buffer; source.playbackRate.value = selected.playbackRate;
        const st = startTime === null ? this.ctx.currentTime + 0.015 : startTime;
        const level = Math.max(0.08, Math.min(1, Number(velocity) / 127));
        envelope.gain.setValueAtTime(0.0001, st); envelope.gain.linearRampToValueAtTime(level, st + 0.008);
        envelope.gain.exponentialRampToValueAtTime(0.0001, st + Math.max(0.08, duration));
        source.connect(envelope); envelope.connect(this.pianoGain); source.start(st); source.stop(st + Math.max(0.12, duration) + 0.1);
        const key = Number(midiNote); if (!this.activePianoSources.has(key)) this.activePianoSources.set(key, new Set());
        const entry = { source, envelope, midi: key }; this.activePianoSources.get(key).add(entry);
        source.onended = () => { this.activePianoSources.get(key)?.delete(entry); if (!this.activePianoSources.get(key)?.size) this.activePianoSources.delete(key); };
        this.pianoStats.samplePlaybackCalls++; this.pianoStats.audioBufferSources++; return true;
      } catch (error) { console.warn('[Audio] sample playback failed:', error); return false; }
    },

    stopPianoNote(midiNote) {
      const entries = this.activePianoSources.get(Number(midiNote)); if (!entries) return;
      entries.forEach(entry => { try { entry.source.stop(); } catch (_) {} }); this.activePianoSources.delete(Number(midiNote));
    },

    stopAllPianoSources() { this.activePianoSources.forEach(entries => entries.forEach(entry => { try { entry.source.stop(); } catch (_) {} })); this.activePianoSources.clear(); },

    playChord(notes, duration = 1.0, velocity = 96) {
      if (this.pianoState !== 'ready' || !Array.isArray(notes) || !notes.length) return false;
      const start = this.ctx.currentTime + 0.03; return notes.every(note => this.playPianoSample(note, { duration, velocity, startTime: start }));
    },

    playSFX(url) {
      if (!this.ctx || !this.initialized || state.settings.muted || state.settings.sfxEnabled === false) return false;
      const buffer = this.cachedBuffers[url]; if (!buffer) return false;
      try { const src = this.ctx.createBufferSource(); src.buffer = buffer; src.connect(this.sfxGain); src.start(); this.pianoStats.sfxCalls++; return true; } catch (_) { return false; }
    },

    playApplause(url) {
      if (!this.ctx || !this.initialized || state.settings.muted || state.settings.sfxEnabled === false) return false;
      const buffer = this.cachedBuffers[url]; if (!buffer) return false;
      try { const src = this.ctx.createBufferSource(); src.buffer = buffer; src.connect(this.applauseGain); src.start(); this.pianoStats.sfxCalls++; return true; } catch (_) { return false; }
    },

    playSfxTone(kind = 'ui') {
      if (!this.ctx || !this.initialized || !this.sfxGain || state.settings.muted || state.settings.sfxEnabled === false || state.settings.effectStrength === 'none') return false;
      const spec = { ui: [520, 0.08], start: [660, 0.13], complete: [880, 0.24], incorrect: [180, 0.18] }[kind] || [520, 0.08];
      try { const oscillator = this.ctx.createOscillator(); const envelope = this.ctx.createGain(); const t = this.ctx.currentTime + 0.01;
        oscillator.type = 'sine'; oscillator.frequency.setValueAtTime(spec[0], t); envelope.gain.setValueAtTime(0.0001, t); envelope.gain.exponentialRampToValueAtTime(0.12, t + 0.008); envelope.gain.exponentialRampToValueAtTime(0.0001, t + spec[1]); oscillator.connect(envelope); envelope.connect(this.sfxGain); oscillator.start(t); oscillator.stop(t + spec[1] + 0.02); this.pianoStats.sfxCalls++; return true;
      } catch (_) { return false; }
    },

    playCorrectChime({ combo = 0, perfect = false, strength = 'normal' } = {}) {
      if (strength === 'none') return false;
      const notes = perfect ? [72, 76, 79, 84] : combo >= 3 ? [72, 76, 79] : [72, 76];
      notes.slice(0, strength === 'subtle' ? 1 : notes.length).forEach((note, index) => setTimeout(() => this.playSfxTone('complete'), index * 110)); return true;
    }
  };

  // ========================================
  // 画面鍵盤（DOMベース）
  // ========================================

  const PianoKeyboard = {
    container: null, startNote: 48, endNote: 72, octaveOffset: 0,
    baseOctave: 4, visibleOctaves: 2,
    _keys: new Map(), _eventsAttached: false, _eventsContainer: null,
    _onNoteDown: null, _onNoteUp: null, _multiSelectMode: false,

    // 鍵盤内部の白黒マッピング
    _isBlack(m) { const n = m % 12; return [1,3,6,8,10].includes(n); },
    _noteName(m) { return ['C','Cs','D','Ds','E','F','Fs','G','Gs','A','As','B'][m%12]; },
    _noteLabelHTML(m, fmt) {
      const nn = this._noteName(m); const oct = Math.floor(m/12)-1;
      const sol = {C:'ド',Cs:'ド#',D:'レ',Ds:'レ#',E:'ミ',F:'ファ',Fs:'ファ#',G:'ソ',Gs:'ソ#',A:'ラ',As:'ラ#',B:'シ'};
      const en = nn.replace('s','#');
      if (fmt === 'none') return '';
      if (fmt === 'solfege') return `<span class="nl-main">${sol[nn]}${oct}</span>`;
      if (fmt === 'english') return `<span class="nl-main">${en}${oct}</span>`;
      if (fmt === 'both') return `<span class="nl-main">${sol[nn]}</span><span class="nl-sub">${en}${oct}</span>`;
      return `<span class="nl-main">${en}${oct}</span>`;
    },

    /** 鍵盤コンテナにDOMを生成 */
    render(container, startNote, endNote) {
      this.container = container;
      this.startNote = startNote;
      this.endNote = endNote;
      this._keys.clear();

      container.innerHTML = '';
      container.style.position = 'relative';

      // 白鍵を生成
      const whiteNotes = [];
      for (let m = startNote; m <= endNote; m++) {
        if (!this._isBlack(m)) whiteNotes.push(m);
      }

      whiteNotes.forEach(m => {
        const div = document.createElement('div');
        div.className = 'piano-key white-key';
        div.dataset.midi = m;
        this._updateLabel(div, m);
        container.appendChild(div);
        this._keys.set(m, div);
      });

      // 黒鍵を生成（絶対位置）
      const whiteKeyWidth = 100 / whiteNotes.length;
      for (let i = 0; i < whiteNotes.length; i++) {
        const m = whiteNotes[i];
        const n = m % 12;
        // C#(1), D#(3), F#(6), G#(8), A#(10) に対応
        if (n === 0 || n === 2 || n === 5 || n === 7 || n === 9) {
          const blackNote = m + 1;
          if (blackNote <= endNote && this._isBlack(blackNote)) {
            const div = document.createElement('div');
            div.className = 'piano-key black-key';
            div.dataset.midi = blackNote;
            // 黒鍵の中心を、隣り合う白鍵の境界へ正確に合わせる。
            // transform: translateX(-50%) で中央配置するため補正値は不要。
            const leftPct = (i + 1) * whiteKeyWidth;
            div.style.left = `${leftPct}%`;
            this._updateLabel(div, blackNote);
            container.appendChild(div);
            this._keys.set(blackNote, div);
          }
        }
      }

      this._attachEvents();
    },

    /** 表示音域を設定して再描画 */
    setRange(startNote, endNote) {
      if (this.container) this.render(this.container, startNote, endNote);
    },

    /** オクターブ移動 */
    shiftOctave(direction) {
      const step = 12 * direction;
      let newStart = this.startNote + step;
      let newEnd = this.endNote + step;
      if (newStart < 24) { newStart = 24; newEnd = newStart + 12 * this.visibleOctaves; }
      if (newEnd > 96) { newEnd = 96; newStart = newEnd - 12 * this.visibleOctaves; }
      this.setRange(newStart, newEnd);
      this._updateRangeLabel();
    },

    /** 中央（C4）を基準に設定 */
    centerOctave() {
      const oct = this.baseOctave;
      this.setRange(48 + (oct-4)*12, 48 + (oct-4)*12 + 12*this.visibleOctaves);
      this._updateRangeLabel();
    },

    /** 音名ラベル更新 */
    _updateLabel(el, m) {
      const fmt = state.settings.noteLabel;
      if (fmt === 'none') { el.innerHTML = ''; return; }
      el.innerHTML = this._noteLabelHTML(m, fmt);
    },

    /** 全鍵盤のラベルを更新 */
    refreshLabels() {
      this._keys.forEach((el, m) => this._updateLabel(el, m));
    },

    /** 範囲ラベル更新 */
    _updateRangeLabel() {
      const label = $('piano-range-label');
      if (!label) return;
      label.textContent = `${this._noteName(this.startNote)}${Math.floor(this.startNote/12)-1} - ${this._noteName(this.endNote)}${Math.floor(this.endNote/12)-1}`;
    },

    /** 鍵盤の視覚状態を設定 */
    setKeyState(midiNote, stateClass) {
      const el = this._keys.get(midiNote);
      if (!el) return;
      ['selected','correct','wrong'].forEach(c => el.classList.remove(c));
      if (stateClass) el.classList.add(stateClass);
    },

    /** 演出用の強調は既存の正誤・選択状態を上書きしない。 */
    setEffectKeyState(midiNote, stateClass) {
      const el = this._keys.get(midiNote);
      if (el && stateClass) el.classList.add(stateClass);
    },

    clearEffectStates() {
      this._keys.forEach(el => el.classList.remove('effect-correct', 'effect-wrong'));
    },

    /** 全鍵盤の状態をクリア */
    clearStates() {
      this._keys.forEach(el => el.classList.remove('selected','correct','wrong'));
    },

    /** イベント設定 */
    _attachEvents() {
      if (this._eventsAttached && this._eventsContainer === this.container) return;
      this._eventsAttached = true;
      this._eventsContainer = this.container;

      const container = this.container;
      if (!container) return;

      container.addEventListener('pointerdown', (e) => {
        const key = e.target.closest('.piano-key');
        if (!key) return;
        const midi = parseInt(key.dataset.midi);
        if (isNaN(midi)) return;
        key.setPointerCapture(e.pointerId);
        // 黒鍵ポップアップ（スマホ向け）
        if (key.classList.contains('black-key')) {
          this._showMobileLabel(midi);
        }
        if (this._onNoteDown) this._onNoteDown(midi);
      });

      container.addEventListener('pointerup', (e) => {
        const key = e.target.closest('.piano-key');
        if (!key) return;
        const midi = parseInt(key.dataset.midi);
        if (isNaN(midi)) return;
        if (this._onNoteUp) this._onNoteUp(midi);
      });

      container.addEventListener('pointercancel', (e) => {
        if (this._onNoteUp) this._onNoteUp(-1);
      });

      // click フォールバック（PointerEvent非対応環境用）
      // pointerdown が先に発火するため、_answered フラグで二重判定を防止
      container.addEventListener('click', (e) => {
        const key = e.target.closest('.piano-key');
        if (!key) return;
        const midi = parseInt(key.dataset.midi);
        if (isNaN(midi)) return;
        // pointerdown が既に処理済みならスキップ
        if (SessionController._answered) return;
        if (this._onNoteDown && !window.PointerEvent) this._onNoteDown(midi);
      });
    },

    /** 物理キーボードマッピング */
    _keyboardMap: {
      'a':60, 'w':61, 's':62, 'e':63, 'd':64, 'f':65, 't':66, 'g':67,
      'y':68, 'h':69, 'u':70, 'j':71, 'k':72, 'o':73, 'l':74
    },

    handleKeyboardNote(key) {
      const note = this._keyboardMap[key];
      if (!note) return null;
      // 現在表示範囲内かチェック
      if (note < this.startNote || note > this.endNote) return null;
      return note;
    },

    /** 表示範囲のMIDI Note一覧 */
    getVisibleNotes() {
      const notes = [];
      for (let m = this.startNote; m <= this.endNote; m++) notes.push(m);
      return notes;
    },

    /** モバイル向け：黒鍵ポップアップ表示 */
    _showMobileLabel(midi) {
      const el = $('piano-mobile-label');
      if (!el) return;
      const fmt = state.settings.noteLabel;
      if (fmt === 'none') { el.hidden = true; return; }
      el.textContent = this._noteLabelHTML(midi, fmt).replace(/<[^>]+>/g,'');
      el.hidden = false;
      clearTimeout(this._labelTimer);
      this._labelTimer = setTimeout(() => { el.hidden = true; }, 1200);
    },

    /** 単音モード用：指定キーをハイライト */
    flashKey(midiNote, className, duration = 800) {
      this.setKeyState(midiNote, className);
      setTimeout(() => {
        const el = this._keys.get(midiNote);
        if (el && el.classList.contains(className)) el.classList.remove(className);
      }, duration);
    }
  };

  // ========================================
  // MIDI 純粋関数
  // ========================================

  /**
   * MIDIメッセージを解析してオブジェクトを返す
   * @param {Uint8Array|number[]} data - MIDIメッセージデータ
   * @returns {{ status:number, command:number, channel:number, note:number|null, velocity:number|null, controller:number|null, controllerValue:number|null, isNoteOn:boolean, isNoteOff:boolean, isSustain:boolean|null, sustainOn:boolean|null }}
   */
  const parseMidiMessage = (data) => {
    const result = {
      status: 0, command: 0, channel: 0,
      note: null, velocity: null,
      controller: null, controllerValue: null,
      isNoteOn: false, isNoteOff: false,
      isSustain: null, sustainOn: null
    };
    if (!data || data.length < 1) return result;
    try {
      result.status = data[0];
      result.command = data[0] & 0xf0;
      result.channel = data[0] & 0x0f;

      if (result.command === 0x90 && data.length >= 3) {
        result.note = data[1];
        result.velocity = data[2];
        if (result.velocity > 0) {
          result.isNoteOn = true;
        } else {
          result.isNoteOff = true;
        }
      } else if (result.command === 0x80 && data.length >= 3) {
        result.note = data[1];
        result.velocity = data[2];
        result.isNoteOff = true;
      } else if (result.command === 0xb0 && data.length >= 3) {
        result.controller = data[1];
        result.controllerValue = data[2];
        if (result.controller === 64) {
          result.isSustain = true;
          result.sustainOn = data[2] >= 64;
        }
      }
    } catch (e) {
      // 不正なデータは無視
    }
    return result;
  };

  /**
   * オクターブ補正を適用（0-127にクランプ）
   * @param {number} note - 生MIDIノート番号
   * @param {number} offset - 補正値（-24, -12, 0, 12, 24など）
   * @returns {number} 補正後のノート番号（0-127）
   */
  const applyMidiOctaveOffset = (note, offset) => {
    const adjusted = note + offset;
    return Math.max(0, Math.min(127, adjusted));
  };

  // ========================================
  // MIDI管理（一元化）
  // ========================================

  const MIDIManager = {
    _access: null,
    _accessRequest: null,
    _accessTimeoutMs: 3000,
    _inputs: [],
    _selectedInputId: null,
    _listening: false,
    _onNoteOn: null,
    _onNoteOff: null,
    _onSustain: null,
    _onInputsChanged: null,

    /** Web MIDI API利用可否を判定 */
    isApiAvailable() {
      return typeof navigator.requestMIDIAccess === 'function';
    },

    /** アクセスを要求 */
    async requestAccess() {
      if (!this.isApiAvailable()) {
        state.midiNoApi = true;
        state.midiConnected = false;
        return false;
      }
      if (this._access) return true;
      if (this._accessRequest) return this._accessRequest;
      state.midiAccessRequested = true;
      const request = Promise.resolve().then(() => navigator.requestMIDIAccess({ sysex: false }));
      const timeout = new Promise(resolve => setTimeout(() => resolve(null), this._accessTimeoutMs));
      this._accessRequest = Promise.race([request, timeout]).then(access => {
        if (!access) throw new Error('MIDI access request timed out');
        this._access = access;
        state.midiAccessGranted = true;
        state.midiAccessFailed = false;
        this._access.onstatechange = () => this._handleStateChange();
        this._updateInputList();
        return true;
      }).catch(e => {
        state.midiAccessGranted = false;
        state.midiAccessFailed = true;
        state.midiConnected = false;
        console.warn('[MIDI] Access unavailable:', e.message);
        return false;
      }).finally(() => { this._accessRequest = null; });
      return this._accessRequest;
    },

    /** statechange ハンドラー */
    _handleStateChange() {
      const wasConnected = state.midiConnected;
      this._updateInputList();
      // 選択済み機器の再接続を試みる
      const selectedId = state.settings.selectedMidiInputId || state.midiSelectedInputId;
      if (selectedId) {
        const input = this._getInputById(selectedId);
        if (input && input.state === 'connected' && input.connection === 'open') {
          this._attachInput(input);
          state.midiConnected = true;
          if (!wasConnected) showError('MIDI機器が再接続されました');
        }
      }
      if (this._onInputsChanged) this._onInputsChanged(this.getInputList(), {
        wasConnected,
        connected: state.midiConnected
      });
    },

    /** 入力一覧を更新（リスナー重複防止） */
    _updateInputList() {
      const oldInputs = this._inputs.slice();
      this._inputs = [];
      if (!this._access) return;
      this._access.inputs.forEach(input => {
        this._inputs.push(input);
      });
      state.midiInputs = this.getInputList();

      // 選択済み機器がまだあれば、リスナーを維持
      const selectedId = state.settings.selectedMidiInputId || this._selectedInputId;
      if (selectedId) {
        const target = this._inputs.find(i => i.id === selectedId);
        if (target && target.state === 'connected') {
          this._attachInput(target);
          state.midiConnected = true;
        } else {
          state.midiConnected = false;
        }
      } else if (this._inputs.length > 0 && this._listening) {
        // 前回選択なしでリスニング中なら最初の機器を使う
        const first = this._inputs.find(i => i.state === 'connected');
        if (first) {
          this._selectedInputId = first.id;
          this._attachInput(first);
          state.midiConnected = true;
        }
      }
    },

    /** 入力一覧を取得（表示用） */
    getInputList() {
      return this._inputs.map(input => ({
        id: input.id,
        name: input.name || '不明な機器',
        manufacturer: input.manufacturer || '',
        state: input.state,
        connection: input.connection
      }));
    },

    /** IDで入力を検索 */
    _getInputById(id) {
      return this._inputs.find(i => i.id === id);
    },

    /** 指定した入力にリスナーを設定 */
    _attachInput(input) {
      if (!input || !this._access) return;
      // すべての入力のリスナーを一度解除してから設定
      this._access.inputs.forEach(i => {
        i.onmidimessage = null;
      });
      // 選択した入力にのみリスナーを設定
      input.onmidimessage = (msg) => this._handleMessage(msg);
      this._selectedInputId = input.id;
      state.midiSelectedInputId = input.id;
    },

    /** 指定機器IDを選択して接続 */
    selectInput(inputId) {
      const input = this._getInputById(inputId);
      if (!input) return false;
      this._attachInput(input);
      this._listening = true;
      state.midiConnected = true;
      state.settings.selectedMidiInputId = inputId;
      state.midiSelectedInputId = inputId;
      ProfileManager.saveCurrentSettings();
      return true;
    },

    /** MIDIを無効化したプロフィール切替・設定変更時に入力を完全解除 */
    stop() {
      if (this._access) this._access.inputs.forEach(input => { input.onmidimessage = null; });
      this.setCallbacks({});
      this._listening = false;
      this._selectedInputId = null;
      state.midiConnected = false;
      state.midiSelectedInputId = null;
      state.midiActiveNotes = new Map();
      state.midiAnswerNotes = new Set();
      state.midiSustainedNotes = new Set();
      state.midiSustainPedal = false;
    },

    /** 現在選択中の入力ID */
    getSelectedInputId() {
      return this._selectedInputId;
    },

    /** 接続状態 */
    isConnected() {
      if (!this._selectedInputId) return false;
      const input = this._getInputById(this._selectedInputId);
      return !!(input && input.state === 'connected');
    },

    /** イベントハンドラー設定 */
    setCallbacks(cbs) {
      this._onNoteOn = cbs.onNoteOn || null;
      this._onNoteOff = cbs.onNoteOff || null;
      this._onSustain = cbs.onSustain || null;
      this._onInputsChanged = cbs.onInputsChanged || null;
    },

    /** MIDIメッセージハンドリング */
    _handleMessage(msg) {
      const parsed = parseMidiMessage(msg.data);

      if (parsed.isNoteOn) {
        if (this._onNoteOn) this._onNoteOn(parsed.note, parsed.velocity);
      } else if (parsed.isNoteOff) {
        if (this._onNoteOff) this._onNoteOff(parsed.note);
      } else if (parsed.isSustain) {
        if (this._onSustain) this._onSustain(parsed.sustainOn);
      }
    },

    /** 切断 */
    disconnect() {
      if (this._access) {
        this._access.inputs.forEach(i => { i.onmidimessage = null; });
      }
      this._listening = false;
      state.midiConnected = false;
    },

    /** 再接続を試みる */
    async reconnect() {
      if (!this._access) {
        return await this.requestAccess();
      }
      this._updateInputList();
      const selectedId = state.settings.selectedMidiInputId || this._selectedInputId;
      if (selectedId) {
        const input = this._getInputById(selectedId);
        if (input && input.state === 'connected') {
          this._attachInput(input);
          this._listening = true;
          state.midiConnected = true;
          return true;
        }
      }
      return false;
    },

    /** 接続機器一覧を更新（再検出） */
    async rescan() {
      if (!this._access) await this.requestAccess();
      this._updateInputList();
      return this.getInputList();
    }
  };

  // ========================================
  // 問題カタログ（候補問題の生成）
  // ========================================

  const INTERVAL_DEFINITIONS = [
    '短2度','長2度','短3度','長3度','完全4度','増4度 / 減5度','完全5度','短6度','長6度','短7度','長7度','完全8度'
  ].map((name,i)=>({semitones:i+1,name,id:['minor2','major2','minor3','major3','perfect4','tritone','perfect5','minor6','major6','minor7','major7','octave'][i]}));

  // ========================================
  // コード定義（第6段階）
  // ========================================

  const CHORD_DEFINITIONS = {
    // 三和音
    major:       { id:'major',       label:'メジャー',          shortLabel:'maj',  intervals:[0,4,7],  noteCount:3, supportedInversions:['root','first','second'],               family:'triad' },
    minor:       { id:'minor',       label:'マイナー',          shortLabel:'m',    intervals:[0,3,7],  noteCount:3, supportedInversions:['root','first','second'],               family:'triad' },
    diminished:  { id:'diminished',  label:'ディミニッシュ',    shortLabel:'dim',  intervals:[0,3,6],  noteCount:3, supportedInversions:['root','first','second'],               family:'triad' },
    augmented:   { id:'augmented',   label:'オーギュメント',    shortLabel:'aug',  intervals:[0,4,8],  noteCount:3, supportedInversions:['root','first','second'],               family:'triad' },
    sus2:        { id:'sus2',        label:'sus2',              shortLabel:'sus2', intervals:[0,2,7],  noteCount:3, supportedInversions:['root','first','second'],               family:'triad' },
    sus4:        { id:'sus4',        label:'sus4',              shortLabel:'sus4', intervals:[0,5,7],  noteCount:3, supportedInversions:['root','first','second'],               family:'triad' },
    // セブンスコード
    major7:      { id:'major7',      label:'メジャーセブンス',      shortLabel:'maj7',  intervals:[0,4,7,11], noteCount:4, supportedInversions:['root','first','second','third'], family:'seventh' },
    dominant7:   { id:'dominant7',   label:'ドミナントセブンス',    shortLabel:'7',     intervals:[0,4,7,10], noteCount:4, supportedInversions:['root','first','second','third'], family:'seventh' },
    minor7:      { id:'minor7',      label:'マイナーセブンス',      shortLabel:'m7',    intervals:[0,3,7,10], noteCount:4, supportedInversions:['root','first','second','third'], family:'seventh' },
    minorMajor7: { id:'minorMajor7', label:'マイナーメジャーセブンス', shortLabel:'mMaj7',intervals:[0,3,7,11], noteCount:4, supportedInversions:['root','first','second','third'], family:'seventh' },
    halfDiminished7: { id:'halfDiminished7', label:'ハーフディミニッシュ', shortLabel:'m7♭5', intervals:[0,3,6,10], noteCount:4, supportedInversions:['root','first','second','third'], family:'seventh' },
    diminished7: { id:'diminished7', label:'ディミニッシュセブンス', shortLabel:'dim7', intervals:[0,3,6,9],  noteCount:4, supportedInversions:['root','first','second','third'], family:'seventh' }
  };

  const CHORD_IDS = Object.keys(CHORD_DEFINITIONS);

  const CM = (m) => ['chord','chordComponents','seventh','seventhChord','chordName','chord-name','chordInversion','inversion'].includes(m);
  const CM_NAME = (m) => m==='chordName'||m==='chord-name';
  const CM_INV = (m) => m==='chordInversion'||m==='inversion';
  const CM_COMP = (m) => m==='chord'||m==='chordComponents'||m==='seventh'||m==='seventhChord';

  const INVERSION_DEFINITIONS = {
    root:   { id:'root',   label:'基本形',     index:0 },
    first:  { id:'first',  label:'第1転回形',  index:1 },
    second: { id:'second', label:'第2転回形',  index:2 },
    third:  { id:'third',  label:'第3転回形',  index:3 }
  };

  /** 指定されたルートMIDI音高からコード構成音を生成 */
  const generateChordVoicing = (rootMidi, chordDef, inversionId) => {
    const baseNotes = chordDef.intervals.map(semi => rootMidi + semi);
    const invIdx = INVERSION_DEFINITIONS[inversionId]?.index || 0;
    const notes = [...baseNotes];
    for (let i = 0; i < invIdx; i++) {
      notes[i] += 12;
    }
    notes.sort((a, b) => a - b);
    // 重複除去
    return notes.filter((n, i) => i === 0 || n !== notes[i - 1]);
  };

  /** 指定ルートとコード定義から構成音のpitch class配列を返す */
  const getChordPitchClasses = (rootPc, chordDef) => {
    return chordDef.intervals.map(semi => (rootPc + semi) % 12);
  };

  /** Pitch class多重集合比較：不足音・余分音・完全一致を返す */
  const matchPitchClassMultisets = (correctNotes, selectedNotes) => {
    const correctPcs = [...new Set(correctNotes.map(n => n % 12))];
    const selectedPcs = selectedNotes.map(n => n % 12);
    const exactMatches = [];
    const missing = [];
    const extra = [];
    const used = new Array(selectedPcs.length).fill(false);
    // 完全一致
    correctPcs.forEach(pc => {
      const idx = selectedPcs.findIndex((s, i) => !used[i] && s === pc);
      if (idx >= 0) { exactMatches.push(pc); used[idx] = true; }
      else { missing.push(pc); }
    });
    selectedPcs.forEach((pc, i) => { if (!used[i]) extra.push(pc); });
    // 最小12音環距離
    let totalDist = 0;
    const paired = [];
    const mCopy = [...missing], eCopy = [...extra];
    while (mCopy.length > 0 && eCopy.length > 0) {
      const mc = mCopy[0];
      let bestIdx = 0, bestDist = Infinity;
      eCopy.forEach((ec, i) => {
        const d = Math.min(Math.abs(ec - mc), 12 - Math.abs(ec - mc));
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      });
      totalDist += bestDist;
      paired.push({ correctPc: mc, selectedPc: eCopy[bestIdx], distance: bestDist });
      mCopy.shift();
      eCopy.splice(bestIdx, 1);
    }
    return {
      exactMatches,
      missingNotes: missing,
      extraNotes: extra,
      matchedDifferences: paired,
      totalSemitoneDistance: totalDist,
      isCorrect: missing.length === 0 && extra.length === 0
    };
  };



  /** 完全一致を除外後、全探索で最小合計半音差を保証する。 */
  const matchNoteSets = (expected, selected) => {
    const correct=[...new Set(expected)].sort((a,b)=>a-b), answer=[...new Set(selected)].sort((a,b)=>a-b);
    const exactMatches=correct.filter(n=>answer.includes(n));
    const a=correct.filter(n=>!exactMatches.includes(n)), b=answer.filter(n=>!exactMatches.includes(n));
    const pairCount=Math.min(a.length,b.length), memo=new Map();
    const solve=(i,mask)=>{ if(i===pairCount)return {distance:0,pairs:[]}; const key=`${i}:${mask}`; if(memo.has(key))return memo.get(key);
      let best={distance:Infinity,pairs:[]};
      for(let j=0;j<b.length;j++)if(!(mask&(1<<j))){const tail=solve(i+1,mask|(1<<j)),distance=Math.abs(a[i]-b[j])+tail.distance;
        if(distance<best.distance)best={distance,pairs:[{correctNote:a[i],selectedNote:b[j],semitoneDifference:b[j]-a[i]},...tail.pairs]};}
      memo.set(key,best);return best;};
    // 正解側が多い場合はそのまま、回答側が多い場合は役割を反転して小さい側を割り当てる。
    let matched, usedCorrect, usedSelected;
    if(a.length<=b.length){matched=solve(0,0);usedCorrect=new Set(matched.pairs.map(p=>p.correctNote));usedSelected=new Set(matched.pairs.map(p=>p.selectedNote));}
    else { const reversed=matchNoteSets(b,a); matched={distance:reversed.totalSemitoneDistance,pairs:reversed.matchedDifferences.map(p=>({correctNote:p.selectedNote,selectedNote:p.correctNote,semitoneDifference:-p.semitoneDifference}))}; usedCorrect=new Set(matched.pairs.map(p=>p.correctNote));usedSelected=new Set(matched.pairs.map(p=>p.selectedNote)); }
    return {exactMatches,matchedDifferences:matched.pairs,missingNotes:a.filter(n=>!usedCorrect.has(n)),extraNotes:b.filter(n=>!usedSelected.has(n)),totalSemitoneDistance:matched.distance,distance:matched.distance,pairs:matched.pairs};
  };

  const QuestionCatalog = {
    _candidateCache:new Map(),
    /** 単音問題の候補MIDIノート一覧を生成 */
    getSingleCandidates(startNote, endNote, includeBlack) {
      const notes = [];
      for (let m = startNote; m <= endNote; m++) {
        const isBlack = [1,3,6,8,10].includes(m % 12);
        if (!includeBlack && isBlack) continue;
        notes.push(m);
      }
      return notes;
    },

    /** 単音問題の候補リストから問題データを生成 */
    makeQuestion(midiNote) {
      const name = ['C','Cs','D','Ds','E','F','Fs','G','Gs','A','As','B'][midiNote%12];
      const oct = Math.floor(midiNote/12)-1;
      const notes_jp = {C:'ド',Cs:'ド#',D:'レ',Ds:'レ#',E:'ミ',F:'ファ',Fs:'ファ#',G:'ソ',Gs:'ソ#',A:'ラ',As:'ラ#',B:'シ'};
      return {
        questionId: `single_midi_${midiNote}`,
        midiNote,
        displayName: `${notes_jp[name]||name}${oct}`,
        octave: oct,
        startedAt: null, replayCount: 0, answered: false,
        selectedNote: null, isCorrect: false, responseTimeMs: 0,
        semitoneDistance: null, direction: null
      };
    },

    getCandidates(mode,start,end,includeBlack) {
      const playback=state.settings.intervalPlaybackType||'harmonic', answerType=state.settings.intervalAnswerType||'name';
      const difficulty=state.settings.difficulty||'normal';
      const chordOctave=state.settings.chordOctaveJudgement||'exact';
      const enabledTypes=state.settings.enabledChordTypes||[];
      const enabledInvs=state.settings.enabledInversions||[];
      const cKey=`chord:${mode}:${start}:${end}:${includeBlack}:${difficulty}:${chordOctave}:${enabledTypes.join(',')}:${enabledInvs.join(',')}`;
      const key=mode==='chord'||mode==='chordComponents'||mode==='seventh'||mode==='seventhChord'||mode==='chordName'||mode==='chord-name'||mode==='chordInversion'||mode==='inversion'?cKey:`${mode}:${start}:${end}:${includeBlack}:${playback}:${answerType}`;
      if(this._candidateCache.has(key))return this._candidateCache.get(key).map(x=>{
        if (typeof x === 'number') return x;
        const copy = { ...x };
        if (Array.isArray(x.notes)) copy.notes = [...x.notes];
        if (Array.isArray(x.correctNotes)) copy.correctNotes = [...x.correctNotes];
        if (Array.isArray(x.correctPitchClasses)) copy.correctPitchClasses = [...x.correctPitchClasses];
        if (Array.isArray(x.chordIntervals)) copy.chordIntervals = [...x.chordIntervals];
        return copy;
      });
      const notes=this.getSingleCandidates(start,end,includeBlack), out=[];
      if(mode==='single') {this._candidateCache.set(key,notes);return [...notes];}
      if(mode==='interval') { for(const root of notes) for(const d of INTERVAL_DEFINITIONS) if(notes.includes(root+d.semitones)) {
        const high=root+d.semitones;
        if(playback==='melodic') { out.push({mode,notes:[root,high],interval:d.semitones,playback,answerType,direction:'ascending'}); out.push({mode,notes:[high,root],interval:d.semitones,playback,answerType,direction:'descending'}); }
        else out.push({mode,notes:[root,high],interval:d.semitones,playback,answerType,direction:null});
      } this._candidateCache.set(key,out);return out.map(x=>({...x,notes:[...x.notes]})); }
      // Chord modes
      const isChord=mode==='chord'||mode==='chordComponents';
      const isSeventh=mode==='seventh'||mode==='seventhChord';
      const isChordName=mode==='chordName'||mode==='chord-name';
      const isInversion=mode==='chordInversion'||mode==='inversion';
      if(isChord||isSeventh||isChordName||isInversion){
        const triadTypes=['major','minor','diminished','augmented','sus2','sus4'];
        const seventhTypes=['major7','dominant7','minor7','minorMajor7','halfDiminished7','diminished7'];
        let allowedTypes=[];
        if(isSeventh){ allowedTypes=[...seventhTypes]; }
        else if(difficulty==='beginner'){ allowedTypes=['major','minor'];}
        else if(difficulty==='normal'){ allowedTypes=['major','minor','diminished','augmented','sus2','sus4'];}
        else if(difficulty==='advanced'||difficulty==='custom'){ allowedTypes=[...triadTypes,...seventhTypes];}
        if(enabledTypes.length>0)allowedTypes=enabledTypes.filter(t=>CHORD_DEFINITIONS[t]);
        if(isSeventh||(isChordName&&difficulty==='advanced'))allowedTypes=allowedTypes.filter(t=>CHORD_DEFINITIONS[t]?.family==='seventh'||(isChordName&&allowedTypes.includes(t)));
        if(isChord||isChordName)allowedTypes=allowedTypes.filter(t=>CHORD_DEFINITIONS[t]?.family==='triad'||(difficulty==='advanced'&&isChordName));
        for(const pc of [0,1,2,3,4,5,6,7,8,9,10,11]){
          for(const tid of allowedTypes){
            const def=CHORD_DEFINITIONS[tid];
            if(!def)continue;
            const rootMidiCandidates=notes.filter(n=>n%12===pc);
            if(rootMidiCandidates.length===0)continue;
            const rootMidi=rootMidiCandidates[0];
            const allNotes=notes.slice();
            // For chord name mode, only check root pitch class
            if(isChordName){
              const pcNotes=def.intervals.map(semi=>rootMidi+semi);
              if(pcNotes.every(n=>allNotes.includes(n)||(n<=end&&n>=start))){
                out.push({mode,rootMidi,rootPitchClass:pc,rootLabel:midiToNoteName(rootMidi,'english').replace(/\d+/g,''),chordType:tid,chordLabel:def.label,chordShortLabel:def.shortLabel,chordIntervals:def.intervals,noteCount:def.noteCount,inversionId:'root',inversionIndex:0,inversionLabel:'基本形',correctNotes:pcNotes,correctPitchClasses:getChordPitchClasses(pc,def)});
              }
              continue;
            }
            // Components: add each supported inversion
            const invs=isInversion?def.supportedInversions:(enabledInvs.length>0?enabledInvs.filter(i=>def.supportedInversions.includes(i)):['root']);
            for(const invId of invs){
              const voicing=generateChordVoicing(rootMidi,def,invId);
              if(voicing.every(n=>allNotes.includes(n)||(n<=end&&n>=start&&includeBlack))){
                const allInRange=voicing.every(n=>n>=start&&n<=end&&(includeBlack||![1,3,6,8,10].includes(n%12)));
                if(allInRange){
                  out.push({mode,rootMidi,rootPitchClass:pc,rootLabel:midiToNoteName(rootMidi,'english').replace(/\d+/g,''),chordType:tid,chordLabel:def.label,chordShortLabel:def.shortLabel,chordIntervals:def.intervals,noteCount:def.noteCount,inversionId:invId,inversionIndex:INVERSION_DEFINITIONS[invId]?.index||0,inversionLabel:INVERSION_DEFINITIONS[invId]?.label||'',correctNotes:voicing,correctPitchClasses:getChordPitchClasses(pc,def)});
                }
              }
            }
          }
        }
        this._candidateCache.set(key,out);
        return out.map(x=>({...x,correctNotes:[...x.correctNotes]}));
      }
      const size=mode==='pair'?2:3;
      const walk=(from,pick)=>{ if(pick.length===size){out.push({mode,notes:[...pick]});return;} for(let i=from;i<notes.length;i++)walk(i+1,[...pick,notes[i]]); };
      walk(0,[]); this._candidateCache.set(key,out);return out.map(x=>({...x,notes:[...x.notes]}));
    },

    getQuestionId(c) { if(typeof c==='number')return `single_midi_${c}`; if(c.mode==='interval') { const p=c.playback||'harmonic', a=c.answerType||'name', notes=p==='harmonic'?[...c.notes].sort((x,y)=>x-y):c.notes; return `interval_${p}_${a}_${notes.join('_')}${p==='melodic'?`_${c.direction==='descending'?'down':'up'}`:''}`; }
      if(c.mode==='chord'||c.mode==='chordComponents'){const rt=c.rootPc!==undefined?c.rootPc:(c.rootMidi%12);return `chord_components_${c.chordType}_root_pc${rt}_${c.correctNotes.join('_')}`;}
      if(c.mode==='seventh'||c.mode==='seventhChord'){const rt=c.rootPc!==undefined?c.rootPc:(c.rootMidi%12);return `seventh_components_${c.chordType}_root_pc${rt}_${c.correctNotes.join('_')}`;}
      if(c.mode==='chordName'||c.mode==='chord-name'){const rt=c.rootPc!==undefined?c.rootPc:(c.rootMidi%12);return `chord_name_${c.chordType}_${c.inversionId||'root'}_pc${rt}_${c.correctNotes.join('_')}`;}
      if(c.mode==='chordInversion'||c.mode==='inversion'){const rt=c.rootPc!==undefined?c.rootPc:(c.rootMidi%12);return `chord_inversion_${c.chordType}_${c.inversionId||'root'}_pc${rt}_${c.correctNotes.join('_')}`;}
      return `${c.mode}_${c.notes.join('_')}`; },
    makeModeQuestion(c) {
      if(typeof c==='number')return this.makeQuestion(c);
      if(c.mode==='chord'||c.mode==='chordComponents'||c.mode==='seventh'||c.mode==='seventhChord'||c.mode==='chordName'||c.mode==='chord-name'||c.mode==='chordInversion'||c.mode==='inversion'){
        return {questionId:this.getQuestionId(c),mode:c.mode,rootMidi:c.rootMidi,rootPitchClass:c.rootPc!==undefined?c.rootPc:(c.rootMidi%12),rootLabel:c.rootLabel||'',chordType:c.chordType,chordLabel:c.chordLabel||'',chordShortLabel:c.chordShortLabel||'',chordIntervals:[...(c.chordIntervals||[])],noteCount:c.noteCount||3,inversionId:c.inversionId||'root',inversionIndex:c.inversionIndex||0,inversionLabel:c.inversionLabel||'',midiNotes:[...(c.correctNotes||[])],correctNotes:[...(c.correctNotes||[])],correctPitchClasses:[...(c.correctPitchClasses||[])],startedAt:null,replayCount:0,answered:false,selectedNotes:[],selectedOrder:[],selectedRootPitchClass:null,selectedChordType:null,selectedInversionId:null,isCorrect:null,componentsCorrect:null,rootCorrect:null,chordTypeCorrect:null,inversionCorrect:null,responseTimeMs:0,semitoneDistance:null};
      }
      const def=INTERVAL_DEFINITIONS[c.interval-1];
      return {questionId:this.getQuestionId(c),mode:c.mode,midiNotes:[...c.notes],correctNotes:[...c.notes],intervalSemitones:c.interval||null,correctIntervalId:def?.id||null,intervalName:def?.name||null,
        playbackType:c.playback||null,answerType:c.answerType||null,direction:c.direction||null,playback:c.playback==='melodic'?'melodic':'simultaneous',startedAt:null,replayCount:0,answered:false,selectedNotes:[],selectedInterval:null,selectedIntervalId:null,isCorrect:null,responseTimeMs:0,semitoneDistance:null};
    },

    /** 設定からpoolSignatureを生成 */
    getPoolSignature(mode, difficulty, startNote, endNote, includeBlack) {
      if(mode==='interval') return `interval_${state.settings.intervalPlaybackType||'harmonic'}_${state.settings.intervalAnswerType||'name'}_${difficulty}_${startNote}_${endNote}_${includeBlack?'black':'white'}_set_${INTERVAL_DEFINITIONS.map(x=>x.semitones).join('-')}`;
      if(['chord','chordComponents','seventh','seventhChord','chordName','chord-name','chordInversion','inversion'].includes(mode)){
        const enabledTypes=(state.settings.enabledChordTypes||[]).length>0?(state.settings.enabledChordTypes||[]).join(','):'all';
        const enabledInvs=(state.settings.enabledInversions||[]).length>0?(state.settings.enabledInversions||[]).join(','):'all';
        const octave=state.settings.chordOctaveJudgement||'exact';
        return `${mode}_${difficulty}_${startNote}_${endNote}_${includeBlack?'black':'white'}_oct${octave}_types${enabledTypes}_invs${enabledInvs}`;
      }
      return `${mode}_${difficulty}_${startNote}_${endNote}_${includeBlack?'black':'white'}`;
    },

    /** 候補一覧からハッシュを生成（設定変更検出用） */
    getCandidateHash(midiNotes) {
      const stable = midiNotes.slice().map(x=>typeof x==='number'?String(x):this.getQuestionId(x)).sort().join('|');
      let hash = 0x811c9dc5;
      for (let i = 0; i < stable.length; i++) { hash ^= stable.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
      return `fnv1a:${(hash>>>0).toString(16).padStart(8,'0')}:count=${midiNotes.length}`;
    },

    /** 設定から対象音域を計算 */
    getRange(difficulty, mode) {
      if (mode === 'single') {
        const isBeginner = difficulty === 'beginner';
        return { start: isBeginner ? 48 : 36, end: isBeginner ? 72 : 84 };
      }
      if (['chordComponents','chord','seventh','seventhChord','chordName','chord-name','chordInversion','inversion'].includes(mode)) {
        const isBeginner = difficulty === 'beginner';
        return { start: isBeginner ? 48 : 36, end: isBeginner ? 72 : 84 };
      }
      return { start: 48, end: 72 };
    }
  };

  // ========================================
  // 問題プール管理（シャッフルバッグ）
  // ========================================

  const QuestionPoolManager = {
    /** 現在の設定からpoolSignatureを計算 */
    _mode:'single', _difficulty:null,
    configure(mode,difficulty){this._mode=mode;this._difficulty=difficulty;},
    _getSig() {
      const s = state.settings;
      const mode=this._mode||'single', difficulty=this._difficulty||s.difficulty, range = QuestionCatalog.getRange(difficulty, mode);
      const includeBlack = s.difficulty !== 'beginner';
      return QuestionCatalog.getPoolSignature(mode, difficulty, range.start, range.end, includeBlack);
    },

    /** プールID（プロフィール分離） */
    _getId() {
      return `${state.currentProfileId}::${this._getSig()}`;
    },

    /** 設定スナップショット */
    _snapshot() {
      const s = state.settings;
      const mode=this._mode||'single', difficulty=this._difficulty||s.difficulty, range = QuestionCatalog.getRange(difficulty, mode);
      const snapshot={ mode, difficulty, minMidi:range.start, maxMidi:range.end, includeBlackKeys:difficulty !== 'beginner' };
      if(mode==='interval') Object.assign(snapshot,{playbackType:s.intervalPlaybackType||'harmonic',answerType:s.intervalAnswerType||'name',enabledIntervals:INTERVAL_DEFINITIONS.map(x=>x.semitones)});
      if(['chord','chordComponents','seventh','seventhChord','chordName','chord-name','chordInversion','inversion'].includes(mode)){
        Object.assign(snapshot,{enabledChordTypes:s.enabledChordTypes||[],enabledInversions:s.enabledInversions||[],chordOctaveJudgement:s.chordOctaveJudgement||'exact'});
      }
      return snapshot;
    },

    prepareAtomic(existing, candidates, count) {
      const now = new Date().toISOString(), mode=this._mode||'single', ids = candidates.map(c => QuestionCatalog.getQuestionId(c)), hash = QuestionCatalog.getCandidateHash(candidates);
      const pool = existing && existing.candidateHash === hash ? { ...existing, remainingQuestionIds:[...existing.remainingQuestionIds], recentQuestionIds:[...(existing.recentQuestionIds||[])] } : {
        id:this._getId(), profileId:state.currentProfileId, poolSignature:this._getSig(), mode, cycle:1,
        remainingQuestionIds:[...ids], recentQuestionIds:[], candidateHash:hash, configSnapshot:this._snapshot(), createdAt:now, updatedAt:now
      };
      if (!existing || existing.candidateHash !== hash) this._shuffle(pool.remainingQuestionIds);
      const drawn=[];
      while (drawn.length<count) { if (!pool.remainingQuestionIds.length) { pool.cycle++; pool.remainingQuestionIds=[...ids]; this._shuffle(pool.remainingQuestionIds); } drawn.push(pool.remainingQuestionIds.shift()); }
      pool.recentQuestionIds = [...pool.recentQuestionIds, ...drawn].slice(-10); pool.updatedAt=now;
      const byId=new Map(candidates.map(c=>[QuestionCatalog.getQuestionId(c),c]));
      return { pool, ids:drawn, questions:drawn.map(id => QuestionCatalog.makeModeQuestion(byId.get(id))) };
    },

    /** 問題プールを読み込む（なければ新規作成） */
    async load() {
      const id = this._getId();
      let pool = await Storage.get('questionPools', id);

      // 現在の設定から候補を生成
      const includeBlack = state.settings.difficulty !== 'beginner';
      const range = QuestionCatalog.getRange(state.settings.difficulty, 'single');
      const candidates = QuestionCatalog.getSingleCandidates(range.start, range.end, includeBlack);
      const newHash = QuestionCatalog.getCandidateHash(candidates);

      if (pool) {
        // 既存プールがあれば、候補変更をチェック
        if (pool.candidateHash !== newHash) {
          // 候補が変わった: 存在しない問題IDを除去、新IDを追加
          const validRemaining = pool.remainingQuestionIds.filter(qid => {
            const midi = parseInt(qid.replace('single_midi_',''));
            return candidates.includes(midi);
          });
          const existingIds = new Set(pool.remainingQuestionIds);
          const newIds = candidates
            .filter(m => !existingIds.has(`single_midi_${m}`))
            .map(m => `single_midi_${m}`);
          pool.remainingQuestionIds = validRemaining.concat(newIds);
          pool.candidateHash = newHash;
          pool.configSnapshot = this._snapshot();
          pool.updatedAt = new Date().toISOString();
        }
      } else {
        // 新規プール作成
        pool = {
          id,
          profileId: state.currentProfileId,
          poolSignature: this._getSig(),
          mode: 'single',
          cycle: 1,
          remainingQuestionIds: candidates.map(m => `single_midi_${m}`),
          recentQuestionIds: [],
          candidateHash: newHash,
          configSnapshot: this._snapshot(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        // Fisher-Yates シャッフル
        this._shuffle(pool.remainingQuestionIds);
      }

      return pool;
    },

    /** Fisher-Yates シャッフル */
    _shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }
    },

    /** プールから指定数の問題IDを取得 */
    async draw(count) {
      const pool = await this.load();
      if (!pool) throw new Error('問題プールの読み込みに失敗');

      let drawn = [];

      while (drawn.length < count) {
        // 現在のバッグから取得
        while (pool.remainingQuestionIds.length > 0 && drawn.length < count) {
          drawn.push(pool.remainingQuestionIds.shift());
        }

        // 足りなければサイクルリセット
        if (drawn.length < count) {
          this._resetCycle(pool);
        }
      }

      // 直近3問を記録
      drawn.slice(-3).forEach(id => {
        if (!pool.recentQuestionIds.includes(id)) {
          pool.recentQuestionIds.push(id);
          if (pool.recentQuestionIds.length > 10) pool.recentQuestionIds.shift();
        }
      });

      pool.updatedAt = new Date().toISOString();
      let saved = await Storage.put('questionPools', pool);
      if (!saved) {
        showError('問題プールの保存に失敗しました。再試行してください。');
        // リトライ（最大3回）
        for (let attempt = 0; !saved && attempt < 3; attempt++) {
          const retry = await showSaveError();
          if (!retry) break;
          saved = await Storage.put('questionPools', pool);
        }
        if (!saved) {
          showError('問題プールの保存に失敗しました。データが不整合になる可能性があります。');
        }
      }

      return { ids: drawn, pool };
    },

    /** サイクルリセット */
    _resetCycle(pool) {
      const includeBlack = state.settings.difficulty !== 'beginner';
      const range = QuestionCatalog.getRange(state.settings.difficulty, 'single');
      const candidates = QuestionCatalog.getSingleCandidates(range.start, range.end, includeBlack);
      let allIds = candidates.map(m => `single_midi_${m}`);

      pool.cycle++;
      pool.recentQuestionIds = pool.recentQuestionIds.slice(-3); // 直近3問を保持

      // シャッフル
      this._shuffle(allIds);

      // 直近問題を後方へ移動
      const recent = pool.recentQuestionIds.filter(id => allIds.includes(id));
      allIds = allIds.filter(id => !recent.includes(id));
      allIds.push(...recent);

      pool.remainingQuestionIds = allIds;
    },

    /** プールの情報を取得 */
    async getInfo() {
      const pool = await Storage.get('questionPools', this._getId());
      if (!pool) return { exists: false };
      const includeBlack = state.settings.difficulty !== 'beginner';
      const range = QuestionCatalog.getRange(state.settings.difficulty, 'single');
      const candidates = QuestionCatalog.getSingleCandidates(range.start, range.end, includeBlack);
      return {
        exists: true,
        poolSignature: pool.poolSignature,
        cycle: pool.cycle,
        remaining: pool.remainingQuestionIds.length,
        total: candidates.length,
        updatedAt: pool.updatedAt
      };
    },

    /** 現在の設定のプールのみをリセット */
    async resetCurrent() {
      const id = this._getId();
      const ok = await Storage.delete('questionPools', id);
      if (ok) showError('出題履歴をリセットしました');
      else showError('リセットに失敗しました');
      return ok;
    }
  };

  // ========================================
  // セッション管理
  // ========================================

  // ========================================
  // 保存失敗パネル（リトライ・バックアップ案内・閉じる）
  // ========================================

  /** 保存失敗パネルを表示し、ユーザーの選択を返す（true=再保存, false=閉じる） */
  const showSaveError = () => new Promise((resolve) => {
    const panel = $('save-error-panel');
    const retryBtn = $('save-error-retry');
    const backupBtn = $('save-error-backup');
    const dismissBtn = $('save-error-dismiss');
    if (!panel || !retryBtn || !dismissBtn) { resolve(false); return; }
    panel.hidden = false;
    const cleanup = () => {
      panel.hidden = true;
      retryBtn.removeEventListener('click', onRetry);
      backupBtn.removeEventListener('click', onBackup);
      dismissBtn.removeEventListener('click', onDismiss);
    };
    const onRetry = () => { cleanup(); resolve(true); };
    const onBackup = () => {
      // JSONバックアップ案内を表示
      try {
        const data = state.currentSession || null;
        if (data) {
          const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `piano_session_backup_${Date.now()}.json`;
          a.click();
          URL.revokeObjectURL(url);
          showError('JSONバックアップをダウンロードしました。再起動後に「データを復元」から読み込めます。');
        } else {
          showError('バックアップできるデータがありません。');
        }
      } catch(e) {
        showError('バックアップの作成に失敗しました。');
      }
      cleanup(); resolve(false);
    };
    const onDismiss = () => { cleanup(); resolve(false); };
    retryBtn.addEventListener('click', onRetry);
    backupBtn.addEventListener('click', onBackup);
    dismissBtn.addEventListener('click', onDismiss);
  });

  const _modeLabel = (m) => ({
    single:'単音当て',pair:'2音同時当て',triple:'3音同時当て',interval:'音程当て',
    chord:'基本コード構成音当て',seventh:'セブンスコード','chord-name':'コード名当て',
    inversion:'コード転回形当て',progression:'コード進行当て',mixed:'全モード混合'
  })[m]||m;

  const localDateKey = (value) => {
    const d = value instanceof Date ? value : new Date(value || Date.now());
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  };

  const CheckinManager = {
    stamps: ['eighth-note', 'treble-clef', 'bass-clef', 'piano', 'record', 'metronome', 'staff', 'grand-piano', 'music-note', 'xylophone'],
    stampLabels: { 'eighth-note':'♪', 'treble-clef':'𝄞', 'bass-clef':'𝄢', piano:'🎹', record:'💿', metronome:'⏱️', staff:'🎼', 'grand-piano':'🎹', 'music-note':'♫', xylophone:'🎶' },
    _hash(value) {
      let hash = 2166136261;
      for (const char of value) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
      return hash >>> 0;
    },
    getCode(profileId, date = new Date()) {
      const dateKey = localDateKey(date), hash = this._hash(`${profileId}:${dateKey}`);
      const typeIds = Object.keys(CHORD_DEFINITIONS);
      const typeId = typeIds[hash % typeIds.length];
      const rootPitchClass = (hash >>> 8) % 12;
      const definition = CHORD_DEFINITIONS[typeId];
      const rootMidi = 60 + rootPitchClass;
      return {
        id: `${profileId}:${dateKey}`,
        profileId, date: dateKey, codeId: `${rootPitchClass}:${typeId}`,
        rootPitchClass, rootMidi, chordType: typeId,
        chordLabel: definition?.label || typeId,
        notes: (definition?.intervals || [0, 4, 7]).map(interval => rootMidi + interval),
        stamp: this.stamps[(hash >>> 16) % this.stamps.length]
      };
    },
    async get(date = new Date(), profileId = state.currentProfileId) {
      return Storage.get('checkins', `${profileId}:${localDateKey(date)}`);
    },
    async getAll(profileId = state.currentProfileId) {
      return (await Storage.getAll('checkins')).filter(item => item.profileId === profileId)
        .sort((a, b) => a.date.localeCompare(b.date));
    },
    async checkIn(date = new Date(), profileId = state.currentProfileId) {
      const existing = await this.get(date, profileId);
      if (existing) return { ...existing, alreadyCheckedIn: true };
      const record = { ...this.getCode(profileId, date), checkedInAt: Date.now(), streak: 0 };
      const dates = (await this.getAll(profileId)).map(item => item.date);
      const previous = new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1);
      record.streak = dates.includes(localDateKey(previous)) ? (await this.get(previous, profileId)).streak + 1 : 1;
      if (!await Storage.put('checkins', record)) throw new Error('チェックイン保存に失敗しました');
      return { ...record, alreadyCheckedIn: false };
    },
    async getStreak(profileId = state.currentProfileId) {
      const records = await this.getAll(profileId);
      if (!records.length) return 0;
      let streak = 0, cursor = new Date();
      const today = localDateKey(cursor);
      if (!records.some(item => item.date === today)) cursor.setDate(cursor.getDate() - 1);
      while (records.some(item => item.date === localDateKey(cursor))) { streak++; cursor.setDate(cursor.getDate() - 1); }
      return streak;
    }
  };

  // Stage 7 record migration.  Questions remain embedded in their session so
  // old Stage 6 saves keep their exact answer data and are not duplicated.
  const HISTORY_SCHEMA_VERSION = 8; // Stage 8: MIDI history fields

  const questionNotes = (q, kind) => {
    if (kind === 'answer') {
      const selected = Array.isArray(q.selectedNotes) ? q.selectedNotes.filter(Number.isFinite) : [];
      return selected.length ? selected : (Number.isFinite(q.selectedNote) ? [q.selectedNote] : []);
    }
    const correct = Array.isArray(q.correctNotes) ? q.correctNotes.filter(Number.isFinite) : [];
    if (correct.length) return correct;
    const played = Array.isArray(q.midiNotes) ? q.midiNotes.filter(Number.isFinite) : [];
    return played.length ? played : (Number.isFinite(q.midiNote) ? [q.midiNote] : []);
  };
  const normalizeSessionRecord = (raw) => {
    if (!raw || !raw.sessionId) return raw;
    const session = { ...raw, schemaVersion: Math.max(Number(raw.schemaVersion)||0, HISTORY_SCHEMA_VERSION) };
    session.modeName = session.modeName || _modeLabel(session.mode);
    session.questions = (Array.isArray(raw.questions) ? raw.questions : []).map((old, index) => {
      const q = { ...old, schemaVersion: Math.max(Number(old.schemaVersion)||0, HISTORY_SCHEMA_VERSION) };
      q.questionId = q.questionId || `${session.mode || 'question'}_legacy_${index}`;
      q.answered = q.answered === true;
      q.correctNotes = questionNotes(q, 'correct');
      q.playedNotes = Array.isArray(q.playedNotes) ? q.playedNotes.slice() : q.correctNotes.slice();
      q.selectedNotes = questionNotes(q, 'answer');
      q.responseTimeMs = Number(q.responseTimeMs) || 0;
      q.replayCount = Number(q.replayCount) || 0;
      q.advanceState = q.advanceState || (q.answered && q.isCorrect === false ? 'awaiting-next' : 'idle');
      return q;
    });
    session.localDate = session.localDate || localDateKey(session.completedAt || session.startedAt);
    session.answeredCount = session.questions.filter(q => q.answered).length;
    session.incorrectCount = session.questions.filter(q => q.answered && !q.isCorrect).length;
    session.accuracy = session.questionCount ? Math.round((Number(session.correctCount)||0) / session.questionCount * 100) : 0;
    const times = session.questions.filter(q => q.answered && q.responseTimeMs > 0).map(q => q.responseTimeMs);
    session.averageAnswerTimeMs = times.length ? Math.round(times.reduce((a,b) => a+b, 0) / times.length) : 0;
    
    session.midiUsed = session.midiUsed === true || (session.questions && session.questions.some(q => q.inputMethod === 'midi'));
    session.midiDeviceName = session.midiDeviceName || (session.midiUsed ? (MIDIManager.getInputList().find(i => i.id === session.midiDeviceId)?.name || null) : null);
    session.inputMethod = session.inputMethod || 'screen';
session.perfect = !!session.completed && session.questionCount > 0 && Number(session.correctCount) === Number(session.questionCount);
    return session;
  };

  const HistoryMetrics = {
    session(raw) { return normalizeSessionRecord(raw); },
    weakness(candidates) {
      const byId = new Map();
      candidates.forEach(({ session, question, questionIndex }) => {
        if (!question?.questionId || !question.answered) return;
        const key = question.questionId;
        const sourceSessionId = question.reviewSourceSessionId || session.sourceSessionId || session.sessionId;
        const item = byId.get(key) || { questionId:key, sourceMode:question.mode || session.mode, sourceSessionId, sourceQuestionIndex:Number.isInteger(questionIndex) ? questionIndex : 0, sample:question, attempts:0, wrong:0, correct:0, replayCount:0, totalTime:0, latestAt:0 };
        item.attempts++; item.correct += question.isCorrect ? 1 : 0; item.wrong += question.isCorrect ? 0 : 1;
        item.replayCount += Number(question.replayCount) || 0; item.totalTime += Number(question.responseTimeMs) || 0;
        const sessionAt = Date.parse(session.completedAt || session.startedAt || 0) || 0;
        // Keep the most recently answered saved note arrays for review playback.
        if (sessionAt >= item.latestAt) {
          item.sample = question;
          item.sourceMode = question.mode || session.mode;
          item.sourceSessionId = sourceSessionId;
          item.sourceQuestionIndex = Number.isInteger(questionIndex) ? questionIndex : 0;
        }
        item.latestAt = Math.max(item.latestAt, sessionAt);
        byId.set(key, item);
      });
      return [...byId.values()].map(item => {
        const accuracy = item.attempts ? item.correct / item.attempts : 0;
        const averageTimeMs = item.attempts ? item.totalTime / item.attempts : 0;
        // Wrong answers dominate; replay/time provide a small deterministic tie-break.
        item.accuracy = accuracy; item.averageTimeMs = Math.round(averageTimeMs);
        item.weaknessScore = Math.round((item.wrong * 100) + ((1 - accuracy) * 40) + Math.min(30, item.replayCount * 3) + Math.min(30, averageTimeMs / 1000));
        return item;
      }).filter(item => item.wrong > 0 || item.replayCount >= 3 || item.averageTimeMs >= 15000)
        .sort((a,b) => b.weaknessScore - a.weaknessScore || b.latestAt - a.latestAt || a.questionId.localeCompare(b.questionId));
    }
  };

  // Stage 11: all analytics are rebuilt from persisted sessions.  This is
  // deliberately kept separate from the history UI so every later view uses
  // the same profile/date/question filtering rules.
  const AnalyticsService = {
    schemaVersion: 1,
    _date(raw) {
      return raw?.localDate || localDateKey(raw?.completedAt || raw?.startedAt);
    },
    _periodStart(filter) {
      if (filter === 'all') return null;
      const days = filter === '7d' ? 6 : 29;
      const d = new Date();
      d.setDate(d.getDate() - days);
      return localDateKey(d);
    },
    async aggregate({profileId=state.currentProfileId, filter='30d'}={}) {
      const result = {
        schemaVersion: this.schemaVersion, profileId, filter,
        updatedAt: Date.now(), answeredCount: 0, totalQuestions: 0,
        correctCount: 0, totalResponseTimeMs: 0, skippedCount: 0,
        mode: {}, difficulty: {}, daily: {}, notes: {}, pitch: {higher:0,lower:0,same:0,differences:{},totalDifference:0}, confusions: {},
        intervals: {}, chords: {}, missingNotes: {}, extraNotes: {}
      };
      const start = this._periodStart(filter), seen = new Set();
      let rawSessions;
      try { rawSessions = await Storage.getAll('sessions'); }
      catch (_) { result.error = '履歴を読み込めませんでした'; return result; }
      for (const raw of Array.isArray(rawSessions) ? rawSessions : []) {
        if (!raw || raw.profileId !== profileId || !raw.sessionId || !raw.completed) continue;
        const date = this._date(raw);
        if (start && date < start) continue;
        let session;
        try { session = normalizeSessionRecord(raw); }
        catch (_) { result.skippedCount++; continue; }
        const mode = session.mode || 'unknown', difficulty = session.difficulty || 'unknown';
        for (const q of Array.isArray(session.questions) ? session.questions : []) {
          if (!q || q.answered !== true) continue;
          const key = `${session.sessionId}:${q.questionId || result.answeredCount}`;
          if (seen.has(key)) continue;
          seen.add(key);
          result.answeredCount++;
          const correct = q.isCorrect === true;
          if (correct) result.correctCount++;
          const time = Number(q.responseTimeMs);
          if (Number.isFinite(time) && time >= 0) result.totalResponseTimeMs += time;
          const correctNotes = [...new Set(questionNotes(q, 'correct'))];
          const answerNotes = [...new Set(questionNotes(q, 'answer'))];
          const noteBucket = (midi) => result.notes[midi] || (result.notes[midi] = {midi, name:midiToNoteName(midi, state.settings.noteLabel), attempts:0, correct:0, wrong:0, missing:0, totalTimeMs:0});
          for (const midi of correctNotes) {
            const b = noteBucket(midi); b.attempts++; if (answerNotes.includes(midi)) b.correct++; else { b.wrong++; b.missing++; } b.totalTimeMs += Number.isFinite(time) && time >= 0 ? time : 0;
          }
          const pairs = Array.isArray(q.matchedDifferences) ? q.matchedDifferences : (correctNotes.length === 1 && answerNotes.length === 1 ? [{correctNote:correctNotes[0], selectedNote:answerNotes[0], semitoneDifference:answerNotes[0]-correctNotes[0]}] : []);
          for (const pair of pairs) {
            const difference = Number(pair?.semitoneDifference ?? (Number(pair?.selectedNote) - Number(pair?.correctNote)));
            if (!Number.isFinite(difference)) continue;
            if (difference > 0) result.pitch.higher++; else if (difference < 0) result.pitch.lower++; else result.pitch.same++;
            result.pitch.totalDifference += difference;
            result.pitch.differences[difference] = (result.pitch.differences[difference] || 0) + 1;
            if (difference !== 0 && Number.isFinite(pair?.correctNote) && Number.isFinite(pair?.selectedNote)) {
              const key = `${pair.correctNote}->${pair.selectedNote}`;
              const c = result.confusions[key] || (result.confusions[key] = {correctNote:pair.correctNote, selectedNote:pair.selectedNote, count:0}); c.count++;
            }
          }
          const bucket = (map, name) => map[name] || (map[name] = {questions:0, correct:0});
          const mb = bucket(result.mode, mode); mb.questions++; if (correct) mb.correct++;
          const db = bucket(result.difficulty, difficulty); db.questions++; if (correct) db.correct++;
          const day = result.daily[date] || (result.daily[date] = {questions:0, correct:0});
          day.questions++; if (correct) day.correct++;
          // Interval analytics (only for interval mode questions)
          if (q.correctIntervalId) {
            const iv = result.intervals[q.correctIntervalId] || (result.intervals[q.correctIntervalId] = {intervalId: q.correctIntervalId, name: q.intervalName || (INTERVAL_DEFINITIONS.find(d => d.id === q.correctIntervalId)?.name) || '', semitones: q.intervalSemitones || null, questions: 0, correct: 0, totalTimeMs: 0});
            iv.questions++; if (correct) iv.correct++; if (Number.isFinite(time)) iv.totalTimeMs += time;
          }
          // Chord analytics (for chord mode questions)
          if (q.chordType && CHORD_DEFINITIONS[q.chordType]) {
            const cv = result.chords[q.chordType] || (result.chords[q.chordType] = {chordType: q.chordType, name: q.chordLabel || CHORD_DEFINITIONS[q.chordType]?.label || q.chordType, questions: 0, correct: 0, totalTimeMs: 0, missingCount: 0, extraCount: 0});
            cv.questions++; if (correct) cv.correct++; if (Number.isFinite(time)) cv.totalTimeMs += time;
            if (q.answered && !correct) {
              // Compute missing and extra notes from authoritative questionNotes
              const cNotes = questionNotes(q, 'correct');
              const aNotes = questionNotes(q, 'answer');
              const missSet = new Set(cNotes.filter(n => !aNotes.includes(n)));
              const extraSet = new Set(aNotes.filter(n => !cNotes.includes(n)));
              missSet.forEach(midi => {
                const mb2 = result.missingNotes[midi] || (result.missingNotes[midi] = {midi, name: midiToNoteName(midi, state.settings.noteLabel), count: 0, chordTypes: {}});
                mb2.count++;
                mb2.chordTypes[q.chordType] = (mb2.chordTypes[q.chordType] || 0) + 1;
              });
              extraSet.forEach(midi => {
                const eb = result.extraNotes[midi] || (result.extraNotes[midi] = {midi, name: midiToNoteName(midi, state.settings.noteLabel), count: 0, chordTypes: {}});
                eb.count++;
                eb.chordTypes[q.chordType] = (eb.chordTypes[q.chordType] || 0) + 1;
              });
              cv.missingCount += missSet.size;
              cv.extraCount += extraSet.size;
            }
          }
        }
      }
      for (const b of Object.values(result.notes)) {
        b.accuracy = b.attempts ? Math.round(b.correct / b.attempts * 100) : null;
        b.averageTimeMs = b.attempts ? Math.round(b.totalTimeMs / b.attempts) : null;
      }
      const pitchTotal = result.pitch.higher + result.pitch.lower + result.pitch.same;
      result.pitch.averageDifference = pitchTotal ? Math.round(result.pitch.totalDifference / pitchTotal * 10) / 10 : null;
      result.pitch.modeDifference = pitchTotal ? Number(Object.entries(result.pitch.differences).sort((a,b)=>b[1]-a[1] || Number(a[0])-Number(b[0]))[0][0]) : null;
      result.pitch.higherRate = pitchTotal ? Math.round(result.pitch.higher / pitchTotal * 100) : null;
      result.pitch.lowerRate = pitchTotal ? Math.round(result.pitch.lower / pitchTotal * 100) : null;
      // Calculate interval accuracies
      for (const iv of Object.values(result.intervals)) {
        iv.accuracy = iv.questions ? Math.round(iv.correct / iv.questions * 100) : null;
        iv.averageTimeMs = iv.questions ? Math.round(iv.totalTimeMs / iv.questions) : null;
      }
      // Calculate chord accuracies
      for (const cv of Object.values(result.chords)) {
        cv.accuracy = cv.questions ? Math.round(cv.correct / cv.questions * 100) : null;
        cv.averageTimeMs = cv.questions ? Math.round(cv.totalTimeMs / cv.questions) : null;
      }
      result.accuracy = result.answeredCount ? Math.round(result.correctCount / result.answeredCount * 100) : null;
      result.averageResponseTimeMs = result.answeredCount ? Math.round(result.totalResponseTimeMs / result.answeredCount) : null;
      return result;
    }
  };

  const SessionManager = {
    _cacheKey(pid=state.currentProfileId) { return `incompleteSession_${pid}`; },
    /** 新規セッションを開始（問題プールから取得） */
    async start(mode, difficulty, questionCount) {
      const sessionId = `${state.debugSessionPrefix || 'session_'}${Date.now()}`;
      const qc = Number(questionCount) || Number(state.settings.questionCount) || 10;
      const range = QuestionCatalog.getRange(difficulty, mode), includeBlack = difficulty !== 'beginner';
      QuestionPoolManager.configure(mode,difficulty);
      const candidates = QuestionCatalog.getCandidates(mode,range.start,range.end,includeBlack);
      if (!candidates.length) {
        if (mode === 'seventh' || mode === 'seventhChord') throw new Error('セブンスコードの出題候補がありません。コード設定を確認してください。');
        throw new Error('この設定では出題できる問題がありません。難易度または音域を変更してください。');
      }
      const sessionDraft = {
        sessionId,
        profileId: state.currentProfileId,
        mode, difficulty, questionCount: qc,
        currentTurn: 0,
        correctCount: 0, streakCount: 0, maxStreak: 0,
        startedAt: new Date().toISOString(),
        completedAt: null,
        completed: false,
        questions: [],
        totalResponseTimeMs: 0, schemaVersion: HISTORY_SCHEMA_VERSION,
        modeName: _modeLabel(mode),
        midiUsed: state.settings.midiEnabled && state.midiConnected,
        midiDeviceName: state.midiConnected && state.midiSelectedInputId ? (MIDIManager.getInputList().find(i => i.id === state.midiSelectedInputId)?.name || null) : null,
        midiDeviceId: state.midiConnected ? state.midiSelectedInputId : null,
        inputMethod: state.settings.midiEnabled && state.midiConnected ? 'midi' : 'screen'
      };
      if(mode==='interval') Object.assign(sessionDraft,{playbackType:state.settings.intervalPlaybackType||'harmonic',answerType:state.settings.intervalAnswerType||'name'});
      if(['chord','chordComponents','seventh','seventhChord','chordName','chord-name','chordInversion','inversion'].includes(mode)){
        Object.assign(sessionDraft,{enabledChordTypes:state.settings.enabledChordTypes||[],enabledInversions:state.settings.enabledInversions||[],chordOctaveJudgement:state.settings.chordOctaveJudgement||'exact'});
      }

      const args = { poolId:QuestionPoolManager._getId(), candidates, sessionDraft,
        makePool:(existing, list) => QuestionPoolManager.prepareAtomic(existing, list, qc) };
      let result;
      for (let attempt=0; attempt<4 && !result; attempt++) {
        try { result = await Storage.startSessionAtomic(args); }
        catch (error) {
          state.emergencySave = { type:'emergency-save', operation:'start-session', profileId:state.currentProfileId,
            sessionId, sessionDraft, poolDraft:{poolId:args.poolId,candidateHash:QuestionCatalog.getCandidateHash(candidates)},
            error:{name:error.name||'Error',message:error.message||String(error)}, createdAt:new Date().toISOString() };
          if (attempt===3 || !(await showSaveError())) throw error;
        }
      }
      state.currentSession = result.session;
      LocalCache.save(this._cacheKey(), {sessionId,profileId:state.currentProfileId,updatedAt:new Date().toISOString()});
      return result.session;
    },

    /** セッションをIndexedDBに保存 */
    async save() {
      if (!state.currentSession) return false;
      state.currentSession.profileId = state.currentProfileId;
      let ok = await Storage.put('sessions', state.currentSession);
      if (!ok) {
        // リトライ付き保存失敗パネルを表示（最大3回再試行）
        for (let attempt = 0; !ok && attempt < 3; attempt++) {
          const retry = await showSaveError();
          if (!retry) break;
          ok = await Storage.put('sessions', state.currentSession);
        }
        if (!ok) return false;
      }
      // localStorageには最低限の情報のみ保存（本体はIndexedDBが正）
      if (!state.currentSession.completed) {
        LocalCache.save(this._cacheKey(), {
          sessionId: state.currentSession.sessionId,
          profileId: state.currentProfileId,
          updatedAt: new Date().toISOString()
        });
      }
      return true;
    },

    /** 未完了セッションをIndexedDBから読み込む（古いquestionId形式も移行） */
    async loadIncomplete() {
      const cached = LocalCache.load(this._cacheKey(), null) || LocalCache.load('incompleteSession', null);
      if (!cached || cached.profileId !== state.currentProfileId) return null;
      const session = await Storage.get('sessions', cached.sessionId);
      if (!session || session.completed || session.profileId !== state.currentProfileId) {
        LocalCache.remove(this._cacheKey());
        return null;
      }
      // 第3段階互換: 古いquestionId形式（single_C4）を新しい形式（single_midi_60）へ移行
      if (session.questions) {
        session.questions.forEach(q => {
          if (q.questionId && !q.questionId.startsWith('single_midi_') && q.midiNote !== undefined) {
            q.questionId = `single_midi_${q.midiNote}`;
          }
          // 第5段階互換: 問題本体は引き直さず、旧interval IDだけ正規化する。
          if (session.mode==='interval' && q.midiNotes?.length===2 && !/^interval_(harmonic|melodic)_(name|keyboard)_/.test(q.questionId||'')) {
            const playback=q.playbackType||session.playbackType||'harmonic', answerType=q.answerType||session.answerType||'name';
            const direction=q.direction||((q.midiNotes[0]<=q.midiNotes[1])?'ascending':'descending');
            q.questionId=QuestionCatalog.getQuestionId({mode:'interval',notes:q.midiNotes,playback,answerType,direction});
          }
        });
      }
      state.currentSession = session;
      return session;
    },

    /** 未完了キャッシュを削除 */
    clearIncompleteCache() {
      LocalCache.remove(this._cacheKey());
    },

    /** セッションを完了 */
    async complete() {
      if (!state.currentSession) return;
      state.currentSession.completed = true;
      state.currentSession.completedAt = new Date().toISOString();
      Object.assign(state.currentSession, normalizeSessionRecord(state.currentSession));
      const saved = await this.save();
      if (!saved) {
        state.currentSession.completed = false;
        state.currentSession.completedAt = null;
        throw new Error('完了セッションを保存できませんでした');
      }
      this.clearIncompleteCache();
      const sessionData = { ...state.currentSession };
      state.currentSession = null;
      state.currentQuestion = null;
      return sessionData;
    },

    /** 進行中セッションを破棄 */
    async abort() {
      if (!state.currentSession) return;
      state.currentSession.completed = true;
      state.currentSession.completedAt = new Date().toISOString();
      await this.save();
      this.clearIncompleteCache();
      state.currentSession = null;
      state.currentQuestion = null;
    },

    /** Stage 7: create a persisted session from distinct saved weak questions. */
    async startReview(candidates, requestedCount) {
      const selected = candidates.slice(0, Math.max(0, Number(requestedCount)||0));
      if (!selected.length) throw new Error('復習できる問題がありません');
      // A review session deliberately keeps only one mode.  This reuses the
      // existing answer controls without introducing the Stage 10 mixed mode.
      const mode = selected[0].sourceMode;
      const sameMode = selected.filter(c => c.sourceMode === mode);
      const questions = sameMode.map((candidate, index) => {
        const source = normalizeSessionRecord({ sessionId:'source', mode, questions:[candidate.sample] }).questions[0];
        return { ...source, questionId:source.questionId, mode, startedAt:null, answered:false, isCorrect:null,
          selectedNote:null, selectedNotes:[], selectedOrder:[], selectedInterval:null, selectedIntervalId:null,
          selectedRootPitchClass:null, selectedChordType:null, selectedInversionId:null, responseTimeMs:0,
          replayCount:0, reviewSourceAnswerNotes:questionNotes(source,'answer'), reviewSourceSessionId:candidate.sourceSessionId || null,
          reviewSourceQuestionId:candidate.questionId, reviewWeaknessScore:candidate.weaknessScore, schemaVersion:HISTORY_SCHEMA_VERSION,
          reviewIndex:index };
      });
      const now = new Date().toISOString();
      const session = normalizeSessionRecord({
        sessionId: `${state.debugSessionPrefix || 'review_'}${Date.now()}`,
        profileId:state.currentProfileId, mode, modeName:`復習：${_modeLabel(mode)}`, difficulty:state.settings.difficulty,
        questionCount:questions.length, currentTurn:0, correctCount:0, streakCount:0, maxStreak:0,
        startedAt:now, completedAt:null, completed:false, questions, totalResponseTimeMs:0,
        reviewSession:true, reviewRequestedCount:Number(requestedCount)||questions.length,
        reviewCandidateCount:candidates.length, reviewShortage:Math.max(0, (Number(requestedCount)||0)-questions.length), schemaVersion:HISTORY_SCHEMA_VERSION
      });
      if (!await Storage.put('sessions', session)) throw new Error('復習セッションを保存できませんでした');
      state.currentSession=session;
      LocalCache.save(this._cacheKey(), {sessionId:session.sessionId,profileId:state.currentProfileId,updatedAt:now});
      return session;
    },

    /** 結果画面の直前セッションから、不正解問題だけで新しい復習セッションを作る。 */
    async startIncorrectRetry(sourceSession) {
      const source = sourceSession && sourceSession.sessionId ? normalizeSessionRecord(sourceSession) : null;
      if (!source || source.profileId !== state.currentProfileId || source.completed !== true) {
        throw new Error('直前のセッションを取得できませんでした');
      }
      if (!Array.isArray(source.questions) || !source.questions.length) throw new Error('復習対象の問題がありません');
      const incorrect = source.questions.filter(question => question && question.answered === true && question.isCorrect === false);
      if (!incorrect.length) throw new Error('復習する間違いはありません');
      const questions = incorrect.map((question, index) => {
        const cloned = cloneData(question);
        const sourceQuestionId = cloned.questionId;
        const correctNotes = questionNotes(cloned, 'correct');
        Object.assign(cloned, {
          questionId: sourceQuestionId, sourceQuestionId, retryIndex: index,
          startedAt: null, answered: false, isCorrect: null, selectedNote: null,
          selectedNotes: [], selectedOrder: [], selectedInterval: null, selectedIntervalId: null,
          selectedRootPitchClass: null, selectedChordType: null, selectedInversionId: null,
          responseTimeMs: 0, inputMethod: null, exactMatches: [], missingNotes: [], extraNotes: [],
          matchedDifferences: [], totalSemitoneDistance: 0, semitoneDistance: null,
          componentsCorrect: null, rootCorrect: null, chordTypeCorrect: null, inversionCorrect: null,
          replayCount: 0
        });
        delete cloned.reviewSourceAnswerNotes;
        delete cloned.reviewSourceSessionId;
        delete cloned.reviewSourceQuestionId;
        delete cloned.reviewWeaknessScore;
        delete cloned.reviewIndex;
        cloned.correctNotes = correctNotes;
        cloned.playedNotes = Array.isArray(cloned.playedNotes) ? cloned.playedNotes.slice() : correctNotes.slice();
        return cloned;
      });
      const now = new Date().toISOString();
      const retry = {
        sessionId: `${state.debugSessionPrefix || 'retry_'}${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        profileId: state.currentProfileId, mode: source.mode,
        difficulty: source.difficulty || state.settings.difficulty,
        modeName: `間違い復習：${_modeLabel(source.mode)}`,
        questionCount: questions.length, currentTurn: 0, correctCount: 0,
        streakCount: 0, maxStreak: 0, startedAt: now, completedAt: null,
        completed: false, questions, totalResponseTimeMs: 0,
        reviewSession: true, isRetrySession: true, sessionType: 'wrong-answer-retry',
        sourceSessionId: source.sessionId, sourceIncorrectCount: incorrect.length,
        retryDepth: (Number(source.retryDepth) || 0) + 1, schemaVersion: HISTORY_SCHEMA_VERSION,
        midiUsed: false, inputMethod: 'screen'
      };
      ['playbackType', 'answerType', 'enabledChordTypes', 'enabledInversions', 'chordOctaveJudgement'].forEach(key => {
        if (source[key] !== undefined) retry[key] = cloneData(source[key]);
      });
      const session = normalizeSessionRecord(retry);
      if (!await Storage.put('sessions', session)) throw new Error('復習セッションを保存できませんでした');
      state.currentSession = session;
      LocalCache.save(this._cacheKey(), { sessionId: session.sessionId, profileId: state.currentProfileId, updatedAt: now });
      return session;
    },

    /** 現在の問題を保存 */
    async saveCurrentQuestion() {
      if (!state.currentSession || !state.currentQuestion) return;
      const turn = state.currentSession.currentTurn;
      if (turn >= 0 && turn < state.currentSession.questions.length) {
        state.currentSession.questions[turn] = { ...state.currentQuestion };
      }
      await this.save();
    }
  };

  // ========================================
  // 画面遷移
  // ========================================

  // ========================================
  // 第12段階：バックアップ、復元、最終調整
  // ========================================

  const DATA_STORES = ['profiles', 'sessions', 'checkins', 'problemPools', 'heatmapData', 'reviewData', 'questionPools'];
  const DATA_BACKUP_VERSION = 1;
  const DATA_SCHEMA_VERSION = 5;
  const APP_LOCAL_STORAGE_PREFIX = 'pe_';
  const MAX_BACKUP_BYTES = 20 * 1024 * 1024;
  const MAX_RECORDS = 10000;
  const MAX_QUESTIONS_PER_SESSION = 100;
  const dangerousBackupText = /(?:__proto__|constructor|prototype|<\s*script\b|<\s*iframe\b|<[^>]+\bon\w+\s*=|javascript\s*:)/i;
  const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
  const cloneData = (value) => JSON.parse(JSON.stringify(value));
  const stableData = (value) => {
    if (Array.isArray(value)) return `[${value.map(stableData).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableData(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
  };
  const recordsEqual = (a, b) => stableData(a) === stableData(b);
  const validIsoDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
  const validId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 240;
  const recordKey = (store, record) => store === 'profiles' ? record.id
    : store === 'sessions' ? record.sessionId
    : store === 'checkins' ? record.id
    : store === 'problemPools' ? record.poolSignature
    : store === 'questionPools' ? record.id
    : record.id;
  const relatedToProfile = (record, profileId) => !record || !own(record, 'profileId') || record.profileId === profileId;
  const localStorageSnapshot = () => {
    const result = {};
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && key.startsWith(APP_LOCAL_STORAGE_PREFIX)) result[key] = localStorage.getItem(key);
    }
    return result;
  };
  const replaceAppLocalStorage = (snapshot) => {
    const before = localStorageSnapshot();
    try {
      Object.keys(before).forEach(key => localStorage.removeItem(key));
      Object.entries(snapshot || {}).forEach(([key, value]) => {
        if (key.startsWith(APP_LOCAL_STORAGE_PREFIX) && typeof value === 'string') localStorage.setItem(key, value);
      });
      return { ok: true, before };
    } catch (error) {
      Object.keys(localStorageSnapshot()).forEach(key => localStorage.removeItem(key));
      Object.entries(before).forEach(([key, value]) => localStorage.setItem(key, value));
      throw error;
    }
  };

  const DataManagementController = {
    currentBackup: null,
    currentFileName: '',
    busy: false,
    _errors: [],

    async _readData() {
      const data = {};
      for (const store of DATA_STORES) data[store] = await Storage.getAll(store);
      data.localStorage = localStorageSnapshot();
      return data;
    },

    _manifest(data) {
      const sessions = Array.isArray(data.sessions) ? data.sessions : [];
      return {
        profiles: data.profiles.length,
        sessions: data.sessions.length,
        checkins: data.checkins.length,
        problemPools: data.problemPools.length,
        questionPools: data.questionPools.length,
        heatmapData: data.heatmapData.length,
        reviewData: data.reviewData.length,
        answeredQuestions: sessions.reduce((total, session) => total + (Array.isArray(session.questions) ? session.questions.length : 0), 0),
        incompleteSessions: sessions.filter(session => session.completed !== true).length,
        hasSettings: data.profiles.some(profile => profile && profile.settings && typeof profile.settings === 'object'),
        hasHeatmap: data.heatmapData.length > 0
      };
    },

    async createBackup(scope = 'all', profileId = state.currentProfileId) {
      const all = await this._readData();
      const selected = all.profiles.find(profile => profile.id === profileId);
      if (scope === 'selected-profile' && !selected) throw new Error('現在のプロフィールが見つかりません');
      const filterStore = (store) => {
        if (scope === 'all' || store === 'profiles') return scope === 'all' ? all[store] : all[store].filter(record => record.id === profileId);
        return all[store].filter(record => relatedToProfile(record, profileId));
      };
      const data = {};
      DATA_STORES.forEach(store => { data[store] = cloneData(filterStore(store)); });
      data.localStorage = cloneData(all.localStorage);
      const backup = {
        app: 'piano-ear-game',
        appVersion: '1.0.0',
        backupVersion: DATA_BACKUP_VERSION,
        schemaVersion: DATA_SCHEMA_VERSION,
        exportedAt: new Date().toISOString(),
        scope,
        selectedProfileId: scope === 'selected-profile' ? profileId : null,
        manifest: this._manifest(data),
        data
      };
      return backup;
    },

    _findDangerous(value, path, errors, seen = new Set()) {
      if (value && typeof value === 'object') {
        if (seen.has(value)) { errors.push(`${path}: 循環参照は使用できません`); return; }
        seen.add(value);
        Object.keys(value).forEach(key => {
          if (dangerousBackupText.test(key)) errors.push(`${path}.${key}: 使用できないキーです`);
          this._findDangerous(value[key], `${path}.${key}`, errors, seen);
        });
        seen.delete(value);
      } else if (typeof value === 'string' && dangerousBackupText.test(value)) {
        errors.push(`${path}: HTML、イベント属性、javascript形式は使用できません`);
      }
    },

    _checkNumeric(value, path, errors) {
      if (!own(value, path)) return;
      const number = value[path];
      if (typeof number !== 'number' || !Number.isFinite(number)) errors.push(`${path}: 有限な数値が必要です`);
      else if (number < 0) errors.push(`${path}: 負の値は使用できません`);
    },

    _validateRecord(store, record, index, profileIds, sessionIds, errors) {
      const label = `${store}[${index}]`;
      if (!record || typeof record !== 'object' || Array.isArray(record)) { errors.push(`${label}: オブジェクトが必要です`); return; }
      const key = recordKey(store, record);
      if (!validId(key)) errors.push(`${label}.id: 識別子が不正です`);
      if (store !== 'profiles' && own(record, 'profileId') && !profileIds.has(record.profileId)) errors.push(`${label}.profileId: 存在しないプロフィールを参照しています`);
      if (store === 'profiles') {
        if (!validId(record.id)) errors.push(`${label}.id: profileIdが不正です`);
        if (typeof record.name !== 'string' || !record.name.trim()) errors.push(`${label}.name: プロフィール名が必要です`);
        if (record.settings !== undefined) {
          if (!record.settings || typeof record.settings !== 'object' || Array.isArray(record.settings)) errors.push(`${label}.settings: 設定オブジェクトが必要です`);
          else {
            ['masterVolume', 'pianoVolume', 'bgmVolume', 'sfxVolume', 'applauseVolume'].forEach(field => {
              if (own(record.settings, field) && (typeof record.settings[field] !== 'number' || !Number.isFinite(record.settings[field]) || record.settings[field] < 0 || record.settings[field] > 1)) errors.push(`${label}.settings.${field}: 0〜1の有限値が必要です`);
            });
            if (own(record.settings, 'questionCount') && (typeof record.settings.questionCount !== 'number' || !Number.isInteger(record.settings.questionCount) || record.settings.questionCount < 1 || record.settings.questionCount > MAX_QUESTIONS_PER_SESSION)) errors.push(`${label}.settings.questionCount: 1〜100の整数が必要です`);
          }
        }
      }
      if (store === 'sessions') {
        if (!validId(record.profileId)) errors.push(`${label}.profileId: profileIdが必要です`);
        if (!validId(record.sessionId)) errors.push(`${label}.sessionId: sessionIdが不正です`);
        if (!Array.isArray(record.questions)) errors.push(`${label}.questions: 配列が必要です`);
        else if (record.questions.length > MAX_QUESTIONS_PER_SESSION) errors.push(`${label}.questions: 問題数が多すぎます`);
        if (typeof record.completed !== 'boolean') errors.push(`${label}.completed: 真偽値が必要です`);
        if (own(record, 'sourceSessionId') && record.sourceSessionId !== null && !validId(record.sourceSessionId)) errors.push(`${label}.sourceSessionId: 識別子が不正です`);
        if (record.completed === true && !validIsoDate(record.completedAt)) errors.push(`${label}.completedAt: 完了日時が必要です`);
        this._checkNumeric(record, 'questionCount', errors); this._checkNumeric(record, 'correctCount', errors);
        if (own(record, 'questionCount') && (record.questionCount > MAX_QUESTIONS_PER_SESSION || !Number.isInteger(record.questionCount))) errors.push(`${label}.questionCount: 1〜100の整数が必要です`);
        (Array.isArray(record.questions) ? record.questions : []).forEach((question, qIndex) => {
          const qPath = `${label}.questions[${qIndex}]`;
          if (!question || typeof question !== 'object' || Array.isArray(question)) { errors.push(`${qPath}: 問題オブジェクトが必要です`); return; }
          ['midiNote', 'selectedNote'].forEach(field => {
            if (own(question, field) && question[field] !== null && (typeof question[field] !== 'number' || !Number.isInteger(question[field]) || question[field] < 0 || question[field] > 127)) errors.push(`${qPath}.${field}: MIDIは0〜127の整数またはnullが必要です`);
          });
          ['midiNotes', 'correctNotes', 'selectedNotes'].forEach(field => {
            if (own(question, field) && (!Array.isArray(question[field]) || question[field].some(note => !(field === 'midiNotes' && note === null) && (!Number.isInteger(note) || note < 0 || note > 127)))) errors.push(`${qPath}.${field}: MIDI配列が不正です`);
          });
          if (own(question, 'responseTimeMs') && (typeof question.responseTimeMs !== 'number' || !Number.isFinite(question.responseTimeMs) || question.responseTimeMs < 0)) errors.push(`${qPath}.responseTimeMs: 0以上の有限値が必要です`);
        });
        if (sessionIds.has(record.sessionId)) errors.push(`${label}.sessionId: バックアップ内で重複しています`);
        sessionIds.add(record.sessionId);
      }
      if (store === 'checkins' && (typeof record.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.date))) errors.push(`${label}.date: YYYY-MM-DD形式が必要です`);
      if (store === 'questionPools') {
        if (!Array.isArray(record.remainingQuestionIds) || !Array.isArray(record.recentQuestionIds || [])) errors.push(`${label}: 問題プールの配列構造が不正です`);
      }
      if (store === 'problemPools' && own(record, 'remainingQuestionIds') && !Array.isArray(record.remainingQuestionIds)) errors.push(`${label}.remainingQuestionIds: 配列が必要です`);
    },

    validateBackup(raw) {
      const errors = [];
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) errors.push('トップレベル: オブジェクトが必要です');
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors };
      this._findDangerous(raw, 'backup', errors);
      if (raw.app !== 'piano-ear-game') errors.push('app: ピアノ音当てゲームのバックアップではありません');
      if (raw.backupVersion !== DATA_BACKUP_VERSION) errors.push('backupVersion: 未対応のバックアップバージョンです');
      if (typeof raw.schemaVersion !== 'number' || !Number.isInteger(raw.schemaVersion) || raw.schemaVersion < 1 || raw.schemaVersion > DATA_SCHEMA_VERSION) errors.push('schemaVersion: 未対応または不正です');
      if (!validIsoDate(raw.exportedAt)) errors.push('exportedAt: ISO日時が必要です');
      if (!['all', 'selected-profile'].includes(raw.scope)) errors.push('scope: 対象範囲が不正です');
      if (!raw.data || typeof raw.data !== 'object' || Array.isArray(raw.data)) errors.push('data: オブジェクトが必要です');
      const data = raw.data || {};
      DATA_STORES.forEach(store => {
        if (!Array.isArray(data[store])) errors.push(`data.${store}: 配列が必要です`);
        else if (data[store].length > MAX_RECORDS) errors.push(`data.${store}: 件数が多すぎます`);
      });
      if (data.localStorage !== undefined && (!data.localStorage || typeof data.localStorage !== 'object' || Array.isArray(data.localStorage))) errors.push('data.localStorage: オブジェクトが必要です');
      const profiles = Array.isArray(data.profiles) ? data.profiles : [];
      const profileIds = new Set(); const sessionIds = new Set();
      profiles.forEach((profile, index) => {
        if (profile && profile.id && profileIds.has(profile.id)) errors.push(`profiles[${index}].id: バックアップ内で重複しています`);
        if (profile?.id) profileIds.add(profile.id);
        this._validateRecord('profiles', profile, index, profileIds, sessionIds, errors);
      });
      DATA_STORES.filter(store => store !== 'profiles').forEach(store => (Array.isArray(data[store]) ? data[store] : []).forEach((record, index) => this._validateRecord(store, record, index, profileIds, sessionIds, errors)));
      const selectedId = raw.selectedProfileId;
      if (raw.scope === 'selected-profile' && (!validId(selectedId) || !profileIds.has(selectedId))) errors.push('selectedProfileId: バックアップ内のプロフィールが必要です');
      Object.entries(data.localStorage || {}).forEach(([key, value]) => {
        if (!key.startsWith(APP_LOCAL_STORAGE_PREFIX)) errors.push(`data.localStorage.${key}: アプリ所有キーではありません`);
        if (typeof value !== 'string') errors.push(`data.localStorage.${key}: 文字列が必要です`);
      });
      const declared = raw.manifest;
      if (!declared || typeof declared !== 'object') errors.push('manifest: 件数情報が必要です');
      else DATA_STORES.forEach(store => { if (declared[store] !== undefined && declared[store] !== (data[store] || []).length) errors.push(`manifest.${store}: 実データ件数と一致しません`); });
      return { ok: errors.length === 0, errors, backup: raw };
    },

    async _collisionSummary(backup) {
      const current = await this._readData(); const summary = { duplicates: 0, collisions: 0 };
      DATA_STORES.forEach(store => {
        const keys = new Map(current[store].map(record => [recordKey(store, record), record]));
        (backup.data[store] || []).forEach(record => {
          const key = recordKey(store, record);
          if (!key) return;
          if (keys.has(key)) { summary.collisions += 1; if (recordsEqual(keys.get(key), record)) summary.duplicates += 1; }
        });
      });
      return summary;
    },

    _copySuffix(base, stamp) { return `${base}-copy-${stamp}`.slice(0, 235); },
    _nextKey(used, base, stamp) {
      let key = base || 'record'; let counter = 0;
      while (used.has(key)) { counter += 1; key = this._copySuffix(base || 'record', `${stamp}-${counter}`); }
      used.add(key); return key;
    },
    _profileRecords(data, profileId) {
      const result = {};
      DATA_STORES.forEach(store => { result[store] = (data[store] || []).filter(record => store === 'profiles' ? record.id === profileId : relatedToProfile(record, profileId)); });
      return result;
    },

    async _prepareNewProfile(backup, sourceId) {
      const source = sourceId || backup.selectedProfileId || backup.data.profiles[0]?.id;
      const records = this._profileRecords(backup.data, source);
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const newId = this._nextKey(new Set(Object.keys(state.profiles)), source || 'profile', stamp);
      const original = records.profiles[0];
      if (!original) throw new Error('復元対象プロフィールがありません');
      const profile = { ...cloneData(original), id: newId, name: `${original.name || 'プロフィール'}（コピー）` };
      const sessionMap = new Map(); const output = Object.fromEntries(DATA_STORES.map(store => [store, []]));
      output.profiles.push(profile);
      const usedSessions = new Set((await this._readData()).sessions.map(session => session.sessionId));
      records.sessions.forEach(session => {
        const next = cloneData(session); const nextId = this._nextKey(usedSessions, session.sessionId, stamp);
        sessionMap.set(session.sessionId, nextId); next.sessionId = nextId; next.profileId = newId; output.sessions.push(next);
      });
      output.sessions.forEach(session => { if (session.sourceSessionId && sessionMap.has(session.sourceSessionId)) session.sourceSessionId = sessionMap.get(session.sourceSessionId); });
      const usedKeys = Object.fromEntries(DATA_STORES.map(store => [store, new Set()]));
      records.checkins.forEach(record => { const next = cloneData(record); next.profileId = newId; next.id = this._nextKey(usedKeys.checkins, `${newId}:${record.date || Date.now()}`, stamp); output.checkins.push(next); });
      records.questionPools.forEach(record => { const next = cloneData(record); next.profileId = newId; next.id = this._nextKey(usedKeys.questionPools, `${newId}:${record.id || record.poolSignature || 'pool'}`, stamp); if (next.poolSignature) next.poolSignature = next.id; output.questionPools.push(next); });
      records.problemPools.forEach(record => { const next = cloneData(record); next.profileId = newId; next.poolSignature = this._nextKey(usedKeys.problemPools, `${newId}:${record.poolSignature || 'pool'}`, stamp); output.problemPools.push(next); });
      ['heatmapData', 'reviewData'].forEach(store => records[store].forEach(record => { const next = cloneData(record); next.profileId = newId; next.id = this._nextKey(usedKeys[store], `${newId}:${record.id || store}`, stamp); if (next.sessionId && sessionMap.has(next.sessionId)) next.sessionId = sessionMap.get(next.sessionId); output[store].push(next); }));
      return { data: output, newProfileId: newId, sourceProfileId: source, added: Object.values(output).reduce((sum, list) => sum + list.length, 0), skipped: 0, reissued: output.sessions.length + output.checkins.length + output.questionPools.length + output.problemPools.length + output.heatmapData.length + output.reviewData.length + 1 };
    },

    async prepareRestore(mode, backup, sourceId) {
      const current = await this._readData();
      if (mode === 'new-profile') return this._prepareNewProfile(backup, sourceId);
      if (mode === 'replace') {
        if (backup.scope === 'all') return { mode, data: cloneData(backup.data), added: Object.values(backup.data).filter(Array.isArray).reduce((sum, list) => sum + list.length, 0), skipped: 0, reissued: 0, selectedProfileId: backup.selectedProfileId || null };
        const selected = sourceId || backup.selectedProfileId;
        const data = {};
        DATA_STORES.forEach(store => data[store] = current[store].filter(record => store === 'profiles' ? record.id !== selected : !(own(record, 'profileId') && record.profileId === selected)));
        DATA_STORES.forEach(store => data[store].push(...cloneData(backup.data[store] || [])));
        return { mode, data, added: Object.values(backup.data).filter(Array.isArray).reduce((sum, list) => sum + list.length, 0), skipped: 0, reissued: 0, selectedProfileId: selected };
      }
      const output = Object.fromEntries(DATA_STORES.map(store => [store, []]));
      const used = Object.fromEntries(DATA_STORES.map(store => [store, new Set(current[store].map(record => recordKey(store, record)))]));
      const profileMap = new Map(); const sessionMap = new Map(); let added = 0; let skipped = 0; let reissued = 0;
      const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      (backup.data.profiles || []).forEach(profile => {
        const currentRecord = current.profiles.find(item => item.id === profile.id);
        if (currentRecord && recordsEqual(currentRecord, profile)) { profileMap.set(profile.id, profile.id); skipped += 1; }
        else { const next = cloneData(profile); if (currentRecord) { next.id = this._nextKey(used.profiles, profile.id, stamp); reissued += 1; } else used.profiles.add(next.id); profileMap.set(profile.id, next.id); output.profiles.push(next); added += 1; }
      });
      (backup.data.sessions || []).forEach(session => {
        const next = cloneData(session); next.profileId = profileMap.get(session.profileId) || session.profileId;
        const currentRecord = current.sessions.find(item => item.sessionId === session.sessionId && item.profileId === next.profileId);
        if (currentRecord && recordsEqual(currentRecord, next)) { sessionMap.set(session.sessionId, session.sessionId); skipped += 1; return; }
        if (used.sessions.has(next.sessionId)) { const old = next.sessionId; next.sessionId = this._nextKey(used.sessions, old, stamp); reissued += 1; } else used.sessions.add(next.sessionId);
        sessionMap.set(session.sessionId, next.sessionId); output.sessions.push(next); added += 1;
      });
      output.sessions.forEach(session => { if (session.sourceSessionId && sessionMap.has(session.sourceSessionId)) session.sourceSessionId = sessionMap.get(session.sourceSessionId); });
      DATA_STORES.filter(store => !['profiles', 'sessions'].includes(store)).forEach(store => (backup.data[store] || []).forEach(record => {
        const next = cloneData(record); if (next.profileId) next.profileId = profileMap.get(next.profileId) || next.profileId; if (next.sessionId) next.sessionId = sessionMap.get(next.sessionId) || next.sessionId;
        let key = recordKey(store, next); const currentRecord = current[store].find(item => recordKey(store, item) === key && recordsEqual(item, next));
        if (currentRecord) { skipped += 1; return; }
        if (used[store].has(key)) { const old = key; key = this._nextKey(used[store], old, stamp); reissued += 1; if (store === 'problemPools') next.poolSignature = key; else if (store === 'questionPools') { next.id = key; if (next.poolSignature) next.poolSignature = key; } else next.id = key; } else used[store].add(key);
        output[store].push(next); added += 1;
      }));
      return { mode: 'add', data: output, added, skipped, reissued, profileMap, sessionMap, current };
    },

    async _writePlan(plan, mode, backup) {
      if (!state.db) throw new Error('IndexedDBを利用できません');
      const stores = mode === 'add' ? DATA_STORES : DATA_STORES;
      await new Promise((resolve, reject) => {
        const tx = state.db.transaction(stores, 'readwrite');
        const fail = error => { try { tx.abort(); } catch (_) {} reject(error || new Error('復元transactionに失敗しました')); };
        tx.onerror = () => fail(tx.error); tx.onabort = () => reject(tx.error || new Error('復元transactionが中断されました')); tx.oncomplete = resolve;
        try {
          if (!['add', 'new-profile'].includes(mode)) DATA_STORES.forEach(store => tx.objectStore(store).clear());
          DATA_STORES.forEach(store => (plan.data[store] || []).forEach(record => {
            const request = tx.objectStore(store).put(record); request.onerror = event => fail(event.target.error);
          }));
        } catch (error) { fail(error); }
      });
      if (mode === 'replace' && backup.scope === 'all') replaceAppLocalStorage(backup.data.localStorage || {});
      if (mode === 'new-profile') {
        const cache = localStorageSnapshot(); cache['pe_currentProfileId'] = JSON.stringify(plan.newProfileId); localStorage.setItem('pe_currentProfileId', cache['pe_currentProfileId']);
      }
      await ProfileManager.loadAll();
      const restoredProfileId = mode === 'replace' && backup.scope === 'all' ? LocalCache.load('currentProfileId', null) : null;
      const preferred = mode === 'new-profile' ? plan.newProfileId : (plan.selectedProfileId || restoredProfileId);
      const nextId = preferred && state.profiles[preferred] ? preferred : (state.currentProfileId && state.profiles[state.currentProfileId] ? state.currentProfileId : Object.keys(state.profiles)[0]);
      if (nextId) await ProfileManager.switchTo(nextId);
      SettingsController.loadSettings();
      HomeController.show();
      return plan;
    },

    _showErrors(errors) {
      const container = $('data-validation-errors'); if (!container) return;
      container.replaceChildren();
      const heading = document.createElement('strong'); heading.textContent = `検証に失敗しました（${errors.length}件）`; container.appendChild(heading);
      const list = document.createElement('ul'); errors.slice(0, 80).forEach(error => { const item = document.createElement('li'); item.textContent = error; list.appendChild(item); });
      container.appendChild(list); container.hidden = false;
    },

    _clearPreview() { this.currentBackup = null; this.currentFileName = ''; $('data-restore-preview')?.setAttribute('hidden', ''); $('data-validation-errors')?.setAttribute('hidden', ''); },
    _renderPreview(backup, fileName, collisions) {
      const preview = $('data-restore-preview'), list = $('data-preview-list'); if (!preview || !list) return;
      list.replaceChildren(); const manifest = backup.manifest || {}; const rows = [
        ['ファイル名', fileName], ['バックアップ日時', backup.exportedAt], ['backupVersion', backup.backupVersion], ['schemaVersion', backup.schemaVersion], ['対象範囲', backup.scope === 'all' ? '全プロフィール' : '選択プロフィール'],
        ['プロフィール数', manifest.profiles], ['プロフィール名', (backup.data.profiles || []).map(profile => profile.name).join('、') || 'なし'], ['セッション数', manifest.sessions], ['回答問題数', manifest.answeredQuestions], ['チェックイン数', manifest.checkins], ['問題プール数', (manifest.questionPools || 0) + (manifest.problemPools || 0)], ['未完了セッション数', manifest.incompleteSessions], ['設定の有無', manifest.hasSettings ? 'あり' : 'なし'], ['ヒートマップデータ', manifest.hasHeatmap ? 'あり' : 'なし'], ['重複候補', collisions.duplicates], ['ID衝突候補', collisions.collisions], ['警告', '手編集したJSONは復元しないでください']
      ];
      rows.forEach(([name, value]) => { const term = document.createElement('dt'); term.textContent = name; const desc = document.createElement('dd'); desc.textContent = String(value); list.append(term, desc); });
      const select = $('data-restore-profile'); select.replaceChildren(); (backup.data.profiles || []).forEach(profile => { const option = document.createElement('option'); option.value = profile.id; option.textContent = profile.name; select.appendChild(option); });
      if (backup.selectedProfileId && [...select.options].some(option => option.value === backup.selectedProfileId)) select.value = backup.selectedProfileId;
      this._updateRestorePlan(); preview.hidden = false;
    },
    _updateRestorePlan() {
      const mode = $('data-restore-mode')?.value || 'add'; const profileLabel = $('data-restore-profile-label'); const profileSelect = $('data-restore-profile');
      if (profileLabel) profileLabel.hidden = mode !== 'new-profile'; if (profileSelect) profileSelect.hidden = mode !== 'new-profile';
      const plan = $('data-restore-plan'); if (plan) plan.textContent = mode === 'add' ? '現在のデータを保持し、同一レコードはスキップします。衝突したIDは再発行します。' : mode === 'replace' ? '現在の全データを検証済みバックアップへ置き換えます。実行前に安全用バックアップを保存してください。' : '選択プロフィールを新しいIDへ複製し、元データは変更しません。';
    },

    async onFile(file) {
      this._clearPreview(); if (!file) return;
      if (file.size > MAX_BACKUP_BYTES) { this._showErrors(['ファイルサイズ: 20MBを超えるファイルは読み込めません']); return; }
      try {
        const started = performance.now(); const text = await file.text(); if (!text.trim()) { this._showErrors(['ファイル: 空ファイルです']); return; }
        let raw; try { raw = JSON.parse(text); } catch (error) { this._showErrors(['JSON: 構文が正しくありません']); return; }
        const result = this.validateBackup(raw); if (!result.ok) { console.warn('[DataManagement] backup rejected', result.errors.length); this._showErrors(result.errors); return; }
        const collisions = await this._collisionSummary(raw); this.currentBackup = raw; this.currentFileName = file.name; this._renderPreview(raw, file.name, collisions);
        const status = $('data-management-result'); if (status) status.textContent = `検証完了（${Math.round(performance.now() - started)}ms）。復元方式を選択してください。`;
      } catch (error) { console.warn('[DataManagement] file read failed', error.name); this._showErrors(['ファイル: 読み込みに失敗しました。再試行してください']); }
    },

    async export(scope) {
      if (this.busy) return; this.busy = true; const button = scope === 'all' ? $('data-export-all') : $('data-export-selected'); if (button) button.disabled = true;
      try {
        const started = performance.now(); const backup = await this.createBackup(scope); const json = JSON.stringify(backup, null, 2); const blob = new Blob([json], { type: 'application/json;charset=utf-8' }); const url = URL.createObjectURL(blob); const profile = state.profiles[state.currentProfileId]; const safeName = (profile?.name || 'profile').replace(/[^\p{Letter}\p{Number}_-]+/gu, '_').slice(0, 24); const filename = `piano-ear-backup-${scope === 'all' ? 'all' : safeName}-${Date.now()}.json`; const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.style.display = 'none'; document.body.appendChild(anchor); anchor.click(); setTimeout(() => { anchor.remove(); URL.revokeObjectURL(url); }, 1000);
        const status = $('data-management-result'); if (status) status.textContent = `JSONを書き出しました: ${filename}（${json.length} bytes、${Math.round(performance.now() - started)}ms）`;
      } catch (error) { console.warn('[DataManagement] export failed', error.name); showError('バックアップの書き出しに失敗しました'); } finally { this.busy = false; if (button) button.disabled = false; }
    },

    async restore() {
      if (this.busy || !this.currentBackup) return; const mode = $('data-restore-mode')?.value || 'add';
      if (mode === 'replace' && !await confirmDialog('現在のデータを置き換えます。実行前に取得した安全用バックアップがあることを確認してください。続けますか？')) return;
      this.busy = true; const execute = $('data-restore-execute'); if (execute) execute.disabled = true;
      try {
        const started = performance.now(); const plan = await this.prepareRestore(mode, this.currentBackup, $('data-restore-profile')?.value); await this._writePlan(plan, mode, this.currentBackup); const status = $('data-management-result'); if (status) status.textContent = `復元完了: 追加 ${plan.added || 0}件、スキップ ${plan.skipped || 0}件、ID変更 ${plan.reissued || 0}件（${Math.round(performance.now() - started)}ms）`; this._clearPreview(); await this.show();
      } catch (error) { console.warn('[DataManagement] restore failed', error.name); showError('復元に失敗しました。現在のデータは可能な限り保持されています'); } finally { this.busy = false; if (execute) execute.disabled = false; }
    },

    async _deleteByProfile(profileId, includeHistoryOnly = false) {
      const data = await this._readData(); const ids = { sessions: [], checkins: [], questionPools: [], problemPools: [], heatmapData: [], reviewData: [] };
      data.sessions.forEach(record => { if (record.profileId === profileId && (!includeHistoryOnly || record.completed === true)) ids.sessions.push(record.sessionId); });
      if (!includeHistoryOnly) ['checkins', 'questionPools', 'problemPools', 'heatmapData', 'reviewData'].forEach(store => data[store].forEach(record => { if (record.profileId === profileId) ids[store].push(recordKey(store, record)); }));
      else ['heatmapData', 'reviewData'].forEach(store => data[store].forEach(record => { if (record.profileId === profileId) ids[store].push(recordKey(store, record)); }));
      await new Promise((resolve, reject) => { const tx = state.db.transaction(DATA_STORES, 'readwrite'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('削除transactionが中断されました')); Object.entries(ids).forEach(([store, keys]) => keys.forEach(key => tx.objectStore(store).delete(key))); });
      return ids;
    },

    async resetSettings() {
      if (!await confirmDialog('現在プロフィールのゲーム、音量、演出、表示、MIDI、BGM設定を既定値へ戻します。履歴とチェックインは保持します。')) return false;
      state.settings = { ...DEFAULT_SETTINGS }; await ProfileManager.saveCurrentSettings(); ProfileManager.applyTheme(); SettingsController.loadSettings(); this._setResult('現在プロフィールの設定を初期化しました。履歴とチェックインは保持されています。'); return true;
    },
    async deleteHistory() {
      if (!await confirmDialog('現在プロフィールの完了セッション、回答履歴、復習候補、分析・ヒートマップ集計を削除します。未完了セッション、設定、チェックイン、問題プール、別プロフィールは保持します。')) return false;
      await this._deleteByProfile(state.currentProfileId, true); this._setResult('現在プロフィールの履歴を削除しました。'); await this.show(); return true;
    },
    async resetProfile() {
      if (!await confirmDialog('現在プロフィールの設定、履歴、チェックイン、問題プール、苦手・ヒートマップ、未完了データを初期化します。名前とアイコンは保持します。')) return false;
      await this._deleteByProfile(state.currentProfileId, false); state.settings = { ...DEFAULT_SETTINGS }; await ProfileManager.saveCurrentSettings(); ProfileManager.applyTheme(); SettingsController.loadSettings(); this._setResult('現在プロフィールを初期化しました。プロフィール名とアイコンは保持されています。'); await this.show(); return true;
    },
    _setResult(message) { const status = $('data-management-result'); if (status) status.textContent = message; },
    async deleteAll() {
      if (!await confirmDialog('全データ削除の第1確認です。プロフィール、履歴、設定、チェックイン、問題プール、復習・分析データを削除します。')) return false;
      const dialog = $('data-delete-confirm'), input = $('data-delete-confirm-text'), ok = $('data-delete-confirm-ok'), cancel = $('data-delete-confirm-cancel'); if (!dialog || !input || !ok || !cancel) return false;
      input.value = ''; ok.disabled = true; dialog.hidden = false; input.focus();
      const confirmed = await new Promise(resolve => { const cleanup = () => { dialog.hidden = true; input.value = ''; ok.disabled = true; input.removeEventListener('input', update); ok.removeEventListener('click', yes); cancel.removeEventListener('click', no); }; const update = () => { ok.disabled = input.value.trim() !== '全データ削除'; }; const yes = () => { cleanup(); resolve(true); }; const no = () => { cleanup(); resolve(false); }; input.addEventListener('input', update); ok.addEventListener('click', yes); cancel.addEventListener('click', no); });
      if (!confirmed) return false;
      this.busy = true; try {
        const defaultProfile = { ...cloneData(DEFAULT_PROFILE), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        await new Promise((resolve, reject) => { const tx = state.db.transaction(DATA_STORES, 'readwrite'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error || new Error('全削除transactionが中断されました')); DATA_STORES.forEach(store => tx.objectStore(store).clear()); tx.objectStore('profiles').put(defaultProfile); });
        Object.keys(localStorageSnapshot()).forEach(key => localStorage.removeItem(key)); LocalCache.save('currentProfileId', 'default'); LocalCache.save('theme', 'cream'); state.currentProfileId = 'default'; state.profiles = { default: defaultProfile }; state.settings = { ...DEFAULT_SETTINGS }; ProfileManager.applyTheme(); SettingsController.loadSettings(); Screens.show('home'); this._setResult('全データを削除し、初期プロフィールを作成しました。'); return true;
      } catch (error) { console.warn('[DataManagement] delete all failed', error.name); showError('全データ削除に失敗しました。再試行してください'); return false; } finally { this.busy = false; }
    },

    async show() { this._clearPreview(); const data = await this._readData(); const status = $('data-management-counts'); if (status) status.textContent = `プロフィール ${data.profiles.length}件 / セッション ${data.sessions.length}件 / チェックイン ${data.checkins.length}件 / 問題プール ${data.questionPools.length + data.problemPools.length}件`; },
    mount() {
      $('data-export-all')?.addEventListener('click', () => this.export('all'));
      $('data-export-selected')?.addEventListener('click', () => this.export('selected-profile'));
      $('data-import-file')?.addEventListener('change', event => this.onFile(event.target.files?.[0]));
      $('data-restore-mode')?.addEventListener('change', () => this._updateRestorePlan());
      $('data-restore-cancel')?.addEventListener('click', () => this._clearPreview());
      $('data-restore-execute')?.addEventListener('click', () => this.restore());
      $('data-reset-settings')?.addEventListener('click', () => this.resetSettings());
      $('data-delete-history')?.addEventListener('click', () => this.deleteHistory());
      $('data-reset-profile')?.addEventListener('click', () => this.resetProfile());
      $('data-delete-all')?.addEventListener('click', () => this.deleteAll());
      document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !$('data-delete-confirm')?.hidden) {
          event.preventDefault(); $('data-delete-confirm-cancel')?.click();
        }
      });
    }
  };

  const Screens = {
    show(screenName, params = {}) {
      // 旧「過去履歴」入口からの遷移も、復習画面へ安全に集約する。
      if (screenName === 'history') screenName = 'review';
      if (screenName !== 'session') EffectsManager.cancel('screen-navigation');
      if (state.currentScreen === 'calendar' && screenName !== 'calendar') CalendarController.clearTodayCode();
      if (screenName === 'session-detail') {
        state.sessionDetailReturnScreen = params.returnTo || state.currentScreen || 'home';
        state.selectedSessionId = params.sessionId || null;
      }
      if (screenName === 'home') { state.sessionDetailReturnScreen = null; state.selectedSessionId = null; }
      const fromScreen = state.currentScreen;
      document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
      const target = $(`screen-${screenName}`);
      if (target) target.classList.add('active');
      state.navigationRevision += 1;
      state.previousScreen = screenName === 'home' ? null : fromScreen;
      state.currentScreen = screenName;
      this.onShow(screenName, params);
      // BGM: 画面に応じてフェード切替
      AudioSystem.switchBGMForScreen(screenName);
    },
    onShow(screenName, params) {
      switch (screenName) {
        case 'home': HomeController.show(params); break;
        case 'mode-select': ModeSelectController.show(params); break;
        case 'session': SessionController.show(params); break;
        case 'calendar': CalendarController.show(params); break;
        case 'review': ReviewController.show(params); break;
        case 'analytics': AnalyticsController.show(params); break;
        case 'settings': SettingsController.show(params); break;
        case 'midi-test': MidiTestController.show(params); break;
        case 'result': ResultController.show(params); break;
        case 'profile': ProfileController.show(params); break;
        case 'session-detail': SessionDetailController.show(params); break;
        case 'data-management': DataManagementController.show(params); break;
      }
    },
    back() {
      if (state.currentScreen === 'session' && state.currentSession) {
        SessionController.handleBack();
        return;
      }
      if (state.currentScreen === 'session-detail') {
        const returnTo = state.sessionDetailReturnScreen || 'home';
        state.sessionDetailReturnScreen = null;
        state.selectedSessionId = null;
        this.show(returnTo);
        // 詳細から一覧へ戻った後、次の戻る操作はホームへ戻す。
        if (['calendar', 'history'].includes(returnTo)) state.previousScreen = 'home';
        return;
      }
      if (state.currentScreen === 'data-management') {
        this.show('settings');
        state.previousScreen = 'home';
        return;
      }
      // MIDIテストから設定へ戻った後に「戻る」を押した場合、
      // 設定⇔MIDIテストの1段履歴を往復せずホームへ戻す。
      const target = (state.currentScreen === 'settings' && ['midi-test', 'profile'].includes(state.previousScreen))
        ? 'home'
        : (state.previousScreen || 'home');
      const reviewSettingsCycle = ['review', 'settings'].includes(state.currentScreen)
        && ['review', 'settings'].includes(target);
      this.show(reviewSettingsCycle ? 'home' : target);
    }
  };

  // ========================================
  // 各画面コントローラー
  // ========================================

  const HomeController = {
    show() {
      AudioSystem.updatePianoStatusUI();
      ProfileManager.updateUI();
      // コード設定
      document.querySelectorAll('#settings-chord-octave .choice-btn').forEach(b => b.classList.toggle('choice-active', b.dataset.value===(state.settings.chordOctaveJudgement||'exact')));
      this.updateStats(); this.checkContinue(); this.updateCheckinStatus();
    },
    async updateStats() {
      const elSessions=$('home-stats-total-sessions'), elAccuracy=$('home-stats-accuracy'), elStreak=$('home-stats-streak');
      if(!elSessions||!elAccuracy||!elStreak)return;
      try {
        const all=await Storage.getAll('sessions');
        const completed=all.filter(s=>s.completed&&s.profileId===state.currentProfileId);
        elSessions.textContent=completed.length;
        const totalQ=completed.reduce((t,s)=>t+(s.questionCount||0),0);
        const totalC=completed.reduce((t,s)=>t+(s.correctCount||0),0);
        const acc=totalQ>0?Math.round(totalC/totalQ*100):0;
        elAccuracy.textContent=totalQ>0?`${acc}%`:'--%';
        const maxStreak=completed.reduce((t,s)=>Math.max(t,s.maxStreak||0),0);
        elStreak.textContent=maxStreak;
      } catch(e) { console.warn('[Home] stats error:',e); }
    },
    async checkContinue() {
      const el = $('home-continue'), info = $('home-continue-info');
      if (!el || !info) return;
      const cached = LocalCache.load(SessionManager._cacheKey(), null) || LocalCache.load('incompleteSession', null);
      if (cached && cached.profileId === state.currentProfileId) {
        // IndexedDBから詳細を取得（localStorageにはIDのみ保存）
        const session = await Storage.get('sessions', cached.sessionId);
        if (session && !session.completed && session.profileId === state.currentProfileId) {
          el.hidden = false;
          const modeName = session.modeName || 'セッション';
          info.textContent = `${modeName} ${(session.currentTurn||0)+1} / ${session.questionCount}問目`;
          return;
        }
        // IndexedDBに見つからなければキャッシュ削除
        LocalCache.remove(SessionManager._cacheKey());
      }
      el.hidden = true;
    },
    async updateCheckinStatus() {
      const el = $('home-checkin-status');
      if (!el) return;
      const checkin = await CheckinManager.get();
      el.textContent = checkin ? `✅ ${CheckinManager.stampLabels[checkin.stamp] || '音符'} チェックイン済み` : '今日の音符スタンプを押そう';
      const card = $('home-checkin-card');
      if (card) {
        card.setAttribute('aria-disabled', 'false');
        card.dataset.checkinComplete = checkin ? 'true' : 'false';
      }
    }
  };

  const ModeSelectController = { show() {
    AudioSystem.updatePianoStatusUI();
    const ic=document.querySelector('.mode-card[data-mode="interval"] .mode-desc');
    if(ic) ic.textContent=`${state.settings.intervalPlaybackType==='melodic'?'順次':'同時'}再生・${state.settings.intervalAnswerType==='keyboard'?'鍵盤':'音程名'}回答`;
    const diff=state.settings.difficulty||'normal';
    const oct=state.settings.chordOctaveJudgement||'exact';
    const ol=oct==='exact'?'実音高':'音の種類';
    const cc=document.querySelector('.mode-card[data-mode="chord"] .mode-desc');
    if(cc) cc.textContent=`${diff==='advanced'?'全コード':diff==='beginner'?'メジャー・マイナー':'基本三和音'}・${ol}`;
    const sc=document.querySelector('.mode-card[data-mode="seventh"] .mode-desc');
    if(sc) sc.textContent='4和音の構成音を答える';
    const nc=document.querySelector('.mode-card[data-mode="chord-name"] .mode-desc');
    if(nc) nc.textContent=`ルート+${diff==='advanced'?'コード種類':'基本三和音'}`;
    const vc=document.querySelector('.mode-card[data-mode="inversion"] .mode-desc');
    if(vc) vc.textContent=`${diff==='advanced'?'全転回形':diff==='beginner'?'基本形のみ':'三和音転回形'}`;
  } };

  // ========================================
  // セッションコントローラー（第3段階 本実装）
  // ========================================

  const SessionController = {
    _inputLocked: false, _answered: false, _nextTurnTimer: null, _playbackLocked: false,
    _openingSequence: false, _openingTimer: null, _countdownTimers: [], _advanceBusy: false, _finishInProgress: false,

    _setAdvanceButton({ hidden = true, disabled = true, busy = false, label = '次の問題へ' } = {}) {
      const button = $('answer-next-btn');
      if (!button) return;
      button.hidden = hidden;
      button.disabled = disabled;
      button.setAttribute('aria-busy', String(busy));
      button.textContent = label;
    },

    _prepareManualAdvance() {
      const session = state.currentSession;
      const question = state.currentQuestion;
      if (!session || !question || !question.answered || question.isCorrect !== false) return;
      question.advanceState = 'awaiting-next';
      this._inputLocked = true;
      this._answered = true;
      SessionManager.saveCurrentQuestion();
      this._setAdvanceButton({
        hidden: false,
        disabled: false,
        busy: false,
        label: session.currentTurn + 1 >= session.questionCount ? '結果を見る' : '次の問題へ'
      });
    },

    _restoreAnsweredQuestion(question) {
      const correctNotes = questionNotes(question, 'correct');
      const answerNotes = questionNotes(question, 'answer');
      const statusEl = $('session-status');
      if (!statusEl) return;
      if (question.isCorrect) {
        statusEl.innerHTML = `<div class="result-feedback correct-feedback"><span class="feedback-icon">✅</span><span class="feedback-text">正解！</span><span class="feedback-note">${question.displayName || ''}</span></div>`;
      } else {
        const selected = answerNotes.length ? answerNotes.map(n => midiToNoteName(n, state.settings.noteLabel)).join('、') : 'なし';
        statusEl.innerHTML = `<div class="result-feedback wrong-feedback"><span class="feedback-icon">❌</span><span class="feedback-text">不正解</span><span class="feedback-detail">正解：${question.displayName || correctNotes.map(n => midiToNoteName(n, state.settings.noteLabel)).join('、')}</span><span class="feedback-answer">選択：${selected}</span></div>`;
      }
      correctNotes.forEach(note => PianoKeyboard.setKeyState(note, 'correct'));
      answerNotes.filter(note => !correctNotes.includes(note)).forEach(note => PianoKeyboard.setKeyState(note, 'wrong'));
    },

    _cancelPendingNextTurn() {
      if (this._nextTurnTimer !== null) clearTimeout(this._nextTurnTimer);
      this._nextTurnTimer = null;
      EffectsManager.cancel('next-turn-cancelled');
    },

    _scheduleNextTurn() {
      this._cancelPendingNextTurn();
      if (this._openingTimer !== null) clearTimeout(this._openingTimer);
      this._openingTimer = null;
      this._countdownTimers.forEach(timer => clearTimeout(timer));
      this._countdownTimers = [];
      this._playbackLocked = false;
      this._cancelMidiAutoConfirm();
      const sessionId = state.currentSession?.sessionId;
      const turn = state.currentSession?.currentTurn;
      const questionId = state.currentQuestion?.questionId;
      const startEffect = state.currentQuestion?.isCorrect
        ? EffectsManager.startCorrect.bind(EffectsManager)
        : EffectsManager.startIncorrect.bind(EffectsManager);
      return startEffect({ sessionId, currentTurn: turn, questionId, onComplete: (effectToken) => {
        const session = state.currentSession;
        const question = state.currentQuestion;
        if (state.currentScreen !== 'session' ||
            session?.sessionId !== sessionId || session?.currentTurn !== turn ||
            question?.questionId !== questionId || !question.answered) return;
        if (question.isCorrect === false) this._prepareManualAdvance();
        else this.nextTurn();
      }});
    },

    async show(params) {
      this._cancelPendingNextTurn();
      const { mode, difficulty, questionCount, resumeSession } = params;
      if (!mode) { Screens.show('mode-select'); return; }
      if (AudioSystem.pianoState !== 'ready') {
        Screens.show('home');
        showError(AudioSystem.pianoState === 'loading' ? 'ピアノ音源を準備しています。完了後にセッションを開始してください。' : 'ピアノ音源を読み込めませんでした。再試行してください。');
        AudioSystem.updatePianoStatusUI();
        return;
      }

      AudioSystem.resume();
      AudioSystem.beginSessionAudio();
      AudioSystem.playSfxTone('start');

      // セッション名を表示
      $('session-mode-name').textContent = this.getModeLabel(mode);
      this._inputLocked = false;
      this._answered = false;
      this._advanceBusy = false;
      this._finishInProgress = false;
      this._setAdvanceButton();

      // 鍵盤を描画（表示音域を設定）
      const container = $('piano-keyboard');
      if (container) {
        const isBeginner = state.settings.difficulty === 'beginner';
        const start = isBeginner ? 48 : 36; // C3 または C2
        const end = isBeginner ? 72 : 84;   // C5 または C6
        PianoKeyboard.visibleOctaves = isBeginner ? 2 : 3;
        PianoKeyboard.baseOctave = 4;
        PianoKeyboard.render(container, start, end);
        PianoKeyboard.refreshLabels();
        PianoKeyboard._updateRangeLabel();
        

      // MIDI入力のセットアップ（セッション用）
      if (state.settings.midiEnabled) {
        await this._setupMidiForSession(mode);
      } else {
        this._teardownMidiForSession();
      }
      PianoKeyboard._onNoteDown = (state.settings.midiEnabled && state.settings.midiScreenKeyboardEnabled === false)
  ? null
  : (midi) => {
    if (this._inputLocked || this._answered || !state.currentQuestion) return;
    AudioSystem.playPianoSample(midi, { duration: 0.9, velocity: 96 });
    mode === 'single' ? this.handleSingleNote(midi) : this.toggleNote(midi);
  };
      PianoKeyboard._onNoteUp = (midi) => { if (midi >= 0) AudioSystem.stopPianoNote(midi); };
        PianoKeyboard._multiSelectMode = mode!=='single';
      }


      if(CM(mode)){const cr=$('session-chord-root-choices'),ct=$('session-chord-type-choices'),iv=$('session-inversion-choices');if(cr)cr.hidden=!CM_NAME(mode)&&!CM_INV(mode);if(ct)ct.hidden=!CM_NAME(mode)&&!CM_INV(mode);if(iv)iv.hidden=!CM_INV(mode);this._populateChordRootButtons();this._populateChordTypeButtons(mode);if(CM_INV(mode))this._populateInversionButtons();}else{const ch=$('session-chord-choices');if(ch)ch.hidden=true;const cr=$('session-chord-root-choices');if(cr)cr.hidden=true;const ct=$('session-chord-type-choices');if(ct)ct.hidden=true;const iv=$('session-inversion-choices');if(iv)iv.hidden=true;}
      // セッション開始または再開
      try {
        if (resumeSession) {
          const loaded = await SessionManager.loadIncomplete();
          if (!loaded) {
            // 復元できなければ新規開始
            const session = await SessionManager.start(mode, difficulty, questionCount);
            state.currentSession = session;
          }
        } else {
          const session = await SessionManager.start(mode, difficulty, questionCount);
          state.currentSession = session;
        }
      } catch (error) {
        this._teardownMidiForSession();
        AudioSystem.endSessionAudio();
        Screens.show('mode-select');
        showError(error?.message || 'セッションを開始できませんでした。設定を確認してください。');
        return;
      }
      if(state.currentSession?.mode==='interval') {
        state.settings.intervalPlaybackType=state.currentSession.playbackType||state.settings.intervalPlaybackType;
        state.settings.intervalAnswerType=state.currentSession.answerType||state.settings.intervalAnswerType;
      }

      // 次の問題へ
      this.showCurrentQuestion();
    },

    getModeLabel(m) {
      return _modeLabel(m);
    },

    /** 現在の問題を表示 */
    showCurrentQuestion() {
      const session = state.currentSession;
      if (!session) return;

      // 前問の不正解/正解演出が次問の鍵盤に重ならないよう、表示開始時に完全消去する。
      EffectsManager.cancel('next-question');

      const turn = session.currentTurn;
      const q = session.questions[turn];
      if (!q) { this.finishSession(); return; }

      state.currentQuestion = q;
      const restoredAnswered = q.answered === true;
      this._answered = restoredAnswered;
      this._inputLocked = restoredAnswered;
      this._advanceBusy = false;
      this._setAdvanceButton();
      this._setChordChoiceEnabled(false);
      const playButton = $('session-play-btn');
      if (playButton) {
        playButton.hidden = false;
        playButton.disabled = false;
      }

      // 進捗更新
      $('session-progress-text').textContent = `${turn+1} / ${session.questionCount}`;
      $('session-progress-fill').style.width = `${((turn) / session.questionCount) * 100}%`;

      // ストリーク表示
      const streakEl = $('session-streak');
      if (session.streakCount >= 3) {
        streakEl.textContent = `🔥 ${session.streakCount}連続正解`;
        streakEl.hidden = false;
      } else {
        streakEl.hidden = true;
      // MIDI接続状態インジケーター
      const midiIndicator = $('session-midi-indicator');
      if (midiIndicator) {
        if (state.midiConnected && state.settings.midiEnabled) {
          midiIndicator.hidden = false;
          midiIndicator.textContent = 'MIDI: ' + (MIDIManager.getInputList().find(i => i.id === state.midiSelectedInputId)?.name || '接続済み');
        } else {
          midiIndicator.hidden = true;
        }
      }

      }

      // 鍵盤をクリア
            state.midiAnswerNotes = new Set();
      this._cancelMidiAutoConfirm();
      state.midiActiveNotes = new Map();
      state.midiSustainedNotes = new Set();
      PianoKeyboard.clearEffectStates();
      PianoKeyboard.clearStates();
      state.selectedNotes = [...(q.selectedNotes||[])];
      this._limitSelectedNotes(q);
      $('session-clear-btn').disabled = true;
      $('session-undo-btn').disabled = true;
      $('session-submit-btn').disabled = true;
      this.renderSelection();
      const choices=$('session-interval-choices');
      const intervalNameMode=session.mode==='interval' && (session.answerType||'name')==='name';
      choices.hidden=!intervalNameMode;
      choices.innerHTML=intervalNameMode?INTERVAL_DEFINITIONS.map(d=>`<button class="btn btn-secondary interval-choice${q.selectedInterval===d.semitones?' choice-active':''}" data-interval="${d.semitones}">${d.name}</button>`).join(''):'';
      if(intervalNameMode) $('session-submit-btn').disabled=!q.selectedInterval;
      // コードモードの選択肢は問題設定後に再生成する。
      // セブンス問題では、ここで第3転回形を含めた選択肢を確定する。
      if(CM(session.mode)){
        if(CM_INV(session.mode))this._populateInversionButtons();
        this._restoreChordSelection(q);
      }

      // ステータス表示
      const statusEl = $('session-status');
      statusEl.innerHTML = `<p class="question-label">問題 ${turn+1} / ${session.questionCount}</p>`;

      if (restoredAnswered) {
        this._restoreAnsweredQuestion(q);
        if (q.isCorrect === false) {
          this._prepareManualAdvance();
        } else {
          this._scheduleNextTurn();
        }
        return;
      }

      // 各ターンの開始前に3秒カウントダウンしてから問題音を再生する。
      // カウントダウン中は鍵盤・回答操作を受け付けない。
      this._inputLocked = true;
      this._setChordChoiceEnabled(false);
      const countdown = $('session-countdown');
      const countdownIsActive = () => state.currentScreen === 'session' && state.currentQuestion === q && !q.answered;
      if (countdown) { countdown.hidden = false; countdown.textContent = '3'; }
      if (playButton) { playButton.hidden = true; playButton.disabled = true; }
      q.replayCount = q.replayCount || 0;
      const finishCountdown = () => {
        this._countdownTimers = [];
        if (state.currentScreen !== 'session' || state.currentQuestion !== q || q.answered) return;
        if (countdown) countdown.hidden = true;
        if (playButton) playButton.hidden = false;
        q.startedAt = Date.now();
        this._inputLocked = false;
        this._setChordChoiceEnabled(true);
        this.playQuestion();
      };
      this._countdownTimers.push(setTimeout(() => {
        if (!countdownIsActive()) return;
        if (countdown) countdown.textContent = '2';
        this._countdownTimers.push(setTimeout(() => {
          if (!countdownIsActive()) return;
          if (countdown) countdown.textContent = '1';
          this._countdownTimers.push(setTimeout(finishCountdown, 1000));
        }, 1000));
      }, 1000));
    },

    /** 問題音を再生 */
    playQuestion() {
      if (this._playbackLocked || this._inputLocked || this._answered) return;
      AudioSystem.resume();
      const q = state.currentQuestion;
      if (!q) return;

      this._playbackLocked = true;
      const playButton = $('session-play-btn');
      if (playButton) playButton.disabled = true;
      const unlockAfter = q.midiNotes && CM(q.mode) ? 1300 : q.playback === 'melodic' ? 1600 : 900;
      setTimeout(() => {
        this._playbackLocked = false;
        if (playButton) playButton.disabled = false;
      }, unlockAfter);

      if (q.midiNote !== undefined) {
        // 単音
        AudioSystem.playPianoSample(q.midiNote, { duration: 0.8, velocity: 96 });
      } else if(q.midiNotes) {
        if(CM(q.mode)){ AudioSystem.playChord(q.midiNotes,1.2); }
        else if(q.playback==='melodic'){ AudioSystem.playPianoSample(q.midiNotes[0], { duration: 0.8, velocity: 96 }); setTimeout(()=>AudioSystem.playPianoSample(q.midiNotes[1], { duration: 0.8, velocity: 96 }),700); }
        else AudioSystem.playChord(q.midiNotes,1.0);
      }

      q.replayCount = (q.replayCount || 0) + 1;
      SessionManager.saveCurrentQuestion();
    },

    /** 単音モード：鍵盤が押されたら即回答 */
    handleSingleNote(midi) {
      if (this._inputLocked || this._answered) return;
      this._inputLocked = true;
      this._answered = true;

      const q = state.currentQuestion;
      if (!q) { this._inputLocked = false; return; }

      const correct = q.midiNote;
      const isCorrect = midi === correct;
      const diff = midi - correct;
      const absDiff = Math.abs(diff);
      const responseTime = Date.now() - (q.startedAt || Date.now());

      // 結果を保存
      
      q.answered = true;
      q.selectedNote = midi;
      q.isCorrect = isCorrect;
      // MIDI入力方法を記録（単音）
      q.inputMethod = (state.settings.midiEnabled && state.midiConnected) ? 'midi' : (state.settings.midiEnabled ? 'midi' : 'screen');
      q.midiNotes = [(state.settings.midiEnabled && state.midiConnected) ? midi : null];
      q.midiVelocities = (state.settings.midiEnabled && state.midiConnected) ? [state.midiLastVelocity || 0] : [];
      q.midiOctaveOffset = state.settings.midiOctaveOffset || 0;
      q.midiConfirmationMode = state.settings.midiConfirmationMode || 'singleImmediate';
q.answered = true;
      q.selectedNote = midi;
      q.isCorrect = isCorrect;
      q.responseTimeMs = responseTime;
      q.semitoneDistance = absDiff;
      q.direction = diff > 0 ? 'higher' : (diff < 0 ? 'lower' : 'same');
      q.advanceState = 'feedback-playing';

      const session = state.currentSession;
      session.totalResponseTimeMs = (Number(session.totalResponseTimeMs)||0) + responseTime;

      // 正誤の鍵盤表示
      PianoKeyboard.setKeyState(correct, 'correct');
      if (!isCorrect) {
        PianoKeyboard.setKeyState(midi, 'wrong');
      }

      // 結果メッセージ
      const statusEl = $('session-status');
      if (isCorrect) {
        session.correctCount++;
        session.streakCount++;
        if (session.streakCount > session.maxStreak) session.maxStreak = session.streakCount;
        statusEl.innerHTML = `
          <div class="result-feedback correct-feedback">
            <span class="feedback-icon">✅</span>
            <span class="feedback-text">正解！</span>
            <span class="feedback-note">${q.displayName}</span>
          </div>`;
      } else {
        session.streakCount = 0;
        const dir = diff > 0 ? '高い' : '低い';
        let dirMsg = '';
        if (absDiff >= 12) {
          const oct = Math.floor(absDiff / 12);
          const semi = absDiff % 12;
          dirMsg = `正解より${oct}オクターブ${semi > 0 ? `と${semi}半音` : ''}${dir}音です`;
        } else {
          dirMsg = `正解より${absDiff}半音${dir}音です`;
        }
        statusEl.innerHTML = `
          <div class="result-feedback wrong-feedback">
            <span class="feedback-icon">❌</span>
            <span class="feedback-text">不正解</span>
            <span class="feedback-detail">${dirMsg}</span>
            <span class="feedback-answer">正解：${q.displayName} | 選択：${midiToNoteName(midi, state.settings.noteLabel) || midiToNoteName(midi, 'english')}</span>
          </div>`;
      }

      // セッションを保存
      this._setAdvanceButton();
      SessionManager.saveCurrentQuestion();

      // 自動で次の問題へ
      this._scheduleNextTurn();
    },

    /** 単音の手動確定用に候補を1つだけ選択する。 */
    selectSingleNote(midi) {
      if (this._inputLocked || this._answered || !state.currentQuestion) return;
      state.selectedNotes = [midi];
      state.currentQuestion.selectedNotes = [midi];
      state.currentQuestion.selectedOrder = [midi];
      PianoKeyboard.setKeyState(midi, 'selected');
      this.renderSelection();
      this.persistDraft();
    },

    getMaxSelectableNotes(q = state.currentQuestion) {
      if (!q) return 0;
      const mode = q.mode || state.currentSession?.mode;
      if (mode === 'single') return 1;
      if (mode === 'interval' && (state.currentSession?.answerType || q.answerType || 'name') !== 'keyboard') return 0;
      if (CM_NAME(mode)) return 0;
      const expected = Array.isArray(q.correctNotes) && q.correctNotes.length
        ? q.correctNotes
        : (Array.isArray(q.midiNotes) ? q.midiNotes : []);
      if (expected.length) return expected.length;
      if (mode === 'pair') return 2;
      if (mode === 'triple' || mode === 'progression' || mode === 'mixed') return 3;
      return 0;
    },

    _limitSelectedNotes(q = state.currentQuestion) {
      if (!q) return 0;
      const max = this.getMaxSelectableNotes(q);
      const unique = [...new Set((Array.isArray(state.selectedNotes) ? state.selectedNotes : []).filter(Number.isFinite))];
      state.selectedNotes = unique.slice(0, max);
      const selected = new Set(state.selectedNotes);
      q.selectedOrder = (Array.isArray(q.selectedOrder) ? q.selectedOrder : [])
        .filter(note => selected.has(note))
        .filter((note, index, order) => order.indexOf(note) === index)
        .slice(0, max);
      state.selectedNotes.forEach(note => { if (!q.selectedOrder.includes(note)) q.selectedOrder.push(note); });
      q.selectedNotes = [...state.selectedNotes];
      return max;
    },

    toggleNote(midi) {
      if(this._inputLocked||this._answered)return;
      if(state.currentSession?.mode==='interval' && (state.currentSession.answerType||'name')!=='keyboard')return;
      const q=state.currentQuestion;
      const max = this._limitSelectedNotes(q) || 0;
      const i=state.selectedNotes.indexOf(midi);
      if(i>=0){state.selectedNotes.splice(i,1);if(state.currentQuestion?.selectedOrder)state.currentQuestion.selectedOrder=state.currentQuestion.selectedOrder.filter(x=>x!==midi);}
      else if(state.selectedNotes.length<max){state.selectedNotes.push(midi);if(!state.currentQuestion)return;if(!state.currentQuestion.selectedOrder)state.currentQuestion.selectedOrder=[];state.currentQuestion.selectedOrder.push(midi);}
      this.renderSelection(); this.persistDraft();
    },
    renderSelection(){ const el=$('session-selected-notes'); if(!el)return;
      const order=state.currentQuestion?.selectedOrder||state.selectedNotes;const shown=new Set();const chips=[];
      for(const n of order){if(shown.has(n)||!state.selectedNotes.includes(n))continue;shown.add(n);chips.push(`<button class="selected-note-chip" data-remove-note="${n}" aria-label="${midiToNoteName(n,'english')}を解除">${midiToNoteName(n,state.settings.noteLabel)}</button>`);}
      el.innerHTML=chips.join('');
      $('session-clear-btn').disabled=!state.selectedNotes.length; $('session-undo-btn').disabled=!state.selectedNotes.length;
      $('session-submit-btn').disabled=!state.selectedNotes.length; },
    persistDraft(){if(!state.currentQuestion)return;state.currentQuestion.selectedNotes=[...state.selectedNotes];state.currentQuestion.selectedOrder=[...(state.currentQuestion.selectedOrder||[])];SessionManager.saveCurrentQuestion();},
    undoSelection(){if(state.selectedNotes.length>0){const last=state.selectedNotes.pop();const order=state.currentQuestion?.selectedOrder;if(order){const li=order.lastIndexOf(last);if(li>=0)order.splice(li,1);}}this.renderSelection();this.persistDraft();},
    clearSelection(){state.selectedNotes=[];if(state.currentQuestion)state.currentQuestion.selectedOrder=[];this.renderSelection();this.persistDraft();},
    chooseInterval(semitones){ if(this._inputLocked||this._answered)return; const n=Number(semitones);state.currentQuestion.selectedInterval=n;state.currentQuestion.selectedIntervalId=INTERVAL_DEFINITIONS[n-1]?.id||null;document.querySelectorAll('#session-interval-choices [data-interval]').forEach(b=>b.classList.toggle('choice-active',Number(b.dataset.interval)===n));$('session-submit-btn').disabled=false;SessionManager.saveCurrentQuestion(); },
    submitAnswer(notes=state.selectedNotes,interval=null){
      let q=state.currentQuestion,s=state.currentSession;
      this._limitSelectedNotes(q);
      notes = state.selectedNotes;
      if(q&&CM(s?.mode)){this._judgeChordAnswer();return;}
      
      if(this._inputLocked||this._answered)return; s=state.currentSession;q=state.currentQuestion;if(!q||!s)return;
      if (s.mode === 'single') {
        if (notes.length) this.handleSingleNote(notes[notes.length - 1]);
        return;
      }
      if(s.mode==='interval'&&(s.answerType||'name')==='name') interval=interval||q.selectedInterval;
      if(s.mode==='interval'&&(s.answerType||'name')==='name'&&!interval)return;
      this._inputLocked=this._answered=true;
      if(s.mode==='interval' && (s.answerType||'name')==='name'){q.selectedInterval=interval;q.selectedIntervalId=INTERVAL_DEFINITIONS[interval-1]?.id||null;q.isCorrect=interval===q.intervalSemitones;q.semitoneDistance=Math.abs(interval-q.intervalSemitones);}
      else if(s.mode==='interval'){const result=matchNoteSets(q.midiNotes,notes);q.selectedNotes=[...notes];Object.assign(q,{exactMatches:result.exactMatches,missingNotes:result.missingNotes,extraNotes:result.extraNotes,matchedDifferences:result.matchedDifferences,totalSemitoneDistance:result.totalSemitoneDistance});q.selectedIntervalId=notes.length===2?INTERVAL_DEFINITIONS[Math.abs(notes[1]-notes[0])-1]?.id||null:null;q.isCorrect=!result.missingNotes.length&&!result.extraNotes.length&&result.totalSemitoneDistance===0;q.semitoneDistance=result.totalSemitoneDistance;}
      else {const result=matchNoteSets(q.midiNotes,notes);q.selectedNotes=[...notes];q.exactMatches=result.exactMatches;q.missingNotes=result.missingNotes;q.extraNotes=result.extraNotes;q.matchedDifferences=result.matchedDifferences;q.totalSemitoneDistance=result.totalSemitoneDistance;q.isCorrect=!result.missingNotes.length&&!result.extraNotes.length&&result.totalSemitoneDistance===0;q.semitoneDistance=result.totalSemitoneDistance;}
      q.answered=true;q.responseTimeMs=Date.now()-(q.startedAt||Date.now());q.advanceState='feedback-playing';s.totalResponseTimeMs=(Number(s.totalResponseTimeMs)||0)+q.responseTimeMs;
      if(q.isCorrect){s.correctCount++;s.streakCount++;s.maxStreak=Math.max(s.maxStreak,s.streakCount);} else s.streakCount=0;
      const nameAnswer=s.mode==='interval'&&(s.answerType||'name')==='name';
      const missing=nameAnswer?q.intervalName:(q.missingNotes||[]).map(n=>midiToNoteName(n,state.settings.noteLabel)).join('、');
      const extra=nameAnswer?INTERVAL_DEFINITIONS[interval-1]?.name:(q.extraNotes||[]).map(n=>midiToNoteName(n,state.settings.noteLabel)).join('、');
      const intervalDetail=s.mode==='interval'&&!nameAnswer?`<span class="feedback-detail">正しい音程：${q.intervalName}　回答した音程：${INTERVAL_DEFINITIONS.find(d=>d.id===q.selectedIntervalId)?.name||'判定不可'}　実音高：${q.isCorrect?'一致':'不一致'}</span>`:'';
      $('session-status').innerHTML=`<div class="result-feedback ${q.isCorrect?'correct-feedback':'wrong-feedback'}"><span class="feedback-text">${q.isCorrect?'正解！':'不正解'}</span>${intervalDetail}${q.isCorrect?'':`<span class="feedback-detail">不足/正解：${missing||'なし'}　余分/選択：${extra||'なし'}　最小合計半音差：${q.semitoneDistance}</span>`}</div>`;
      this._setAdvanceButton();
      SessionManager.saveCurrentQuestion();this._scheduleNextTurn();
    },

    /** 不正解後の手動進行 */
    advanceAfterIncorrect() {
      const session = state.currentSession;
      const question = state.currentQuestion;
      if (this._advanceBusy || !session || !question || !question.answered || question.isCorrect !== false) return;
      if (question.advanceState !== 'awaiting-next') return;
      this._advanceBusy = true;
      question.advanceState = 'advancing';
      this._setAdvanceButton({ hidden: true, disabled: true, busy: true, label: session.currentTurn + 1 >= session.questionCount ? '結果を見る' : '次の問題へ' });
      SessionManager.saveCurrentQuestion();
      this.nextTurn();
    },

    /** 次の問題へ進む */
    nextTurn() {
      const session = state.currentSession;
      if (!session) return;

      session.currentTurn++;
            this._cancelMidiAutoConfirm();
      state.midiAnswerNotes = new Set();
      state.midiActiveNotes = new Map();
      state.midiSustainedNotes = new Set();
      state.currentQuestion = null;
      this._inputLocked = false;
      this._answered = false;
      this._setAdvanceButton();

      if (session.currentTurn >= session.questionCount) {
        this.finishSession();
      } else {
        SessionManager.save();
        this.showCurrentQuestion();
      }
    },

    /** セッション完了 */
    async finishSession() {
      if (this._finishInProgress) return;
      this._finishInProgress = true;
            this._teardownMidiForSession();
PianoKeyboard._onNoteDown = null;
      PianoKeyboard._onNoteUp = null;
      this._inputLocked = true;

      const sessionData = await SessionManager.complete();
      if (!sessionData) { AudioSystem.endSessionAudio(); Screens.show('home'); return; }

      // 結果画面へ
      AudioSystem.endSessionAudio();
      Screens.show('result', {
        correctCount: sessionData.correctCount,
        questionCount: sessionData.questionCount,
        maxStreak: sessionData.maxStreak,
        mode: sessionData.mode,
        modeName: sessionData.modeName,
        sessionData
      });
    },

    /** 戻る：3択ダイアログ */
  
    /** MIDI入力をセッションに接続 */
    async _setupMidiForSession(mode) {
      if (!MIDIManager.isApiAvailable() || !state.midiConnected) {
        if (state.settings.midiEnabled && MIDIManager.isApiAvailable()) {
          MIDIManager.requestAccess().then(() => {
            if (state.midiConnected) this._connectMidiCallbacks(mode);
          });
        }
        return;
      }
      this._connectMidiCallbacks(mode);
    },

    _teardownMidiForSession() {
      MIDIManager.setCallbacks({});
      this._cancelMidiAutoConfirm();
      state.midiAnswerNotes = new Set();
      state.midiActiveNotes = new Map();
      state.midiSustainedNotes = new Set();
      state.midiAutoConfirmTimer = null;
    },

    _connectMidiCallbacks(mode) {
      const self = this;
      const isSingleMode = mode === 'single';
      const offset = state.settings.midiOctaveOffset || 0;
      const confirmMode = state.settings.midiConfirmationMode || 'singleImmediate';

      MIDIManager.setCallbacks({
        onNoteOn: (note, velocity) => {
          if (self._inputLocked || self._answered) return;
          const adjusted = applyMidiOctaveOffset(note, offset);
          state.midiLastVelocity = velocity;
          state.midiActiveNotes.set(note, velocity);
          AudioSystem.playPianoSample(adjusted, { duration: 2.5, velocity: velocity || 96 });

          if (isSingleMode && confirmMode === 'singleImmediate') {
            // 単音即時回答
            self.handleSingleNote(adjusted);
          } else if (isSingleMode && confirmMode !== 'singleImmediate') {
            // 単音手動確定：候補を表示し、回答ボタンで採点する。
            self.selectSingleNote(adjusted);
          } else {
            // 複数音モード
            const maxNotes = self.getMaxSelectableNotes(state.currentQuestion);
            if (!state.midiAnswerNotes.has(adjusted) && state.selectedNotes.length < maxNotes) {
              state.midiAnswerNotes.add(adjusted);
              PianoKeyboard.setKeyState(adjusted, 'selected');
              self.toggleNote(adjusted);
            }
            // 自動確定タイマー
            if (confirmMode === 'auto') {
              self._restartMidiAutoConfirm();
            }
          }
        },

        onNoteOff: (note) => {
          const adjusted = applyMidiOctaveOffset(note, offset);
          state.midiActiveNotes.delete(note);
          AudioSystem.stopPianoNote(adjusted);
          
          // サステイン管理
          if (state.midiSustainPedal && state.settings.midiSustainAffectsAnswer) {
            state.midiSustainedNotes.add(note);
          }
          
          // 単音モードではノートオフで何もしない
          // 複数音モードではノートオフで選択解除しない（画面鍵盤と同様）
          // サステインなしの場合は押下中ノートから削除のみ
          if (!state.midiSustainPedal) {
            // 物理的に押されていない音は削除
          }
        },

        onSustain: (on) => {
          state.midiSustainPedal = on;
          if (!on) {
            // ペダルオフ：サステイン保持音をクリア
            state.midiSustainedNotes.clear();
          }
        },

        onInputsChanged: (inputs, connection) => {
          // 切断検出
          if (connection?.wasConnected && !connection.connected) {
            showError('MIDIキーボードとの接続が切れました。画面鍵盤で続けられます。');
            self._cancelMidiAutoConfirm();
            state.midiAnswerNotes = new Set();
            state.midiActiveNotes = new Map();
            state.midiSustainedNotes = new Set();
          }
          // 再接続検出
          // MIDIManager が保存済み deviceId を再接続済み。コールバックは保持する。
        }
      });
    },

    _restartMidiAutoConfirm() {
      this._cancelMidiAutoConfirm();
      const sessionId = state.currentSession?.sessionId;
      const turn = state.currentSession?.currentTurn;
      const questionId = state.currentQuestion?.questionId;
      const delay = state.settings.midiAutoConfirmDelayMs || 500;
      
      state.midiAutoConfirmTimer = setTimeout(() => {
        state.midiAutoConfirmTimer = null;
        if (state.currentSession?.sessionId !== sessionId || 
            state.currentSession?.currentTurn !== turn ||
            state.currentQuestion?.questionId !== questionId ||
            this._answered || this._inputLocked) return;
        const q = state.currentQuestion;
        const requiredNotes = Array.isArray(q?.correctNotes) ? q.correctNotes.length
          : (Array.isArray(q?.midiNotes) ? q.midiNotes.length : 0);
        if (requiredNotes > 0 && state.selectedNotes.length < requiredNotes) return;
        this.submitAnswer();
      }, delay);
    },

    _cancelMidiAutoConfirm() {
      if (state.midiAutoConfirmTimer !== null) {
        clearTimeout(state.midiAutoConfirmTimer);
        state.midiAutoConfirmTimer = null;
      }
    },
    async handleBack() {
      if (!state.currentSession) { Screens.show('home'); return; }
      const cancelSessionTimers = () => {
        this._cancelPendingNextTurn();
        const countdown = $('session-countdown');
        if (countdown) { countdown.hidden = true; countdown.textContent = ''; }
      };
      const choice = await new Promise((resolve) => {
        const d = $('confirm-dialog'), m = $('confirm-message');
        if (!d || !m) { resolve('cancel'); return; }
        m.innerHTML = 'セッションを中断しますか？<br><br>';
        const ok = $('confirm-ok'), cancel = $('confirm-cancel');
        if (!ok || !cancel) { resolve('cancel'); return; }
        ok.textContent = 'ホームへ戻る';
        cancel.textContent = '続ける';
        d.hidden = false;

        const actions = document.querySelector('#confirm-dialog .dialog-actions');
        actions?.classList.add('session-interrupt-actions');

        const cleanup = () => {
          d.hidden = true;
          ok.textContent = 'OK';
          cancel.textContent = 'キャンセル';
          actions?.classList.remove('session-interrupt-actions');
          ok.removeEventListener('click', onSaveExit);
          cancel.removeEventListener('click', onContinue);
        };
        const onSaveExit = () => { cleanup(); resolve('save'); };
        const onContinue = () => { cleanup(); resolve('cancel'); };
        ok.addEventListener('click', onSaveExit);
        cancel.addEventListener('click', onContinue);
      });

      if (choice === 'save') {
        cancelSessionTimers();
        const saved = await SessionManager.save();
        if (!saved) {
          showError('セッションを保存できませんでした。ホームへ戻らず、もう一度お試しください。');
          return;
        }
        AudioSystem.endSessionAudio();
        state.previousScreen = 'home';
        Screens.show('home');
      }
      // 'cancel'の場合は何もしない
    },

    clearSelection() {
      state.selectedNotes = [];
      PianoKeyboard.clearStates();
      $('session-clear-btn').disabled = true;
      $('session-undo-btn').disabled = true;
      $('session-submit-btn').disabled = true;
    },

    saveIncomplete() {
      SessionManager.save();
    },

    // ===== コードモード用ヘルパー（第6段階） =====
    _setChordChoiceEnabled(enabled) {
      document.querySelectorAll('#chord-root-buttons .chord-root-btn, #chord-type-buttons .chord-type-btn, #inversion-buttons .inversion-btn').forEach(button => {
        button.disabled = !enabled;
      });
    },
    _populateChordRootButtons() {
      const c=$('chord-root-buttons');if(!c)return;
      const labels=['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
      const q=state.currentQuestion;
      c.innerHTML=labels.map((l,i)=>'<button class="btn btn-secondary chord-root-btn'+(q?.selectedRootPitchClass===i?' choice-active':'')+'" data-root-pc="'+i+'">'+l+'</button>').join('');
      c.onclick=(e)=>{const b=e.target.closest('.chord-root-btn');if(!b||this._inputLocked||this._answered)return;c.querySelectorAll('.chord-root-btn').forEach(x=>x.classList.remove('choice-active'));b.classList.add('choice-active');if(state.currentQuestion)state.currentQuestion.selectedRootPitchClass=parseInt(b.dataset.rootPc);this._updateChordSubmitBtn();SessionManager.saveCurrentQuestion();};
    },
    _populateChordTypeButtons(mode) {
      const c=$('chord-type-buttons');if(!c)return;
      const q=state.currentQuestion,diff=state.settings.difficulty||'normal',et=state.settings.enabledChordTypes||[];
      const allTriads=['major','minor','diminished','augmented','sus2','sus4'];
      const allSevenths=['major7','dominant7','minor7','minorMajor7','halfDiminished7','diminished7'];
      let types=[];
      if(CM_NAME(mode)||CM_INV(mode)){
        if(diff==='beginner')types=allTriads.filter(t=>['major','minor'].includes(t));
        else if(diff==='normal')types=allTriads;
        else types=[...allTriads,...allSevenths];
      } else if(mode==='seventh'||mode==='seventhChord'){
        types=diff==='advanced'?allSevenths.slice():allTriads.slice();
      } else {
        types=diff==='beginner'?allTriads.filter(t=>['major','minor'].includes(t)):allTriads.slice();
      }
      if(et.length>0)types=types.filter(t=>et.includes(t));
      c.innerHTML=types.map(t=>{const d=CHORD_DEFINITIONS[t];return d?'<button class="btn btn-secondary chord-type-btn'+(q?.selectedChordType===t?' choice-active':'')+'" data-chord-type="'+t+'">'+d.shortLabel+'</button>':'';}).join('');
      c.onclick=(e)=>{const b=e.target.closest('.chord-type-btn');if(!b||this._inputLocked||this._answered)return;c.querySelectorAll('.chord-type-btn').forEach(x=>x.classList.remove('choice-active'));b.classList.add('choice-active');if(state.currentQuestion)state.currentQuestion.selectedChordType=b.dataset.chordType;this._updateChordSubmitBtn();SessionManager.saveCurrentQuestion();};
    },
    _populateInversionButtons() {
      const c=$('inversion-buttons');if(!c)return;
      const q=state.currentQuestion,is7=q?.chordType&&CHORD_DEFINITIONS[q.chordType]?.family==='seventh',ei=state.settings.enabledInversions||[];
      let invs=['root','first','second'];if(is7)invs=['root','first','second','third'];
      if(ei.length>0)invs=invs.filter(i=>ei.includes(i));
      c.innerHTML=invs.map(iv=>{const d=INVERSION_DEFINITIONS[iv];return d?'<button class="btn btn-secondary inversion-btn'+(q?.selectedInversionId===iv?' choice-active':'')+'" data-inversion="'+iv+'">'+d.label+'</button>':'';}).join('');
      c.onclick=(e)=>{const b=e.target.closest('.inversion-btn');if(!b||this._inputLocked||this._answered)return;c.querySelectorAll('.inversion-btn').forEach(x=>x.classList.remove('choice-active'));b.classList.add('choice-active');if(state.currentQuestion)state.currentQuestion.selectedInversionId=b.dataset.inversion;this._updateChordSubmitBtn();SessionManager.saveCurrentQuestion();};
    },
    _updateChordSubmitBtn() {
      const q=state.currentQuestion;if(!q)return;const btn=$('session-submit-btn');if(!btn)return;
      if(CM_COMP(q.mode))btn.disabled=state.selectedNotes.length===0;
      else if(CM_NAME(q.mode))btn.disabled=!(q.selectedRootPitchClass!==null&&q.selectedRootPitchClass!==undefined&&q.selectedChordType);
      else if(CM_INV(q.mode))btn.disabled=!(state.selectedNotes.length>0&&q.selectedRootPitchClass!==null&&q.selectedRootPitchClass!==undefined&&q.selectedChordType&&q.selectedInversionId);
      else btn.disabled=true;
    },
    _judgeChordAnswer() {
      const q=state.currentQuestion,s=state.currentSession;if(!q||!s||this._inputLocked||this._answered||q.answered)return;
      this._inputLocked=this._answered=true;
      this._setChordChoiceEnabled(false);
      q.answered=true;q.responseTimeMs=Date.now()-(q.startedAt||Date.now());s.totalResponseTimeMs=(Number(s.totalResponseTimeMs)||0)+q.responseTimeMs;
      const sm=s.mode,oct=state.settings.chordOctaveJudgement||'exact';
      // chordComponents / seventhChord
      if(CM_COMP(sm)){
        const usePc=oct==='pitchClass';
        const result=usePc?matchPitchClassMultisets(q.correctNotes,state.selectedNotes):matchNoteSets(q.correctNotes,state.selectedNotes);
        q.selectedNotes=[...state.selectedNotes];
        if(usePc){
          q.exactMatches=result.exactMatches.map(pc=>({pitchClass:pc}));q.missingNotes=result.missingNotes.map(pc=>({pitchClass:pc}));q.extraNotes=result.extraNotes.map(pc=>({pitchClass:pc}));q.matchedDifferences=result.matchedDifferences;q.totalSemitoneDistance=result.totalSemitoneDistance;
          q.componentsCorrect=result.isCorrect;
        } else {
          q.exactMatches=result.exactMatches;q.missingNotes=result.missingNotes;q.extraNotes=result.extraNotes;q.matchedDifferences=result.matchedDifferences;q.totalSemitoneDistance=result.totalSemitoneDistance;
          q.componentsCorrect=!result.missingNotes.length&&!result.extraNotes.length&&result.totalSemitoneDistance===0;
        }
        q.isCorrect=q.componentsCorrect;q.rootCorrect=true;q.chordTypeCorrect=true;q.inversionCorrect=true;
      }
      // chordName
      else if(CM_NAME(sm)){
        q.selectedRootPitchClass=q.selectedRootPitchClass!==undefined&&q.selectedRootPitchClass!==null?q.selectedRootPitchClass:null;
        q.selectedChordType=q.selectedChordType||null;
        q.rootCorrect=q.selectedRootPitchClass===q.rootPitchClass;
        q.chordTypeCorrect=q.selectedChordType===q.chordType;
        q.isCorrect=q.rootCorrect&&q.chordTypeCorrect;
        q.componentsCorrect=q.isCorrect;q.inversionCorrect=true;
      }
      // chordInversion (always exact for inversion)
      else if(CM_INV(sm)){
        const result=matchNoteSets(q.correctNotes,state.selectedNotes);
        q.selectedNotes=[...state.selectedNotes];q.exactMatches=result.exactMatches;q.missingNotes=result.missingNotes;q.extraNotes=result.extraNotes;q.matchedDifferences=result.matchedDifferences;q.totalSemitoneDistance=result.totalSemitoneDistance;
        q.componentsCorrect=!result.missingNotes.length&&!result.extraNotes.length&&result.totalSemitoneDistance===0;
        q.selectedRootPitchClass=q.selectedRootPitchClass!==undefined&&q.selectedRootPitchClass!==null?q.selectedRootPitchClass:null;
        q.selectedChordType=q.selectedChordType||null;q.selectedInversionId=q.selectedInversionId||null;
        q.rootCorrect=q.selectedRootPitchClass===q.rootPitchClass;
        q.chordTypeCorrect=q.selectedChordType===q.chordType;
        q.inversionCorrect=q.selectedInversionId===q.inversionId;
        q.isCorrect=q.componentsCorrect&&q.rootCorrect&&q.chordTypeCorrect&&q.inversionCorrect;
      }
      // Update session stats
      if(q.isCorrect){s.correctCount++;s.streakCount++;s.maxStreak=Math.max(s.maxStreak,s.streakCount);}else s.streakCount=0;
      this._showChordFeedback(q);
      // MIDI入力方法を記録
      const midiActive = state.settings.midiEnabled && state.midiConnected && (state.midiActiveNotes.size > 0 || state.midiAnswerNotes.size > 0);
      const screenUsed = state.selectedNotes && state.selectedNotes.length > 0;
      if (q) {
        q.inputMethod = (midiActive && screenUsed) ? 'mixed' : (midiActive ? 'midi' : (screenUsed ? 'screen' : q.inputMethod || 'screen'));
        q.midiNotes = midiActive ? (() => { const s = new Set(); state.midiActiveNotes.forEach((v,n) => s.add(applyMidiOctaveOffset(n, state.settings.midiOctaveOffset || 0))); state.midiAnswerNotes.forEach(n => s.add(n)); return [...s]; })() : [];
        q.midiVelocities = midiActive ? [...state.midiActiveNotes.values()] : [];
        q.midiOctaveOffset = state.settings.midiOctaveOffset || 0;
        q.midiConfirmationMode = state.settings.midiConfirmationMode || 'singleImmediate';
      }
SessionManager.saveCurrentQuestion();this._scheduleNextTurn();
    },
    _showChordFeedback(q) {
      if(!q)return;const status=$('session-status');if(!status)return;
      let html='';const rl=['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
      if(CM_COMP(q.mode)){
        const ns=q.rootMidi!==undefined?midiToNoteName(q.rootMidi,state.settings.noteLabel):(q.rootLabel||'');const cl=q.chordLabel||'';
        const ms=(q.missingNotes||[]).map(n=>typeof n==='object'?rl[n.pitchClass]||'?':midiToNoteName(n,state.settings.noteLabel)).join('、')||'なし';
        const es=(q.extraNotes||[]).map(n=>typeof n==='object'?rl[n.pitchClass]||'?':midiToNoteName(n,state.settings.noteLabel)).join('、')||'なし';
        const octLabel=state.settings.chordOctaveJudgement||'exact';
        html='<div class="result-feedback '+(q.isCorrect?'correct-feedback':'wrong-feedback')+'"><span class="feedback-text">'+(q.isCorrect?'正解！':'不正解')+'</span><span class="feedback-note">'+ns+' '+cl+'</span>'+(q.isCorrect?'':'<span class="feedback-detail">不足：'+ms+' 余分：'+es+' 判定：'+octLabel+'</span>')+'</div>';
      } else if(CM_NAME(q.mode)){
        const cr=rl[q.rootPitchClass]||'?',ct=q.chordLabel||'',sr=q.selectedRootPitchClass!==null?rl[q.selectedRootPitchClass]:'未選択',st=CHORD_DEFINITIONS[q.selectedChordType]?.label||'未選択';
        if(q.isCorrect)html='<div class="result-feedback correct-feedback"><span class="feedback-text">正解！</span><span class="feedback-note">'+cr+ct+'</span></div>';
        else if(q.rootCorrect)html='<div class="result-feedback wrong-feedback"><span class="feedback-text">不正解</span><span class="feedback-detail">ルート音'+cr+'は正解ですが、コード種類は'+ct+'です（回答：'+sr+' '+st+'）</span></div>';
        else if(q.chordTypeCorrect)html='<div class="result-feedback wrong-feedback"><span class="feedback-text">不正解</span><span class="feedback-detail">コード種類'+ct+'は正解ですが、ルート音は'+cr+'です（回答：'+sr+' '+st+'）</span></div>';
        else html='<div class="result-feedback wrong-feedback"><span class="feedback-text">不正解</span><span class="feedback-detail">正解は'+cr+ct+'です（回答：'+sr+' '+st+'）</span></div>';
      } else if(CM_INV(q.mode)){
        const ns=q.rootMidi!==undefined?midiToNoteName(q.rootMidi,state.settings.noteLabel):'?',cl=q.chordLabel||'',ci=INVERSION_DEFINITIONS[q.inversionId]?.label||'',sp=['構成:'+(q.componentsCorrect?'✅':'❌'),'ルート:'+(q.rootCorrect?'✅':'❌'),'種類:'+(q.chordTypeCorrect?'✅':'❌'),'転回:'+(q.inversionCorrect?'✅':'❌')];
        html='<div class="result-feedback '+(q.isCorrect?'correct-feedback':'wrong-feedback')+'"><span class="feedback-text">'+(q.isCorrect?'正解！':'不正解')+'</span><span class="feedback-note">'+ns+' '+cl+' '+ci+'</span><span class="feedback-detail">'+sp.join(' | ')+'</span></div>';
      }
      status.innerHTML=html||'<div class="result-feedback wrong-feedback"><span class="feedback-text">結果表示エラー</span></div>';
    },
    _restoreChordSelection(q) {
      if(!q)return;
      // 選択音の復元（selectedOrder優先）
      if(q.selectedOrder&&q.selectedOrder.length>0){state.selectedNotes=[...(q.selectedNotes||[])];this.renderSelection();}
      else if(q.selectedNotes&&q.selectedNotes.length>0){state.selectedNotes=[...q.selectedNotes];if(!q.selectedOrder)q.selectedOrder=[...q.selectedNotes];this.renderSelection();}
      // ルート音の復元
      if(q.selectedRootPitchClass!==null&&q.selectedRootPitchClass!==undefined){
        document.querySelectorAll('.chord-root-btn').forEach(b=>b.classList.toggle('choice-active',parseInt(b.dataset.rootPc)===q.selectedRootPitchClass));
      }
      // コード種類の復元
      if(q.selectedChordType){
        document.querySelectorAll('.chord-type-btn').forEach(b=>b.classList.toggle('choice-active',b.dataset.chordType===q.selectedChordType));
      }
      // 転回形の復元
      if(q.selectedInversionId){
        document.querySelectorAll('.inversion-btn').forEach(b=>b.classList.toggle('choice-active',b.dataset.inversion===q.selectedInversionId));
      }
      this._updateChordSubmitBtn();
    },
  };

  const CalendarController = {
    _checkinBusy: false,
    _autoCheckinKey() { return `autoCheckin:${state.currentProfileId}:${localDateKey()}`; },
    stampLabels: { 'eighth-note':'♪', 'treble-clef':'𝄞', 'bass-clef':'𝄢', piano:'🎹', record:'💿', metronome:'⏱️', staff:'🎼', 'grand-piano':'🎹', 'music-note':'♫', xylophone:'🎶' },
    currentMonth: new Date().getMonth(), currentYear: new Date().getFullYear(),
    selectedDate: localDateKey(),
    async show() { await this.renderCalendar(); await this.updateCheckinButton(); await this.renderTodayCode(); },
    async autoCheckInOnFirstLaunch() {
      const key = this._autoCheckinKey();
      if (LocalCache.load(key, false) || await CheckinManager.get()) return false;
      LocalCache.save(key, true);
      Screens.show('calendar');
      await this.checkIn();
      return true;
    },
    clearTodayCode() {
      const box = $('calendar-today-code'), keyboard = $('calendar-code-keyboard');
      if (box) box.hidden = true;
      if (keyboard) keyboard.innerHTML = '';
      if (PianoKeyboard.container === keyboard) { PianoKeyboard.clearStates(); PianoKeyboard.container = null; }
    },
    async renderTodayCode() {
      const box = $('calendar-today-code');
      if (!box) return;
      const checkin = await CheckinManager.get();
      if (!checkin) { this.clearTodayCode(); return; }
      const definition = CHORD_DEFINITIONS[checkin.chordType];
      const rootName = midiToNoteName(checkin.rootMidi, state.settings.noteLabel);
      $('calendar-code-name').textContent = `${rootName} ${definition?.shortLabel || checkin.chordType}`;
      $('calendar-code-type').textContent = `種類: ${definition?.label || checkin.chordType}`;
      $('calendar-code-notes').textContent = `構成音: ${checkin.notes.map(note => midiToNoteName(note, state.settings.noteLabel)).join('、')}`;
      $('calendar-code-midi').textContent = `MIDI: ${checkin.notes.join('、')}`;
      const keyboard = $('calendar-code-keyboard');
      if (keyboard) {
        PianoKeyboard.render(keyboard, Math.min(48, ...checkin.notes), Math.max(72, ...checkin.notes));
        checkin.notes.forEach(note => PianoKeyboard.setKeyState(note, 'correct'));
      }
      $('calendar-trivia').textContent = await this.loadTrivia(checkin);
      box.hidden = false;
    },
    async loadTrivia(checkin) {
      const fallback = `${CHORD_DEFINITIONS[checkin.chordType]?.label || 'このコード'}は、複数の音を重ねて響きを作る和音です。構成音の間隔により響きの印象が変わります。`;
      try {
        const response = await fetch('./assets/data/trivia.json', { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const item = Array.isArray(data) ? data.find(entry => entry.codeId === checkin.codeId || entry.chordType === checkin.chordType) : data[checkin.chordType];
        return typeof item === 'string' ? item : item?.text || fallback;
      } catch (_) { return fallback; }
    },
    async renderCalendar() {
      const grid = $('calendar-grid'), label = $('calendar-month-label');
      if (!grid || !label) return;
      const today = new Date();
      const firstDay = new Date(this.currentYear, this.currentMonth, 1);
      const lastDay = new Date(this.currentYear, this.currentMonth + 1, 0);
      label.textContent = `${this.currentYear}年${this.currentMonth+1}月`;
      const checkins = new Map((await CheckinManager.getAll()).map(item => [item.date, item]));
      let html = ['日','月','火','水','木','金','土'].map(d => `<div class="calendar-weekday">${d}</div>`).join('');
      for (let i = 0; i < firstDay.getDay(); i++) html += '<div class="calendar-day other-month"></div>';
      for (let d = 1; d <= lastDay.getDate(); d++) {
        const ds = `${this.currentYear}-${String(this.currentMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
        const isT = today.getFullYear()===this.currentYear && today.getMonth()===this.currentMonth && today.getDate()===d;
        const checkin = checkins.get(ds);
        const selected = this.selectedDate === ds;
        const dayLabel = isT && checkin ? '今日・済' : isT ? '今日' : checkin ? '済' : '';
        html += `<button type="button" class="calendar-day${isT?' today':''}${checkin?' checked':''}${selected?' selected':''}" data-date="${ds}" aria-label="${this.currentYear}年${this.currentMonth+1}月${d}日${isT?' 今日':''}${checkin?' チェックイン済み':''}" title="${ds}"><span class="day-number">${d}</span>${checkin?`<span class="day-stamp">${this.stampLabels[checkin.stamp] || '♪'}</span>`:''}${dayLabel ? `<span class="day-label">${dayLabel}</span>` : ''}</button>`;
      }
      grid.innerHTML = html;
      await this.renderDateDetail(this.selectedDate);
    },
    async renderDateDetail(dateKey) {
      const detail = $('calendar-date-detail');
      if (!detail) return;
      const sessions = (await Storage.getAll('sessions')).filter(session => session.profileId === state.currentProfileId && (session.localDate || localDateKey(session.completedAt || session.startedAt)) === dateKey);
      const checkin = await CheckinManager.get(new Date(`${dateKey}T12:00:00`));
      const completed = sessions.filter(session => session.completed);
      const answered = completed.reduce((sum, session) => sum + (Number(session.correctCount) || 0), 0);
      const questions = completed.reduce((sum, session) => sum + (Number(session.questionCount) || 0), 0);
      const reviewed = sessions.some(session => session.reviewSession === true);
      const perfect = completed.some(session => session.questionCount > 0 && Number(session.correctCount) === Number(session.questionCount));
      const code = checkin ? `<p class="calendar-checkin-code">${this.stampLabels[checkin.stamp] || '♪'} ${checkin.chordLabel} <span>(${checkin.notes.map(note => midiToNoteName(note, state.settings.noteLabel)).join('、')})</span></p><p class="calendar-checkin-trivia">${await this.loadTrivia(checkin)}</p><button type="button" class="btn btn-small" data-calendar-code-play="${checkin.id}">コードを聴く</button>` : '<p class="calendar-detail-muted">チェックインなし</p>';
      const sessionRows = sessions.length ? sessions.map(session => {
        const accuracy = session.questionCount ? Math.round((Number(session.correctCount) || 0) / session.questionCount * 100) : 0;
        const time = session.completedAt || session.startedAt;
        const isPerfect = session.questionCount > 0 && Number(session.correctCount) === Number(session.questionCount);
        return `<li class="calendar-session-row"><button type="button" class="calendar-session-card" data-calendar-session="${session.sessionId}"><span class="calendar-session-main"><span class="calendar-session-mode">${session.modeName || _modeLabel(session.mode)}</span><span class="calendar-session-score">${session.correctCount || 0}/${session.questionCount || 0}問 <strong>${accuracy}%</strong></span></span><span class="calendar-session-meta">${session.reviewSession ? '<span class="calendar-session-badge review">復習</span>' : ''}${isPerfect ? '<span class="calendar-session-badge perfect">全問正解</span>' : ''}<time>${time ? new Date(time).toLocaleTimeString('ja-JP', {hour:'2-digit', minute:'2-digit'}) : '時刻不明'}</time></span></button></li>`;
      }).join('') : '<li class="calendar-session-empty">この日のセッションはありません</li>';
      const accuracy = questions ? Math.round(answered / questions * 100) : null;
      detail.innerHTML = `<section class="calendar-date-summary" aria-labelledby="calendar-detail-date"><h3 id="calendar-detail-date" class="calendar-detail-date">${dateKey.replace(/-/g, '/')} ${dateKey === localDateKey() ? '（今日）' : ''}</h3><div class="calendar-summary-stats"><span><strong>${sessions.length}</strong> セッション</span><span><strong>${accuracy === null ? '--' : `${accuracy}%`}</strong> 正答率</span></div><div class="calendar-summary-code">${code}</div><div class="calendar-summary-badges"><span class="calendar-detail-status">${reviewed ? '↻ 復習セッションあり' : '復習セッションなし'}</span><span class="calendar-detail-status">${perfect ? '★ 全問正解あり' : '全問正解なし'}</span></div></section><section class="calendar-session-history" aria-labelledby="calendar-session-history-title"><div class="calendar-panel-heading"><h3 id="calendar-session-history-title">セッション履歴</h3><span>${sessions.length}件</span></div><ul class="calendar-session-list">${sessionRows}</ul>${sessions.length ? '<button type="button" class="btn btn-secondary btn-small calendar-review-button" data-calendar-review>この日の復習を開く</button>' : ''}</section>`;
      detail.hidden = false;
    },
    async selectDate(dateKey) { this.selectedDate = dateKey; await this.renderCalendar(); },
    goToday() { const now = new Date(); this.currentYear = now.getFullYear(); this.currentMonth = now.getMonth(); this.selectedDate = localDateKey(now); return this.renderCalendar(); },
    async updateCheckinButton() {
      const btn = $('calendar-checkin-btn'), status = $('calendar-checkin-status');
      if (!btn || !status) return;
      const checkin = await CheckinManager.get();
      if (checkin) { btn.disabled = true; btn.textContent = '✅ チェックイン済み'; status.textContent = `${this.stampLabels[checkin.stamp] || '♪'} 今日はチェックイン済みです（${checkin.streak}日連続）`; }
      else { btn.disabled = this._checkinBusy; btn.textContent = '今日のスタンプを押す'; status.textContent = '未チェックイン'; }
    },
    async checkIn() {
      if (this._checkinBusy) return;
      const btn = $('calendar-checkin-btn'), status = $('calendar-checkin-status');
      if (!btn || !status) return;
      this._checkinBusy = true; btn.disabled = true; status.textContent = '保存しています…';
      try {
        const result = await CheckinManager.checkIn();
        status.textContent = `${this.stampLabels[result.stamp] || '♪'} チェックイン完了！ ${result.streak}日連続`;
        status.classList.add('pulse-glow');
        setTimeout(() => status.classList.remove('pulse-glow'), 700);
        await this.renderCalendar();
        await HomeController.updateCheckinStatus();
        await this.renderTodayCode();
      } catch (error) {
        status.textContent = 'チェックインを保存できませんでした。もう一度お試しください';
        btn.disabled = false;
        console.warn('[Checkin] save failed', error);
      } finally { this._checkinBusy = false; await this.updateCheckinButton(); }
    }
  };

  const ReviewController = {
    candidates:[], selectedMode:'', expandedSessionIds:new Set(),
    _notes(q, kind){return questionNotes(q,kind);},
    _play(notes, button){if(!notes.length)return;AudioSystem.resume();if(button){button.disabled=true;setTimeout(()=>button.disabled=false,900);}if(notes.length===1)AudioSystem.playPianoSample(notes[0],{duration:.8,velocity:96});else AudioSystem.playChord(notes,1,96);},
    async show() {
      const container=$('review-content');
      if(!container)return;
      try {
        const profileSessions=(await Storage.getAll('sessions')).filter(s=>s.profileId===state.currentProfileId).map(HistoryMetrics.session);
        const sessions=profileSessions.filter(s=>s.completed);
        const incompleteSessions=profileSessions.filter(s=>!s.completed).sort((a,b)=>(Date.parse(b.updatedAt||b.startedAt||0)||0)-(Date.parse(a.updatedAt||a.startedAt||0)||0));
        const sessionsById=new Map(sessions.map(session=>[session.sessionId,session]));
        this.candidates=HistoryMetrics.weakness(sessions.flatMap(session=>session.questions.map((question,questionIndex)=>({session,question,questionIndex}))));
        const modes=[...new Set(this.candidates.map(c=>c.sourceMode))]; if(!this.selectedMode||!modes.includes(this.selectedMode))this.selectedMode=modes[0]||'';
        const candidates=this.candidates.filter(c=>c.sourceMode===this.selectedMode);
        const savedSessionHtml=incompleteSessions.map(session=>{
          const date=session.updatedAt||session.startedAt;
          const dateText=date?new Date(date).toLocaleString('ja-JP',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'日時不明';
          const current=Math.min(Number(session.currentTurn)||0,Number(session.questionCount)||0);
          const total=Number(session.questionCount)||0;
          const progress=total?`${current}/${total}問まで回答`:`${current}問まで回答`;
          return `<article class="review-session-card review-incomplete-session-card"><div class="review-session-heading"><div class="review-session-toggle review-incomplete-session-summary"><span class="review-session-date">${dateText}</span><span class="review-session-mode">${session.modeName||_modeLabel(session.mode)}</span><span class="review-session-result review-session-saved">途中保存</span><span class="review-session-candidates">${progress}</span></div><button type="button" class="btn btn-primary btn-small review-session-start" data-review-resume-session="${session.sessionId}">続きから再開</button></div></article>`;
        }).join('');
        const savedSessionsSection=incompleteSessions.length?`<section class="review-saved-sessions"><h3>保存したセッション</h3><div class="review-list review-session-list">${savedSessionHtml}</div></section>`:'';
        if(!this.candidates.length){
          container.innerHTML=`${savedSessionsSection}<p class="empty-state">復習できる問題がありません。セッションをプレイして間違えた問題がここに表示されます。</p>`;
          container.onclick=async e=>{const resume=e.target.closest('[data-review-resume-session]');if(!resume)return;const saved=incompleteSessions.find(session=>session.sessionId===resume.dataset.reviewResumeSession);if(!saved)return;LocalCache.save(SessionManager._cacheKey(),{sessionId:saved.sessionId,profileId:state.currentProfileId,updatedAt:new Date().toISOString()});Screens.show('session',{mode:saved.mode,difficulty:saved.difficulty,questionCount:saved.questionCount,resumeSession:true});};
          return;
        }
        const shortageText=n=>candidates.length<n?`候補は${candidates.length}問のため、重複せず${candidates.length}問で開始します。`:`${n}問を重複なしで開始します。`;
        const groups=new Map();
        candidates.forEach((candidate,index)=>{const sessionId=candidate.sourceSessionId || `unknown-${index}`;const group=groups.get(sessionId)||{sessionId,candidates:[]};group.candidates.push({...candidate,candidateIndex:index});groups.set(sessionId,group);});
        const cards=[...groups.values()].map(group=>{
          const source=sessionsById.get(group.sessionId), sessionAt=Date.parse(source?.completedAt||source?.startedAt||0)||0;
          group.candidates.sort((a,b)=>a.sourceQuestionIndex-b.sourceQuestionIndex||a.candidateIndex-b.candidateIndex);
          return {...group,source,sessionAt};
        }).sort((a,b)=>b.sessionAt-a.sessionAt||a.sessionId.localeCompare(b.sessionId));
        const cardHtml=cards.map(card=>{const source=card.source||{}, date=source.completedAt||source.startedAt, dateText=date?new Date(date).toLocaleString('ja-JP',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):'日時不明';const reviewed=sessions.some(session=>session.reviewSession===true&&(session.sourceSessionId===card.sessionId||session.questions.some(question=>question.reviewSourceSessionId===card.sessionId)));const expanded=this.expandedSessionIds.has(card.sessionId);const questions=card.candidates.map(candidate=>{const noteInfo=this._notes(candidate.sample,'correct').map(note=>midiToNoteName(note,state.settings.noteLabel)).join(' + ')||'回答方式の選択問題';return `<li class="review-session-question"><span class="review-question-order">${candidate.sourceQuestionIndex+1}</span><span class="review-question-note">${noteInfo}</span><span class="review-question-wrong">誤答 ${candidate.wrong}/${candidate.attempts}</span><button type="button" class="btn btn-secondary btn-small" data-review-listen="${candidate.candidateIndex}">問題音を聴く</button></li>`;}).join('');return `<article class="review-session-card"><div class="review-session-heading"><button type="button" class="review-session-toggle" data-review-session-toggle="${card.sessionId}" aria-expanded="${expanded}"><span class="review-session-date">${dateText}</span><span class="review-session-mode">${source.modeName||_modeLabel(source.mode||this.selectedMode)}</span><span class="review-session-result">${Number(source.correctCount)||0}/${Number(source.questionCount)||card.candidates.length}問正解</span><span class="review-session-candidates">候補 ${card.candidates.length}問</span><span class="review-session-reviewed">${reviewed?'復習済み':'未復習'}</span><span class="review-session-toggle-mark" aria-hidden="true">${expanded?'▲':'▼'}</span></button><button type="button" class="btn btn-primary btn-small review-session-start" data-review-session-start="${card.sessionId}">このセッションを復習</button></div><div class="review-session-details" ${expanded?'':'hidden'}><ol class="review-session-questions">${questions}</ol></div></article>`;}).join('');
        container.innerHTML=`<div class="review-summary"><span class="review-count">苦手候補: ${this.candidates.length}問（${_modeLabel(this.selectedMode)} ${candidates.length}問）</span></div><div class="review-mode-filters">${modes.map(m=>`<button class="btn btn-small ${m===this.selectedMode?'choice-active':''}" data-review-mode="${m}">${_modeLabel(m)}</button>`).join('')}</div><div class="review-starts">${[5,7,10].map(n=>`<button class="btn btn-primary btn-small" data-review-start="${n}">全体を復習 ${n}問</button>`).join('')}<p id="review-shortage-message" class="review-shortage">${shortageText(5)}</p></div><div class="review-list review-session-list">${cardHtml}</div>${savedSessionsSection}`;
        container.onclick=async e=>{const resume=e.target.closest('[data-review-resume-session]');if(resume){const saved=incompleteSessions.find(session=>session.sessionId===resume.dataset.reviewResumeSession);if(saved){LocalCache.save(SessionManager._cacheKey(),{sessionId:saved.sessionId,profileId:state.currentProfileId,updatedAt:new Date().toISOString()});Screens.show('session',{mode:saved.mode,difficulty:saved.difficulty,questionCount:saved.questionCount,resumeSession:true});}return;}const modeButton=e.target.closest('[data-review-mode]');if(modeButton){this.selectedMode=modeButton.dataset.reviewMode;this.show();return;}const start=e.target.closest('[data-review-start]');if(start){const requested=Number(start.dataset.reviewStart), chosen=this.candidates.filter(c=>c.sourceMode===this.selectedMode);try{const session=await SessionManager.startReview(chosen,requested);Screens.show('session',{mode:session.mode,difficulty:session.difficulty,questionCount:session.questionCount,resumeSession:true});}catch(err){showError(err.message||'復習を開始できませんでした');}return;}const toggle=e.target.closest('[data-review-session-toggle]');if(toggle){const sessionId=toggle.dataset.reviewSessionToggle;if(this.expandedSessionIds.has(sessionId))this.expandedSessionIds.delete(sessionId);else this.expandedSessionIds.add(sessionId);this.show();return;}const sessionStart=e.target.closest('[data-review-session-start]');if(sessionStart){const chosen=(groups.get(sessionStart.dataset.reviewSessionStart)?.candidates||[]).map(candidate=>candidates[candidate.candidateIndex]);try{const session=await SessionManager.startReview(chosen,chosen.length);Screens.show('session',{mode:session.mode,difficulty:session.difficulty,questionCount:session.questionCount,resumeSession:true});}catch(err){showError(err.message||'復習を開始できませんでした');}return;}const listen=e.target.closest('[data-review-listen]');if(listen){const c=candidates[Number(listen.dataset.reviewListen)];if(c)this._play(this._notes(c.sample,'correct'),listen);}};
      } catch(e){ console.warn('[Review] error:',e); container.innerHTML='<p class="empty-state">読み込みエラーが発生しました</p>'; }
    }
  };
    const AnalyticsController = {
    _currentFilter: '30d',
    async show(filter) {
      if (filter) this._currentFilter = filter;
      var elQ=$('analytics-total-questions'), elC=$('analytics-total-correct');
      var elAcc=$('analytics-accuracy'), elTime=$('analytics-avg-time'), elStreak=$('analytics-streak');
      var elBreakdown=$('analytics-mode-breakdown'), elHeat=$('heatmap-container');
      if(!elQ||!elAcc||!elTime)return;
      try {
        var analytics=await AnalyticsService.aggregate({profileId:state.currentProfileId,filter:this._currentFilter});
        var completed=(await Storage.getAll('sessions')).filter(function(s){return s.completed&&s.profileId===state.currentProfileId;});
        elQ.textContent=analytics.answeredCount;
        if(elC)elC.textContent=analytics.correctCount;
        elAcc.textContent=analytics.accuracy===null?'--%':analytics.accuracy+'%';
        elTime.textContent=analytics.averageResponseTimeMs===null?'--':Math.round(analytics.averageResponseTimeMs/1000)+'秒';
        if(elStreak){try{var streak=await CheckinService.getStreak(state.currentProfileId);elStreak.textContent=streak;}catch(e){elStreak.textContent='0';}}
        document.querySelectorAll('.analytics-period-filter .choice-btn').forEach(function(b){b.classList.toggle('choice-active',b.dataset.filter===AnalyticsController._currentFilter);});
        // mode breakdown
        if(elBreakdown){
          var modeStats=Object.fromEntries(Object.entries(analytics.mode).map(function(e){return [e[0],{total:e[1].questions,correct:e[1].correct}];}));
          var modes=Object.keys(modeStats);
          if(modes.length===0){
            elBreakdown.innerHTML='<h3 class="analytics-section-title">モード別正答率</h3><p class="empty-state">データがありません</p>';
          }else{
            elBreakdown.innerHTML='<h3 class="analytics-section-title">モード別正答率</h3><div class="mode-breakdown-list">'+modes.map(function(m){
              var ms=modeStats[m];var pct=ms.total>0?Math.round(ms.correct/ms.total*100):0;
              return '<div class="mode-breakdown-item"><span class="breakdown-mode">'+m+'</span><div class="breakdown-bar-bg"><div class="breakdown-bar-fill" style="width:'+pct+'%"></div></div><span class="breakdown-pct">'+pct+'%</span><span class="breakdown-nums">'+ms.correct+'/'+ms.total+'</span></div>';
            }).join('')+'</div>';
          }
        }
        // difficulty breakdown
        var diffPanel=$('analytics-difficulty-breakdown');
        if(diffPanel){
          var diffStats=Object.fromEntries(Object.entries(analytics.difficulty).map(function(e){return [e[0],{total:e[1].questions,correct:e[1].correct}];}));
          var diffs=Object.keys(diffStats);
          if(diffs.length===0){
            diffPanel.innerHTML='<h3 class="analytics-section-title">難易度別正答率</h3><p class="empty-state">データがありません</p>';
          }else{
            diffPanel.innerHTML='<h3 class="analytics-section-title">難易度別正答率</h3><div class="mode-breakdown-list">'+diffs.map(function(m){
              var ms=diffStats[m];var pct=ms.total>0?Math.round(ms.correct/ms.total*100):0;
              return '<div class="mode-breakdown-item"><span class="breakdown-mode">'+m+'</span><div class="breakdown-bar-bg"><div class="breakdown-bar-fill" style="width:'+pct+'%"></div></div><span class="breakdown-pct">'+pct+'%</span><span class="breakdown-nums">'+ms.correct+'/'+ms.total+'</span></div>';
            }).join('')+'</div>';
          }
        }
        var notePanel=$('analytics-note-performance'), pitchPanel=$('analytics-pitch-tendency'), confusionPanel=$('analytics-confusions');
        if(notePanel){
          var notes=Object.values(analytics.notes).sort(function(a,b){return a.midi-b.midi;});
          notePanel.innerHTML='<h3 class="analytics-section-title">音別成績</h3>'+(notes.length?'<div class="analytics-note-list">'+notes.map(function(n){
            return '<div class="analytics-note-row"><span>'+n.name+'</span><span>'+n.attempts+'回中'+n.correct+'回正解、正答率'+n.accuracy+'%</span><span>誤答'+n.wrong+'・不足'+n.missing+'・平均'+(n.averageTimeMs===null?'--':Math.round(n.averageTimeMs/1000)+'秒')+'</span></div>';
          }).join('')+'</div>':'<p class="empty-state">データがありません</p>');
        }
        if(pitchPanel){
          var p=analytics.pitch,pt=p.higher+p.lower+p.same;
          pitchPanel.innerHTML='<h3 class="analytics-section-title">高低傾向</h3>'+(pt?'<p>高く回答: '+p.higher+'回（'+p.higherRate+'%）／低く回答: '+p.lower+'回（'+p.lowerRate+'%）／一致: '+p.same+'回</p><p>平均半音差: '+p.averageDifference+'、最頻半音差: '+p.modeDifference+'</p>':'<p class="empty-state">データがありません</p>');
        }
        if(confusionPanel){
          var rows=Object.values(analytics.confusions).sort(function(a,b){return b.count-a.count||a.correctNote-b.correctNote;});
          confusionPanel.innerHTML='<h3 class="analytics-section-title">音の取り違え</h3>'+(rows.length?'<ul>'+rows.map(function(c){
            return '<li>'+midiToNoteName(c.correctNote,state.settings.noteLabel)+' → '+midiToNoteName(c.selectedNote,state.settings.noteLabel)+': '+c.count+'回</li>';
          }).join('')+'</ul>':'<p class="empty-state">データがありません</p>');
        }
        // interval performance
        var intervalPanel=$('analytics-interval-performance');
        if(intervalPanel){
          var ivs=Object.values(analytics.intervals).sort(function(a,b){return (a.semitones||0)-(b.semitones||0)||(a.intervalId||'').localeCompare(b.intervalId||'');});
          intervalPanel.innerHTML='<h3 class="analytics-section-title">音程別正答率</h3>'+(ivs.length?'<div class="analytics-interval-list">'+ivs.map(function(iv){
            var pct2=iv.accuracy===null?'--%':iv.accuracy+'%';
            return '<div class="analytics-interval-row"><span class="interval-name">'+iv.name+'</span><span class="interval-count">'+iv.questions+'回出題</span><span class="interval-accuracy">正答率 '+pct2+'</span><span class="interval-time">平均 '+(iv.averageTimeMs===null?'--':Math.round(iv.averageTimeMs/1000)+'秒')+'</span></div>';
          }).join('')+'</div>':'<p class="empty-state">データがありません</p>');
        }
        // chord performance
        var chordPanel=$('analytics-chord-performance');
        if(chordPanel){
          var cvs=Object.values(analytics.chords).sort(function(a,b){return b.questions-a.questions;});
          chordPanel.innerHTML='<h3 class="analytics-section-title">コード別正答率</h3>'+(cvs.length?'<div class="analytics-chord-list">'+cvs.map(function(cv){
            var pct3=cv.accuracy===null?'--%':cv.accuracy+'%';
            return '<div class="analytics-chord-row"><span class="chord-name">'+cv.name+'</span><span class="chord-count">'+cv.questions+'回出題</span><span class="chord-accuracy">正答率 '+pct3+'</span><span class="chord-time">平均 '+(cv.averageTimeMs===null?'--':Math.round(cv.averageTimeMs/1000)+'秒')+'</span>'+(cv.missingCount>0?'<span class="chord-missing">不足 '+cv.missingCount+'回</span>':'')+(cv.extraCount>0?'<span class="chord-extra">余分 '+cv.extraCount+'回</span>':'')+'</div>';
          }).join('')+'</div>':'<p class="empty-state">データがありません</p>');
        }
        // missing/extra notes
        var missingPanel=$('analytics-missing-notes');
        if(missingPanel){
          var mns=Object.values(analytics.missingNotes).sort(function(a,b){return b.count-a.count;});
          missingPanel.innerHTML='<h3 class="analytics-section-title">不足しやすい音</h3>'+(mns.length?'<div class="analytics-missing-list">'+mns.map(function(mn){
            return '<div class="analytics-missing-row"><span class="missing-name">'+mn.name+'</span><span class="missing-count">'+mn.count+'回</span></div>';
          }).join('')+'</div>':'<p class="empty-state">データがありません</p>');
        }
        var extraPanel=$('analytics-extra-notes');
        if(extraPanel){
          var ens=Object.values(analytics.extraNotes).sort(function(a,b){return b.count-a.count;});
          extraPanel.innerHTML='<h3 class="analytics-section-title">余分に加えやすい音</h3>'+(ens.length?'<div class="analytics-extra-list">'+ens.map(function(en){
            return '<div class="analytics-extra-row"><span class="extra-name">'+en.name+'</span><span class="extra-count">'+en.count+'回</span></div>';
          }).join('')+'</div>':'<p class="empty-state">データがありません</p>');
        }
        // heatmap
        HeatmapRenderer.render(elHeat, analytics, completed, state.settings.heatmapMode||'subtle');
        // daily chart
        AnalyticsController._renderDailyChart(analytics);
        // bar chart
        AnalyticsController._renderBarChart(analytics);
      } catch(e){ console.warn('[Analytics] error:',e); }
    },
    hide() {
      HeatmapRenderer.unmount();
    },
    _renderDailyChart(analytics) {
      var container=$('daily-chart-svg-container');
      if(!container)return;
      var daily=analytics.daily||{};
      var days=Object.keys(daily).sort();
      if(days.length===0){container.innerHTML='<p class="empty-state">データがありません</p>';return;}
      var data=days.map(function(d){return {date:d,correct:daily[d].correct,total:daily[d].questions,rate:daily[d].questions>0?Math.round(daily[d].correct/daily[d].questions*100):0};});
      var w=container.clientWidth||600,h=150,pad={t:10,r:10,b:25,l:30};
      var svgW=Math.max(w,200),svgH=h;
      var plotW=svgW-pad.l-pad.r,plotH=svgH-pad.t-pad.b;
      var maxRate=100;
      var xScale=plotW/Math.max(data.length-1,1);
      var yScale=plotH/maxRate;
      var svg='<svg viewBox="0 0 '+svgW+' '+svgH+'" style="width:100%;height:'+svgH+'px;font-size:10px;overflow:visible" xmlns="http://www.w3.org/2000/svg">';
      for(var g=0;g<=100;g+=25){
        var gy=pad.t+(maxRate-g)*yScale;
        svg+='<line x1="'+pad.l+'" y1="'+gy+'" x2="'+(svgW-pad.r)+'" y2="'+gy+'" stroke="#ddd" stroke-width="1"/>';
        svg+='<text x="'+(pad.l-3)+'" y="'+(gy+3)+'" text-anchor="end" fill="#999">'+g+'%</text>';
      }
      var linePath='';
      data.forEach(function(d,i){
        var x=pad.l+i*xScale,y=pad.t+(maxRate-d.rate)*yScale;
        linePath+=(i===0?'M':'L')+x+','+y;
      });
      svg+='<path d="'+linePath+'" fill="none" stroke="var(--primary,#4a90d9)" stroke-width="2"/>';
      data.forEach(function(d,i){
        var x=pad.l+i*xScale,y=pad.t+(maxRate-d.rate)*yScale;
        svg+='<circle cx="'+x+'" cy="'+y+'" r="3" fill="var(--primary,#4a90d9)" stroke="#fff" stroke-width="1"/>';
        svg+='<text x="'+(x+5)+'" y="'+(y-3)+'" font-size="9" fill="var(--text,#333)">'+d.rate+'%</text>';
        if(i%Math.max(1,Math.floor(data.length/6))===0||i===data.length-1){
          svg+='<text x="'+x+'" y="'+(svgH-4)+'" text-anchor="middle" fill="#999" font-size="9">'+d.date.slice(5)+'</text>';
        }
      });
      svg+='</svg>';
      container.innerHTML=svg;
    },
    _renderBarChart(analytics) {
      var container=$('mode-bar-chart-container');
      if(!container)return;
      var modes=analytics.mode||{};
      var keys=Object.keys(modes);
      if(keys.length===0){container.innerHTML='<p class="empty-state">データがありません</p>';return;}
      var max=0;keys.forEach(function(k){if(modes[k].questions>max)max=modes[k].questions;});
      if(max===0)max=1;
      var html='<div class="bar-chart" style="display:flex;flex-direction:column;gap:8px;padding:8px 0">';
      keys.forEach(function(k){
        var m=modes[k];var pct=m.questions>0?Math.round(m.correct/m.questions*100):0;
        var barW=Math.max(Math.round(m.questions/max*100),2);
        html+='<div class="bar-chart-row" style="display:flex;align-items:center;gap:8px">';
        html+='<span class="bar-chart-label" style="width:100px;font-size:12px;text-align:right;flex-shrink:0">'+_modeLabel(k)+'</span>';
        html+='<div class="bar-chart-bar-bg" style="flex:1;height:20px;background:var(--bg-secondary,#eee);border-radius:4px;overflow:hidden;position:relative">';
        html+='<div class="bar-chart-bar-fill" style="height:100%;width:'+barW+'%;background:var(--primary,#4a90d9);border-radius:4px"></div>';
        html+='</div>';
        html+='<span class="bar-chart-pct" style="width:40px;font-size:12px;text-align:right">'+pct+'%</span>';
        html+='<span class="bar-chart-count" style="font-size:11px;color:#999">'+m.correct+'/'+m.questions+'</span>';
        html+='</div>';
      });
      html+='</div>';
      container.innerHTML=html;
    }
  };
  // === 第11段階: ヒートマップレンダラー ===
  const HeatmapRenderer = {
    _popupEl: null,
    _container: null,
    _keys: new Map(),

    _isBlack(m) { var n = m % 12; return [1,3,6,8,10].includes(n); },
    _noteName(m) { return ['C','Cs','D','Ds','E','F','Fs','G','Gs','A','As','B'][m%12]; },
    _noteLabelHTML(m, fmt) {
      var nn = this._noteName(m); var oct = Math.floor(m/12)-1;
      var sol = {C:'ド',Cs:'ド#',D:'レ',Ds:'レ#',E:'ミ',F:'ファ',Fs:'ファ#',G:'ソ',Gs:'ソ#',A:'ラ',As:'ラ#',B:'シ'};
      var en = nn.replace('s','#');
      if (fmt === 'none') return '';
      if (fmt === 'solfege') return sol[nn]+oct;
      if (fmt === 'english') return en+oct;
      if (fmt === 'both') return sol[nn]+' '+en+oct;
      return en+oct;
    },
    _buildNoteStats(analytics, completed) {
      var stats = {};
      if (analytics && analytics.notes) {
        Object.values(analytics.notes).forEach(function(n) {
          stats[n.midi] = { attempts: n.attempts, correct: n.correct, wrong: n.wrong, missing: n.missing || 0, totalTimeMs: n.totalTimeMs || 0 };
        });
      }
      if (completed) {
        (completed||[]).forEach(function(s) {
          (s.questions||[]).forEach(function(q) {
            if (!q.answered) return;
            var cNotes = questionNotes(q, 'correct');
            var aNotes = questionNotes(q, 'answer');
            cNotes.forEach(function(m) {
              if (!stats[m]) stats[m] = { attempts: 0, correct: 0, wrong: 0, missing: 0, totalTimeMs: 0 };
              stats[m].attempts++;
              if (aNotes.includes(m)) stats[m].correct++; else stats[m].wrong++;
            });
          });
        });
      }
      return stats;
    },
    render(container, analytics, completed, mode) {
      if (this._popupEl) this._closePopup();
      this._container = container;
      if (!container) return;
      if (mode === 'off') { container.innerHTML = '<p class="empty-state">ヒートマップ表示: 非表示</p>'; return; }
      if (!analytics || !completed || completed.length === 0) {
        container.innerHTML = '<p class="empty-state">データがありません</p>';
        return;
      }
      var startNote = 48, endNote = 72;
      var stats = this._buildNoteStats(analytics, completed);
      var maxWrong = 0;
      Object.values(stats).forEach(function(s) { if (s.wrong > maxWrong) maxWrong = s.wrong; });
      if (maxWrong === 0) maxWrong = 1;

      container.innerHTML = '<div class="heatmap-keyboard-wrapper" style="position:relative;width:100%;max-width:100%"></div>';
      var wrapper = container.querySelector('.heatmap-keyboard-wrapper');
      if (!wrapper) return;

      // Build white and black keys
      var whiteNotes = [];
      for (var m = startNote; m <= endNote; m++) { if (!this._isBlack(m)) whiteNotes.push(m); }
      var wHtml = '', bHtml = '';
      var wIdx = -1;
      var self = this;
      for (var i = 0; i < whiteNotes.length; i++) {
        var m = whiteNotes[i]; wIdx++;
        var ws = stats[m];
        var wrongCount = ws ? ws.wrong : 0;
        var wOpacity = wrongCount > 0 ? (0.3 + 0.7 * Math.min(wrongCount / maxWrong, 1)) : 0;
        var wLineColor = wrongCount > 0 ? 'rgba(200,50,50,' + (0.4 + 0.3 * Math.min(wrongCount / maxWrong, 1)) + ')' : 'transparent';
        var noteLabel = self._noteLabelHTML(m, state.settings.noteLabel);
        var wLabel = '<span class="heatmap-key-label">' + noteLabel + '</span>' + (ws && mode === 'detail' ? '<span class="heatmap-count-label">' + ws.wrong + '</span>' : '');
        wHtml += '<div class="piano-key white-key heatmap-key" data-midi="' + m + '" title="' + self._noteName(m).replace('s','#') + (Math.floor(m/12)-1) + '" style="border-bottom:3px solid ' + wLineColor + ';position:relative">' + wLabel + '<span class="heatmap-dot" style="position:absolute;bottom:2px;left:50%;transform:translateX(-50%);width:5px;height:5px;border-radius:50%;background:rgba(200,50,50,' + wOpacity + ')"></span></div>';
        var n = m % 12;
        if ((n === 0 || n === 2 || n === 5 || n === 7 || n === 9) && (m+1) <= endNote && this._isBlack(m+1)) {
          var bm = m + 1;
          var bs = stats[bm];
          var bWrong = bs ? bs.wrong : 0;
          var bOpacity = bWrong > 0 ? (0.3 + 0.7 * Math.min(bWrong / maxWrong, 1)) : 0;
          var bLineColor = bWrong > 0 ? 'rgba(200,50,50,' + (0.4 + 0.3 * Math.min(bWrong / maxWrong, 1)) + ')' : 'transparent';
          var blackLabel = self._noteLabelHTML(bm, state.settings.noteLabel);
          bHtml += '<div class="piano-key black-key heatmap-key" data-midi="' + bm + '" title="' + self._noteName(bm).replace('s','#') + (Math.floor(bm/12)-1) + '" style="left:' + ((wIdx + 1) * 100 / whiteNotes.length - 100 / whiteNotes.length * 0.4) + '%;border-bottom:3px solid ' + bLineColor + ';position:absolute;z-index:2"><span class="heatmap-key-label">' + blackLabel + '</span><span class="heatmap-dot" style="position:absolute;bottom:2px;left:50%;transform:translateX(-50%);width:4px;height:4px;border-radius:50%;background:rgba(200,50,50,' + bOpacity + ')"></span></div>';
        }
      }
      wrapper.innerHTML = '<div class="heatmap-white-keys" style="display:flex;flex:1;height:100px;position:relative">' + wHtml + '</div>' + bHtml;

      // Update aria-labels
      wrapper.querySelectorAll('.piano-key').forEach(function(el) {
        var m = parseInt(el.dataset.midi);
        if (!isNaN(m) && stats[m]) {
          el.setAttribute('aria-label', self._noteName(m).replace('s','#') + ' ' + (Math.floor(m/12)-1) + ': 誤答' + stats[m].wrong + '回 / 正答' + stats[m].correct + '回');
        }
      });

      // Detail mode: click to show popup
      if (mode === 'detail') {
        wrapper.addEventListener('click', function(e) {
          var key = e.target.closest('.heatmap-key');
          if (!key) { self._closePopup(); return; }
          var midi = parseInt(key.dataset.midi);
          if (isNaN(midi)) return;
          var s = stats[midi] || { attempts: 0, correct: 0, wrong: 0, missing: 0, totalTimeMs: 0 };
          var name = self._noteName(midi).replace('s','#') + (Math.floor(midi/12)-1);
          var acc = s.attempts > 0 ? Math.round(s.correct / s.attempts * 100) + '%' : '--';
          var avgTime = s.attempts > 0 && s.totalTimeMs > 0 ? Math.round(s.totalTimeMs / s.attempts / 1000) + '秒' : '--';
          var confusions = analytics && analytics.confusions ? Object.values(analytics.confusions).filter(function(c) { return c.correctNote === midi || c.selectedNote === midi; }) : [];
          var confusionHtml = confusions.length > 0 ? confusions.map(function(c) {
            var target = c.correctNote === midi ? c.selectedNote : c.correctNote;
            return '<div>→ ' + self._noteName(target).replace('s','#') + (Math.floor(target/12)-1) + ': ' + c.count + '回</div>';
          }).join('') : '<div>なし</div>';
          var pitchDiff = analytics && analytics.pitch && analytics.pitch.differences ? (analytics.pitch.differences[midi]||0) : 0;
          var higher = pitchDiff > 0 ? pitchDiff : 0;
          var lower = pitchDiff < 0 ? -pitchDiff : 0;

          self._showPopup(e, {
            name: name, midi: midi, attempts: s.attempts, correct: s.correct,
            wrong: s.wrong, missing: s.missing || 0, accuracy: acc,
            avgTime: avgTime, confusions: confusionHtml,
            higher: higher, lower: lower
          });
        });
      }
    },
    _showPopup(event, data) {
      this._closePopup();
      var popup = document.createElement('div');
      popup.className = 'heatmap-popup';
      popup.style.cssText = 'position:fixed;z-index:1000;background:var(--bg-card,#fff);border:1px solid var(--border,#ddd);border-radius:8px;padding:16px;max-width:360px;width:auto;box-shadow:0 4px 16px rgba(0,0,0,0.2);font-size:14px';
      popup.innerHTML = '<button class="heatmap-popup-close" style="float:right;border:none;background:none;font-size:20px;cursor:pointer;color:var(--text,#333)">&times;</button>' +
        '<h4 style="margin:0 0 8px;font-size:16px">' + data.name + ' (MIDI ' + data.midi + ')</h4>' +
        '<div class="heatmap-popup-stats">' +
        '<div>出題: ' + data.attempts + '回</div>' +
        '<div>正解: ' + data.correct + '回</div>' +
        '<div>誤答: ' + data.wrong + '回</div>' +
        '<div>不足: ' + data.missing + '回</div>' +
        '<div>正答率: ' + data.accuracy + '</div>' +
        '<div>平均回答時間: ' + data.avgTime + '</div>' +
        '<div>高く答えた: ' + (data.higher||0) + '回 / 低く答えた: ' + (data.lower||0) + '回</div>' +
        '<div style="margin-top:4px"><strong>主な取り違え先:</strong>' + data.confusions + '</div>' +
        '</div>';
      document.body.appendChild(popup);
      this._popupEl = popup;

      // Position
      var rect = popup.getBoundingClientRect();
      var x = Math.min(event.clientX, window.innerWidth - rect.width - 10);
      var y = Math.min(event.clientY - rect.height - 10, window.innerHeight - rect.height - 10);
      if (y < 10) y = event.clientY + 10;
      if (x < 10) x = 10;
      popup.style.left = x + 'px';
      popup.style.top = y + 'px';

      var self = this;
      popup.querySelector('.heatmap-popup-close').addEventListener('click', function() { self._closePopup(); });
      var escHandler = function(e2) { if (e2.key === 'Escape') self._closePopup(); };
      document.addEventListener('keydown', escHandler);
      popup._escHandler = escHandler;
      setTimeout(function() {
        document.addEventListener('click', function docClick(e2) {
          if (self._popupEl && !self._popupEl.contains(e2.target) && !e2.target.closest('.heatmap-key')) {
            self._closePopup();
            document.removeEventListener('click', docClick);
          }
        });
      }, 0);
    },
    _closePopup() {
      if (this._popupEl) {
        if (this._popupEl._escHandler) document.removeEventListener('keydown', this._popupEl._escHandler);
        this._popupEl.remove();
        this._popupEl = null;
      }
    },
    unmount() {
      this._closePopup();
      this._keys.clear();
      this._container = null;
    }
  };
  const SettingsController = {
    async show() {
      this.loadSettings();
      if (state.settings.midiEnabled && MIDIManager.isApiAvailable() && !MIDIManager._access) {
        await MIDIManager.requestAccess();
        this.loadSettings();
      }
    },
    loadSettings() {
      const s = state.settings;
      this.updatePoolInfo();
      document.querySelectorAll('#settings-question-count .choice-btn').forEach(b => b.classList.toggle('choice-active', parseInt(b.dataset.value)===s.questionCount));
      document.querySelectorAll('#settings-difficulty .choice-btn').forEach(b => b.classList.toggle('choice-active', b.dataset.value===s.difficulty));
      document.querySelectorAll('#settings-theme .choice-btn').forEach(b => b.classList.toggle('choice-active', b.dataset.value===s.theme));
      document.querySelectorAll('#settings-note-label .choice-btn').forEach(b => b.classList.toggle('choice-active', b.dataset.value===s.noteLabel));
      document.querySelectorAll('#settings-effects .choice-btn').forEach(b => b.classList.toggle('choice-active', b.dataset.value===s.effectStrength));
      // Stage 9 accessibility toggles
      if ($('settings-reduced-blinking')) $('settings-reduced-blinking').checked = s.reducedBlinking === true;
      if ($('settings-screen-shake')) $('settings-screen-shake').checked = s.screenShake === true;
      document.querySelectorAll('#settings-intervalPlaybackType .choice-btn').forEach(b => b.classList.toggle('choice-active', b.dataset.value===(s.intervalPlaybackType||'harmonic')));
      document.querySelectorAll('#settings-intervalAnswerType .choice-btn').forEach(b => b.classList.toggle('choice-active', b.dataset.value===(s.intervalAnswerType||'name')));
      document.querySelectorAll('#settings-heatmap-mode .choice-btn').forEach(b => b.classList.toggle('choice-active', b.dataset.value===(s.heatmapMode||'subtle')));
      this.setSlider('volume-master', s.masterVolume);
      this.setSlider('volume-piano', s.pianoVolume);
      this.setSlider('volume-bgm', s.bgmVolume);
      this.setSlider('volume-sfx', s.sfxVolume);
      this.setSlider('volume-applause', s.applauseVolume);
      if ($('settings-sfx-enabled')) $('settings-sfx-enabled').checked = s.sfxEnabled !== false;
      // ミュートトグル
      const muteToggle = $('settings-mute-toggle');
      if (muteToggle) muteToggle.checked = s.muted;
      ProfileManager.updateUI();
            // MIDI設定
      const midiEnabledCheck = $('settings-midi-enabled');
      if (midiEnabledCheck) midiEnabledCheck.checked = s.midiEnabled;
      const midiScreenCheck = $('settings-midi-screen-keys');
      if (midiScreenCheck) midiScreenCheck.checked = s.midiScreenKeyboardEnabled !== false;
      const midiSustainCheck = $('settings-midi-sustain');
      if (midiSustainCheck) midiSustainCheck.checked = s.midiSustainAffectsAnswer === true;
      document.querySelectorAll('#settings-midi-confirm-mode .choice-btn').forEach(b => b.classList.toggle('choice-active', b.dataset.value===(s.midiConfirmationMode||'singleImmediate')));
      document.querySelectorAll('#settings-midi-auto-delay .choice-btn').forEach(b => b.classList.toggle('choice-active', parseInt(b.dataset.value)===(s.midiAutoConfirmDelayMs||500)));
      document.querySelectorAll('#settings-midi-octave .choice-btn').forEach(b => b.classList.toggle('choice-active', parseInt(b.dataset.value)===(s.midiOctaveOffset||0)));
      const midiDetails = $('settings-midi-details');
      if (midiDetails) midiDetails.hidden = !s.midiEnabled;
      const autoDelayRow = $('settings-midi-auto-delay-row');
      if (autoDelayRow) autoDelayRow.hidden = (s.midiConfirmationMode||'singleImmediate') !== 'auto';
      
      // MIDI機器選択ドロップダウン更新
      const deviceSelect = $('settings-midi-device-select');
      const midiInputs = MIDIManager.getInputList();
      if (deviceSelect) {
        deviceSelect.innerHTML = midiInputs.map(i =>
          '<option value="' + i.id + '"' + (i.id === (s.selectedMidiInputId || state.midiSelectedInputId) ? ' selected' : '') + '>' + i.name + '</option>'
        ).join('');
      }
      const deviceRow = $('settings-midi-device-row');
      if (deviceRow) deviceRow.hidden = !midiInputs.length;
      // MIDI接続状態表示
      const statusEl = $('settings-midi-status');
      if (statusEl) statusEl.textContent = state.midiConnected ? '接続済み' : (state.midiNoApi ? '利用不可' : '未接続');
          },
    async updatePoolInfo() {
      const text = $('pool-info-text');
      if (!text) return;
      try {
        const info = await QuestionPoolManager.getInfo();
        if (info.exists) {
          text.textContent = `サイクル: ${info.cycle}周目 | 残り問題: ${info.remaining}/${info.total}問 | 最終更新: ${new Date(info.updatedAt).toLocaleString('ja-JP')}`;
        } else {
          text.textContent = '出題履歴はまだありません。セッションを開始すると自動的に作成されます。';
        }
      } catch (e) {
        text.textContent = '情報の読み込みに失敗しました';
      }
    },

    setSlider(id, val) { const s=$(id), v=$(`${id}-value`); if(s)s.value=Math.round(val*100); if(v)v.textContent=`${Math.round(val*100)}%`; },
    async applySetting(key, value) {
      state.settings[key] = value;
      if (key === 'theme') ProfileManager.applyTheme();
      if (key === 'heatmapMode') { /* heatmap mode change is immediate */ }
      if (key === 'masterVolume' || key === 'pianoVolume' || key === 'bgmVolume' || key === 'sfxVolume' || key === 'applauseVolume' || key === 'muted') {
        AudioSystem.applyVolumes();
      }
      await ProfileManager.saveCurrentSettings();
    }
  };

  const MidiTestController = {
    _logLimit: 20,

    async show() {
      const statusEl = $('midi-status'), devicesEl = $('midi-devices'), testArea = $('midi-test-area');
      if (!statusEl || !devicesEl) return;

      if (!MIDIManager.isApiAvailable()) {
        statusEl.innerHTML = '<p>⚠️ この環境ではMIDI入力を利用できません。画面鍵盤で引き続き遊べます。</p>';
        devicesEl.innerHTML = '';
        if (testArea) testArea.hidden = true;
        return;
      }

      statusEl.innerHTML = '<p>MIDIアクセスを要求しています...</p>';
      const ok = await MIDIManager.requestAccess();
      if (!ok) {
        statusEl.innerHTML = '<p>⚠️ MIDIアクセスを確認できませんでした。画面鍵盤で引き続き遊べます。<br><button id="midi-retry-access" class="btn btn-secondary btn-small">再試行</button></p>';
        if (testArea) testArea.hidden = true;
        devicesEl.innerHTML = '';
        const retryBtn = $('midi-retry-access');
        if (retryBtn) retryBtn.addEventListener('click', () => this.show());
        return;
      }

      this._refreshDisplay();
      this.startListening();
    },

    _refreshDisplay() {
      const statusEl = $('midi-status'), devicesEl = $('midi-devices'), testArea = $('midi-test-area');
      if (!statusEl || !devicesEl) return;

      const inputs = MIDIManager.getInputList();
      const connected = state.midiConnected;
      const selectedId = state.settings.selectedMidiInputId || state.midiSelectedInputId;

      let statusHtml = '';
      if (state.midiNoApi) {
        statusHtml = '<p>⚠️ この環境ではMIDI入力を利用できません。画面鍵盤で引き続き遊べます。</p>';
      } else if (state.midiAccessFailed) {
        statusHtml = '<p>⚠️ MIDIアクセスを利用できませんでした。画面鍵盤で引き続き遊べます。</p>';
      } else if (inputs.length === 0) {
        statusHtml = '<p>🔍 MIDI機器が見つかりませんでした。機器を接続して「再検出」を押してください。</p>';
      } else if (connected) {
        const sel = inputs.find(i => i.id === selectedId);
        statusHtml = '<p>✅ MIDI接続済み: ' + (sel ? sel.name : '選択された機器') + '</p>';
      } else {
        statusHtml = '<p>⚠️ 接続が切れています。「再検出」を押してください。</p>';
      }
      statusEl.innerHTML = statusHtml;

      if (inputs.length > 0) {
        devicesEl.innerHTML = inputs.map(i => {
          const isSelected = i.id === selectedId;
          return '<div class="midi-device-item' + (isSelected ? ' active' : '') + '">' +
            '<span>🎹</span>' +
            '<span><strong>' + i.name + '</strong>' + (i.manufacturer ? ' (' + i.manufacturer + ')' : '') + '<br>' +
            '<small>状態: ' + i.state + ' | 接続: ' + i.connection + '</small></span>' +
            (!isSelected ? '<button class="btn btn-secondary btn-small midi-select-device" data-id="' + i.id + '">選択</button>' : '<span class="midi-info-value">✓ 選択中</span>') +
            '</div>';
        }).join('');

        devicesEl.querySelectorAll('.midi-select-device').forEach(btn => {
          btn.addEventListener('click', (e) => {
            const id = e.target.dataset.id;
            MIDIManager.selectInput(id);
            this._refreshDisplay();
          });
        });
      } else {
        devicesEl.innerHTML = '';
      }

      if (testArea) {
        testArea.hidden = !connected && inputs.length === 0;
      }

      this._clearLog();
      this._updateActiveNotes();
      this._updateSustainStatus();
    },

    _clearLog() {
      state.midiLogEntries = [];
      const logEl = $('midi-event-log-list');
      if (logEl) logEl.innerHTML = '--';
    },

    _addLogEntry(entry) {
      state.midiLogEntries.unshift(entry);
      if (state.midiLogEntries.length > this._logLimit) {
        state.midiLogEntries = state.midiLogEntries.slice(0, this._logLimit);
      }
      const logEl = $('midi-event-log-list');
      if (!logEl) return;
      logEl.innerHTML = state.midiLogEntries.map(e =>
        '<div class="midi-event-entry">' + e + '</div>'
      ).join('');
    },

    _updateEventDisplay(parsed, rawNote, adjustedNote, noteName) {
      const setText = (id, val) => { const el = $(id); if (el) el.textContent = val; };
      setText('midi-event-type', parsed.isNoteOn ? 'ノートオン' : parsed.isNoteOff ? 'ノートオフ' : '--');
      setText('midi-channel', '1');
      setText('midi-raw-note', rawNote);
      setText('midi-adjusted-note', adjustedNote);
      setText('midi-note-name', noteName);
      setText('midi-velocity', parsed.velocity != null ? parsed.velocity : '--');
    },

    _updateActiveNotes() {
      const listEl = $('midi-active-notes-list');
      if (!listEl) return;
      const sustainedNotes = state.midiSustainPedal ? [...state.midiSustainedNotes] : [];
      const activeArr = [...new Set([...state.midiActiveNotes.keys(), ...sustainedNotes])];
      if (activeArr.length === 0) {
        listEl.innerHTML = 'なし';
        return;
      }
      listEl.innerHTML = activeArr.sort((a, b) => a - b).map(n =>
        '<span class="midi-active-note-chip">' + midiToNoteName(n, 'english') + ' (' + n + ')</span>'
      ).join('');
    },

    _updateSustainStatus() {
      const el = $('midi-sustain-status');
      if (el) el.textContent = state.midiSustainPedal ? 'ON' : 'OFF';
    },

    startListening() {
      const self = this;
      MIDIManager.setCallbacks({
        onNoteOn: (note, velocity) => {
          const adjusted = applyMidiOctaveOffset(note, state.settings.midiOctaveOffset);
          const noteName = midiToNoteName(adjusted, 'english');
          state.midiActiveNotes.set(note, velocity);
          state.midiLastVelocity = velocity;

          const displayEl = $('midi-note-display');
          if (displayEl) displayEl.textContent = noteName + ' (MIDI ' + adjusted + ')';

          self._updateEventDisplay({ isNoteOn: true, channel: 0, velocity }, note, adjusted, noteName);
          self._addLogEntry('ノートオン Ch1 生:' + note + ' 補正後:' + adjusted + '(' + noteName + ') Vel:' + velocity);
          self._updateActiveNotes();
        },

        onNoteOff: (note) => {
          const adjusted = applyMidiOctaveOffset(note, state.settings.midiOctaveOffset);
          const noteName = midiToNoteName(adjusted, 'english');
          state.midiActiveNotes.delete(note);

          if (state.midiSustainPedal) {
            state.midiSustainedNotes.add(note);
          }

          self._updateEventDisplay({ isNoteOff: true, channel: 0, velocity: 0 }, note, adjusted, noteName);
          self._addLogEntry('ノートオフ Ch1 生:' + note + ' 補正後:' + adjusted + '(' + noteName + ')');
          self._updateActiveNotes();
        },

        onSustain: (on) => {
          state.midiSustainPedal = on;
          self._updateSustainStatus();
          self._addLogEntry('サステイン ' + (on ? 'ON' : 'OFF'));
          if (!on) {
            state.midiSustainedNotes.clear();
            self._updateActiveNotes();
          }
        },

        onInputsChanged: () => {
          self._refreshDisplay();
        }
      });
    },

    stopListening() {
      MIDIManager.setCallbacks({});
    }
  };
  const ResultController = {
    sessionData: null,
    _retryInProgress: false,
    show(params) {
      const { correctCount=0, questionCount=0, maxStreak=0 } = params;
      $('result-correct').textContent = correctCount;
      $('result-total').textContent = questionCount;
      const acc = questionCount > 0 ? Math.round(correctCount/questionCount*100) : 0;
      $('result-accuracy').textContent = `${acc}%`;
      $('result-streak').textContent = maxStreak;
      const pe = $('result-perfect');
      if (pe) pe.hidden = correctCount !== questionCount || questionCount === 0;
      const sd = params.sessionData;
      this.sessionData = sd || null;
      this._retryInProgress = false;
      const incorrectCount = Array.isArray(sd?.questions) ? sd.questions.filter(q => q?.answered === true && q.isCorrect === false).length : 0;
      const reviewButton = $('result-review-btn');
      if (reviewButton) {
        reviewButton.hidden = incorrectCount === 0;
        reviewButton.disabled = false;
        reviewButton.removeAttribute('aria-busy');
      }
      const emptyReview = $('result-review-empty');
      if (emptyReview) emptyReview.hidden = incorrectCount !== 0;
      if (sd) { const ss = LocalCache.load('sessions',[]); ss.push(sd); LocalCache.save('sessions',ss); }
      // result heatmap
      var rh=$('result-heatmap');
      if(rh&&sd){
        var noteMap={};
        (sd.questions||[]).forEach(function(q){
          if(!q.answered)return;
          var cn=questionNotes(q,'correct'),an=questionNotes(q,'answer');
          cn.forEach(function(m){
            if(!noteMap[m])noteMap[m]={w:0};
            if(!an.includes(m))noteMap[m].w++;
          });
        });
        var maxW=0;Object.values(noteMap).forEach(function(n){n.w>maxW&&(maxW=n.w);});if(maxW===0)maxW=1;
        var nms=['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
        var hml='<div class="result-heatmap-title">間違えやすい音</div><p class="result-heatmap-caption">赤い帯が長いほど、今回のセッションで誤答が多かった音です。</p><div class="result-heatmap-bar" role="img" aria-label="間違えやすい音のヒートマップ" style="display:flex;gap:1px;height:30px;margin-top:8px">';
        for(var mm=48;mm<=72;mm++){var nn=mm%12;if([1,3,6,8,10].includes(nn))continue;var ws=noteMap[mm];var op=ws?0.2+0.8*Math.min(ws.w/maxW,1):0;hml+='<div style="flex:1;background:rgba(200,50,50,'+op+')" title="'+nms[nn]+(Math.floor(mm/12)-1)+'"></div>';}
        hml+='</div><div style="margin-top:4px;font-size:11px"><button id="result-analytics-btn" class="btn btn-secondary btn-small">\u6210\u7e3e\u5206\u6790\u3092\u898b\u308b</button></div>';
        rh.innerHTML=hml;
      }
    },
    async startIncorrectRetry() {
      if (this._retryInProgress) return;
      const button = $('result-review-btn');
      const source = this.sessionData;
      const incorrectCount = Array.isArray(source?.questions) ? source.questions.filter(q => q?.answered === true && q.isCorrect === false).length : 0;
      if (!incorrectCount) { showError('復習する間違いはありません'); return; }
      this._retryInProgress = true;
      if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
      try {
        const session = await SessionManager.startIncorrectRetry(source);
        Screens.show('session', { mode: session.mode, difficulty: session.difficulty, questionCount: session.questionCount, resumeSession: true, retrySession: true });
      } catch (error) {
        showError(error?.message || '間違えた問題の復習を開始できませんでした');
      } finally {
        if (state.currentScreen === 'result' && button) { button.disabled = false; button.removeAttribute('aria-busy'); }
        if (state.currentScreen === 'result') this._retryInProgress = false;
      }
    }
  };

  const ProfileController = {
    show() { this.renderList(); },
    renderList() {
      const list = $('profile-list'); if (!list) return;
      const ids = Object.keys(state.profiles).sort((a,b) => {
        if (a==='default') return -1; if (b==='default') return 1;
        return (state.profiles[a].createdAt||'').localeCompare(state.profiles[b].createdAt||'');
      });
      list.innerHTML = ids.map(id => {
        const p = state.profiles[id], active = id === state.currentProfileId;
        return `<div class="profile-item${active?' active':''}" data-profile-id="${id}"><span class="profile-icon">${p.icon||'🎹'}</span><div class="profile-info"><span class="profile-name" id="profile-name-${id}">${this._esc(p.name)}</span><span class="profile-detail">${active?'現在選択中':'タップして切り替え'}</span></div><div class="profile-actions">${active&&id!=='default'?`<button class="profile-action-btn" data-action="rename" data-profile-id="${id}">名前変更</button><button class="profile-action-btn danger" data-action="delete" data-profile-id="${id}">削除</button>`:''}</div></div>`;
      }).join('');
    },
    _esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; },
    showCreateForm() { const f=$('profile-create-form'),i=$('profile-name-input'); if(f)f.hidden=false; if(i){i.value='';i.focus();} },
    hideCreateForm() { const f=$('profile-create-form'); if(f)f.hidden=true; },
    async create(name) {
      const t = name.trim(); if (!t) { showError('プロフィール名を入力してください'); return false; }
      const id = `profile_${Date.now()}_${Math.random().toString(36).slice(2,6)}`;
      const profile = { id, name: t, icon: '🎹', settings: { ...DEFAULT_SETTINGS }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      state.profiles[id] = profile;
      if (!await Storage.put('profiles', profile)) { showError('保存失敗'); return false; }
      this.renderList(); this.hideCreateForm(); return true;
    },
    async switchTo(pid) { await ProfileManager.switchTo(pid); this.renderList(); if (state.currentScreen==='settings') SettingsController.loadSettings(); },
    showRenameForm(pid) {
      const nameEl = $(`profile-name-${pid}`); if (!nameEl) return;
      const currentName = state.profiles[pid]?.name||'';
      const container = nameEl.parentElement;
      const existing = container.querySelector('.profile-rename-form'); if (existing) existing.remove();
      const form = document.createElement('div'); form.className = 'profile-rename-form';
      form.innerHTML = `<input type="text" class="profile-rename-input" value="${this._esc(currentName)}" maxlength="20" autocomplete="off"><button class="profile-action-btn" data-action="rename-confirm" data-profile-id="${pid}">保存</button><button class="profile-action-btn" data-action="rename-cancel" data-profile-id="${pid}">キャンセル</button>`;
      nameEl.style.display = 'none';
      container.insertBefore(form, container.firstChild);
      const input = form.querySelector('.profile-rename-input'); if (input) { input.focus(); input.select(); }
    },
    async confirmRename(pid, newName) {
      const t = newName.trim(); if (!t) { showError('名前を入力してください'); return false; }
      const p = state.profiles[pid]; if (!p) return false;
      p.name = t; p.updatedAt = new Date().toISOString(); state.profiles[pid] = p;
      await Storage.put('profiles', p); this.renderList(); ProfileManager.updateUI(); return true;
    },
    async delete(pid) {
      if (pid === 'default') { showError('デフォルトプロフィールは削除できません'); return false; }
      const p = state.profiles[pid]; if (!p) return false;
      if (!await confirmDialog(`「${p.name}」を削除しますか？\nこのプロフィールの設定、履歴、チェックインがすべて削除されます。\n\nこの操作は元に戻せません。`)) return false;
      await ProfileManager.delete(pid);
      if (state.currentProfileId === pid) { await ProfileManager.switchTo('default'); if (state.currentScreen==='settings') SettingsController.loadSettings(); }
      this.renderList(); ProfileManager.updateUI();
      showError(`「${p.name}」を削除しました`);
      return true;
    }
  };

  const SessionDetailController = {
    async show(params) {
      const container=$('session-detail-content');
      if(!container)return;
      const sessionId=params?.sessionId;
      const requestScreen = state.currentScreen;
      const requestReturn = state.sessionDetailReturnScreen;
      if(!sessionId){ container.innerHTML='<p class="empty-state">セッションが指定されていません</p>'; return; }
      try {
        const session=await Storage.get('sessions',sessionId);
        if (state.currentScreen !== requestScreen || state.currentScreen !== 'session-detail' || state.sessionDetailReturnScreen !== requestReturn || state.selectedSessionId !== sessionId) return;
        if(!session||session.profileId!==state.currentProfileId){
          container.innerHTML='<p class="empty-state">セッションが見つかりません</p>';
          return;
        }
        const qs=session.questions||[];
        const acc=session.questionCount>0?Math.round((session.correctCount||0)/session.questionCount*100):0;
        const dateStr=session.completedAt?new Date(session.completedAt).toLocaleDateString('ja-JP',{year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'}):'未完了';
        const isChSess=CM(session.mode);
        container.innerHTML=`
          <div class="sd-header">
            <div class="sd-mode">${session.modeName||session.mode||'不明'}</div>
            <div class="sd-date">${dateStr}</div>
          </div>
          ${isChSess&&qs[0]?'<div class="sd-chord-info">'+(qs[0].rootLabel||'')+(CHORD_DEFINITIONS[qs[0].chordType]?.label||'')+' '+(INVERSION_DEFINITIONS[qs[0].inversionId]?.label||'')+'</div>':''}
          <div class="sd-summary">
            <div class="sd-stat"><span class="sd-stat-val">${session.questionCount||0}</span><span class="sd-stat-lbl">問題</span></div>
            <div class="sd-stat"><span class="sd-stat-val">${session.correctCount||0}</span><span class="sd-stat-lbl">正解</span></div>
            <div class="sd-stat"><span class="sd-stat-val">${acc}%</span><span class="sd-stat-lbl">正答率</span></div>
            <div class="sd-stat"><span class="sd-stat-val">${session.maxStreak||0}</span><span class="sd-stat-lbl">最大連続</span></div>
          </div>
          <div class="sd-question-list">
            ${qs.map((q,i)=>{
              const correct=q.isCorrect;
              let noteInfo,selected;const rl=['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
              if(CM(session.mode)){const rl2=q.rootLabel||'';const cl2=CHORD_DEFINITIONS[q.chordType]?.label||'',iv2=INVERSION_DEFINITIONS[q.inversionId]?.label||'';noteInfo=rl2+cl2+' '+iv2;selected=(q.selectedNotes||[]).map(n=>midiToNoteName(n,state.settings.noteLabel)).join('、')||'無回答';if(CM_NAME(session.mode)){const sr=q.selectedRootPitchClass!==null?rl[q.selectedRootPitchClass]:'未選択';const st=CHORD_DEFINITIONS[q.selectedChordType]?.label||'未選択';selected=sr+' '+st+(q.rootCorrect!==null?' [ルート:'+(q.rootCorrect?'✅':'❌')+' 種類:'+(q.chordTypeCorrect?'✅':'❌')+']':'');}if(CM_INV(session.mode)&&q.componentsCorrect!==null)selected+=' [構成:'+(q.componentsCorrect?'✅':'❌')+' ルート:'+(q.rootCorrect?'✅':'❌')+' 種類:'+(q.chordTypeCorrect?'✅':'❌')+' 転回:'+(q.inversionCorrect?'✅':'❌')+']';}
              else{noteInfo=q.midiNote!==undefined?midiToNoteName(q.midiNote,state.settings.noteLabel):(q.midiNotes?q.midiNotes.map(n=>midiToNoteName(n,state.settings.noteLabel)).join(' + '):'?');selected=q.selectedNote!==undefined?midiToNoteName(q.selectedNote,state.settings.noteLabel):(q.selectedNotes?q.selectedNotes.map(n=>midiToNoteName(n,state.settings.noteLabel)).join(' + '):'無回答');}
              const timeStr=q.responseTimeMs?`${(q.responseTimeMs/1000).toFixed(1)}秒`:'--';
              const correctNotes=questionNotes(q,'correct'), answerNotes=questionNotes(q,'answer');
              const matches=correctNotes.filter(n=>answerNotes.includes(n)), missing=correctNotes.filter(n=>!answerNotes.includes(n)), extra=answerNotes.filter(n=>!correctNotes.includes(n));
              const labels=(title,notes,klass)=>`<span class="note-compare ${klass}"><b>${title}</b> ${notes.length?notes.map(n=>midiToNoteName(n,state.settings.noteLabel)).join(' '):'なし'}</span>`;
              const keyboard=[...new Set([...correctNotes,...answerNotes])].sort((a,b)=>a-b).map(n=>`<span class="comparison-key ${matches.includes(n)?'match':missing.includes(n)?'missing':'extra'}"><b>${midiToNoteName(n,state.settings.noteLabel)}</b><small>${matches.includes(n)?'一致':missing.includes(n)?'不足':'余分'}</small></span>`).join('');
              return `<div class="sd-question" data-question-id="${q.questionId}">
                <div class="sd-q-num">${i+1}</div>
                <div class="sd-q-body">
                  <div class="sd-q-status ${correct?'sd-correct':'sd-wrong'}">${correct?'✅':'❌'}</div>
                  <div class="sd-q-details">
                    <div class="sd-q-row"><span class="sd-label">正解</span><span class="sd-value">${noteInfo}</span></div>
                    <div class="sd-q-row"><span class="sd-label">回答</span><span class="sd-value">${selected}</span></div>
                    <div class="sd-q-row"><span class="sd-label">時間</span><span class="sd-value">${timeStr}</span></div>
                    <div class="note-comparison">${labels('正解',correctNotes,'correct')}${labels('回答',answerNotes,'answer')}${labels('一致',matches,'match')}${labels('不足',missing,'missing')}${labels('余分',extra,'extra')}</div>
                    <div class="comparison-keyboard" aria-label="同じ鍵盤での正解と回答の比較">${keyboard}</div>
                    <div class="sd-audio-actions"><button class="btn btn-secondary btn-small" data-detail-audio="problem" data-question-index="${i}">問題音を再生</button><button class="btn btn-secondary btn-small" data-detail-audio="correct" data-question-index="${i}">正解音を再生</button><button class="btn btn-secondary btn-small" data-detail-audio="answer" data-question-index="${i}">過去の回答音を再生</button></div>
                  </div>
                </div>
              </div>`;
            }).join('')}
          </div>`;
        container.onclick=e=>{const b=e.target.closest('[data-detail-audio]');if(!b)return;const q=qs[Number(b.dataset.questionIndex)];if(!q)return;const notes=b.dataset.detailAudio==='answer'?questionNotes(q,'answer'):b.dataset.detailAudio==='problem'?(q.playedNotes||questionNotes(q,'correct')):questionNotes(q,'correct');if(!notes.length){showError('保存された回答音がありません');return;}b.disabled=true;setTimeout(()=>b.disabled=false,900);AudioSystem.resume();if(notes.length===1)AudioSystem.playPianoSample(notes[0],{duration:.8,velocity:96});else AudioSystem.playChord(notes,1,96);};
      } catch(e){ if (state.currentScreen === requestScreen && state.currentScreen === 'session-detail') { console.warn('[SessionDetail] error:',e); container.innerHTML='<p class="empty-state">読み込みエラー</p>'; } }
    }
  };

  // ========================================
  // イベント設定
  // ========================================

  function setupEventListeners() {
    $('audio-init-btn')?.addEventListener('click', handleAudioInit);

    document.querySelectorAll('[data-action="back"]').forEach(btn => {
      btn.addEventListener('click', () => Screens.back());
    });
    document.querySelectorAll('[data-action="home"]').forEach(btn => {
      btn.addEventListener('click', () => Screens.show('home'));
    });

    document.addEventListener('click', async (e) => {
      const card = e.target.closest('[data-screen]');
      if (!card || card.disabled) return;
      if (card.id === 'home-checkin-card' && card.dataset.screen === 'calendar') {
        if (card.dataset.checkinGuard === 'checking') return;
        card.dataset.checkinGuard = 'checking';
        try {
          AudioSystem.playSfxTone('ui');
          Screens.show(card.dataset.screen, {});
        } finally {
          delete card.dataset.checkinGuard;
        }
        return;
      }
      AudioSystem.playSfxTone('ui');
      Screens.show(card.dataset.screen, {});
    });

    document.querySelectorAll('.mode-card').forEach(card => {
      card.addEventListener('click', () => {
        if (AudioSystem.pianoState !== 'ready') {
          AudioSystem.updatePianoStatusUI();
          showError(AudioSystem.pianoState === 'loading' ? 'ピアノ音源を準備しています。完了後に開始できます。' : 'ピアノ音源を読み込めませんでした。再読み込みしてください。');
          return;
        }
        Screens.show('session', { mode: card.dataset.mode, difficulty: state.settings.difficulty, questionCount: state.settings.questionCount });
      });
    });

    document.querySelectorAll('.settings-choices').forEach(group => {
      group.addEventListener('click', (e) => {
        const btn = e.target.closest('.choice-btn');
        if (!btn || btn.disabled) return;
        const rawKey = group.id.replace('settings-', '');
        const key = rawKey === 'question-count' ? 'questionCount' : rawKey === 'heatmap-mode' ? 'heatmapMode' : rawKey;
        const raw = btn.dataset.value;
        const num = parseInt(raw);
        const val = isNaN(num) ? raw : num;
        group.querySelectorAll('.choice-btn').forEach(b => b.classList.remove('choice-active'));
        btn.classList.add('choice-active');
        SettingsController.applySetting(key, val);
      });
    });

    ['volume-master','volume-piano','volume-bgm','volume-sfx','volume-applause'].forEach(id => {
      const slider = $(id), valEl = $(`${id}-value`);
      if (!slider || !valEl) return;
      slider.addEventListener('input', () => {
        const val = parseInt(slider.value)/100;
        valEl.textContent = `${Math.round(val*100)}%`;
        const key = id.replace('volume-', '');
        state.settings[`${key}Volume`] = val;
        AudioSystem.applyVolumes();
      });
      slider.addEventListener('change', () => { ProfileManager.saveCurrentSettings(); });
    });

    // ミュートトグル
    $('settings-mute-toggle')?.addEventListener('change', (e) => {
      const muted = e.target.checked;
      SettingsController.applySetting('muted', muted);
    });

    // Stage 9 accessibility toggle handlers
    $('settings-reduced-blinking')?.addEventListener('change', (e) => {
      state.settings.reducedBlinking = e.target.checked;
      ProfileManager.saveCurrentSettings();
    });
    $('settings-screen-shake')?.addEventListener('change', (e) => {
      state.settings.screenShake = e.target.checked;
      ProfileManager.saveCurrentSettings();
    });

    // 音声テスト（第2段階確認用）
    $('audio-test-single')?.addEventListener('click', () => { AudioSystem.resume(); AudioSystem.playPianoSample(60,{duration:.8,velocity:96}); });
    $('audio-test-pair')?.addEventListener('click', () => { AudioSystem.resume(); AudioSystem.playChord([60, 64]); });
    $('audio-test-triad')?.addEventListener('click', () => { AudioSystem.resume(); AudioSystem.playChord([60, 64, 67]); });
    $('audio-test-bgm-home')?.addEventListener('click', () => { AudioSystem.resume(); AudioSystem.playBGM('./assets/audio/bgm/home_loop.mp3'); });
    $('audio-test-stop-bgm')?.addEventListener('click', () => { AudioSystem.stopBGM(); });
    $('settings-bgm-home')?.addEventListener('click', () => { AudioSystem.resume(); AudioSystem.playBGM('./assets/audio/bgm/home_loop.mp3'); });

    $('calendar-prev')?.addEventListener('click', () => { CalendarController.currentMonth--; if (CalendarController.currentMonth<0) { CalendarController.currentMonth=11; CalendarController.currentYear--; } CalendarController.renderCalendar(); });
    $('calendar-next')?.addEventListener('click', () => { CalendarController.currentMonth++; if (CalendarController.currentMonth>11) { CalendarController.currentMonth=0; CalendarController.currentYear++; } CalendarController.renderCalendar(); });
    $('calendar-today')?.addEventListener('click', () => CalendarController.goToday());
    $('calendar-grid')?.addEventListener('click', (event) => { const cell = event.target.closest('[data-date]'); if (cell) CalendarController.selectDate(cell.dataset.date); });
    $('calendar-date-detail')?.addEventListener('click', async (event) => {
      const session = event.target.closest('[data-calendar-session]');
      if (session) { Screens.show('session-detail', { sessionId: session.dataset.calendarSession, returnTo: 'calendar' }); return; }
      if (event.target.closest('[data-calendar-review]')) { Screens.show('review'); return; }
      const play = event.target.closest('[data-calendar-code-play]');
      if (play) { const checkin = await CheckinManager.get(new Date(`${CalendarController.selectedDate}T12:00:00`)); if (!checkin) return; if (AudioSystem.ctx) AudioSystem.playChord(checkin.notes, 1.2); else $('calendar-checkin-status').textContent = '音声を有効にしてから再生してください'; }
    });
    $('calendar-checkin-btn')?.addEventListener('click', () => CalendarController.checkIn());
    $('calendar-code-play')?.addEventListener('click', () => {
      const button = $('calendar-code-play');
      if (button.disabled) return;
      const notes = CheckinManager.getCode(state.currentProfileId).notes;
      if (!AudioSystem.ctx) { $('calendar-checkin-status').textContent = '音声を有効にしてから再生してください'; return; }
      button.disabled = true; AudioSystem.resume(); AudioSystem.playChord(notes, 1.2);
      setTimeout(() => { button.disabled = false; }, 1200);
    });

    $('session-play-btn')?.addEventListener('click', () => {
      AudioSystem.resume();
      SessionController.playQuestion();
    });
    $('answer-next-btn')?.addEventListener('click', () => SessionController.advanceAfterIncorrect());
    $('effects-skip-btn')?.addEventListener('click', () => { EffectsManager.skip(); });
    $('session-clear-btn')?.addEventListener('click', () => { SessionController.clearSelection(); });
    $('session-undo-btn')?.addEventListener('click', () => { SessionController.undoSelection(); });
    $('session-submit-btn')?.addEventListener('click', () => { SessionController.submitAnswer(); });
    $('session-selected-notes')?.addEventListener('click', (e) => { const b=e.target.closest('[data-remove-note]'); if(!b)return; const n=Number(b.dataset.removeNote); state.selectedNotes=state.selectedNotes.filter(x=>x!==n); if(state.currentQuestion?.selectedOrder)state.currentQuestion.selectedOrder=state.currentQuestion.selectedOrder.filter(x=>x!==n); SessionController.renderSelection();SessionController.persistDraft(); });
    $('session-interval-choices')?.addEventListener('click',(e)=>{const b=e.target.closest('[data-interval]');if(b)SessionController.chooseInterval(b.dataset.interval);});

    // オクターブ移動
    $('piano-octave-down')?.addEventListener('click', () => {
      PianoKeyboard.shiftOctave(-1);
    });
    $('piano-octave-up')?.addEventListener('click', () => {
      PianoKeyboard.shiftOctave(1);
    });
    $('error-dismiss')?.addEventListener('click', () => { $('error-notification').hidden = true; });

    $('settings-profile-btn')?.addEventListener('click', () => { Screens.show('profile'); });
    $('settings-data-management')?.addEventListener('click', () => { Screens.show('data-management'); });
    $('settings-midi-btn')?.addEventListener('click', () => { Screens.show('midi-test'); });
    // MIDI設定トグル

  // 成績分析フィルター
  var pf=$('analytics-period-filter');
  if(pf){
    pf.addEventListener('click', function(e) {
      var btn=e.target.closest('.choice-btn');
      if(!btn||!btn.dataset.filter)return;
      AnalyticsController.show(btn.dataset.filter);
    });
  }    $('settings-midi-enabled')?.addEventListener('change', (e) => {
      SettingsController.applySetting('midiEnabled', e.target.checked);
      const details = $('settings-midi-details');
      if (details) details.hidden = !e.target.checked;
      if (e.target.checked && MIDIManager.isApiAvailable() && !state.midiAccessGranted) {
        MIDIManager.requestAccess().then(() => {
          SettingsController.loadSettings();
        });
      } else if (!e.target.checked) {
        MIDIManager.stop();
      }
    });
    $('settings-midi-screen-keys')?.addEventListener('change', (e) => {
      SettingsController.applySetting('midiScreenKeyboardEnabled', e.target.checked);
    });
    $('settings-midi-sustain')?.addEventListener('change', (e) => {
      SettingsController.applySetting('midiSustainAffectsAnswer', e.target.checked);
    });
    document.querySelectorAll('#settings-midi-confirm-mode .choice-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#settings-midi-confirm-mode .choice-btn').forEach(b => b.classList.remove('choice-active'));
        btn.classList.add('choice-active');
        SettingsController.applySetting('midiConfirmationMode', btn.dataset.value);
        const autoDelayRow = $('settings-midi-auto-delay-row');
        if (autoDelayRow) autoDelayRow.hidden = btn.dataset.value !== 'auto';
      });
    });
    document.querySelectorAll('#settings-midi-auto-delay .choice-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#settings-midi-auto-delay .choice-btn').forEach(b => b.classList.remove('choice-active'));
        btn.classList.add('choice-active');
        SettingsController.applySetting('midiAutoConfirmDelayMs', parseInt(btn.dataset.value));
      });
    });
    document.querySelectorAll('#settings-midi-octave .choice-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#settings-midi-octave .choice-btn').forEach(b => b.classList.remove('choice-active'));
        btn.classList.add('choice-active');
        SettingsController.applySetting('midiOctaveOffset', parseInt(btn.dataset.value));
      });
    });
    $('settings-midi-device-select')?.addEventListener('change', (e) => {
      if (e.target.value) {
        MIDIManager.selectInput(e.target.value);
        SettingsController.loadSettings();
      }
    });
    $('settings-midi-rescan')?.addEventListener('click', async () => {
      if (MIDIManager.isApiAvailable()) {
        await MIDIManager.rescan();
        SettingsController.loadSettings();
        showError('MIDI機器を再検出しました');
      }
    });
    $('midi-scan-btn')?.addEventListener('click', () => MidiTestController.show());
    
    

    $('settings-pool-reset')?.addEventListener('click', async () => {
      if (!await confirmDialog('現在のプロフィール・設定の出題履歴をリセットしますか？\nこの操作は現在のサイクルのみに影響します。')) return;
      await QuestionPoolManager.resetCurrent();
      SettingsController.updatePoolInfo();
    });

    $('settings-backup')?.addEventListener('click', async () => {
      try {
        const data={exportedAt:new Date().toISOString(),version:6,profileId:state.currentProfileId};
        const stores=['profiles','sessions','checkins','questionPools','problemPools','heatmapData','reviewData'];
        for(const store of stores){
          try{data[store]=await Storage.getAll(store);}catch(e){data[store]=[];}
        }
        try{data.localStorage={};for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k&&k.startsWith('pe_'))data.localStorage[k]=localStorage.getItem(k);}}catch(e){}
        const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
        const url=URL.createObjectURL(blob);
        const a=document.createElement('a');a.href=url;a.download='piano_ear_backup_'+Date.now()+'.json';a.click();
        URL.revokeObjectURL(url);
        showError('バックアップをダウンロードしました');
      } catch(e){ showError('バックアップに失敗しました'); console.warn(e); }
    });
    $('settings-restore')?.addEventListener('click', () => {
      const input=document.createElement('input');
      input.type='file';input.accept='.json,application/json';
      input.onchange=async (e)=>{
        const file=e.target.files[0];
        if(!file)return;
        try {
          const text=await file.text();
          const data=JSON.parse(text);
          if(!data.version||!data.profiles){showError('無効なバックアップファイルです');return;}
          if(data.profiles&&Array.isArray(data.profiles)){for(const p of data.profiles)if(p&&p.id)await Storage.put('profiles',p);}
          if(data.sessions&&Array.isArray(data.sessions)){for(const s of data.sessions)if(s&&s.sessionId)await Storage.put('sessions',s);}
          if(data.questionPools&&Array.isArray(data.questionPools)){for(const p of data.questionPools)if(p&&p.id)await Storage.put('questionPools',p);}
          showError('データを復元しました。ページを再読み込みします。');
          setTimeout(()=>location.reload(),1500);
        } catch(e){ showError('復元に失敗しました: ファイル形式が正しくありません'); console.warn(e); }
      };
      input.click();
    });
    $('settings-reset')?.addEventListener('click', async () => {
      if (!await confirmDialog('すべてのデータを削除します。\nこの操作は元に戻せません。\n\nよろしいですか？')) return;
      if (!await confirmDialog('本当にすべてのデータを削除しますか？\n設定、履歴、プロフィールがすべて削除されます。')) return;
      localStorage.clear();
      if (state.db) { for (const s of ['profiles','sessions','checkins','problemPools','heatmapData','reviewData']) await Storage.clear(s); }
      location.reload();
    });

    $('profile-add-btn')?.addEventListener('click', () => ProfileController.showCreateForm());
    $('profile-create-cancel')?.addEventListener('click', () => ProfileController.hideCreateForm());
    $('profile-create-confirm')?.addEventListener('click', async () => { const i=$('profile-name-input'); if(i) await ProfileController.create(i.value); });
    $('profile-name-input')?.addEventListener('keydown', (e) => { if(e.key==='Enter'){e.preventDefault();$('profile-create-confirm')?.click();} if(e.key==='Escape') ProfileController.hideCreateForm(); });

    document.addEventListener('click', (e) => {
      const item = e.target.closest('.profile-item');
      if (item && item.dataset.profileId && !e.target.closest('.profile-action-btn') && !e.target.closest('.profile-rename-form')) {
        if (item.dataset.profileId !== state.currentProfileId) ProfileController.switchTo(item.dataset.profileId);
        return;
      }
      const btn = e.target.closest('.profile-action-btn');
      if (!btn || !btn.dataset.action) return;
      const pid = btn.dataset.profileId, act = btn.dataset.action;
      if (act === 'rename') ProfileController.showRenameForm(pid);
      else if (act === 'delete') ProfileController.delete(pid);
      else if (act === 'rename-confirm') { const f=btn.closest('.profile-rename-form'); const i=f?.querySelector('.profile-rename-input'); if(i) ProfileController.confirmRename(pid, i.value); }
      else if (act === 'rename-cancel') ProfileController.renderList();
    });

    $('result-review-btn')?.addEventListener('click', () => ResultController.startIncorrectRetry());
    $('result-home-btn')?.addEventListener('click', () => Screens.show('home'));
    $('result-retry-btn')?.addEventListener('click', () => Screens.show('mode-select'));
    document.addEventListener('click', (e) => {
      if (e.target.closest('#result-analytics-btn')) Screens.show('analytics');
    });
    $('settings-sfx-enabled')?.addEventListener('change', (e) => {
      SettingsController.applySetting('sfxEnabled', e.target.checked);
    });

    $('piano-source-retry')?.addEventListener('click', async () => {
      if (AudioSystem.pianoState === 'loading') return;
      const button = $('piano-source-retry'); if (button) button.disabled = true;
      await AudioSystem.preparePianoSamples({ force: true });
      state.audioReady = AudioSystem.pianoState === 'ready';
      AudioSystem.updatePianoStatusUI();
      if (button) button.disabled = false;
    });

    DataManagementController.mount();
    $('home-continue')?.addEventListener('click', async () => {
      const s = await SessionManager.loadIncomplete();
      if (s) {
        Screens.show('session', {
          mode: s.mode,
          difficulty: s.difficulty,
          questionCount: s.questionCount,
          resumeSession: true
        });
      }
    });

    document.addEventListener('keydown', (e) => {
      // フォーム入力中は無視
      if (['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName) || e.target.isContentEditable) return;
      if (document.querySelector('.dialog-overlay:not([hidden])')) return;

      // プロフィール名変更フォーム
      const ri = e.target.closest('.profile-rename-input');
      if (ri) {
        if (e.key==='Enter') { e.preventDefault(); const f=ri.closest('.profile-rename-form'); const b=f?.querySelector('[data-action="rename-confirm"]'); if(b)b.click(); }
        if (e.key==='Escape') { e.preventDefault(); const f=ri.closest('.profile-rename-form'); const b=f?.querySelector('[data-action="rename-cancel"]'); if(b)b.click(); }
        return;
      }

      // 物理キーボードによるピアノ演奏（セッション画面のみ）
      if (state.currentScreen === 'session' && !SessionController._inputLocked) {
        if(e.key==='Enter' && !$('session-submit-btn')?.disabled){e.preventDefault();SessionController.submitAnswer();return;}
        if(e.key==='Backspace'){e.preventDefault();const q2=state.currentQuestion,cm2=state.currentSession?.mode;if(CM(cm2)&&!state.selectedNotes.length&&q2){if(CM_NAME(cm2)||CM_INV(cm2)){if(q2.selectedInversionId){q2.selectedInversionId=null;}else if(q2.selectedChordType){q2.selectedChordType=null;}else if(q2.selectedRootPitchClass!==null){q2.selectedRootPitchClass=null;}document.querySelectorAll('.chord-root-btn,.chord-type-btn,.inversion-btn').forEach(b=>b.classList.remove('choice-active'));SessionManager.saveCurrentQuestion();}}else{SessionController.undoSelection();}SessionController._updateChordSubmitBtn();return;}
        if(e.key==='Escape'){e.preventDefault();const q3=state.currentQuestion,cm3=state.currentSession?.mode;if(CM(cm3)&&q3){q3.selectedRootPitchClass=null;q3.selectedChordType=null;q3.selectedInversionId=null;document.querySelectorAll('.chord-root-btn,.chord-type-btn,.inversion-btn').forEach(b=>b.classList.remove('choice-active'));SessionManager.saveCurrentQuestion();}SessionController.clearSelection();return;}
        const note = PianoKeyboard.handleKeyboardNote(e.key.toLowerCase());
        if (note !== null) {
          e.preventDefault();
          AudioSystem.resume();
          PianoKeyboard.flashKey(note, 'selected', 200);
          if (typeof PianoKeyboard._onNoteDown === 'function') {
            PianoKeyboard._onNoteDown(note);
          }
        }
      }
    });
    document.addEventListener('keyup', (e) => {
      if (state.currentScreen !== 'session') return;
      const note = PianoKeyboard.handleKeyboardNote(e.key.toLowerCase());
      if (note !== null) AudioSystem.stopPianoNote(note);
    });

    // タブ可視性変更 → AudioContext再開
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        AudioSystem.resume();
      } else {
        // タブ非表示中もBGMは継続（ユーザー体験重視）
      }
    });
  }

  // ========================================
  // 音声有効化処理
  // ========================================

  async function handleAudioInit() {
    if (handleAudioInit._running) return handleAudioInit._running;
    handleAudioInit._running = (async () => {
    const navigationAtStart = state.navigationRevision;
    console.log('[App] 音声初期化開始');
    const overlay = $('audio-overlay'), app = $('app');
    const initButton = $('audio-init-btn'); if (initButton) initButton.disabled = true;
    const initialized = AudioSystem.init();
    if (initialized) AudioSystem.resume();

    try {
      const profiles = await Storage.getAll('profiles');
      state.profiles = {};
      if (profiles && profiles.length > 0) {
        profiles.forEach(p => { if (p && p.id) state.profiles[p.id] = p; });
      }

      if (!state.profiles.default) {
        state.profiles.default = { ...DEFAULT_PROFILE, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        await Storage.put('profiles', state.profiles.default);
      }

      // BGMの既定値を50%へ移行（ユーザーが明示的に設定した他の値は保持）。
      for (const profile of Object.values(state.profiles)) {
        const legacyBgmVolume = profile?.settings?.bgmVolume;
        if (legacyBgmVolume === 0.3 || legacyBgmVolume === 0.4) {
          profile.settings = { ...profile.settings, bgmVolume: DEFAULT_SETTINGS.bgmVolume };
          await Storage.put('profiles', profile);
        }

        // セッション既定問題数を10問から5問へ移行する。既にこの移行を
        // 済ませたプロフィールで、ユーザーが後から10問を選んだ場合は保持する。
        const legacyQuestionCount = profile?.settings?.questionCount;
        if (legacyQuestionCount === 10 && profile?.settings?.questionCountDefaultVersion !== 2) {
          profile.settings = { ...profile.settings, questionCount: DEFAULT_SETTINGS.questionCount, questionCountDefaultVersion: 2 };
          await Storage.put('profiles', profile);
        }
      }

      const savedProfileId = LocalCache.load('currentProfileId', 'default');
      const targetProfile = state.profiles[savedProfileId] || state.profiles.default;
      state.currentProfileId = targetProfile.id;
      state.settings = { ...DEFAULT_SETTINGS, ...(targetProfile.settings || {}) };

      const cachedTheme = LocalCache.load('theme', null);
      if (cachedTheme && !targetProfile.settings?.theme) state.settings.theme = cachedTheme;
      ProfileManager.applyTheme();
      AudioSystem.applyVolumes();
      ProfileManager.updateUI();
    } catch (e) {
      console.warn('[App] プロフィール読み込みエラー:', e);
      // デフォルト設定で続行
      state.currentProfileId = 'default';
      state.settings = { ...DEFAULT_SETTINGS };
      ProfileManager.applyTheme();
      AudioSystem.applyVolumes();
    }

    if (!initialized) {
      AudioSystem.pianoState = 'error';
      state.pianoSourceState = 'error';
      AudioSystem.pianoDiagnostics = [{ name: 'AudioContext', httpStatus: null, decoded: false, decodeError: 'AudioContextの初期化に失敗しました' }];
    } else {
      await AudioSystem.preparePianoSamples();
    }
    state.audioReady = AudioSystem.pianoState === 'ready';
    if (state.audioReady) LocalCache.save('audioEnabled', true);

    // 非同期初期化が画面遷移を上書きしないよう、操作可能にするのは完了後だけにする。
    if (overlay) overlay.hidden = true;
    if (app) app.hidden = false;
    AudioSystem.updatePianoStatusUI();
    if (state.navigationRevision === navigationAtStart) Screens.show('home');
    await CalendarController.autoCheckInOnFirstLaunch();
    if (!state.audioReady) showError('ピアノ音源を読み込めませんでした。ホームから再読み込みしてください。');
    if (initButton) initButton.disabled = false;
    console.log('[App] 音声初期化完了', AudioSystem.pianoState);
    })();
    try { return await handleAudioInit._running; } finally { handleAudioInit._running = null; }
  }

  function loadChordStage6DebugRunner() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('debugChordStage6Test') !== '1') return;
    if (document.querySelector('script[data-chord-stage6-runner]')) return;
    const script = document.createElement('script');
    script.src = './chord-stage6-debug-runner.js?v=chord-stage6-syntax-recovery-001';
    script.dataset.chordStage6Runner = '1';
    script.defer = true;
    document.head.appendChild(script);
  }

  async function init() {
    console.log('[App] ピアノ音当てゲーム v1.0.0');
    await Storage.open();
    setupEventListeners();
    AtomicStorageDebugRunner.mount();
    const cachedTheme = LocalCache.load('theme', 'cream');
    state.settings.theme = cachedTheme;
    document.documentElement.setAttribute('data-theme', cachedTheme);

    const audioEnabled = LocalCache.load('audioEnabled', false);
    if (audioEnabled) await handleAudioInit();
    state.initialized = true;
    loadChordStage6DebugRunner();
    console.log('[App] 初期化完了');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  if (new URLSearchParams(location.search).get('debugAtomicTest') === '1') {
    window.__pianoTestExports = { matchNoteSets, INTERVAL_DEFINITIONS, QuestionCatalog };
  }

  if (new URLSearchParams(location.search).get('debugChordStage6Test') === '1') {
    window.__ChordStage6DebugBridge = Object.freeze({
      getStateSnapshot: () => structuredClone({
        currentScreen: state.currentScreen,
        currentProfileId: state.currentProfileId,
        settings: state.settings,
        currentSession: state.currentSession,
        currentQuestion: state.currentQuestion,
        selectedNotes: state.selectedNotes
      }),
      chordDefinitions: structuredClone(CHORD_DEFINITIONS),
      inversionDefinitions: structuredClone(INVERSION_DEFINITIONS),
      generateChordVoicing,
      matchPitchClassMultisets,
      matchNoteSets,
      getQuestionCandidates: (mode, start, end, includeBlack) => QuestionCatalog.getCandidates(mode, start, end, includeBlack),
      getQuestionId: (candidate) => QuestionCatalog.getQuestionId(candidate),
      getPoolSignature: (mode, difficulty, start, end, includeBlack) => QuestionCatalog.getPoolSignature(mode, difficulty, start, end, includeBlack)
    });
  }

  if (new URLSearchParams(location.search).get('debugStage9Effects') === '1') {
    window.__Stage9EffectsDebug = Object.freeze({
      getSnapshot: () => EffectsManager.getSnapshot(),
      skip: () => EffectsManager.skip()
    });
  }

  if (new URLSearchParams(location.search).get('postV1AudioTest') === '1') {
    window.__PostV1AudioDebug = Object.freeze({
      getSnapshot: () => ({
        state: AudioSystem.pianoState,
        audioContextState: AudioSystem.ctx?.state || 'uninitialized',
        requiredSamples: AudioSystem.pianoManifest.length,
        decodedSamples: AudioSystem.pianoDiagnostics.filter(item => item.decoded).length,
        failedSamples: AudioSystem.pianoDiagnostics.filter(item => !item.decoded).length,
        cacheCount: AudioSystem.pianoManifest.filter(item => Boolean(AudioSystem.cachedBuffers[item.url])).length,
        readyTimeMs: AudioSystem.pianoReadyAt && AudioSystem.pianoLoadStartedAt ? Math.round(AudioSystem.pianoReadyAt - AudioSystem.pianoLoadStartedAt) : null,
        diagnostics: AudioSystem.pianoDiagnostics.map(item => ({ ...item })),
        stats: { ...AudioSystem.pianoStats },
        activePianoNotes: [...AudioSystem.activePianoSources.keys()],
        bgm: { ...AudioSystem.sessionBgm, playing: state.bgmPlaying, url: AudioSystem.bgmUrl },
        midi: { connected: state.midiConnected, activeNotes: [...state.midiActiveNotes.keys()], lastVelocity: state.midiLastVelocity },
        currentScreen: state.currentScreen
      }),
      prepare: (force = false) => AudioSystem.preparePianoSamples({ force }),
      play: (midi, duration = 0.8, velocity = 96) => AudioSystem.playPianoSample(midi, { duration, velocity }),
      chord: (notes, duration = 1, velocity = 96) => AudioSystem.playChord(notes, duration, velocity),
      stop: midi => AudioSystem.stopPianoNote(midi),
      beginSessionAudio: () => AudioSystem.beginSessionAudio(),
      endSessionAudio: () => AudioSystem.endSessionAudio(),
      stopBgm: () => AudioSystem.stopBGM()
      ,sfx: kind => AudioSystem.playSfxTone(kind)
      ,midiMessage: data => MIDIManager._handleMessage({ data: Array.from(data) })
    });
  }

  return {
    state, Audio: AudioSystem, MIDIManager, Storage, LocalCache,
    Screens, showError, confirmDialog, midiToNoteName,
    ProfileManager, SettingsController, ProfileController, CheckinManager,
    SessionManager, SessionController, QuestionCatalog, QuestionPoolManager
  };
})();
