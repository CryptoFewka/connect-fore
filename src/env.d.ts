/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Absolute origin of the deployed Worker, e.g. `https://fore.automa.agency`.
   * Unset on web builds, which use the page origin instead. Required for any
   * build bundled into a native app.
   */
  readonly VITE_API_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
