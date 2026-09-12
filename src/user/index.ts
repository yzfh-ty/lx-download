import { UserDataManage } from './data'
import { DislikeManage } from '@/modules'

export interface UserSpace {
  dataManage: UserDataManage
  dislikeManage: DislikeManage
}
let sharedSpace: UserSpace | null = null

export const getUserSpace = (_userName: string) => {
  let user = sharedSpace
  if (!user) {
    console.log('initializing shared data space')
    const dataManage = new UserDataManage('shared')
    const dislikeManage = new DislikeManage(dataManage)
    sharedSpace = user = {
      dataManage,
      dislikeManage,
    }
  }
  return user
}


export * from './data'
