/**
 * One-shot model calls through the Harness LLM service.
 *
 * The plugin never talks to a provider itself. `ctx.llm.stream` is the only
 * supported path into an adapter, and it gives the plugin the same vocabulary
 * the agent loop uses: token chunks, a `usage` sample, and exactly one terminal
 * `finish` whose `reason` says whether the call succeeded.
 *
 * A summary or a routing answer is short, so the call is buffered into a string
 * rather than streamed onward. Failures are returned, never thrown: the bridge
 * decides whether a failed classification deserves a user-visible message or
 * only a log line.
 *
 * @module dsh-feishu-session-manager/llm/call
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import type { LlmFailure, RequestMessage } from '@deepseek-ai/dsh-llm'

/** Which model performs the auxiliary calls. */
export interface ModelRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** One buffered model call. */
export interface ModelCallRequest {
  /** System policy text. */
  readonly system: string
  /** Single user message. */
  readonly user: string
  /** Output cap; omitted leaves the adapter default. */
  readonly maxTokens?: number
  /** Sampling temperature; routing uses 0 so one prompt yields one answer. */
  readonly temperature?: number
  /** Cancellation. */
  readonly signal?: AbortSignal
}

/** Outcome of one buffered model call. */
export interface ModelCallResult {
  /** Accumulated visible text, `''` when the call produced none. */
  readonly text: string
  /** Stable provider-neutral failure code, when the call failed. */
  readonly failure?: string
  /** Seconds the call took, rounded to one decimal. */
  readonly seconds: number
  /** Visible-text deltas received. `0` while `text` is empty says "nothing arrived". */
  readonly textChunks: number
  /**
   * Reasoning deltas received.
   *
   * A route that spends its whole output budget thinking returns no visible text
   * at all; this counter is what tells that case apart from a model that answered
   * in prose, so the activity log can say which one happened.
   */
  readonly reasoningChunks: number
}

/**
 * Build the route from settings.
 * @param provider - configured provider.
 * @param model - configured model.
 * @param reasoningEffort - optional effort id.
 * @returns the route, or `null` when either half is missing.
 */
export function modelRouteOf(provider: string, model: string, reasoningEffort: string): ModelRoute | null {
  if (provider.trim() === '' || model.trim() === '') return null
  return {
    provider: provider.trim(),
    model: model.trim(),
    ...(reasoningEffort.trim() === '' ? {} : { reasoningEffort: reasoningEffort.trim() }),
  }
}

/**
 * Run one model call and buffer its text.
 *
 * @param ctx - host context carrying the LLM service.
 * @param route - model to call.
 * @param request - system policy, user message, cap and signal.
 * @returns the buffered text plus a failure code when the stream ended badly.
 */
export async function callModelText(
  ctx: Context,
  route: ModelRoute,
  request: ModelCallRequest,
): Promise<ModelCallResult> {
  const started = Date.now()
  let text = ''
  let textChunks = 0
  let reasoningChunks = 0
  let failure: string | undefined
  const messages: RequestMessage[] = [{ role: 'user', content: [{ type: 'text', text: request.user }] }]
  try {
    const stream = ctx.llm.stream({
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort === undefined ? {} : { reasoningEffort: route.reasoningEffort as never }),
      system: request.system,
      messages,
      ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') {
        text += chunk.text
        textChunks += 1
      }
      if (chunk.type === 'reasoning-delta') reasoningChunks += 1
      if (chunk.type === 'finish') {
        const reason = chunk.reason
        if (reason.kind === 'error' || reason.kind === 'aborted') failure = failureCode(reason.failure)
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  }
  return {
    text: text.trim(),
    ...(failure === undefined ? {} : { failure }),
    seconds: Math.round((Date.now() - started) / 100) / 10,
    textChunks,
    reasoningChunks,
  }
}

/**
 * Read the stable code of one LLM failure.
 * @param failure - provider-neutral failure record.
 * @returns its code, or a generic marker.
 */
function failureCode(failure: LlmFailure): string {
  const code = (failure as { code?: unknown }).code
  return typeof code === 'string' && code !== '' ? code : 'unknown'
}

/**
 * List the model routes the host can currently serve.
 *
 * Used by the settings page's picker through the models route, and by the
 * bridge to refuse a save that names an unreachable route.
 *
 * @param ctx - host context carrying the session controller.
 * @returns grouped model ids, or `null` when the catalog is unavailable.
 */
export async function readModelCatalog(ctx: Context): Promise<{
  groups: { id: string; name: string; models: { id: string; name: string }[] }[]
  fallback: { provider: string; model: string } | null
  failures: { id: string; message: string }[]
}> {
  try {
    const catalog = await ctx.sessionController.modelCatalog()
    return {
      groups: catalog.groups.map((group) => ({
        id: group.id,
        name: group.name,
        models: group.models.map((model) => ({ id: model.id, name: model.name })),
      })),
      fallback:
        catalog.default === undefined
          ? null
          : { provider: catalog.default.provider, model: catalog.default.model },
      failures: catalog.failures.map((failure) => ({ id: failure.id, message: failure.message })),
    }
  } catch {
    return { groups: [], fallback: null, failures: [] }
  }
}