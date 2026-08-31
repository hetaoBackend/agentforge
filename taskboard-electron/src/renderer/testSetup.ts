// Preloaded by bun test (see bunfig.toml) so component tests have a DOM.
//
// GlobalRegistrator installs happy-dom's window/document/HTMLElement onto
// globalThis. React 19 and @testing-library/react both read those at import
// time, so this has to run before any test module is loaded — hence a
// preload rather than a per-file beforeAll.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!("document" in globalThis)) {
  GlobalRegistrator.register();
}

// React 19 checks this flag to decide whether act() warnings apply.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
