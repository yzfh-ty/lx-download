import { DislikeEvent, type DislikeEventType } from '@/modules'

export type { DislikeEventType }

export const createModuleEvent = () => {
  global.event_dislike = new DislikeEvent()
}
