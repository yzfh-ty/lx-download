/* eslint-disable no-var */
import { type DislikeEventType } from '@/event'

declare global {
  interface Lx {
    logPath: string
    dataPath: string
    userPath: string
    config: LX.Config
    staticPath: string
    saveConfig: () => void
    lastCpuSample?: { idle: number, total: number }
    lastProcessSample?: { cpu: NodeJS.CpuUsage, time: number }
  }

  var lx: Lx
  var event_dislike: DislikeEventType

}

export { }
