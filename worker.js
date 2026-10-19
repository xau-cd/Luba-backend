'use strict';

const { randomUUID } = require('node:crypto');

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'blocked']);
const TRANSITIONS = Object.freeze({
  proposed: new Set(['running', 'failed', 'cancelled', 'blocked']),
  running: new Set(['succeeded', 'partial', 'failed', 'cancelled', 'blocked']),
  partial: new Set(['running', 'succeeded', 'failed', 'cancelled', 'blocked']),
  succeeded: new Set(), failed: new Set(), cancelled: new Set(), blocked: new Set()
});

class WorkerError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'WorkerError';
    this.code = code;
    this.status = options.status || 500;
    this.retryable = Boolean(options.retryable);
  }
}

function createWorker(options = {}) {
  const deps = options.dependencies || {};
  const maxSteps = boundedInt(options.maxSteps ?? process.env.WORKER_MAX_STEPS, 12, 1, 30);
  const timeoutMs = boundedInt(options.timeoutMs ?? process.env.WORKER_TIMEOUT_MS, 180000, 1000, 300000);
  const tasks = new Map();
  const now = options.now || Date.now;
  let closed = false;

  function transition(task, next, extra = {}) {
    if (!TRANSITIONS[task.status]?.has(next)) {
      throw new WorkerError('INVALID_STATE_TRANSITION', `Transition interdite : ${task.status} → ${next}`);
    }
    task.status = next;
    Object.assign(task, extra);
    task.updatedAt = now();
    task.events.push({ at: task.updatedAt, status: next, ...(extra.step ? { step: extra.step } : {}) });
  }

  function publicTask(task) {
    return {
      id: task.id, status: task.status, createdAt: task.createdAt, updatedAt: task.updatedAt,
      deadlineAt: task.deadlineAt, completedSteps: task.completedSteps, totalSteps: task.steps.length,
      progress: task.steps.length ? Math.round(task.completedSteps / task.steps.length * 100) : 0,
      steps: task.steps.map(s => ({ id: s.id, kind: s.kind, status: s.status, result: s.result, error: s.error })),
      result: task.result, error: task.error, events: task.events.slice()
    };
  }

  async function plan(input, context = {}) {
    if (typeof deps.plan === 'function') {
      const proposed = await deps.plan(input, context);
      if (!Array.isArray(proposed)) throw new WorkerError('INVALID_PLAN', 'Le plan doit être une liste d’étapes.');
      return proposed;
    }
    const steps = [];
    if (input?.research === true && typeof deps.research === 'function') steps.push({ id: 'research', kind: 'research', input: input.query || input.instruction || '' });
    if (input?.engine === true && typeof deps.engine === 'function') steps.push({ id: 'engine', kind: 'engine', input });
    if (!steps.length) steps.push({ id: 'resolve', kind: 'llm', input });
    return steps;
  }

  async function run(input, context = {}) {
    if (closed) throw new WorkerError('WORKER_CLOSED', 'Le worker est arrêté.', { status: 503 });
    const started = now();
    const task = {
      id: randomUUID(), status: 'proposed', createdAt: started, updatedAt: started,
      deadlineAt: Math.min(Number.isFinite(context.deadlineAt) ? context.deadlineAt : started + timeoutMs, started + timeoutMs),
      completedSteps: 0, steps: [], events: [], result: null, error: null,
      controller: new AbortController(), externalSignal: context.signal || null
    };
    if (task.externalSignal?.aborted) transition(task, 'cancelled', { error: { code: 'ABORTED', message: 'Tâche annulée avant démarrage.' } });
    tasks.set(task.id, task);
    if (task.status === 'cancelled') return publicTask(task);
    const onAbort = () => task.controller.abort(task.externalSignal?.reason || 'aborted');
    task.externalSignal?.addEventListener('abort', onAbort, { once: true });
    try {
      const planned = await plan(input, { ...context, signal: task.controller.signal, deadlineAt: task.deadlineAt });
      if (task.controller.signal.aborted) throw new WorkerError('ABORTED', 'Tâche annulée.');
      if (!planned.length) throw new WorkerError('INVALID_PLAN', 'Le plan ne contient aucune étape exécutable.');
      if (planned.length > maxSteps) throw new WorkerError('PLAN_TOO_LARGE', `Le plan dépasse la limite de ${maxSteps} étapes.`, { status: 400 });
      task.steps = planned.map((s, i) => ({ id: String(s.id || `step-${i + 1}`), kind: String(s.kind || 'llm'), input: s.input, dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : [], status: 'pending', result: null, error: null }));
      const ids = new Set(task.steps.map(s => s.id));
      if (ids.size !== task.steps.length || task.steps.some(s => s.dependsOn.some(d => !ids.has(d)))) throw new WorkerError('INVALID_PLAN', 'Identifiants dupliqués ou dépendance inconnue dans le plan.');
      transition(task, 'running');
      const results = new Map();
      for (const step of task.steps) {
        if (task.controller.signal.aborted) throw new WorkerError('ABORTED', 'Tâche annulée.');
        if (now() >= task.deadlineAt) throw new WorkerError('WORKER_TIMEOUT', 'La tâche a dépassé son délai maximal.', { status: 408 });
        for (const dep of step.dependsOn) if (!results.has(dep)) throw new WorkerError('DEPENDENCY_FAILED', `Étape dépendante non terminée : ${dep}`);
        step.status = 'running';
        const executor = deps[step.kind];
        if (typeof executor !== 'function') {
          step.status = 'blocked'; step.error = { code: 'EXECUTOR_UNAVAILABLE', message: `Aucun exécuteur autorisé pour ${step.kind}.` };
          throw new WorkerError('EXECUTOR_UNAVAILABLE', step.error.message, { status: 503 });
        }
        try {
          const result = await withDeadline(executor({ input: step.input, taskId: task.id, stepId: step.id,
            dependencies: Object.fromEntries(step.dependsOn.map(id => [id, results.get(id)])),
            signal: task.controller.signal, deadlineAt: task.deadlineAt, context }), task.deadlineAt, task.controller.signal);
          step.result = result; step.status = 'succeeded'; results.set(step.id, result); task.completedSteps++;
          task.events.push({ at: now(), status: 'step_succeeded', step: step.id });
        } catch (e) {
          step.status = task.controller.signal.aborted ? 'cancelled' : 'failed';
          step.error = { code: e.code || 'STEP_FAILED', message: safeMessage(e.message) };
          throw e;
        }
      }
      task.result = Object.fromEntries(results);
      transition(task, 'succeeded');
    } catch (e) {
      if (e.code === 'WORKER_TIMEOUT') task.controller.abort('timeout');
      const cancelled = e.code === 'ABORTED' || (task.controller.signal.aborted && e.code !== 'WORKER_TIMEOUT');
      const blocked = ['EXECUTOR_UNAVAILABLE', 'INVALID_PLAN', 'PLAN_TOO_LARGE'].includes(e.code);
      const status = cancelled ? 'cancelled' : blocked ? 'blocked' : task.completedSteps ? 'partial' : 'failed';
      task.error = { code: e.code || 'WORKER_FAILED', message: safeMessage(e.message) };
      if (!TERMINAL.has(task.status)) transition(task, status);
    } finally {
      task.externalSignal?.removeEventListener('abort', onAbort);
    }
    return publicTask(task);
  }

  function cancel(id, reason = 'cancelled') {
    const task = tasks.get(id);
    if (!task) throw new WorkerError('TASK_NOT_FOUND', 'Tâche introuvable.', { status: 404 });
    if (!TERMINAL.has(task.status)) {
      task.controller.abort(reason);
      transition(task, 'cancelled', { error: { code: 'ABORTED', message: 'Tâche annulée.' } });
    }
    return publicTask(task);
  }

  function get(id) { const task = tasks.get(id); return task ? publicTask(task) : null; }
  function list() { return [...tasks.values()].map(publicTask); }
  return { run, cancel, get, list, plan, WorkerError, shutdown() { closed = true; for (const t of tasks.values()) if (!TERMINAL.has(t.status)) t.controller.abort('shutdown'); } };
}

function boundedInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}
function safeMessage(message) { return String(message || 'Erreur interne').replace(/(?:sk-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,})/g, '[REDACTED]').slice(0, 300); }
function withDeadline(promise, deadlineAt, signal) {
  const ms = deadlineAt - Date.now();
  if (ms <= 0) return Promise.reject(new WorkerError('WORKER_TIMEOUT', 'Délai maximal dépassé.', { status: 408 }));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); fn(value); };
    const timer = setTimeout(() => finish(reject, new WorkerError('WORKER_TIMEOUT', 'Délai maximal dépassé.', { status: 408 })), ms);
    const abort = () => finish(reject, new WorkerError('ABORTED', 'Tâche annulée.'));
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(v => finish(resolve, v), e => finish(reject, e));
  });
}

module.exports = { createWorker, WorkerError, TERMINAL, TRANSITIONS };
