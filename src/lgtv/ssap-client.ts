import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import path from 'node:path'
import WebSocket from 'ws'
import pairingTemplate from './pairing.json' with { type: 'json' }

// Payloads are loosely typed JSON objects defined by webOS
export type SsapPayload = Record<string, any>

type SsapMessage = {
  type: 'response' | 'registered' | 'error'
  id?: string
  payload?: SsapPayload
  error?: string
}

type PendingRequest = {
  resolve: (payload: SsapPayload) => void
  reject: (error: Error) => void
}

type SsapClientEvents = {
  connected: []
  disconnected: []
  prompt: []
}

const REQUEST_TIMEOUT_MS = 10_000
const PING_INTERVAL_MS = 10_000
const RECONNECT_DELAY_MS = 5_000

/**
 * Minimal client for the webOS "Second Screen Application Protocol" (SSAP) spoken on
 * wss://<tv>:3001. Keeps reconnecting while started, since the TV drops the connection
 * whenever it goes into standby.
 */
export class SsapClient extends EventEmitter<SsapClientEvents> {
  #host: string
  #clientKeyFile: string
  #clientKey: string | undefined
  #ws: WebSocket | undefined
  #registered = false
  #started = false
  #nextId = 0
  #pending = new Map<string, PendingRequest>()
  #subscriptions = new Map<string, (payload: SsapPayload) => void>()
  #reconnectTimer: NodeJS.Timeout | undefined
  #pingTimer: NodeJS.Timeout | undefined

  constructor(host: string, clientKeyFile: string) {
    super()
    this.#host = host
    this.#clientKeyFile = clientKeyFile
  }

  get connected(): boolean {
    return this.#registered
  }

  async start(): Promise<void> {
    if (this.#started) {
      return
    }
    this.#started = true
    this.#clientKey = await this.#loadClientKey()
    this.#connect()
  }

  stop(): void {
    this.#started = false
    clearTimeout(this.#reconnectTimer)
    this.#ws?.terminate()
  }

  /**
   * Connects immediately instead of waiting for the next scheduled reconnect attempt.
   */
  reconnectNow(): void {
    if (this.#started && !this.#ws) {
      clearTimeout(this.#reconnectTimer)
      this.#connect()
    }
  }

  request(uri: string, payload: SsapPayload = {}): Promise<SsapPayload> {
    if (!this.#registered) {
      return Promise.reject(new Error(`Not connected to TV, cannot request ${uri}`))
    }
    return this.#send('request', uri, payload)
  }

  /**
   * Subscribes for the lifetime of the current connection. The initial response is returned,
   * later updates are delivered to the callback.
   */
  async subscribe(uri: string, payload: SsapPayload, callback: (payload: SsapPayload) => void): Promise<SsapPayload> {
    if (!this.#registered) {
      throw new Error(`Not connected to TV, cannot subscribe to ${uri}`)
    }
    const id = this.#createId()
    const initial = await this.#send('subscribe', uri, payload, id)
    this.#subscriptions.set(id, callback)
    return initial
  }

  #createId(): string {
    return `msg_${this.#nextId++}`
  }

  #send(type: 'request' | 'subscribe' | 'register', uri: string | undefined, payload: SsapPayload, id = this.#createId()) {
    const ws = this.#ws
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket is not open'))
    }
    return new Promise<SsapPayload>((resolve, reject) => {
      // Registration waits for the user to accept the prompt on the TV, so it has no timeout
      const timer =
        type === 'register'
          ? undefined
          : setTimeout(() => {
              this.#pending.delete(id)
              reject(new Error(`Request ${uri} timed out`))
            }, REQUEST_TIMEOUT_MS)
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      ws.send(JSON.stringify({ id, type, uri, payload }))
    })
  }

  #connect(): void {
    const ws = new WebSocket(`wss://${this.#host}:3001`, {
      // The TV uses a self-signed certificate
      rejectUnauthorized: false,
      handshakeTimeout: 5_000,
    })
    this.#ws = ws

    ws.on('open', () => {
      this.#startPing(ws)
      this.#register().catch((error: Error) => {
        console.error(`[lgtv] Registration failed: ${error.message}`)
        ws.terminate()
      })
    })
    ws.on('message', (data) => this.#handleMessage(data.toString()))
    ws.on('error', () => {
      // Errors are expected while the TV is off, the close handler takes care of reconnecting
    })
    ws.on('close', () => this.#handleClose(ws))
  }

  async #register(): Promise<void> {
    const pairing: SsapPayload = structuredClone(pairingTemplate)
    if (this.#clientKey) {
      pairing['client-key'] = this.#clientKey
    }
    const response = await this.#send('register', undefined, pairing, 'register_0')
    const clientKey = response['client-key']
    if (typeof clientKey === 'string' && clientKey !== this.#clientKey) {
      this.#clientKey = clientKey
      await this.#saveClientKey(clientKey)
    }
    this.#registered = true
    this.emit('connected')
  }

  #handleMessage(raw: string): void {
    let message: SsapMessage
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    const id = message.id
    if (!id) {
      return
    }

    if (id === 'register_0' && message.type === 'response' && message.payload?.pairingType === 'PROMPT') {
      // The TV shows a pairing prompt, the final answer arrives as a "registered" message
      this.emit('prompt')
      return
    }

    const subscription = this.#subscriptions.get(id)
    if (subscription && message.type === 'response' && message.payload) {
      subscription(message.payload)
      return
    }

    const pending = this.#pending.get(id)
    if (!pending) {
      return
    }
    this.#pending.delete(id)
    if (message.type === 'error' || message.payload?.returnValue === false) {
      pending.reject(new Error(message.error ?? message.payload?.errorText ?? 'Unknown SSAP error'))
    } else {
      pending.resolve(message.payload ?? {})
    }
  }

  #startPing(ws: WebSocket): void {
    // Detect half-open connections, e.g. when the TV loses power abruptly
    let alive = true
    ws.on('pong', () => {
      alive = true
    })
    this.#pingTimer = setInterval(() => {
      if (!alive) {
        ws.terminate()
        return
      }
      alive = false
      ws.ping()
    }, PING_INTERVAL_MS)
  }

  #handleClose(ws: WebSocket): void {
    if (this.#ws !== ws) {
      return
    }
    clearInterval(this.#pingTimer)
    this.#ws = undefined
    const wasRegistered = this.#registered
    this.#registered = false
    this.#subscriptions.clear()
    for (const pending of this.#pending.values()) {
      pending.reject(new Error('Connection to TV closed'))
    }
    this.#pending.clear()
    if (wasRegistered) {
      this.emit('disconnected')
    }
    if (this.#started) {
      this.#reconnectTimer = setTimeout(() => this.#connect(), RECONNECT_DELAY_MS)
    }
  }

  async #loadClientKey(): Promise<string | undefined> {
    try {
      const content = JSON.parse(await fs.readFile(this.#clientKeyFile, 'utf8'))
      return typeof content.clientKey === 'string' ? content.clientKey : undefined
    } catch {
      return undefined
    }
  }

  async #saveClientKey(clientKey: string): Promise<void> {
    await fs.mkdir(path.dirname(this.#clientKeyFile), { recursive: true })
    await fs.writeFile(this.#clientKeyFile, JSON.stringify({ clientKey }, null, 2))
  }
}
