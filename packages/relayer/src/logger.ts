/** A minimal structured logger; printf-style, matching the SDK's logger shape. */
export type Logger = (formatter: string, ...args: unknown[]) => void

/** The default logger writes to the console with a fixed prefix. */
export const defaultLogger = (prefix: string): Logger => {
  return (formatter: string, ...args: unknown[]) => {
    console.log(`[${prefix}] ${formatter}`, ...args)
  }
}
