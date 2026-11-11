/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `mock` for the scripted demo data, `http` for sherpa-server. Dev defaults to mock, a build to http. */
  readonly VITE_DATA?: 'mock' | 'http'
}
