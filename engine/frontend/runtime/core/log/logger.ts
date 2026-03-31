export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
    FATAL = 4,
}

export class Logger {
    level: LogLevel;

    constructor(level: LogLevel = LogLevel.INFO) {
        this.level = level;
    }

    debug(...args: unknown[]): void {
        if (this.level <= LogLevel.DEBUG) {
            console.debug('[DEBUG]', ...args);
        }
    }

    info(...args: unknown[]): void {
        if (this.level <= LogLevel.INFO) {
            console.info('[INFO]', ...args);
        }
    }

    warn(...args: unknown[]): void {
        if (this.level <= LogLevel.WARN) {
            console.warn('[WARN]', ...args);
        }
    }

    error(...args: unknown[]): void {
        if (this.level <= LogLevel.ERROR) {
            console.error('[ERROR]', ...args);
        }
    }

    fatal(...args: unknown[]): void {
        if (this.level <= LogLevel.FATAL) {
            console.error('[FATAL]', ...args);
        }
        const message = args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ');
        throw new Error(`[FATAL] ${message}`);
    }

    setLevel(level: LogLevel): void {
        this.level = level;
    }

    static global: Logger = new Logger(LogLevel.INFO);
}
