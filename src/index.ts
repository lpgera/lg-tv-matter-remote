import { config } from './config.ts'
import { LgTv } from './lgtv/lg-tv.ts'
import { createTvPlug } from './matter/tv-plug.ts'

const tv = new LgTv(config.tv)
tv.on('prompt', () => console.log('[lgtv] Please accept the connection prompt on the TV'))
await tv.start()
// Give the TV a moment so the initial Matter state reflects reality
await tv.waitForConnection(5_000)

const node = await createTvPlug(tv, config.matter)

async function shutdown() {
  console.log('Shutting down')
  tv.stop()
  await node.close()
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

// matter.js prints the pairing QR code while the device is not commissioned yet
await node.start()
