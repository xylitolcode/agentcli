import type { Project } from '../types'

type Props = {
  projects: Project[]
  onPick: (project: Project) => void
}

/**
 * 进来先选项目：选定之后终端和目录树都锁在这个目录里。
 *
 * 这是用户看到的第一屏，所以没有做成「卡片列表」：左侧一条竖标尺、
 * 右侧平铺的细线条目，选中前就已经是这台机器的语气。
 */
export function ProjectPicker({ projects, onPick }: Props) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 overflow-auto bg-surface p-6">
      <div className="w-[min(820px,92vw)] border-l-2 border-accent pl-4">
        <div className="mb-1 text-[10.5px] uppercase tracking-[0.2em] text-faint">select project</div>
        <h2 className="m-0 text-[20px] font-semibold text-fg">选择要进入的项目</h2>
        <p className="m-0 mt-1.5 text-[12px] text-dim">
          进入后终端与目录树都限定在该项目内；项目清单由服务端维护。
        </p>
      </div>

      {projects.length === 0 ? (
        <div className="w-[min(820px,92vw)] border border-line px-4 py-3 text-[12.5px] text-faint">
          台账里还没有项目，先在服务端播种或登记。
        </div>
      ) : (
        <div className="grid w-[min(820px,92vw)] gap-px bg-[rgba(110,243,200,0.2)] [grid-template-columns:repeat(auto-fill,minmax(240px,1fr))]">
          {projects.map((project) => (
            <button
              key={project.id}
              type="button"
              onClick={() => onPick(project)}
              className="group flex flex-col gap-2 bg-panel px-4 py-3.5 text-left transition-shadow hover:bg-panel-2 hover:shadow-[inset_2px_0_0_var(--color-phos)] focus-visible:bg-panel-2"
            >
              <span className="text-[13px] font-semibold text-fg">{project.name}</span>
              <span className="break-all text-[11px] text-faint">{project.path}</span>
              <span className="mt-1 flex items-center gap-1.5">
                <span className="rounded-[1px] border border-[rgba(110,243,200,0.35)] px-1.5 py-px text-[10px] text-accent">
                  {project.agent}
                </span>
                {!project.exists && <span className="text-[10px] text-err">目录不存在</span>}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
