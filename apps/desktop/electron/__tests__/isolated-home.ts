// Import this first in a test file that does not use `createElectronTestEnv`:
//
//   import "./isolated-home.js";
//
// ES modules run in import order, so HOME already points at a scratch folder
// when the modules under test are evaluated. Without it, a module that builds
// `~/.letagents/...` paths while it loads would read and write the real home.
import { installIsolatedTestHome } from "./harness.js";

installIsolatedTestHome();
