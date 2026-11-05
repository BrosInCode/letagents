// The one place the renderer reaches the shared live-demo module (the wire
// format that the API and the main process also use).
export {
  LIVE_DEMO,
  LIVE_DEMO_COLORS,
  liveDemoColor,
  liveDemoKey,
} from "../../../../../../../../../shared/live-demo.mjs";
export type {
  DemoMark,
  DemoMarkInput,
  LiveDemoAnchor,
  LiveDemoClientFrame,
  LiveDemoPerson,
  LiveDemoPoint,
  LiveDemoServerFrame,
} from "../../../../../../../../../shared/live-demo.mjs";
