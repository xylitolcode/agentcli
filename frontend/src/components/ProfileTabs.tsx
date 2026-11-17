import type { Profile } from '../types'

type Props = {
  profiles: Profile[]
  current: string
  onSelect: (name: string) => void
}

/** 一个标签 = 一个前台进程。点一下换一个会话，旧进程会被后端回收。 */
export function ProfileTabs({ profiles, current, onSelect }: Props) {
  if (profiles.length === 0) {
    return <span className="text-[11px] text-err">没有可用的 agent</span>
  }

  return (
    <div className="ml-1 flex gap-0.5" role="tablist">
      {profiles.map((profile) => {
        const active = profile.name === current
        return (
          <button
            key={profile.name}
            role="tab"
            aria-selected={active}
            title={profile.path}
            onClick={() => onSelect(profile.name)}
            className={
              'rounded-[5px] border px-1.5 py-px text-[11px] leading-5 transition-colors ' +
              (active
                ? 'border-[#1f3a5c] bg-[#0e1a26] text-accent'
                : 'border-transparent text-faint hover:bg-line-soft hover:text-fg')
            }
          >
            {profile.name}
          </button>
        )
      })}
    </div>
  )
}
