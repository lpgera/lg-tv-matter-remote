// Debug tool to test the TV connection without Matter: node src/cli.ts <command>
import { config } from './config.ts'
import { LgTv } from './lgtv/lg-tv.ts'

const [command, argument] = process.argv.slice(2)
const usage = 'Usage: npm run tv -- pair | status | on | off | brightness <0-100>'

const tv = new LgTv(config.tv)
tv.on('prompt', () => console.log('Please accept the connection prompt on the TV'))

async function connect(timeoutMs = 10_000) {
  await tv.start()
  if (!(await tv.waitForConnection(timeoutMs))) {
    throw new Error('Could not connect to the TV, is it on?')
  }
  // Let the initial power state and brightness arrive
  await new Promise((resolve) => setTimeout(resolve, 1_000))
}

try {
  switch (command) {
    case 'pair':
      await connect(60_000)
      console.log(`Paired, client key saved to ${config.tv.clientKeyFile}`)
      break
    case 'status':
      await connect()
      console.log({ on: tv.isOn, powerState: tv.powerState, brightness: tv.brightness })
      break
    case 'on':
      await tv.start()
      await tv.powerOn()
      console.log('TV is on')
      break
    case 'off':
      await connect()
      await tv.powerOff()
      console.log('TV is turning off')
      break
    case 'brightness': {
      const value = Number.parseInt(argument ?? '', 10)
      if (Number.isNaN(value)) {
        throw new Error(usage)
      }
      await connect()
      tv.setBrightness(value)
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      console.log(`Brightness is now ${tv.brightness}`)
      break
    }
    default:
      console.log(usage)
  }
} catch (error) {
  console.error((error as Error).message)
  process.exitCode = 1
} finally {
  tv.stop()
}
