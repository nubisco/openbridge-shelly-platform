import http from 'http'
import type { ShellyDeviceInfo, ShellyEmeterStatus, ShellyStatus, PhaseReading } from '../types'

export interface ShellyClientOptions {
  username?: string
  password?: string
  /** Request timeout in milliseconds (default 4000) */
  timeout?: number
}

/** Thrown when the device answers, but not with something this client understands. */
export class ShellyProtocolError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message)
    this.name = 'ShellyProtocolError'
  }
}

/**
 * Minimal client for the Gen1 Shelly HTTP API (3EM / EM).
 *
 * Gen1 devices expose plain REST endpoints (`/shelly`, `/status`, `/emeter/N`)
 * and have no `/rpc/` namespace at all — pointing a Gen2+ RPC client at one
 * yields `404 Not Found` on every call, so callers should use
 * {@link assertGen1} before polling.
 */
export class ShellyGen1Client {
  private readonly timeout: number

  constructor(
    readonly ip: string,
    private readonly options: ShellyClientOptions = {},
  ) {
    this.timeout = options.timeout ?? 4000
  }

  /** GET a path and parse the JSON body. */
  private request<T>(path: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const auth =
        this.options.username && this.options.password ? `${this.options.username}:${this.options.password}` : undefined

      // `ip` may carry an explicit port ("192.168.1.122:8080"), which Node will
      // not split out of the `host` option on its own.
      const [hostname, portPart] = splitHostPort(this.ip)
      const port = portPart ?? 80

      const req = http.get({ host: hostname, port, path, timeout: this.timeout, auth }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')

          if (res.statusCode === 401) {
            reject(new ShellyProtocolError('Authentication required — set username and password in the config'))
            return
          }
          if (res.statusCode !== 200) {
            reject(new ShellyProtocolError(`HTTP ${res.statusCode} for ${path}`, body.slice(0, 100)))
            return
          }
          try {
            resolve(JSON.parse(body) as T)
          } catch {
            reject(new ShellyProtocolError(`Invalid JSON from ${path}`, body.slice(0, 100)))
          }
        })
      })

      req.on('error', (err) => reject(err))
      req.on('timeout', () => {
        req.destroy()
        reject(new ShellyProtocolError(`Timed out after ${this.timeout}ms contacting ${this.ip}`))
      })
    })
  }

  /** `/shelly` — available on every generation, so safe to call before probing further. */
  getDeviceInfo(): Promise<ShellyDeviceInfo> {
    return this.request<ShellyDeviceInfo>('/shelly')
  }

  /** `/status` — one call returns every channel plus the aggregate power. */
  getStatus(): Promise<ShellyStatus> {
    return this.request<ShellyStatus>('/status')
  }

  /** `/emeter/N` — a single channel. Useful for probing; `/status` is cheaper for polling. */
  getEmeter(channel: number): Promise<ShellyEmeterStatus> {
    return this.request<ShellyEmeterStatus>(`/emeter/${channel}`)
  }
}

/**
 * Verify a device speaks the Gen1 API before polling it.
 *
 * Gen2+ devices answer `/shelly` with a `gen` field and serve their data under
 * `/rpc/`, which this client does not implement. Failing loudly here beats
 * looping on 404s forever, which is exactly how the Gen3-only plugins behave
 * when pointed at a Gen1 meter.
 */
export function assertGen1(info: ShellyDeviceInfo, ip: string): void {
  if (info.gen !== undefined && info.gen >= 2) {
    // Reaching here means the caller picked the wrong client: the plugin
    // dispatches on `info.gen` and Gen2+ devices are handled by
    // ShellyGen2Device. Kept as a guard so a mis-wired call fails loudly.
    throw new ShellyProtocolError(
      `${ip} is a Gen${info.gen} device (model ${info.model ?? 'unknown'}), which speaks the /rpc/ API — ` +
        `it must be polled with the Gen2 client, not this one.`,
    )
  }
  if (!info.type) {
    throw new ShellyProtocolError(`${ip} did not report a Gen1 device type — unrecognised Shelly device`)
  }
  if (!info.num_emeters || info.num_emeters < 1) {
    throw new ShellyProtocolError(`${ip} reports type ${info.type} with no energy meter channels — not an energy meter`)
  }
}

/**
 * Convert one raw Gen1 channel into normalised units.
 *
 * The device reports cumulative energy in watt-hours; OpenBridge history is
 * kept in kilowatt-hours, so it is scaled here rather than at every call site.
 */
export function toPhaseReading(emeter: ShellyEmeterStatus): PhaseReading {
  return {
    power: round(emeter.power, 2),
    voltage: round(emeter.voltage, 2),
    current: round(emeter.current, 3),
    powerFactor: round(emeter.pf, 2),
    totalForwardEnergy: round(emeter.total / 1000, 4),
    totalReturnedEnergy: round(emeter.total_returned / 1000, 4),
    valid: emeter.is_valid !== false,
  }
}

/**
 * Combine every channel into a whole-installation reading.
 *
 * Power, current and energy sum across phases. Voltage does not — it is the
 * mean of the valid channels, since summing three ~240 V phases into 720 V
 * would be meaningless.
 */
export function toTotalReading(status: ShellyStatus): PhaseReading {
  const emeters = status.emeters ?? []
  const valid = emeters.filter((e) => e.is_valid !== false)
  const voltages = valid.map((e) => e.voltage).filter((v) => typeof v === 'number' && v > 0)

  const sum = (pick: (e: ShellyEmeterStatus) => number) => emeters.reduce((acc, e) => acc + (pick(e) || 0), 0)

  // Prefer the device's own aggregate when present; fall back to summing.
  const power = typeof status.total_power === 'number' ? status.total_power : sum((e) => e.power)

  return {
    power: round(power, 2),
    voltage: voltages.length ? round(voltages.reduce((a, b) => a + b, 0) / voltages.length, 2) : 0,
    current: round(
      sum((e) => e.current),
      3,
    ),
    powerFactor: 0,
    totalForwardEnergy: round(sum((e) => e.total) / 1000, 4),
    totalReturnedEnergy: round(sum((e) => e.total_returned) / 1000, 4),
    valid: valid.length > 0,
  }
}

/** Split "host" or "host:port" into its parts. IPv6 literals are not supported. */
export function splitHostPort(value: string): [string, number | null] {
  const index = value.lastIndexOf(':')
  if (index === -1) return [value, null]
  const port = Number(value.slice(index + 1))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return [value, null]
  return [value.slice(0, index), port]
}

function round(value: number, decimals: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}
