import pkg from '../package.json' with { type: 'json' }

/** Package version, for logs and reports. */
export const VERSION: string = pkg.version
