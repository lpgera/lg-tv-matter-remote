import { DeviceTypeId, Endpoint, Environment, ServerNode, VendorId } from '@matter/main'
import { DimmablePlugInUnitDevice } from '@matter/main/devices/dimmable-plug-in-unit'
import type { LgTv } from '../lgtv/lg-tv.ts'

export type TvPlugOptions = {
  port: number
  passcode: number
  discriminator: number
  storagePath: string
}

const MIN_LEVEL = 1
const MAX_LEVEL = 254

// Matter levels are 1-254, the TV brightness is 0-100
export function levelToBrightness(level: number): number {
  return Math.round(((level - MIN_LEVEL) / (MAX_LEVEL - MIN_LEVEL)) * 100)
}

export function brightnessToLevel(brightness: number): number {
  return Math.round((brightness / 100) * (MAX_LEVEL - MIN_LEVEL)) + MIN_LEVEL
}

/**
 * Exposes the TV as a Matter dimmable plug-in unit: on/off controls the TV power, the level
 * controls the panel brightness.
 */
export async function createTvPlug(tv: LgTv, options: TvPlugOptions) {
  Environment.default.vars.set('storage.path', options.storagePath)

  const node = await ServerNode.create({
    id: 'lg-tv',
    network: { port: options.port },
    commissioning: {
      passcode: options.passcode,
      discriminator: options.discriminator,
    },
    productDescription: {
      name: 'LG TV',
      deviceType: DeviceTypeId(DimmablePlugInUnitDevice.deviceType),
    },
    basicInformation: {
      vendorName: 'lpgera',
      // Test vendor and product IDs, fine for a non-certified private device
      vendorId: VendorId(0xfff1),
      productName: 'LG TV Matter Remote',
      productLabel: 'LG TV',
      productId: 0x8000,
      nodeLabel: 'LG TV',
      serialNumber: 'LGTV-0001',
      uniqueId: 'lg-tv-matter-remote',
    },
  })

  const endpoint = new Endpoint(DimmablePlugInUnitDevice, {
    id: 'tv',
    levelControl: {
      minLevel: MIN_LEVEL,
      maxLevel: MAX_LEVEL,
    },
  })
  await node.add(endpoint)

  // Matter -> TV. Changes equal to the TV's own state originate from the TV sync below.
  endpoint.events.onOff.onOff$Changed.on((onOff) => {
    if (onOff === tv.isOn) {
      return
    }
    console.log(`[matter] Turning TV ${onOff ? 'on' : 'off'}`)
    const action = onOff ? tv.powerOn() : tv.powerOff()
    action.catch(async (error: Error) => {
      console.error(`[matter] Turning TV ${onOff ? 'on' : 'off'} failed: ${error.message}`)
      await endpoint.set({ onOff: { onOff: tv.isOn } })
    })
  })

  endpoint.events.levelControl.currentLevel$Changed.on((level) => {
    if (level === null) {
      return
    }
    const brightness = levelToBrightness(level)
    if (brightness === tv.brightness) {
      return
    }
    console.log(`[matter] Setting TV brightness to ${brightness}`)
    tv.setBrightness(brightness)
  })

  // TV -> Matter, e.g. when the TV is controlled with its remote
  tv.on('power', (on) => {
    console.log(`[lgtv] TV is ${on ? 'on' : 'off'}`)
    endpoint.set({ onOff: { onOff: on } }).catch((error: Error) => console.error(`[matter] ${error.message}`))
  })
  tv.on('brightness', (brightness) => {
    console.log(`[lgtv] TV brightness is ${brightness}`)
    endpoint
      .set({ levelControl: { currentLevel: brightnessToLevel(brightness) } })
      .catch((error: Error) => console.error(`[matter] ${error.message}`))
  })

  // The endpoint restores its last state from storage, and the TV may have reported its state
  // before the listeners above were registered, so sync the current TV state explicitly
  await endpoint.set({
    onOff: { onOff: tv.isOn },
    ...(tv.brightness !== undefined && { levelControl: { currentLevel: brightnessToLevel(tv.brightness) } }),
  })

  return node
}
