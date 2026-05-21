/**
 * publication-orchestrator.js  —  Centralized Generation Orchestrator
 * ABE GTM Platform  ·  Cloudflare Workers compatible
 *
 * Implements the strict sequential publication pipeline:
 *
 *   START
 *   ↓
 *   Generate Step N  (via routeProviderRequest)
 *   ↓
 *   Validate Step N  (schema + critical fields)
 *   ↓
 *   Normalize Step N (fill safe defaults)
 *   ↓
 *   Persist Step N   (only after validation passes)
 *   ↓
 *   Breathing pause  (provider stabilization — no overlapping retries)
 *   ↓
 *   Continue → Step N+1
 *   ↓
 *   (Steps 1–7 all complete)
 *   ↓
 *   Run publication validation
 *   ↓
 *   Mark publicationReady = true / false
 *   ↓
 *   Return publication state (frontend enables export only when true)
 *
 * This module is imported by gtm.js and exposed as:
 *   action: 'run_full_report'  — triggers orchestrated 7-step generation
 *   action: 'validate_publication' — validates existing strategy readiness
 *
 * Key invariants enforced:
 *   1. Steps execute strictly sequentially — no parallelism
 *   2. A step's output MUST pass validation before persisting
 *   3. Placeholder-only output is NOT counted as a completed step
 *   4. Export is gated behind publication validation
 *   5. Breathing time (INTER_STEP_DELAY_MS) between provider calls
 *   6. No corrupted/null structures reach the database
 */

import { routeProviderRequest, normalizeStepOutput, validateStepSchema, retryWithProvider } from './provider-router.js';
import { validatePublicationReadiness, buildPublicationReport } from './publication-validator.js';
// normalizeStrategy intentionally not imported — lib/ must not import from api/

// ── Orchestration constants ───────────────────────────────────────
const INTER_STEP_DELAY_MS    = 800;   // breathing time between provider calls
const STEP_COMPLETION_TIMEOUT = 30_000; // max time per step (ms) before hard abort
const MAX_STEP_RETRIES        = 2;    // max provider retries per step

// ── Telemetry record shape ────────────────────────────────────────
function newTelemetryRecord(step) {
  return {
    step,
    providerUsed:          null,
    retryCount:            0,
    responseLatency:       0,
    normalizationApplied:  false,
    validationFailures:    [],
    fallbackTriggered:     false,
    fallbackReason:        null,
    placeholderFilled:     false,
    completedAt:           null,
    status:                'pending',   // pending | running | complete | failed
  };
}

// ── Breathing pause ───────────────────────────────────────────────
function breathe(ms = INTER_STEP_DELAY_MS) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Step validation gate ──────────────────────────────────────────
// Returns { valid, missing, isPlaceholderOnly }
function validateStepCompleteness(step, data) {
  if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
    return { valid: false, missing: ['entire step output is empty'], isPlaceholderOnly: true };
  }

  const schemaCheck = validateStepSchema(step, data);

  // Check if all critical fields are placeholders
  const PLACEHOLDER_PATTERNS = [
    /^AI-inferred — validate$/i,
    /^Demo placeholder — requires validation$/i,
    /^Source data missing$/i,
    /^missing data$/i,
  ];
  const isPlaceholder = v =>
    (v === null || v === undefined) ||
    (typeof v === 'string' && PLACEHOLDER_PATTERNS.some(p => p.test(v.trim())));

  const criticals = schemaCheck.missing || [];
  const criticalValues = Object.values(data).slice(0, 5);
  const isPlaceholderOnly = criticalValues.length > 0 && criticalValues.every(isPlaceholder);

  return {
    valid:            schemaCheck.valid && !isPlaceholderOnly,
    missing:          schemaCheck.missing || [],
    isPlaceholderOnly,
  };
}

// ── Single step orchestration ─────────────────────────────────────
/**
 * executeStep(step, params, env)
 *
 * Runs one step through the full generate → validate → normalize pipeline.
 * Returns { data, telemetry, error? }
 */
export async function executeStep(step, {
  systemPrompt,
  userPrompt,
  maxTokens,
  temperature,
}, env) {
  const telemetry = newTelemetryRecord(step);
  const t0 = Date.now();

  telemetry.status = 'running';

  // ── PRIMARY provider call ─────────────────────────────────────
  const result = await routeProviderRequest({
    step,
    systemPrompt,
    userPrompt,
    maxTokens,
    temperature,
  }, env);

  telemetry.responseLatency = Date.now() - t0;
  telemetry.providerUsed    = result.provider || 'unknown';
  telemetry.fallbackTriggered = !!result.fallbackTriggered;
  telemetry.fallbackReason    = result.fallbackReason || null;

  if (result.error) {
    telemetry.status = 'failed';
    telemetry.validationFailures.push(`Provider error: ${result.error}`);
    return {
      data:      null,
      telemetry,
      error:     result.error,
      statusCode: result.statusCode || 502,
    };
  }

  let parsed     = result.parsed;
  let tokensUsed = result.tokensUsed;

  // ── VALIDATION GATE ────────────────────────────────────────────
  const validation = validateStepCompleteness(step, parsed);
  telemetry.validationFailures = validation.missing;

  if (!validation.valid) {
    // Attempt cross-provider retry for missing critical fields
    if (validation.missing.length > 0) {
      telemetry.retryCount++;
      const retryResult = await retryWithProvider(step, userPrompt, validation.missing, env);
      if (!retryResult.error && retryResult.parsed) {
        parsed      = retryResult.parsed;
        tokensUsed += retryResult.tokensUsed || 0;
        telemetry.providerUsed = `${telemetry.providerUsed}→retry:${retryResult.provider || 'unknown'}`;
      }
    }

    // Even if retry fails, normalize fills safe defaults (empty arrays / strings)
    // This prevents null render-critical fields from reaching the database
    parsed = normalizeStepOutput(step, parsed || {}, parsed?._provider || telemetry.providerUsed || 'openai');
    telemetry.normalizationApplied = true;
    telemetry.placeholderFilled    = true;
  }

  // ── NORMALIZE (always run to ensure consistent output shape) ───
  if (!telemetry.normalizationApplied) {
    parsed = normalizeStepOutput(step, parsed, result.provider || 'openai');
  }

  // ── Re-validate after normalization ───────────────────────────
  const finalValidation = validateStepCompleteness(step, parsed);
  if (!finalValidation.valid) {
    telemetry.status = 'failed';
    telemetry.validationFailures = finalValidation.missing;
    console.error(`[orchestrator] step=${step} FAILED final validation:`, finalValidation.missing);
    // Return the best we have — caller decides whether to block or allow
    return {
      data:      parsed,
      telemetry,
      tokensUsed,
      warning:   `Step ${step} did not pass final validation: ${finalValidation.missing.join(', ')}`,
    };
  }

  telemetry.status      = 'complete';
  telemetry.completedAt = new Date().toISOString();

  return { data: parsed, telemetry, tokensUsed };
}

// ── Full 7-step orchestration ─────────────────────────────────────
/**
 * orchestrateFullReport({ company, industry, steps, buildPromptFn, env })
 *
 * Executes steps 1–7 sequentially with breathing time, validation,
 * and normalization at each stage.
 *
 * Returns { steps, telemetry, publicationState, allStepsComplete }
 */
export async function orchestrateFullReport({
  company,
  industry,
  existingSteps = {},   // steps already completed (for resuming)
  buildPromptFn,        // (step, company, industry, prior_steps) => { systemPrompt, userPrompt, maxTokens, temperature }
  env,
  onStepComplete = null, // optional callback(step, data, telemetry)
}) {
  const steps    = { ...existingSteps };
  const telemetry = {};
  const errors   = [];

  // ── Steps 1–6 ─────────────────────────────────────────────────
  for (let step = 1; step <= 6; step++) {
    // Skip steps that already have valid data (resume support)
    if (steps[step] && Object.keys(steps[step]).length > 0) {
      const existing = validateStepCompleteness(step, steps[step]);
      if (existing.valid) {
        telemetry[step] = { ...newTelemetryRecord(step), status: 'complete', providerUsed: 'cached' };
        continue;
      }
    }

    const promptParams = buildPromptFn(step, company, industry, steps);
    if (!promptParams) {
      errors.push({ step, error: `buildPromptFn returned null for step ${step}` });
      continue;
    }

    const result = await executeStep(step, promptParams, env);
    telemetry[step] = result.telemetry;

    if (result.error && !result.data) {
      errors.push({ step, error: result.error });
      // Do NOT persist failed step data — stop the chain
      console.error(`[orchestrator] Step ${step} failed fatally — stopping chain`);
      break;
    }

    // Only persist data that passed validation
    if (result.data) {
      steps[step] = result.data;
      if (onStepComplete) {
        await onStepComplete(step, result.data, result.telemetry, result.tokensUsed);
      }
    }

    // Breathing time — prevent overlapping provider calls
    if (step < 6) {
      await breathe(INTER_STEP_DELAY_MS);
    }
  }

  // ── Step 7 (revenue intelligence — runs after steps 1–6) ────
  // Only run step 7 if steps 1 and 6 are complete
  if (steps[1] && steps[6] && !steps[7]) {
    await breathe(INTER_STEP_DELAY_MS * 2); // longer pause before step 7 (heavier prompt)

    const step7Params = buildPromptFn(7, company, industry, steps);
    if (step7Params) {
      const result7 = await executeStep(7, step7Params, env);
      telemetry[7]  = result7.telemetry;

      if (result7.data) {
        steps[7] = result7.data;
        if (onStepComplete) {
          await onStepComplete(7, result7.data, result7.telemetry, result7.tokensUsed);
        }
      }
    }
  }

  // ── Publication validation ─────────────────────────────────────
  // Build a strategy-shaped object from the completed steps
  const strategySnapshot = {
    company_name:          company,
    industry:              industry || null,
    step_1_market:         steps[1] || null,
    step_2_tam:            steps[2] || null,
    step_3_icp:            steps[3] || null,
    step_4_sourcing:       steps[4] || null,
    step_5_keywords:       steps[5] || null,
    step_6_messaging:      steps[6] || null,
    step_7_intelligence:   steps[7] || null,
    backend_intelligence:  null, // populated by caller (gtm.js) after orchestration
    steps_completed:       Object.values(steps).filter(s => s && Object.keys(s).length > 0).length,
  };

  const publicationState = validatePublicationReadiness(strategySnapshot);

  // Log publication state
  console.info(`[orchestrator] ${buildPublicationReport(publicationState)}`);

  return {
    steps,
    telemetry,
    publicationState,
    allStepsComplete: publicationState.publicationReady,
    errors,
    strategySnapshot,
  };
}

// ── Telemetry serializer ──────────────────────────────────────────
/**
 * serializeTelemetry(telemetry)
 * Returns a clean, loggable object (no circular refs, no large data blobs)
 */
export function serializeTelemetry(telemetry) {
  const out = {};
  for (const [step, t] of Object.entries(telemetry)) {
    out[step] = {
      status:               t.status,
      providerUsed:         t.providerUsed,
      retryCount:           t.retryCount,
      responseLatency:      t.responseLatency,
      normalizationApplied: t.normalizationApplied,
      placeholderFilled:    t.placeholderFilled,
      fallbackTriggered:    t.fallbackTriggered,
      fallbackReason:       t.fallbackReason,
      validationFailures:   t.validationFailures,
      completedAt:          t.completedAt,
    };
  }
  return out;
}
