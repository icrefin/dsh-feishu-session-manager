/**
 * The settings page's HTTP client.
 *
 * Every call checks both `response.ok` and the content type before parsing: the
 * page can be mounted under a path prefix (the remote-control relay serves it at
 * `/s/<sessionId>/`), and a misrouted request then comes back as `200 text/html`
 * — which `response.json()` reports as `Unexpected token '<'` instead of as the
 * HTTP failure it is.
 *
 * @module dsh-feishu-session-manager/client/api
 */

import {
  CLIENT_API,
  type ErrorPayload,
  type ModelsPayload,
  type RoutePreviewPayload,
  type StatusPayload,
  type TestPayload,
} from '../protocol.ts'

/**
 * Parse one JSON response, turning every failure into a message a user can act on.
 * @param response - fetch result.
 * @returns the parsed body.
 * @throws when the response is not a JSON success.
 */
async function parseJson<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    throw new Error(`expected JSON from the host, received ${contentType || 'no content type'}`)
  }
  const body = (await response.json()) as T | ErrorPayload
  if (!response.ok) {
    const message = (body as ErrorPayload).error
    throw new Error(typeof message === 'string' ? message : `${response.status} ${response.statusText}`)
  }
  return body as T
}

/**
 * Read the bridge status.
 * @returns the status payload.
 */
export async function getStatus(): Promise<StatusPayload> {
  const response = await fetch(CLIENT_API.status, { headers: { accept: 'application/json' } })
  return parseJson<StatusPayload>(response)
}

/**
 * Read the host's model catalog.
 * @returns provider-grouped models.
 */
export async function getModels(): Promise<ModelsPayload> {
  const response = await fetch(CLIENT_API.models, { headers: { accept: 'application/json' } })
  return parseJson<ModelsPayload>(response)
}

/**
 * Send one real message to the bound chat.
 * @param text - optional custom text.
 * @returns the send result.
 */
export async function postTest(text?: string): Promise<TestPayload> {
  const response = await fetch(CLIENT_API.test, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  return parseJson<TestPayload>(response)
}

/**
 * Reopen the Feishu long connection.
 * @returns the refreshed status.
 */
export async function postReconnect(): Promise<StatusPayload> {
  const response = await fetch(CLIENT_API.reconnect, {
    method: 'POST',
    headers: { accept: 'application/json' },
  })
  return parseJson<StatusPayload>(response)
}

/**
 * Dry-run the router on one text.
 * @param text - hypothetical message.
 * @returns the decision, or why there is none.
 */
export async function postRoute(text: string): Promise<RoutePreviewPayload> {
  const response = await fetch(CLIENT_API.route, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  return parseJson<RoutePreviewPayload>(response)
}