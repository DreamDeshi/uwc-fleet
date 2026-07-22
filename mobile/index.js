// Explicit entry point. In this npm-workspaces monorepo, dependencies hoist to
// the repo-root node_modules, so Expo's default `expo/AppEntry` (which imports
// `../../App`) resolves to the wrong folder. Registering App ourselves from
// here keeps the path correct regardless of hoisting.
import { registerRootComponent } from "expo";
import App from "./App";

// Register the background-location task at startup, BEFORE the OS can fire it in
// a headless (app-closed) launch. Importing the module runs its defineTask().
import "./src/lib/backgroundLocation";

registerRootComponent(App);
