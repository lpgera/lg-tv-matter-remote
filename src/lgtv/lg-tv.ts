import { EventEmitter, once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { SsapClient, type SsapPayload } from './ssap-client.ts'
import { wakeOnLan } from './wol.ts'

export type LgTvOptions = {
  host: string
  mac: string
  wolAddress: string
  clientKeyFile: string
  brightnessKey?: string
}

type LgTvEvents = {
  power: [on: boolean]
  brightness: [value: number]
  prompt: []
}

// Candidate picture settings for the panel brightness ("OLED Light" in the TV menu)
const BRIGHTNESS_KEYS = ['backlight', 'oledLight']
// Power states in which the panel is actually showing something
const ACTIVE_POWER_STATES = new Set(['Active', 'Screen Saver'])
const POWER_ON_TIMEOUT_MS = 20_000
const BRIGHTNESS_DEBOUNCE_MS = 300

/**
 * High level control of an LG webOS TV: power and panel brightness (0-100).
 */
export class LgTv extends EventEmitter<LgTvEvents> {
  #options: LgTvOptions
  #client: SsapClient
  #isOn = false
  #powerState: string | undefined
  #brightness: number | undefined
  #brightnessKey: string | undefined
  #pendingBrightness: number | undefined
  #brightnessTimer: NodeJS.Timeout | undefined

  constructor(options: LgTvOptions) {
    super()
    this.#options = options
    this.#brightnessKey = options.brightnessKey
    this.#client = new SsapClient(options.host, options.clientKeyFile)
    this.#client.on('prompt', () => this.emit('prompt'))
    this.#client.on('connected', () => {
      this.#onConnected().catch((error: Error) => console.error(`[lgtv] Setup after connect failed: ${error.message}`))
    })
    this.#client.on('disconnected', () => {
      this.#powerState = undefined
      this.#updatePower()
    })
  }

  get isOn(): boolean {
    return this.#isOn
  }

  get connected(): boolean {
    return this.#client.connected
  }

  get brightness(): number | undefined {
    return this.#pendingBrightness ?? this.#brightness
  }

  get powerState(): string | undefined {
    return this.#powerState
  }

  async start(): Promise<void> {
    await this.#client.start()
  }

  stop(): void {
    clearTimeout(this.#brightnessTimer)
    this.#client.stop()
  }

  /**
   * Resolves once the TV reports a connected, active state.
   */
  waitForConnection(timeoutMs: number): Promise<boolean> {
    if (this.#client.connected) {
      return Promise.resolve(true)
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#client.off('connected', onConnected)
        resolve(false)
      }, timeoutMs)
      const onConnected = () => {
        clearTimeout(timer)
        resolve(true)
      }
      this.#client.once('connected', onConnected)
    })
  }

  async powerOn(): Promise<void> {
    if (this.#isOn) {
      return
    }
    const deadline = Date.now() + POWER_ON_TIMEOUT_MS
    while (Date.now() < deadline) {
      await wakeOnLan(this.#options.mac, this.#options.wolAddress)
      this.#client.reconnectNow()
      if (this.#isOn) {
        return
      }
      const abort = new AbortController()
      try {
        await Promise.race([sleep(2_000, undefined, { signal: abort.signal }), once(this, 'power', { signal: abort.signal })])
      } finally {
        abort.abort()
      }
      if (this.#isOn) {
        return
      }
    }
    throw new Error('TV did not turn on (is "Turn on via Wi-Fi/LAN" enabled on the TV?)')
  }

  async powerOff(): Promise<void> {
    if (!this.#client.connected) {
      return
    }
    await this.#client.request('ssap://system/turnOff')
    this.#powerState = 'Power Off'
    this.#updatePower()
  }

  /**
   * Sets the panel brightness (0-100). If the TV is off, the value is applied once it turns on.
   */
  setBrightness(value: number): void {
    this.#pendingBrightness = Math.max(0, Math.min(100, Math.round(value)))
    clearTimeout(this.#brightnessTimer)
    // Debounced, since level transitions produce a burst of updates
    this.#brightnessTimer = setTimeout(() => {
      this.#applyPendingBrightness().catch((error: Error) =>
        console.error(`[lgtv] Setting brightness failed: ${error.message}`),
      )
    }, BRIGHTNESS_DEBOUNCE_MS)
  }

  async #applyPendingBrightness(): Promise<void> {
    const value = this.#pendingBrightness
    if (value === undefined || !this.#isOn || !this.#brightnessKey) {
      return
    }
    try {
      if (value !== this.#brightness) {
        await this.#setPictureSettings({ [this.#brightnessKey]: value })
      }
    } finally {
      // A newer value may have been requested in the meantime
      if (this.#pendingBrightness === value) {
        this.#pendingBrightness = undefined
      }
    }
    this.#setBrightnessState(value)
  }

  /**
   * Picture settings can't be written through the public SSAP API on recent firmware.
   * Instead we create a system alert whose close action is a luna call to the settings
   * service and immediately close it, which runs the luna call with system privileges.
   */
  async #setPictureSettings(settings: SsapPayload): Promise<void> {
    await this.#lunaRequest('luna://com.webos.settingsservice/setSystemSettings', { category: 'picture', settings })
  }

  async #lunaRequest(uri: string, params: SsapPayload): Promise<void> {
    const action = { uri, params }
    const alert = await this.#client.request('ssap://system.notifications/createAlert', {
      message: ' ',
      buttons: [{ label: '', onClick: uri, params }],
      onclose: action,
      onfail: action,
    })
    await this.#client.request('ssap://system.notifications/closeAlert', { alertId: alert.alertId })
  }

  async #onConnected(): Promise<void> {
    try {
      const initial = await this.#client.subscribe(
        'ssap://com.webos.service.tvpower/power/getPowerState',
        { subscribe: true },
        (payload) => this.#handlePowerState(payload),
      )
      this.#handlePowerState(initial)
    } catch (error) {
      // Not available on older firmware: being connected means being on
      console.warn(`[lgtv] Power state subscription failed, assuming on: ${(error as Error).message}`)
      this.#powerState = 'Active'
      this.#updatePower()
    }

    this.#brightnessKey ??= await this.#detectBrightnessKey()
    if (!this.#brightnessKey) {
      console.warn('[lgtv] Could not detect the brightness setting, set TV_BRIGHTNESS_KEY to override')
      return
    }
    const key = this.#brightnessKey
    const initial = await this.#client.subscribe(
      'ssap://settings/getSystemSettings',
      { category: 'picture', keys: [key], subscribe: true },
      (payload) => this.#handlePictureSettings(payload, key),
    )
    this.#handlePictureSettings(initial, key)
    await this.#applyPendingBrightness()
  }

  async #detectBrightnessKey(): Promise<string | undefined> {
    for (const key of BRIGHTNESS_KEYS) {
      try {
        const response = await this.#client.request('ssap://settings/getSystemSettings', {
          category: 'picture',
          keys: [key],
        })
        if (response.settings?.[key] !== undefined) {
          console.log(`[lgtv] Using picture setting "${key}" for brightness`)
          return key
        }
      } catch {
        // Unknown key, try the next one
      }
    }
    return undefined
  }

  #handlePowerState(payload: SsapPayload): void {
    // While transitioning (e.g. "Request Power Off") the TV reports a "processing" field
    this.#powerState = payload.processing ? String(payload.processing) : payload.state
    this.#updatePower()
  }

  #handlePictureSettings(payload: SsapPayload, key: string): void {
    const raw = payload.settings?.[key]
    const value = Number.parseInt(String(raw), 10)
    if (!Number.isNaN(value)) {
      this.#setBrightnessState(value)
    }
  }

  #setBrightnessState(value: number): void {
    if (value !== this.#brightness) {
      this.#brightness = value
      if (this.#pendingBrightness === undefined) {
        this.emit('brightness', value)
      }
    }
  }

  #updatePower(): void {
    const isOn = this.#client.connected && this.#powerState !== undefined && ACTIVE_POWER_STATES.has(this.#powerState)
    if (isOn !== this.#isOn) {
      this.#isOn = isOn
      this.emit('power', isOn)
      if (isOn) {
        this.#applyPendingBrightness().catch((error: Error) =>
          console.error(`[lgtv] Setting brightness failed: ${error.message}`),
        )
      }
    }
  }
}
