import { SPLIT_CHAR } from '@/constants'
import { filterRules } from './utils'
import { getJson, setJson } from '@/storage/database'

const filterRulesToString = (rules: string) => {
  return Array.from(filterRules(rules)).join('\n')
}

export class DislikeDataManage {
  dislikeRules = ''

  constructor() {
    this.dislikeRules = getJson<LX.Dislike.DislikeRules>('dislike_data', 'current', '')
  }

  getDislikeRules = async(): Promise<LX.Dislike.DislikeRules> => {
    return this.dislikeRules
  }

  addDislikeInfo = async(infos: LX.Dislike.DislikeMusicInfo[]) => {
    this.dislikeRules = filterRulesToString(this.dislikeRules + '\n' + infos.map(info => `${info.name ?? ''}${SPLIT_CHAR.DISLIKE_NAME}${info.singer ?? ''}`).join('\n'))
    setJson('dislike_data', 'current', this.dislikeRules)
    return this.dislikeRules
  }

  overwirteDislikeInfo = async(rules: string) => {
    this.dislikeRules = filterRulesToString(rules)
    setJson('dislike_data', 'current', this.dislikeRules)
    return this.dislikeRules
  }
}
