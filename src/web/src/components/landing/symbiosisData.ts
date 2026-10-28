import { reactive } from 'vue'

export type TopologyModeId = 'symbiosis' | 'lending' | 'swarm'
export type HemisphereFocus = 'human' | 'fused' | 'agent'
export type SiteTheme = 'dark' | 'light'

export const symbiosisBridge = reactive({
  biasTarget: 0,
  focus: 'fused' as HemisphereFocus,
})

export function setHemisphereFocus(focus: HemisphereFocus) {
  symbiosisBridge.focus = focus
  symbiosisBridge.biasTarget = focus === 'human' ? -1 : focus === 'agent' ? 1 : 0
}
