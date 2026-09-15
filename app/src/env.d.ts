/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly PUBLIC_API_BASE_URL: string
  readonly PUBLIC_POLYGON_CHAIN_ID: string
  readonly PUBLIC_USDT_ADDRESS: string
  readonly PUBLIC_NIMFUEL_NIM_RECIPIENT: string
  readonly PUBLIC_DEFAULT_USDT_AMOUNT?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.css' {}
