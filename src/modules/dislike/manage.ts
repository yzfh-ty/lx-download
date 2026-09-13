import { type UserDataManage } from '@/user'
import { DislikeDataManage } from './dislikeDataManage'

export class DislikeManage {
  dislikeDataManage: DislikeDataManage

  constructor(_userDataManage: UserDataManage) {
    this.dislikeDataManage = new DislikeDataManage()
  }

  getDislikeRules = async() => {
    return await this.dislikeDataManage.getDislikeRules()
  }
}
