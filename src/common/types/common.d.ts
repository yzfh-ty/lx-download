// import './app_setting'

declare namespace LX {
  type OnlineSource = 'kw' | 'kg' | 'tx' | 'wy' | 'mg'
  type Source = OnlineSource | 'local'
  type Quality = '128k' | '320k' | 'flac' | 'flac24bit' | 'hires' | 'atmos' | 'atmos_plus' | 'master' | '192k' | 'ape' | 'wav'

  type QualityList = Partial<Record<LX.Source, LX.Quality[]>>

  interface HotKey {
    name: string
    action: string
    type: keyof typeof keyName
  }

  interface HotKeyDownInfo {
    type: 'local' | 'global'
    key: string
  }

  interface HotKeyConfig {
    enable: boolean
    keys: Record<string, HotKey>
  }
  interface HotKeyConfigAll {
    local: HotKeyConfig
    global: HotKeyConfig
  }
  interface RegisterKeyInfo {
    key: string
    info: HotKey
  }
  type HotKeyState = Map<string, {
    status: boolean
    info: HotKey
  }>
  interface HotKeyActionWrap<T, D> {
    action: T
    data: D
    source?: string
  }
  type HotKeyActions = HotKeyActionWrap<'config', HotKeyConfigAll>
  | HotKeyActionWrap<'enable', boolean>
  | HotKeyActionWrap<'register', RegisterKeyInfo>
  | HotKeyActionWrap<'unregister', string>

  interface HotKeyEvent {
    type: string
    key: string
  }

  interface TaskBarButtonFlags {
    empty: boolean
    collect: boolean
    play: boolean
    next: boolean
    prev: boolean
  }

  type UpdateStatus = 'downloaded' | 'downloading' | 'error' | 'checking' | 'idle'
  interface VersionInfo {
    version: string
    desc: string
  }
}
