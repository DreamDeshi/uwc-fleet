/**
 * `react-dom` is already a runtime dependency (react-native-web renders through
 * it), but `@types/react-dom` is not installed and adding it would churn the
 * shared root lockfile for one test helper. The only entry point used is the
 * server renderer in `components/DemoRoleSwitcher.test.tsx`, so it is declared
 * here with its real signature rather than typed as `any`.
 */
declare module "react-dom/server" {
  import type { ReactElement } from "react";
  export function renderToStaticMarkup(element: ReactElement): string;
  export function renderToString(element: ReactElement): string;
}
