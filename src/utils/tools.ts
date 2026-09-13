import type http from 'node:http'

export const getIP = (request: http.IncomingMessage) => {
  let ip: string | undefined
  if (global.lx.config['proxy.enabled']) {
    const proxyIp = request.headers[global.lx.config['proxy.header']]
    if (typeof proxyIp == 'string') ip = proxyIp
  }
  ip ||= request.socket.remoteAddress

  return ip
}
