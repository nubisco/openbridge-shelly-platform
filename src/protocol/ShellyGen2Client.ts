import http from 'http'
import { createHash, randomBytes } from 'crypto'
import { ShellyProtocolError, splitHostPort, type ShellyClientOptions } from './ShellyGen1Client'
import type {
  ShellyComponentId,
  ShellyDeviceInfo,
  ShellyEmDataStatus,
  ShellyEmStatus,
  ShellyGen2Status,
  ShellyInputStatus,
  ShellySwitchConfig,
  ShellySwitchStatus,
  PhaseReading,
} from '../types'

/**
 * Client for the Gen2+ Shelly RPC API (Plus / Pro / Gen3).
 *
 * Gen2 devices drop the Gen1 REST endpoints entirely and serve everything under
 * `/rpc/`. One `Shelly.GetStatus` call returns every component the device has,
 * keyed by id (`switch:0`, `em:0`, `cover:0`), so a 1PM, 2PM and 4PM are all
 * handled by the same code without a per-model table.
 *
 * Pointing this at a Gen1 device yields 404 on every call, so callers should
 * use {@link assertGen2} first.
 */
export class ShellyGen2Client {
  private readonly timeout: number
  /** Digest challenge from a previous 401, reused until the device rejects it. */
  private challenge: DigestChallenge | null = null
  private nonceCount = 0

  constructor(
    readonly ip: string,
    private readonly options: ShellyClientOptions = {},
  ) {
    this.timeout = options.timeout ?? 4000
  }

  /**
   * Call an RPC method.
   *
   * Auth is the one real departure from Gen1. Gen1 accepts HTTP basic, which
   * Node applies from the `auth` option; Gen2 uses digest with SHA-256 and
   * simply answers 401 to a basic header. So an unauthenticated attempt goes
   * first and, only if the device challenges, is it retried with a digest
   * response. Devices without auth enabled (the common case) never pay for
   * the second round trip.
   */
  private async call<T>(method: string, params?: Record<string, string | number | boolean>): Promise<T> {
    const query = params
      ? '?' +
        Object.entries(params)
          .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
          .join('&')
      : ''
    const path = `/rpc/${method}${query}`

    const first = await this.request(path, this.challenge ? this.authorizationFor(path) : undefined)
    if (first.status !== 401) return this.parse<T>(first, path)

    // Challenged: (re)negotiate and retry exactly once. A second 401 means the
    // credentials are wrong, not that the nonce went stale.
    const challenge = parseChallenge(first.headers['www-authenticate'])
    if (!challenge) {
      throw new ShellyProtocolError(`${this.ip} demanded authentication but sent no usable challenge`)
    }
    if (!this.options.username || !this.options.password) {
      throw new ShellyProtocolError('Authentication required: set username and password in the config')
    }

    this.challenge = challenge
    this.nonceCount = 0
    const second = await this.request(path, this.authorizationFor(path))
    if (second.status === 401) {
      this.challenge = null
      throw new ShellyProtocolError(`${this.ip} rejected the credentials: check username and password`)
    }
    return this.parse<T>(second, path)
  }

  private parse<T>(res: RawResponse, path: string): T {
    if (res.status !== 200) {
      throw new ShellyProtocolError(`HTTP ${res.status} for ${path}`, res.body.slice(0, 100))
    }
    let payload: unknown
    try {
      payload = JSON.parse(res.body)
    } catch {
      throw new ShellyProtocolError(`Invalid JSON from ${path}`, res.body.slice(0, 100))
    }
    // RPC errors come back as 200 with an `error` member rather than a status code.
    const err = (payload as { error?: { message?: string } })?.error
    if (err) throw new ShellyProtocolError(`${path} failed: ${err.message ?? 'unknown RPC error'}`)
    return payload as T
  }

  private request(path: string, authorization?: string): Promise<RawResponse> {
    return new Promise<RawResponse>((resolve, reject) => {
      const [hostname, portPart] = splitHostPort(this.ip)
      const headers = authorization ? { Authorization: authorization } : undefined

      const req = http.get({ host: hostname, port: portPart ?? 80, path, timeout: this.timeout, headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | undefined>,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
      })

      req.on('error', (err) => reject(err))
      req.on('timeout', () => {
        req.destroy()
        reject(new ShellyProtocolError(`Timed out after ${this.timeout}ms contacting ${this.ip}`))
      })
    })
  }

  private authorizationFor(uri: string): string {
    const c = this.challenge
    if (!c) return ''
    const user = this.options.username ?? ''
    const pass = this.options.password ?? ''
    const cnonce = randomBytes(8).toString('hex')
    const nc = String(++this.nonceCount).padStart(8, '0')

    const ha1 = sha256(`${user}:${c.realm}:${pass}`)
    const ha2 = sha256(`GET:${uri}`)
    const response = sha256(`${ha1}:${c.nonce}:${nc}:${cnonce}:${c.qop}:${ha2}`)

    return (
      `Digest username="${user}", realm="${c.realm}", nonce="${c.nonce}", uri="${uri}", ` +
      `algorithm=SHA-256, qop=${c.qop}, nc=${nc}, cnonce="${cnonce}", response="${response}"`
    )
  }

  /** `Shelly.GetDeviceInfo`: model, mac, firmware and the configured profile. */
  getDeviceInfo(): Promise<ShellyDeviceInfo & { profile?: string }> {
    return this.call<ShellyDeviceInfo & { profile?: string }>('Shelly.GetDeviceInfo')
  }

  /** `Shelly.GetStatus`: every component in one call. */
  getStatus(): Promise<ShellyGen2Status> {
    return this.call<ShellyGen2Status>('Shelly.GetStatus')
  }

  /** `Switch.Set`: actuate a relay. */
  async setSwitch(id: number, on: boolean): Promise<void> {
    await this.call('Switch.Set', { id, on })
  }

  /**
   * Close a relay once and let the device's own auto-off open it again.
   *
   * Deliberately one call, not on-then-off. A control board reads the step
   * input as an edge, so the pulse only has to be clean, and the device timing
   * it itself means a bridge that dies mid-pulse cannot leave the relay closed
   * across the board's step input. That is worth more than the convenience of
   * owning the timing here: a latched step input is a gate that stops
   * answering its remote.
   */
  async pulseSwitch(id: number): Promise<void> {
    await this.setSwitch(id, true)
  }

  /** `Switch.GetConfig`: used to verify the auto-off a pulse depends on. */
  getSwitchConfig(id: number): Promise<ShellySwitchConfig> {
    return this.call<ShellySwitchConfig>('Switch.GetConfig', { id })
  }
}

interface RawResponse {
  status: number
  headers: Record<string, string | undefined>
  body: string
}

interface DigestChallenge {
  realm: string
  nonce: string
  qop: string
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Pull realm/nonce/qop out of a `WWW-Authenticate: Digest ...` header. */
export function parseChallenge(header: string | undefined): DigestChallenge | null {
  if (!header || !/^digest/i.test(header.trim())) return null
  const read = (key: string) => header.match(new RegExp(`${key}\\s*=\\s*"?([^",]+)"?`, 'i'))?.[1]
  const realm = read('realm')
  const nonce = read('nonce')
  if (!realm || !nonce) return null
  return { realm, nonce, qop: read('qop') ?? 'auth' }
}

/**
 * Verify a device speaks the Gen2 RPC API before polling it.
 *
 * The mirror of `assertGen1`: failing loudly here beats looping on 404s, which
 * is what happens when an RPC client is pointed at a Gen1 meter.
 */
export function assertGen2(info: ShellyDeviceInfo, ip: string): void {
  if (info.gen === undefined || info.gen < 2) {
    throw new ShellyProtocolError(
      `${ip} did not report a Gen2+ generation, it looks like a Gen1 device (type ${info.type ?? 'unknown'})`,
    )
  }
}

/** Component ids present in a `Shelly.GetStatus` payload, in key order. */
export function parseComponents(status: ShellyGen2Status): ShellyComponentId[] {
  const components: ShellyComponentId[] = []
  for (const key of Object.keys(status ?? {})) {
    const match = /^([a-z_]+):(\d+)$/.exec(key)
    if (!match) continue
    components.push({ type: match[1], index: Number(match[2]), key })
  }
  return components
}

/** True when the device is wired as a roller shutter rather than two relays. */
export function isCoverMode(status: ShellyGen2Status): boolean {
  return parseComponents(status).some((c) => c.type === 'cover')
}

/**
 * Read one `input:N` level out of a status payload.
 *
 * Returns null rather than false when the input is missing or reports no level,
 * so a mistyped input index shows up as "unknown" instead of quietly reading as
 * "not at the limit", which for a gate would mean an invented position.
 */
export function readInputState(status: ShellyGen2Status, index: number, invert = false): boolean | null {
  const input = status[`input:${index}`] as ShellyInputStatus | undefined
  if (!input || typeof input.state !== 'boolean') return null
  return invert ? !input.state : input.state
}

/**
 * Normalise a metering relay channel into the same shape the energy meters use,
 * so switch channels feed the existing history charting unchanged.
 *
 * Non-PM relays report no power fields at all; those come back as zeros rather
 * than being dropped, so a channel's telemetry keys stay stable over time.
 */
export function toSwitchReading(sw: ShellySwitchStatus): PhaseReading {
  return {
    power: round(sw.apower ?? 0, 2),
    voltage: round(sw.voltage ?? 0, 2),
    current: round(sw.current ?? 0, 3),
    powerFactor: 0,
    totalForwardEnergy: round((sw.aenergy?.total ?? 0) / 1000, 4),
    totalReturnedEnergy: 0,
    valid: !sw.errors?.length,
  }
}

/**
 * Normalise one `em:N` phase, optionally enriched with its `emdata:N` counters.
 *
 * Gen2 splits live readings (`em`) from cumulative energy (`emdata`), which
 * Gen1 returned together, so the two are recombined here to keep `PhaseReading`
 * identical across generations.
 */
export function toEmPhaseReading(em: ShellyEmStatus, phase: 'a' | 'b' | 'c', data?: ShellyEmDataStatus): PhaseReading {
  const power = em[`${phase}_act_power`] ?? 0
  const voltage = em[`${phase}_voltage`] ?? 0
  const current = em[`${phase}_current`] ?? 0

  return {
    power: round(power, 2),
    voltage: round(voltage, 2),
    current: round(current, 3),
    powerFactor: 0,
    totalForwardEnergy: round((data?.[`${phase}_total_act_energy`] ?? 0) / 1000, 4),
    totalReturnedEnergy: round((data?.[`${phase}_total_act_ret_energy`] ?? 0) / 1000, 4),
    valid: typeof em[`${phase}_act_power`] === 'number',
  }
}

/** Combine every phase of an `em:N` into a whole-installation reading. */
export function toEmTotalReading(em: ShellyEmStatus, data?: ShellyEmDataStatus): PhaseReading {
  const phases: Array<'a' | 'b' | 'c'> = ['a', 'b', 'c']
  const present = phases.filter((p) => typeof em[`${p}_act_power`] === 'number')
  const voltages = present.map((p) => em[`${p}_voltage`] ?? 0).filter((v) => v > 0)

  // Prefer the device's own aggregate when present; fall back to summing.
  const power =
    typeof em.total_act_power === 'number'
      ? em.total_act_power
      : present.reduce((a, p) => a + (em[`${p}_act_power`] ?? 0), 0)
  const current =
    typeof em.total_current === 'number' ? em.total_current : present.reduce((a, p) => a + (em[`${p}_current`] ?? 0), 0)

  return {
    power: round(power, 2),
    // Voltage is the mean of the live phases, not a sum: three ~240 V phases
    // do not make 720 V.
    voltage: voltages.length ? round(voltages.reduce((a, b) => a + b, 0) / voltages.length, 2) : 0,
    current: round(current, 3),
    powerFactor: 0,
    totalForwardEnergy: round(
      (data?.total_act ?? present.reduce((a, p) => a + (data?.[`${p}_total_act_energy`] ?? 0), 0)) / 1000,
      4,
    ),
    totalReturnedEnergy: round(
      (data?.total_act_ret ?? present.reduce((a, p) => a + (data?.[`${p}_total_act_ret_energy`] ?? 0), 0)) / 1000,
      4,
    ),
    valid: present.length > 0,
  }
}

function round(value: number, decimals: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}
