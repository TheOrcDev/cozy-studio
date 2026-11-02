/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_STUDIO_API_BASE?: string;
  /** "1" when the UI is built for hosted Cozy Studio (ADR 0012). */
  readonly VITE_STUDIO_HOSTED?: string;
}

declare module '*.yaml?raw' {
  const content: string;
  export default content;
}
