import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'

/** 点云规模。230 个点 + 每条点一根近邻连线，是「看得见结构」和「不吃 GPU」的折中 */
const COUNT = 230
const RADIUS = 1.5

/** 确定性抖动：同一个 i 每次算出同一个偏移，刷新后还是同一颗核 */
function hash(i: number) {
  const value = Math.sin(i * 12.9898) * 43758.5453
  return value - Math.floor(value)
}

function buildGeometry() {
  const pts: THREE.Vector3[] = []
  const golden = Math.PI * (3 - Math.sqrt(5))
  for (let i = 0; i < COUNT; i++) {
    const y = 1 - (i / (COUNT - 1)) * 2
    const r = Math.sqrt(Math.max(0, 1 - y * y))
    const theta = golden * i
    const jitter = 0.9 + hash(i) * 0.16
    pts.push(
      new THREE.Vector3(Math.cos(theta) * r, y, Math.sin(theta) * r).multiplyScalar(RADIUS * jitter),
    )
  }

  const dots = new Float32Array(COUNT * 3)
  pts.forEach((point, i) => dots.set([point.x, point.y, point.z], i * 3))

  // 每个点只连最近的邻居：天然形成网状，不需要手工拓扑
  const segs: number[] = []
  const seen = new Set<string>()
  for (let i = 0; i < COUNT; i++) {
    let best = -1
    let dist = Infinity
    for (let j = 0; j < COUNT; j++) {
      if (j === i) continue
      const d = pts[i].distanceToSquared(pts[j])
      if (d < dist) {
        dist = d
        best = j
      }
    }
    if (best < 0) continue
    const key = i < best ? `${i}:${best}` : `${best}:${i}`
    if (seen.has(key)) continue
    seen.add(key)
    segs.push(pts[i].x, pts[i].y, pts[i].z, pts[best].x, pts[best].y, pts[best].z)
  }

  const dotGeo = new THREE.BufferGeometry()
  dotGeo.setAttribute('position', new THREE.BufferAttribute(dots, 3))
  const lineGeo = new THREE.BufferGeometry()
  lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segs), 3))
  return { dotGeo, lineGeo }
}

function Core() {
  const { invalidate } = useThree()
  const group = useRef<THREE.Group>(null)
  const dotMat = useRef<THREE.PointsMaterial>(null)
  const glowMat = useRef<THREE.SpriteMaterial>(null)
  const { dotGeo, lineGeo } = useMemo(buildGeometry, [])

  /*
   * 中心的"源点"用 sprite + 径向渐变贴图，而不是 sphere：
   * 球面在加法混合下就是一块硬边白盘，只有渐变才像光。
   */
  const glowTex = useMemo(() => {
    const size = 128
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
    grad.addColorStop(0, 'rgba(226,255,246,1)')
    grad.addColorStop(0.18, 'rgba(150,255,225,0.72)')
    grad.addColorStop(0.46, 'rgba(110,243,200,0.24)')
    grad.addColorStop(1, 'rgba(110,243,200,0)')
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, size, size)
    const tex = new THREE.CanvasTexture(canvas)
    tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }, [])

  useEffect(() => {
    return () => {
      dotGeo.dispose()
      lineGeo.dispose()
      glowTex?.dispose()
    }
  }, [dotGeo, lineGeo, glowTex])

  /*
   * 限帧：这个场景不需要 60fps。用 33ms 定时器点名要一帧，
   * 页面不可见时定时器自己跳过 —— 后台标签页零渲染。
   */
  useEffect(() => {
    const id = window.setInterval(() => {
      if (!document.hidden) invalidate()
    }, 33)
    const onVisible = () => {
      if (!document.hidden) invalidate()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [invalidate])

  useFrame((state) => {
    const g = group.current
    if (!g) return
    const t = state.clock.elapsedTime
    const breath = Math.sin(t * 0.9)
    g.scale.setScalar(1 + breath * 0.045)
    g.rotation.y = t * 0.06
    g.rotation.x = Math.sin(t * 0.18) * 0.12
    // 明暗跟着呼吸走：核心亮一点、外层皮层淡一点，像在供氧
    if (glowMat.current) glowMat.current.opacity = 0.6 + breath * 0.16
    if (dotMat.current) dotMat.current.opacity = 0.7 + breath * 0.12
  })

  return (
    <group ref={group}>
      <points geometry={dotGeo}>
        <pointsMaterial
          ref={dotMat}
          size={0.013}
          color="#6ef3c8"
          transparent
          opacity={0.7}
          sizeAttenuation
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
      <lineSegments geometry={lineGeo}>
        <lineBasicMaterial
          color="#6ef3c8"
          transparent
          opacity={0.075}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </lineSegments>
      {/* 源点：一团加法混合的柔光 + 一层薄壳做体积 */}
      {glowTex && (
        <sprite scale={[0.46, 0.46, 1]}>
          <spriteMaterial
            ref={glowMat}
            map={glowTex}
            transparent
            opacity={0.8}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </sprite>
      )}
      <mesh>
        <sphereGeometry args={[0.28, 24, 24]} />
        <meshBasicMaterial color="#6ef3c8" transparent opacity={0.1} side={THREE.BackSide} />
      </mesh>
    </group>
  )
}

/**
 * 空态神经核心。只在没有面板时挂载；开面板即整棵卸载，WebGL 上下文随之释放 ——
 * xterm 每格一个上下文，这里绝不能留第二个常驻 canvas。
 */
export default function StageCore3D() {
  return (
    <Canvas
      frameloop="demand"
      dpr={[1, 1.6]}
      camera={{ position: [0, 0.35, 4.9], fov: 40 }}
      gl={{ antialias: false, alpha: true, powerPreference: 'low-power' }}
      style={{ position: 'absolute', inset: 0 }}
    >
      <Core />
    </Canvas>
  )
}
