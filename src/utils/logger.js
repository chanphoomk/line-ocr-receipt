/**
 * Logging Utility
 * Provides structured logging with different levels
 */

const winston = require('winston');

const { combine, timestamp, printf, colorize, errors } = winston.format;

// Custom log format
const logFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
    let log = `${timestamp} [${level}]: ${message}`;

    // Add stack trace for errors
    if (stack) {
        log += `\n${stack}`;
    }

    // Add metadata if present
    if (Object.keys(meta).length > 0) {
        log += ` ${JSON.stringify(meta)}`;
    }

    return log;
});

// Create logger instance
const logger = winston.createLogger({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    format: combine(
        errors({ stack: true }),
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        logFormat
    ),
    transports: [
        new winston.transports.Console({
            format: combine(
                colorize(),
                timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                logFormat
            ),
        }),
    ],
});

module.exports = logger;
