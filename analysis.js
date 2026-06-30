/* ════════════════════════════════════════════════════════════════════════
   BuildingMind AI — Anomaly Analysis Engine
   ────────────────────────────────────────────────────────────────────────
   Браузерный движок анализа аномалий (пока без реальных датчиков).

   Поток данных:
     systems (data.json)
       → generateSeries()   синтетическая телеметрия: норма + шум + аномалия
       → detect()           baseline (μ,σ) + z-score / дисперсия / пропажа
       → prioritize()       severity × длительность × критичность → score
       → problem objects     то, что показывает UI

   Метод детекции — статистический baseline + z-score (см. detect()).
   Генератор детерминированный (seed от id системы) — числа стабильны
   между перезагрузками, но являются результатом реального измерения ряда.
   ════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  // ── Параметры дискретизации ───────────────────────────────────────────
  const POINTS = 72;          // всего отсчётов в ряду
  const INTERVAL_MIN = 5;     // минут между отсчётами  (72 × 5 = 6 часов)

  // ── Веса приоритизации (прозрачная формула) ───────────────────────────
  const W_SEVERITY    = 0.5;  // насколько сильно отклонение
  const W_DURATION    = 0.2;  // как долго длится
  const W_CRITICALITY = 0.3;  // важность самой системы

  // ── Пороги уровней приоритета (по score 0..100) ───────────────────────
  const THRESHOLD_HIGH   = 65;
  const THRESHOLD_MEDIUM = 42;

  // ── Нормировка severity по типам аномалий ─────────────────────────────
  const Z_SCALE        = 10;  // |z| / Z_SCALE → severity (level)
  const RATIO_SCALE    = 15;  // (ratio-1) / RATIO_SCALE → severity (oscillation)
  const MISSING_SCALE  = 240; // minutes / MISSING_SCALE → severity (missing)

  // ════════════════════════════════════════════════════════════════════
  //  Утилиты
  // ════════════════════════════════════════════════════════════════════
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function seedFromString(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function gaussian(rng) {
    let u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const mean  = arr => arr.reduce((s, x) => s + x, 0) / (arr.length || 1);
  const std   = (arr, m) => {
    if (arr.length < 2) return 0;
    const mu = (m === undefined) ? mean(arr) : m;
    return Math.sqrt(arr.reduce((s, x) => s + (x - mu) ** 2, 0) / (arr.length - 1));
  };

  // ════════════════════════════════════════════════════════════════════
  //  1. Генерация телеметрии
  // ════════════════════════════════════════════════════════════════════
  function generateSeries(sys) {
    const rng = mulberry32(seedFromString(sys.id));
    const now = Date.now();
    const inj = sys.inject || {};
    const anomalyPoints = inj.duration_min ? Math.round(inj.duration_min / INTERVAL_MIN) : 0;
    const startIdx = POINTS - anomalyPoints;
    const series = [];

    for (let i = 0; i < POINTS; i++) {
      const t = now - (POINTS - 1 - i) * INTERVAL_MIN * 60 * 1000;
      const wave = Math.sin((i / POINTS) * Math.PI * 2) * (sys.daily_amp || 0);
      let value = sys.baseline + wave + gaussian(rng) * (sys.normal_std || 1);

      if (anomalyPoints > 0 && i >= startIdx) {
        const p = (i - startIdx) / Math.max(anomalyPoints - 1, 1); // прогресс 0..1
        switch (inj.type) {
          case 'drift': {                      // плавный дрейф: разгон, затем плато
            const ramp = Math.min(p / 0.4, 1);
            value += inj.delta * ramp;
            break;
          }
          case 'level_shift':                  // резкий сдвиг уровня
            value += inj.delta;
            break;
          case 'oscillation': {                // раскачка амплитуды
            const amp = sys.baseline * (inj.amplitude_pct / 100);
            value += Math.sin(i * 1.7) * amp + gaussian(rng) * amp * 0.3;
            break;
          }
          case 'missing':                      // пропажа данных
            value = null;
            break;
        }
      }
      series.push({ t, v: value === null ? null : Math.round(value * 100) / 100 });
    }
    return series;
  }

  // ════════════════════════════════════════════════════════════════════
  //  2. Детекция аномалий
  // ════════════════════════════════════════════════════════════════════
  function detect(sys, series) {
    const inj = sys.inject || {};
    const recentCount = Math.max(Math.round((inj.duration_min || 30) / INTERVAL_MIN), 4);

    // Чистое (референсное) окно = всё до аномалии
    const cleanCount = Math.max(POINTS - recentCount - 1, 6);
    const cleanVals  = series.slice(0, cleanCount).filter(p => p.v !== null).map(p => p.v);
    const baseMean   = mean(cleanVals);
    const baseStd    = Math.max(std(cleanVals, baseMean), 1e-6);

    const recent     = series.slice(POINTS - recentCount);
    const recentVals = recent.filter(p => p.v !== null).map(p => p.v);

    const result = {
      systemId:   sys.id,
      mode:       sys.metric_mode,
      baseline:   baseMean,
      std:        baseStd,
      series,
      recentCount,
      durationMin: inj.duration_min || 0
    };

    switch (sys.metric_mode) {
      case 'missing': {
        let lastValidIdx = -1;
        for (let i = series.length - 1; i >= 0; i--) {
          if (series[i].v !== null) { lastValidIdx = i; break; }
        }
        const minutesMissing = (series.length - 1 - lastValidIdx) * INTERVAL_MIN + INTERVAL_MIN;
        result.kind           = 'missing';
        result.minutesMissing = minutesMissing;
        result.durationMin    = minutesMissing;
        result.severity       = clamp(minutesMissing / MISSING_SCALE, 0, 1);
        result.z              = null;
        break;
      }
      case 'oscillation': {
        const rMean = mean(recentVals);
        const rStd  = std(recentVals, rMean);
        const ratio = rStd / baseStd;
        const amp   = (Math.max(...recentVals) - Math.min(...recentVals)) / 2;
        result.kind          = 'oscillation';
        result.current       = rMean;
        result.amplitudePct  = (amp / baseMean) * 100;
        result.varianceRatio = ratio;
        result.severity      = clamp((ratio - 1) / RATIO_SCALE, 0, 1);
        result.z             = ratio;
        break;
      }
      default: {  // level: percent / absolute_delta / absolute_value
        // «текущее значение» = последние отсчёты (плато), а не всё окно,
        // чтобы отразить установившееся состояние, а не разгон дрейфа
        const tail      = recentVals.slice(-Math.min(6, recentVals.length));
        const cur       = mean(tail.length ? tail : recentVals);
        const deviation = cur - baseMean;
        const z         = deviation / baseStd;
        result.kind      = 'level';
        result.current   = cur;
        result.deviation = deviation;
        result.z         = z;
        result.severity  = clamp(Math.abs(z) / Z_SCALE, 0, 1);
      }
    }
    return result;
  }

  // ════════════════════════════════════════════════════════════════════
  //  3. Приоритизация
  // ════════════════════════════════════════════════════════════════════
  function prioritize(sys, det) {
    const durNorm = clamp(det.durationMin / 240, 0, 1);
    const score = 100 * (
      W_SEVERITY    * det.severity +
      W_DURATION    * durNorm +
      W_CRITICALITY * sys.criticality
    );
    const rounded = Math.round(score);
    const level = rounded >= THRESHOLD_HIGH ? 'high'
                : rounded >= THRESHOLD_MEDIUM ? 'medium'
                : 'low';
    return { score: rounded, level };
  }

  // ════════════════════════════════════════════════════════════════════
  //  4. Форматирование метрики (из измеренных значений)
  // ════════════════════════════════════════════════════════════════════
  function fmtNum(x, digits) {
    const r = Number(x.toFixed(digits));
    return Number.isInteger(r) ? String(r) : r.toFixed(digits).replace(/\.?0+$/, '');
  }
  function formatMetric(sys, det) {
    switch (sys.metric_mode) {
      case 'percent': {
        const pct = (det.deviation / det.baseline) * 100;
        return (pct >= 0 ? '+' : '−') + Math.round(Math.abs(pct)) + '%';
      }
      case 'absolute_delta': {
        const sign = det.deviation >= 0 ? '+' : '−';
        return sign + fmtNum(Math.abs(det.deviation), 1) + ' ' + sys.unit;
      }
      case 'absolute_value':
        return Math.round(det.current) + sys.unit;
      case 'oscillation':
        return '±' + Math.round(det.amplitudePct) + '%';
      case 'missing':
        return (Math.floor(det.minutesMissing / 10) * 10) + '+ мин';
      default:
        return '';
    }
  }

  // ════════════════════════════════════════════════════════════════════
  //  Сборка: systems → problems
  // ════════════════════════════════════════════════════════════════════
  function run(systems) {
    return systems.map(sys => {
      const series = generateSeries(sys);
      const det    = detect(sys, series);
      const prio   = prioritize(sys, det);
      const info   = sys.interpretation;

      return {
        id:                 sys.id,
        system_name:        sys.system_name,
        description:        info.description,
        priority:           prio.level,
        priority_score:     prio.score,
        detected_minutes_ago: Math.round(det.durationMin),
        metric:             formatMetric(sys, det),
        metric_label:       sys.metric_label,
        why:                info.why,
        cause:              info.cause,
        cause_probability:  info.cause_probability,
        consequences:       info.consequences,
        steps:              info.steps,
        // ── данные анализа для UI «как обнаружено» ──
        analysis: {
          kind:          det.kind,
          metric_name:   sys.metric_name,
          unit:          sys.unit,
          baseline:      det.baseline,
          current:       det.current,
          deviation:     det.deviation,
          z:             det.z,
          severity:      det.severity,
          durationMin:   det.durationMin,
          amplitudePct:  det.amplitudePct,
          varianceRatio: det.varianceRatio,
          minutesMissing: det.minutesMissing,
          series:        det.series,
          recentCount:   det.recentCount
        }
      };
    }).sort((a, b) => b.priority_score - a.priority_score);
  }

  global.BuildingMindAnalysis = { run, generateSeries, detect, prioritize, formatMetric };
})(window);
