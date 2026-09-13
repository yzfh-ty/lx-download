export class UserDataManage {
  userName: string
  userDir: string

  constructor(userName: string) {
    this.userName = 'shared'
    this.userDir = global.lx.userPath
  }
}
