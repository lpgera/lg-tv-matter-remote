import path from 'node:path'

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing required environment variable ${name} (see .env.example)`)
  }
  return value
}

function integer(name: string, fallback: number): number {
  const value = process.env[name]
  if (!value) {
    return fallback
  }
  const parsed = Number.parseInt(value, 10)
  if (Number.isNaN(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${value}"`)
  }
  return parsed
}

const dataDir = path.resolve(process.env.DATA_DIR ?? 'data')

export const config = {
  tv: {
    host: required('TV_HOST'),
    mac: required('TV_MAC'),
    // Broadcast address used for Wake-on-LAN packets
    wolAddress: process.env.TV_WOL_ADDRESS ?? '255.255.255.255',
    // Picture setting that controls the panel brightness, auto-detected when unset
    brightnessKey: process.env.TV_BRIGHTNESS_KEY || undefined,
    clientKeyFile: path.join(dataDir, 'lgtv-client-key.json'),
  },
  matter: {
    port: integer('MATTER_PORT', 5540),
    passcode: integer('MATTER_PASSCODE', 20202021),
    discriminator: integer('MATTER_DISCRIMINATOR', 3840),
    storagePath: path.join(dataDir, 'matter'),
  },
}

export type Config = typeof config
