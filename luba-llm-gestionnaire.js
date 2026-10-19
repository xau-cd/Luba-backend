'use strict';

const { createOperationBudget, remainingMs, tryConsumeGeneration } = require('./llm-operation-budget');

class LlmManagerError extends Error {
  constructor(code, message, options = {}) { super(message); this.name = 'LlmManagerError'; this.code = code; this.status = options.status || 502; this.retryable = Boolean(options.retryable); this.attempts = options.attempts || 0; }
}

const DEFAULT_ORDER = ['groq', 'gemini', 'cerebras', 'openrouter'];

function createLlmManager(options = {}) {
  const generate = options.generate;
  const getProviderState = options.getProviderState || (() => ({}));
  const configuredOrder = Array.isArray(options.order) ? options.order : DEFAULT_ORDER;
  const maxAttempts = clampInt(options.maxAttempts ?? process.env.LLM_MAX_GENERATION_ATTEMPTS, 5, 1, 5);
  const maxDurationMs = clampInt(options.maxDurationMs ?? process.env.LLM_MAX_OPERATION_MS, 300000, 1000, 300000);
  if (typeof generate !== 'function') throw new TypeError('createLlmManager nécessite generate(args).');

  async function complete(request = {}) {
    const budget = request.generationBudget || createOperationBudget({ deadlineAt: request.deadlineAt, maxAttempts, maxDurationMs });
    const startedAt = Date.now();
    if (options.delegateToExistingOrchestrator === true) {
      const delegated = await generate({ ...request, generationBudget: budget, deadlineAt: Math.min(Number.isFinite(request.deadlineAt) ? request.deadlineAt : budget.deadlineAt, budget.deadlineAt) });
      if (!delegated || typeof delegated !== 'object' || (typeof delegated.text !== 'string' && !Array.isArray(delegated.toolCalls))) throw new LlmManagerError('INVALID_RESPONSE', 'L’orchestrateur existant a renvoyé une réponse invalide.');
      return { ...delegated, text: typeof delegated.text === 'string' ? delegated.text : '', attempts: budget.attempts, maxAttempts: Math.min(maxAttempts, budget.maxAttempts), elapsedMs: Date.now() - startedAt, status: delegated.partial ? 'partial' : 'succeeded', generationBudget: { attempts: budget.attempts, maxAttempts: Math.min(maxAttempts, budget.maxAttempts), remainingMs: remainingMs(budget, Date.now(), request.deadlineAt) } };
    }
    const deadlineAt = Math.min(Number.isFinite(request.deadlineAt) ? request.deadlineAt : budget.deadlineAt, budget.deadlineAt, startedAt + maxDurationMs);
    const chain = resolveChain(request, configuredOrder, getProviderState);
    if (!chain.length) throw new LlmManagerError('NO_COMPATIBLE_PROVIDER', 'Aucun fournisseur configuré ne convient à cette tâche.', { status: 503 });
    let lastError = null;
    const errors = [];
    for (const candidate of chain) {
      if (request.signal?.aborted) throw new LlmManagerError('ABORTED', 'La requête a été annulée.', { status: 499, attempts: budget.attempts });
      if (remainingMs(budget, Date.now(), deadlineAt) <= 0) break;
      if (budget.attempts >= Math.min(maxAttempts, budget.maxAttempts)) break;
      const state = getProviderState(candidate.provider, candidate.model) || {};
      if (state.enabled === false || state.openCircuit === true || !supports(candidate, request.requirements || {})) continue;
      const permit = tryConsumeGeneration(budget, Date.now(), deadlineAt);
      if (!permit.ok) break;
      try {
        const result = await withTimeout(generate({ ...request, candidate, generationBudget: budget, deadlineAt, attempt: permit.attempt }), remainingMs(budget, Date.now(), deadlineAt), request.signal);
        if (!result || typeof result !== 'object' || (typeof result.text !== 'string' && !Array.isArray(result.toolCalls))) throw new LlmManagerError('INVALID_RESPONSE', 'Le fournisseur a renvoyé une réponse invalide.', { retryable: true, attempts: budget.attempts });
        const normalized = {
          ...result, text: typeof result.text === 'string' ? result.text : '', provider: result.provider || candidate.provider,
          model: result.model || candidate.model, attempts: budget.attempts, maxAttempts: Math.min(maxAttempts, budget.maxAttempts),
          elapsedMs: Date.now() - startedAt, status: result.partial ? 'partial' : 'succeeded', generationBudget: { attempts: budget.attempts, maxAttempts: Math.min(maxAttempts, budget.maxAttempts), remainingMs: remainingMs(budget, Date.now(), deadlineAt) }, errors: errors.map(safeError)
        };
        if (normalized.status === 'partial') normalized.retrySuppressed = true;
        return normalized;
      } catch (error) {
        lastError = classify(error); errors.push({ provider: candidate.provider, model: candidate.model, code: lastError.code });
        if (lastError.code === 'ABORTED') throw lastError;
        if (!lastError.retryable) continue;
        const waitMs = Math.min(backoff(budget.attempts), Math.max(0, remainingMs(budget, Date.now(), deadlineAt) - 100));
        if (waitMs > 0 && request.waitBeforeRetry !== false) await delay(waitMs, request.signal);
      }
    }
    if (request.partialText) return { text: String(request.partialText), partial: true, status: 'partial', provider: request.currentProvider || null, model: request.currentModel || null, attempts: budget.attempts, elapsedMs: Date.now() - startedAt, retrySuppressed: true, errors: errors.map(safeError) };
    const code = budget.attempts >= Math.min(maxAttempts, budget.maxAttempts) ? 'LLM_ATTEMPTS_EXHAUSTED' : remainingMs(budget, Date.now(), deadlineAt) <= 0 ? 'LLM_DEADLINE_EXCEEDED' : lastError?.code || 'LLM_UNAVAILABLE';
    throw new LlmManagerError(code, userMessage(code), { status: code.includes('DEADLINE') ? 504 : 503, retryable: false, attempts: budget.attempts });
  }

  return { complete, inspect: () => ({ maxAttempts, maxDurationMs, order: configuredOrder.slice() }) };
}

function resolveChain(request, order, getState) {
  const supplied = Array.isArray(request.chain) ? request.chain : [];
  const candidates = supplied.length ? supplied : order.map(provider => ({ provider, model: null }));
  const orderIndex = new Map(order.map((p, i) => [p, i]));
  return candidates.filter(c => c && typeof c.provider === 'string').sort((a, b) => (orderIndex.get(a.provider) ?? 999) - (orderIndex.get(b.provider) ?? 999)).filter(c => {
    const s = getState(c.provider, c.model) || {};
    return s.configured !== false && s.enabled !== false;
  });
}
function supports(candidate, req) { const caps = candidate.capabilities || {}; if (req.tools && !caps.tools && caps.tools !== undefined) return false; if (req.vision && !caps.vision) return false; if (req.json && !caps.json) return false; if (req.minContext && caps.context && caps.context < req.minContext) return false; return true; }
function classify(e) {
  if (e instanceof LlmManagerError) return e;
  const status = Number(e?.status || e?.statusCode || e?.response?.status || 0); const text = String(e?.message || '');
  if (e?.name === 'AbortError' || e?.code === 'ABORT_ERR') return new LlmManagerError('ABORTED', 'Requête annulée.', { status: 499 });
  if (status === 401 || status === 403 || /invalid api key|unauthorized|revoked key/i.test(text)) return new LlmManagerError('AUTH_FAILED', 'Authentification fournisseur refusée.', { status: 502 });
  if (status === 429 || /rate.?limit|quota/i.test(text)) return new LlmManagerError('RATE_LIMITED', 'Limite fournisseur atteinte.', { retryable: true });
  if (status === 404 || /model.*not found|unknown model/i.test(text)) return new LlmManagerError('MODEL_UNAVAILABLE', 'Modèle indisponible.', { retryable: true });
  if (status >= 500 || /timeout|timed out|network|econnreset|fetch failed/i.test(text)) return new LlmManagerError('PROVIDER_TEMPORARY', 'Fournisseur temporairement indisponible.', { retryable: true });
  return new LlmManagerError('PROVIDER_REQUEST_FAILED', 'La requête fournisseur a échoué.', { retryable: false });
}
function safeError(e) { return { provider: e.provider, model: e.model, code: e.code }; }
function userMessage(code) { return ({ LLM_ATTEMPTS_EXHAUSTED: 'Le nombre maximal de générations a été atteint.', LLM_DEADLINE_EXCEEDED: 'La requête a dépassé son délai maximal.', NO_COMPATIBLE_PROVIDER: 'Aucun fournisseur configuré ne convient à cette tâche.', LLM_UNAVAILABLE: 'Aucun modèle n’a pu produire une réponse vérifiable.' })[code] || 'Le service de génération est temporairement indisponible.'; }
function clampInt(v, fallback, min, max) { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback; }
function backoff(attempt) { return Math.min(1500, 150 * (2 ** Math.max(0, attempt - 1))) + Math.floor(Math.random() * 100); }
function delay(ms, signal) { return new Promise((resolve, reject) => { if (signal?.aborted) return reject(new LlmManagerError('ABORTED', 'Requête annulée.', { status: 499 })); const t = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(t); reject(new LlmManagerError('ABORTED', 'Requête annulée.', { status: 499 })); }, { once: true }); }); }
function withTimeout(promise, ms, signal) { if (ms <= 0) return Promise.reject(new LlmManagerError('LLM_DEADLINE_EXCEEDED', 'Délai maximal dépassé.', { status: 504 })); return new Promise((resolve, reject) => { let settled = false; const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(t); signal?.removeEventListener('abort', abort); fn(v); }; const t = setTimeout(() => finish(reject, new LlmManagerError('LLM_DEADLINE_EXCEEDED', 'Délai maximal dépassé.', { status: 504 })), ms); const abort = () => finish(reject, new LlmManagerError('ABORTED', 'Requête annulée.', { status: 499 })); signal?.addEventListener('abort', abort, { once: true }); Promise.resolve(promise).then(v => finish(resolve, v), e => finish(reject, e)); }); }

module.exports = { createLlmManager, LlmManagerError, DEFAULT_ORDER, classify, supports };
