import type { Project } from '../types'

type Props = {
  projects: Project[]
  onPick: (project: Project) => void
}

/** 进来先选项目：选定之后终端和目录树都锁在这个目录里。 */
export function ProjectPicker({ projects, onPick }: Props) {
  return (
    <div className="fixed inset-0 z-30 flex flex-col items-center justify-center gap-[22px] bg-surface p-6">
      <div className="text-center">
        <h2 className="mb-1.5 text-lg font-semibold">选择要进入的项目</h2>
        <p className="m-0 text-[12.5px] text-dim">
          进入后终端与目录树都限定在该项目内；项目清单由服务端维护。
        </p>
      </div>

      {projects.length === 0 ? (
        <div className="text-[12.5px] text-faint">台账里还没有项目，先在服务端播种或登记。</div>
      ) : (
        <div className="grid w-[min(880px,92vw)] gap-3.5 [grid-template-columns:repeat(auto-fill,minmax(230px,1fr))]">
          {projects.map((project) => (
            <button
              key={project.id}
              onClick={() => onPick(project)}
              className="rounded-xl border border-line bg-panel px-4 pb-3.5 pt-4 text-left transition-all hover:-translate-y-0.5 hover:border-[#1f3a5c] hover:bg-panel-2"
            >
              <div className="mb-1.5 text-sm font-semibold">{project.name}</div>
              <div className="break-all text-[11.5px] text-faint">{project.path}</div>
              <div className="mt-2.5 flex items-center gap-1.5">
                <span className="rounded-full border border-[#1f3a5c] px-2 py-px text-[10.5px] text-accent">
                  {project.agent}
                </span>
                {!project.exists && <span className="text-[10.5px] text-err">目录不存在</span>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
