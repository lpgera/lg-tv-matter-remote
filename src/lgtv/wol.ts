import dgram from 'node:dgram'

function macToBytes(mac: string): Buffer {
  const hex = mac.replace(/[^0-9a-f]/gi, '')
  if (hex.length !== 12) {
    throw new Error(`Invalid MAC address: ${mac}`)
  }
  return Buffer.from(hex, 'hex')
}

/**
 * Sends a Wake-on-LAN magic packet: 6 x 0xFF followed by the MAC address repeated 16 times.
 */
export async function wakeOnLan(mac: string, address = '255.255.255.255', port = 9): Promise<void> {
  const macBytes = macToBytes(mac)
  const packet = Buffer.alloc(6 + 16 * 6, 0xff)
  for (let i = 0; i < 16; i++) {
    macBytes.copy(packet, 6 + i * 6)
  }

  const socket = dgram.createSocket('udp4')
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject)
      socket.bind(() => {
        socket.setBroadcast(true)
        socket.send(packet, port, address, (error) => (error ? reject(error) : resolve()))
      })
    })
  } finally {
    socket.close()
  }
}
