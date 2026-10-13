declare module 'three' {
  export class Vector2 {
    x: number
    y: number
    constructor(x?: number, y?: number)
    set(x: number, y: number): this
  }

  export class Vector3 {
    x: number
    y: number
    z: number
    constructor(x?: number, y?: number, z?: number)
    set(x: number, y: number, z: number): this
    copy(v: Vector3): this
    add(v: Vector3): this
    subVectors(a: Vector3, b: Vector3): this
    multiplyScalar(s: number): this
    lerp(v: Vector3, alpha: number): this
    lerpVectors(v1: Vector3, v2: Vector3, alpha: number): this
    distanceTo(v: Vector3): number
    normalize(): this
    clone(): Vector3
  }

  export class Euler {
    x: number
    y: number
    z: number
    constructor(x?: number, y?: number, z?: number)
    set(x: number, y: number, z: number): this
  }

  export class Quaternion {
    setFromUnitVectors(vFrom: Vector3, vTo: Vector3): this
  }

  export class Matrix4 {
    compose(position: Vector3, quaternion: Quaternion, scale: Vector3): this
    makeTranslation(x: number, y: number, z: number): this
    makeScale(x: number, y: number, z: number): this
  }

  export class Color {
    r: number
    g: number
    b: number
    constructor(color?: string | number)
    set(color: string | number): this
    lerp(color: Color, alpha: number): this
    clone(): Color
  }

  export class Object3D {
    position: Vector3
    rotation: Euler
    scale: Vector3
    quaternion: Quaternion
    matrix: Matrix4
    visible: boolean
    userData: Record<string, unknown>
    add(...objects: Object3D[]): this
    remove(...objects: Object3D[]): this
    lookAt(x: number | Vector3, y?: number, z?: number): void
    updateMatrix(): void
  }

  export class Group extends Object3D {
    constructor()
  }

  export class Scene extends Object3D {
    fog: FogExp2 | null
    constructor()
  }

  export class FogExp2 {
    color: Color
    density: number
    constructor(color: number | string, density?: number)
  }

  export class PerspectiveCamera extends Object3D {
    aspect: number
    fov: number
    constructor(fov?: number, aspect?: number, near?: number, far?: number)
    updateProjectionMatrix(): void
  }

  export class BufferAttribute {
    array: ArrayLike<number>
    count: number
    needsUpdate: boolean
    constructor(array: ArrayLike<number>, itemSize: number, normalized?: boolean)
    setXYZ(index: number, x: number, y: number, z: number): this
  }

  export class Float32BufferAttribute extends BufferAttribute {
    constructor(array: Iterable<number> | ArrayLike<number>, itemSize: number)
  }

  export class BufferGeometry {
    attributes: Record<string, BufferAttribute>
    constructor()
    setAttribute(name: string, attribute: BufferAttribute): this
    setFromPoints(points: Vector3[]): this
    computeVertexNormals(): void
    dispose(): void
  }

  export class SphereGeometry extends BufferGeometry {
    constructor(radius?: number, widthSegments?: number, heightSegments?: number)
  }

  export class IcosahedronGeometry extends BufferGeometry {
    constructor(radius?: number, detail?: number)
  }

  export class OctahedronGeometry extends BufferGeometry {
    constructor(radius?: number, detail?: number)
  }

  export class TorusGeometry extends BufferGeometry {
    constructor(radius?: number, tube?: number, radialSegments?: number, tubularSegments?: number, arc?: number)
  }

  export class RingGeometry extends BufferGeometry {
    constructor(innerRadius?: number, outerRadius?: number, thetaSegments?: number)
  }

  export class TubeGeometry extends BufferGeometry {
    constructor(path: Curve<Vector3>, tubularSegments?: number, radius?: number, radialSegments?: number, closed?: boolean)
  }

  export class Curve<T> {
    getPoint(t: number, optionalTarget?: T): T
    getPointAt(u: number, optionalTarget?: T): T
    getPoints(divisions?: number): T[]
  }

  export class CatmullRomCurve3 extends Curve<Vector3> {
    points: Vector3[]
    closed: boolean
    constructor(points?: Vector3[], closed?: boolean, curveType?: string, tension?: number)
  }

  export interface MaterialParameters {
    color?: number | string | Color
    transparent?: boolean
    opacity?: number
    wireframe?: boolean
    blending?: number
    depthWrite?: boolean
    side?: number
  }

  export class Material {
    opacity: number
    transparent: boolean
    needsUpdate: boolean
    dispose(): void
  }

  export class MeshBasicMaterial extends Material {
    color: Color
    wireframe: boolean
    constructor(parameters?: MaterialParameters)
  }

  export class MeshStandardMaterial extends Material {
    color: Color
    emissive: Color
    emissiveIntensity: number
    roughness: number
    metalness: number
    wireframe: boolean
    constructor(parameters?: MaterialParameters & {
      emissive?: number | string | Color
      emissiveIntensity?: number
      roughness?: number
      metalness?: number
    })
  }

  export class LineBasicMaterial extends Material {
    color: Color
    constructor(parameters?: MaterialParameters)
  }

  export class PointsMaterial extends Material {
    color: Color
    size: number
    constructor(parameters?: MaterialParameters & {
      size?: number
      sizeAttenuation?: boolean
      vertexColors?: boolean
    })
  }

  export interface IUniform<T = unknown> {
    value: T
  }

  export class ShaderMaterial extends Material {
    uniforms: Record<string, IUniform>
    constructor(parameters?: {
      uniforms?: Record<string, IUniform>
      vertexShader?: string
      fragmentShader?: string
      transparent?: boolean
      blending?: number
      depthWrite?: boolean
      side?: number
      wireframe?: boolean
    })
  }

  export class Mesh extends Object3D {
    geometry: BufferGeometry
    material: Material | Material[]
    constructor(geometry?: BufferGeometry, material?: Material | Material[])
  }

  export class InstancedMesh extends Mesh {
    count: number
    instanceMatrix: BufferAttribute
    instanceColor: BufferAttribute | null
    constructor(geometry: BufferGeometry, material: Material, count: number)
    setMatrixAt(index: number, matrix: Matrix4): void
    setColorAt(index: number, color: Color): void
  }

  export class Line extends Object3D {
    geometry: BufferGeometry
    material: Material
    constructor(geometry?: BufferGeometry, material?: Material)
  }

  export class Points extends Object3D {
    geometry: BufferGeometry
    material: Material
    constructor(geometry?: BufferGeometry, material?: Material)
  }

  export class Light extends Object3D {
    color: Color
    intensity: number
  }

  export class AmbientLight extends Light {
    constructor(color?: number | string, intensity?: number)
  }

  export class PointLight extends Light {
    distance: number
    decay: number
    constructor(color?: number | string, intensity?: number, distance?: number, decay?: number)
  }

  export class DirectionalLight extends Light {
    constructor(color?: number | string, intensity?: number)
  }

  export class WebGLRenderer {
    domElement: HTMLCanvasElement
    constructor(parameters?: {
      canvas?: HTMLCanvasElement
      antialias?: boolean
      alpha?: boolean
      powerPreference?: 'high-performance' | 'low-power' | 'default'
    })
    setSize(width: number, height: number, updateStyle?: boolean): void
    setPixelRatio(value: number): void
    setClearColor(color: number | string | Color, alpha?: number): void
    render(scene: Scene, camera: PerspectiveCamera): void
    dispose(): void
  }

  export const AdditiveBlending: number
  export const NormalBlending: number
  export const DoubleSide: number
  export const FrontSide: number
  export const BackSide: number
}
